const https = require('https');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ==================== CẤU HÌNH ====================
const PORT = 1997;
const LOG_FILE = 'bot.log';

// ==================== BIẾN TOÀN CỤC ====================
let config = {
    apiKey: '',
    secretKey: '',
    symbol: 'BTCUSDT',
    amount: 20,
    doubleStrategy: false,
    totalInvestment: 0
};

let bot = {
    running: false,
    position: null,
    stats: {
        profit: 0,
        loss: 0,
        net: 0
    }
};

// ==================== HÀM TIỆN ÍCH ====================
function log(message) {
    const time = new Date().toLocaleString('vi-VN', { 
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false 
    });
    const entry = `[${time}] ${message}\n`;
    
    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry);
}

// ==================== API BINANCE ====================
async function binanceRequest(endpoint, method = 'GET', params = {}, signed = false) {
    const baseUrl = 'https://fapi.binance.com';
    let query = new URLSearchParams(params).toString();
    
    if (signed) {
        const timestamp = Date.now() - 1000;
        const signature = crypto.createHmac('sha256', config.secretKey)
            .update(`${query}&timestamp=${timestamp}`)
            .digest('hex');
        query += `&timestamp=${timestamp}&signature=${signature}`;
    }

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'fapi.binance.com',
            path: `${endpoint}?${query}`,
            method,
            headers: signed ? { 'X-MBX-APIKEY': config.apiKey } : {}
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.code) {
                        throw new Error(`Binance API error: ${result.msg} (code ${result.code})`);
                    }
                    resolve(result);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        
        if (method === 'POST') {
            req.write(query);
        }
        
        req.end();
    });
}

// ==================== ĐÒN BẨY TỐI ĐA ====================
async function getMaxLeverage(symbol) {
    try {
        const leverageBrackets = await binanceRequest('/fapi/v1/leverageBracket', 'GET', {}, true);
        const symbolBracket = leverageBrackets.find(b => b.symbol === symbol);
        
        if (!symbolBracket) {
            throw new Error(`Không tìm thấy thông tin đòn bẩy cho ${symbol}`);
        }
        
        return symbolBracket.brackets[0].initialLeverage;
    } catch (error) {
        log(`❌ Lỗi lấy đòn bẩy: ${error.message}`);
        return 10; // Mặc định nếu không lấy được
    }
}

async function setLeverage(symbol, leverage) {
    try {
        const response = await binanceRequest('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: leverage
        }, true);
        
        log(`✅ Đã đặt đòn bẩy ${leverage}x cho ${symbol}`);
        return true;
    } catch (error) {
        log(`❌ Lỗi đặt đòn bẩy: ${error.message}`);
        return false;
    }
}

// ==================== LOGIC GIAO DỊCH ====================
async function getSymbolInfo(symbol) {
    try {
        const exchangeInfo = await binanceRequest('/fapi/v1/exchangeInfo', 'GET', { symbol });
        const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
        
        if (!symbolInfo) {
            throw new Error(`Không tìm thấy thông tin symbol ${symbol}`);
        }

        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        
        return {
            minQty: parseFloat(lotSizeFilter.minQty),
            stepSize: parseFloat(lotSizeFilter.stepSize),
            tickSize: parseFloat(priceFilter.tickSize),
            minNotional: parseFloat(minNotionalFilter.notional),
            pricePrecision: symbolInfo.pricePrecision,
            quantityPrecision: symbolInfo.quantityPrecision
        };
    } catch (error) {
        log(`❌ Lỗi lấy thông tin symbol: ${error.message}`);
        return null;
    }
}

async function openTrade() {
    if (!bot.running || bot.position) return;

    try {
        // 1. Lấy thông tin symbol và đòn bẩy
        const [symbolInfo, maxLeverage] = await Promise.all([
            getSymbolInfo(config.symbol),
            getMaxLeverage(config.symbol)
        ]);
        
        if (!symbolInfo) return;
        
        // 2. Đặt đòn bẩy
        const leverageSet = await setLeverage(config.symbol, maxLeverage);
        if (!leverageSet) return;

        // 3. Lấy giá hiện tại
        const ticker = await binanceRequest('/fapi/v1/ticker/price', 'GET', { symbol: config.symbol });
        const price = parseFloat(ticker.price);

        // 4. Tính khối lượng chính xác
        let quantity = (config.amount * maxLeverage) / price;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        // Kiểm tra điều kiện tối thiểu
        if (quantity < symbolInfo.minQty) {
            log(`Số lượng ${quantity} nhỏ hơn mức tối thiểu ${symbolInfo.minQty}`);
            return;
        }

        const notionalValue = quantity * price;
        if (notionalValue < symbolInfo.minNotional) {
            log(`Giá trị hợp đồng ${notionalValue} nhỏ hơn mức tối thiểu ${symbolInfo.minNotional}`);
            return;
        }

        // 5. Đặt lệnh
        const order = await binanceRequest('/fapi/v1/order', 'POST', {
            symbol: config.symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL'
        }, true);

        log(`✅ Đã mở lệnh ${config.symbol} | Khối lượng: ${quantity} | Giá: ${price} | Đòn bẩy: ${maxLeverage}x`);

        // 6. Lưu vị thế
        bot.position = {
            symbol: config.symbol,
            entryPrice: price,
            quantity: quantity,
            leverage: maxLeverage,
            time: new Date(),
            symbolInfo: symbolInfo
        };

        // 7. Đặt lệnh TP/SL
        await placeTPSLOrders();

    } catch (error) {
        log(`❌ Lỗi mở lệnh: ${error.message}`);
    }
}

async function placeTPSLOrders() {
    if (!bot.position) return;

    const { symbol, entryPrice, quantity, symbolInfo } = bot.position;
    const tpPrice = parseFloat((entryPrice * 1.006).toFixed(symbolInfo.pricePrecision)); // TP +0.6%
    const slPrice = parseFloat((entryPrice * 0.994).toFixed(symbolInfo.pricePrecision)); // SL -0.6%

    try {
        // Đặt lệnh Take Profit
        await binanceRequest('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL',
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice,
            quantity: quantity,
            closePosition: 'true',
            timeInForce: 'GTC'
        }, true);

        // Đặt lệnh Stop Loss
        await binanceRequest('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL',
            type: 'STOP_MARKET',
            stopPrice: slPrice,
            quantity: quantity,
            closePosition: 'true',
            timeInForce: 'GTC'
        }, true);

        log(`🔹 Đã đặt TP @ ${tpPrice} và SL @ ${slPrice} cho ${symbol}`);

    } catch (error) {
        log(`❌ Lỗi đặt TP/SL: ${error.message}`);
    }
}

async function closeTrade(reason) {
    if (!bot.position) {
        log('Không có vị thế nào để đóng');
        return;
    }

    try {
        const { symbol, quantity } = bot.position;
        
        // 1. Hủy tất cả lệnh chờ
        await binanceRequest('/fapi/v1/allOpenOrders', 'DELETE', { symbol }, true);
        log(`Đã hủy các lệnh chờ cũ cho ${symbol}`);

        // 2. Đặt lệnh đóng
        const order = await binanceRequest('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL'
        }, true);

        // 3. Tính PNL
        const ticker = await binanceRequest('/fapi/v1/ticker/price', 'GET', { symbol });
        const exitPrice = parseFloat(ticker.price);
        const pnl = (exitPrice - bot.position.entryPrice) * bot.position.quantity;

        // 4. Cập nhật thống kê
        if (pnl > 0) bot.stats.profit += pnl;
        else bot.stats.loss += Math.abs(pnl);
        bot.stats.net = bot.stats.profit - bot.stats.loss;

        log(`🔴 Đã đóng lệnh ${symbol} | PNL: ${pnl.toFixed(4)} USDT | Lý do: ${reason}`);
        log(`📊 Tổng Lãi: ${bot.stats.profit.toFixed(2)} | Tổng Lỗ: ${bot.stats.loss.toFixed(2)} | PNL Ròng: ${bot.stats.net.toFixed(2)}`);

        // 5. Reset vị thế
        bot.position = null;

    } catch (error) {
        log(`❌ Lỗi đóng lệnh: ${error.message}`);
    }
}

// ==================== WEB SERVER ====================
const app = express();
app.use(express.json());
app.use(express.static('public'));

// API Cấu hình
app.post('/api/configure', (req, res) => {
    try {
        config = {
            apiKey: req.body.apiKey.trim(),
            secretKey: req.body.secretKey.trim(),
            symbol: req.body.coinSymbol.trim().toUpperCase(),
            amount: parseFloat(req.body.initialAmount),
            doubleStrategy: req.body.applyDoubleStrategy === 'true',
            totalInvestment: parseFloat(req.body.totalInvestment) || 0
        };

        log(`⚙️ Cập nhật cấu hình: ${JSON.stringify(config)}`);
        res.json({ success: true, message: 'Cấu hình đã được cập nhật' });

    } catch (error) {
        log(`❌ Lỗi cập nhật cấu hình: ${error.message}`);
        res.status(400).json({ success: false, error: error.message });
    }
});

// API Điều khiển bot
app.get('/start_bot_logic', async (req, res) => {
    if (bot.running) {
        return res.send('Bot đang chạy');
    }

    if (!config.apiKey || !config.secretKey) {
        return res.status(400).send('API Key và Secret Key là bắt buộc');
    }

    bot.running = true;
    log('🚀 Bot đã khởi động');

    // Bắt đầu giao dịch
    setInterval(async () => {
        if (bot.running) {
            await openTrade();
        }
    }, 10000); // Kiểm tra mỗi 10 giây

    res.send('Bot đã khởi động');
});

app.get('/stop_bot_logic', async (req, res) => {
    if (!bot.running) {
        return res.send('Bot chưa chạy');
    }

    await closeTrade('Dừng thủ công');
    bot.running = false;
    log('🛑 Bot đã dừng');
    res.send('Bot đã dừng');
});

// API Trạng thái
app.get('/api/status', (req, res) => {
    res.json({
        running: bot.running,
        position: bot.position,
        stats: bot.stats,
        config: config
    });
});

// API Logs
app.get('/api/logs', (req, res) => {
    try {
        const logs = fs.readFileSync(LOG_FILE, 'utf-8');
        res.send(logs);
    } catch (error) {
        res.status(500).send('Lỗi đọc log');
    }
});

// Phục vụ file tĩnh
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    log(`🌐 Server chạy tại http://localhost:${PORT}`);
    log(`⚡ Bot sẵn sàng giao dịch ${config.symbol} với đòn bẩy tối đa`);
});
