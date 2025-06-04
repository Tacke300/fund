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
    symbol: 'ETHUSDT',
    amount: 10,
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
    const time = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' });
    const entry = `[${time}] ${message}\n`;
    
    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry);
}

// ==================== API BINANCE ====================
async function binanceRequest(endpoint, params = {}, signed = false) {
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
        const req = https.get(`${baseUrl}${endpoint}?${query}`, {
            headers: signed ? { 'X-MBX-APIKEY': config.apiKey } : {}
        }, res => {
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
        req.end();
    });
}

// ==================== LOGIC GIAO DỊCH ====================
async function getSymbolInfo(symbol) {
    try {
        const exchangeInfo = await binanceRequest('/fapi/v1/exchangeInfo', { symbol });
        const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
        
        if (!symbolInfo) {
            throw new Error(`Symbol ${symbol} not found`);
        }

        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
        
        return {
            minQty: parseFloat(lotSizeFilter.minQty),
            stepSize: parseFloat(lotSizeFilter.stepSize),
            tickSize: parseFloat(priceFilter.tickSize),
            pricePrecision: symbolInfo.pricePrecision,
            quantityPrecision: symbolInfo.quantityPrecision
        };
    } catch (error) {
        log(`Lỗi lấy thông tin symbol: ${error.message}`);
        return null;
    }
}

async function openTrade() {
    if (!bot.running || bot.position) return;

    try {
        // 1. Lấy thông tin symbol
        const symbolInfo = await getSymbolInfo(config.symbol);
        if (!symbolInfo) return;

        // 2. Lấy giá hiện tại
        const ticker = await binanceRequest('/fapi/v1/ticker/price', { symbol: config.symbol });
        const price = parseFloat(ticker.price);

        // 3. Tính khối lượng chính xác
        let quantity = config.amount / price;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        if (quantity < symbolInfo.minQty) {
            log(`Số lượng tính toán (${quantity}) quá nhỏ cho ${config.symbol}. MinQty là ${symbolInfo.minQty}. Không thể mở lệnh.`);
            return;
        }

        // 4. Đặt lệnh
        const order = await binanceRequest('/fapi/v1/order', {
            symbol: config.symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL'
        }, true);

        log(`✅ Đã mở lệnh ${config.symbol} | Khối lượng: ${quantity} | Giá: ${price}`);

        // 5. Lưu vị thế
        bot.position = {
            symbol: config.symbol,
            entryPrice: price,
            quantity: quantity,
            time: new Date(),
            symbolInfo: symbolInfo
        };

        // 6. Đặt lệnh TP/SL
        await placeTPSLOrders();

    } catch (error) {
        log(`❌ Lỗi mở lệnh: ${error.message}`);
    }
}

async function placeTPSLOrders() {
    if (!bot.position) return;

    const { symbol, entryPrice, quantity, symbolInfo } = bot.position;
    const tpPrice = parseFloat((entryPrice * 1.006).toFixed(symbolInfo.pricePrecision));
    const slPrice = parseFloat((entryPrice * 0.994).toFixed(symbolInfo.pricePrecision));

    try {
        // Đặt lệnh Take Profit
        await binanceRequest('/fapi/v1/order', {
            symbol: symbol,
            side: 'SELL',
            type: 'TAKE_PROFIT_MARKET',
            quantity: quantity,
            stopPrice: tpPrice,
            closePosition: 'true'
        }, true);

        // Đặt lệnh Stop Loss
        await binanceRequest('/fapi/v1/order', {
            symbol: symbol,
            side: 'SELL',
            type: 'STOP_MARKET',
            quantity: quantity,
            stopPrice: slPrice,
            closePosition: 'true'
        }, true);

        log(`Đã đặt TP @ ${tpPrice} và SL @ ${slPrice} cho ${symbol}`);

    } catch (error) {
        log(`❌ Lỗi đặt TP/SL: ${error.message}`);
    }
}

async function closeTrade(reason) {
    if (!bot.position) {
        log('Không có vị thế nào để đóng.');
        return;
    }

    try {
        const { symbol, quantity } = bot.position;
        
        // 1. Hủy tất cả lệnh chờ
        await binanceRequest('/fapi/v1/allOpenOrders', { symbol }, true);
        log(`Đã hủy các lệnh chờ cũ (nếu có) cho ${symbol}.`);

        // 2. Đặt lệnh đóng
        const order = await binanceRequest('/fapi/v1/order', {
            symbol: symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL'
        }, true);

        // 3. Tính PNL
        const ticker = await binanceRequest('/fapi/v1/ticker/price', { symbol });
        const exitPrice = parseFloat(ticker.price);
        const pnl = (exitPrice - bot.position.entryPrice) * bot.position.quantity;

        // 4. Cập nhật thống kê
        if (pnl > 0) bot.stats.profit += pnl;
        else bot.stats.loss += Math.abs(pnl);
        bot.stats.net = bot.stats.profit - bot.stats.loss;

        log(`🔴 Đã đóng lệnh ${symbol} | PNL: ${pnl.toFixed(4)} | Lý do: ${reason}`);

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
            doubleStrategy: req.body.applyDoubleStrategy,
            totalInvestment: parseFloat(req.body.totalInvestment) || 0
        };

        log(`⚙️ Cập nhật cấu hình: ${JSON.stringify(config)}`);
        res.json({ success: true, message: 'Cấu hình đã được cập nhật' });

    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// API Điều khiển bot
app.get('/start_bot_logic', async (req, res) => {
    if (bot.running) {
        return res.send('Bot đang chạy');
    }

    bot.running = true;
    log('🚀 Bot đã khởi động');

    // Bắt đầu giao dịch
    setInterval(async () => {
        if (bot.running) {
            await openTrade();
        }
    }, 5000);

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
    const status = {
        running: bot.running,
        position: bot.position,
        stats: bot.stats,
        config: config
    };
    res.json(status);
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
});
