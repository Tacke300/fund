// server.js
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
    amount: 0.12,
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
    const time = new Date().toISOString();
    const entry = `[${time}] ${message}\n`;
    
    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry);
}

// ==================== API BINANCE ====================
async function binanceRequest(method, endpoint, params = {}, signed = false) {
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
        const req = https.request(`${baseUrl}${endpoint}?${query}`, {
            method,
            headers: signed ? { 'X-MBX-APIKEY': config.apiKey } : {}
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// ==================== LOGIC GIAO DỊCH ====================
async function openTrade() {
    if (!bot.running || bot.position) return;

    try {
        // 1. Lấy thông tin symbol
        const symbolInfo = await binanceRequest('GET', '/fapi/v1/exchangeInfo', {
            symbol: config.symbol
        });
        
        const filters = symbolInfo.symbols[0].filters;
        const minQty = parseFloat(filters.find(f => f.filterType === 'LOT_SIZE').minQty);
        const stepSize = parseFloat(filters.find(f => f.filterType === 'LOT_SIZE').stepSize);

        // 2. Lấy giá hiện tại
        const ticker = await binanceRequest('GET', '/fapi/v1/ticker/price', {
            symbol: config.symbol
        });
        const price = parseFloat(ticker.price);

        // 3. Tính khối lượng
        let quantity = config.amount / price;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        
        if (quantity < minQty) {
            log(`Khối lượng ${quantity} nhỏ hơn mức tối thiểu ${minQty}`);
            return;
        }

        // 4. Đặt lệnh
        const order = await binanceRequest('POST', '/fapi/v1/order', {
            symbol: config.symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: quantity.toFixed(8)
        }, true);

        log(`✅ Đã mở lệnh ${config.symbol} | Khối lượng: ${quantity} | Giá: ${price}`);

        // 5. Lưu vị thế
        bot.position = {
            symbol: config.symbol,
            entryPrice: price,
            quantity: quantity,
            time: new Date()
        };

    } catch (error) {
        log(`❌ Lỗi mở lệnh: ${error.message}`);
    }
}

async function closeTrade(reason) {
    if (!bot.position) return;

    try {
        const pos = bot.position;
        
        // 1. Đặt lệnh đóng
        const order = await binanceRequest('POST', '/fapi/v1/order', {
            symbol: pos.symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: pos.quantity.toFixed(8)
        }, true);

        // 2. Tính PNL
        const ticker = await binanceRequest('GET', '/fapi/v1/ticker/price', {
            symbol: pos.symbol
        });
        const exitPrice = parseFloat(ticker.price);
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity;

        // 3. Cập nhật thống kê
        if (pnl > 0) bot.stats.profit += pnl;
        else bot.stats.loss += Math.abs(pnl);
        bot.stats.net = bot.stats.profit - bot.stats.loss;

        log(`🔴 Đã đóng lệnh ${pos.symbol} | PNL: ${pnl.toFixed(2)} | Lý do: ${reason}`);

        // 4. Reset vị thế
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
        res.json({ success: true });

    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// API Điều khiển bot
app.get('/start_bot_logic', (req, res) => {
    if (bot.running) return res.send('Bot đang chạy');

    bot.running = true;
    log('🚀 Bot đã khởi động');

    // Bắt đầu giao dịch
    setInterval(() => {
        if (bot.running) openTrade();
    }, 5000);

    res.send('Bot đã khởi động');
});

app.get('/stop_bot_logic', async (req, res) => {
    if (!bot.running) return res.send('Bot chưa chạy');

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
        stats: bot.stats
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
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    log(`🌐 Server chạy tại http://localhost:${PORT}`);
});
