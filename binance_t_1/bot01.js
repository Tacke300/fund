const https = require('https');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ==================== CẤU HÌNH ====================
const BASE_HOST = 'fapi.binance.com';
const WEB_SERVER_PORT = 1997;
const BOT_LOG_FILE = './bot.log';

// ==================== BIẾN TOÀN CỤC ====================
let config = {
    API_KEY: '',
    SECRET_KEY: '',
    TARGET_COIN_SYMBOL: 'ETHUSDT',
    INITIAL_INVESTMENT_AMOUNT: 0.12,
    APPLY_DOUBLE_STRATEGY: false,
    TOTAL_INVESTMENT_CAP: 0
};

let botStatus = {
    running: false,
    startTime: null,
    currentPosition: null,
    totalProfit: 0,
    totalLoss: 0,
    netPNL: 0
};

// ==================== HÀM TIỆN ÍCH ====================
function addLog(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    
    console.log(logEntry);
    fs.appendFileSync(BOT_LOG_FILE, logEntry);
}

// ==================== API GIAO DỊCH ====================
async function callBinanceAPI(endpoint, method = 'GET', params = {}, signed = false) {
    const query = new URLSearchParams(params).toString();
    let url = `${endpoint}?${query}`;
    
    if (signed) {
        const timestamp = Date.now() - 1000; // Đồng bộ thời gian
        const signature = crypto
            .createHmac('sha256', config.SECRET_KEY)
            .update(`${query}&timestamp=${timestamp}`)
            .digest('hex');
        url += `&timestamp=${timestamp}&signature=${signature}`;
    }

    return new Promise((resolve, reject) => {
        https.get(`https://${BASE_HOST}${url}`, {
            headers: signed ? { 'X-MBX-APIKEY': config.API_KEY } : {}
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// ==================== LOGIC BOT ====================
async function openPosition() {
    if (!botStatus.running || botStatus.currentPosition) return;

    try {
        // 1. Lấy giá hiện tại
        const ticker = await callBinanceAPI('/fapi/v1/ticker/price', 'GET', {
            symbol: config.TARGET_COIN_SYMBOL
        });
        const currentPrice = parseFloat(ticker.price);

        // 2. Tính toán khối lượng
        const quantity = (config.INITIAL_INVESTMENT_AMOUNT / currentPrice).toFixed(4);

        // 3. Gửi lệnh mở
        const order = await callBinanceAPI('/fapi/v1/order', 'POST', {
            symbol: config.TARGET_COIN_SYMBOL,
            side: 'BUY',
            type: 'MARKET',
            quantity: quantity
        }, true);

        // 4. Lưu vị thế
        botStatus.currentPosition = {
            symbol: config.TARGET_COIN_SYMBOL,
            entryPrice: currentPrice,
            quantity: quantity,
            openTime: new Date()
        };

        addLog(`✅ Đã mở lệnh ${config.TARGET_COIN_SYMBOL} | Giá: ${currentPrice} | Khối lượng: ${quantity}`);

    } catch (error) {
        addLog(`❌ Lỗi mở lệnh: ${error.message}`);
    }
}

async function closePosition(reason) {
    if (!botStatus.currentPosition) return;

    try {
        const position = botStatus.currentPosition;
        
        // 1. Gửi lệnh đóng
        const order = await callBinanceAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: position.quantity
        }, true);

        // 2. Tính PNL
        const ticker = await callBinanceAPI('/fapi/v1/ticker/price', 'GET', {
            symbol: position.symbol
        });
        const exitPrice = parseFloat(ticker.price);
        const pnl = (exitPrice - position.entryPrice) * position.quantity;

        // 3. Cập nhật thống kê
        if (pnl > 0) botStatus.totalProfit += pnl;
        else botStatus.totalLoss += Math.abs(pnl);
        botStatus.netPNL = botStatus.totalProfit - botStatus.totalLoss;

        addLog(`🔴 Đã đóng lệnh ${position.symbol} | Lý do: ${reason} | PNL: ${pnl.toFixed(2)}`);

        // 4. Reset vị thế
        botStatus.currentPosition = null;

    } catch (error) {
        addLog(`❌ Lỗi đóng lệnh: ${error.message}`);
    }
}

// ==================== WEB SERVER ====================
const app = express();
app.use(express.json());
app.use(express.static('public'));

// API nhận cấu hình từ front-end
app.post('/api/configure', (req, res) => {
    try {
        config = {
            API_KEY: req.body.apiKey,
            SECRET_KEY: req.body.secretKey,
            TARGET_COIN_SYMBOL: req.body.coinSymbol,
            INITIAL_INVESTMENT_AMOUNT: parseFloat(req.body.initialAmount),
            APPLY_DOUBLE_STRATEGY: req.body.applyDoubleStrategy,
            TOTAL_INVESTMENT_CAP: parseFloat(req.body.totalInvestment)
        };

        addLog(`⚙️ Cập nhật cấu hình: ${JSON.stringify(config)}`);
        res.json({ success: true });

    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// API khởi động bot
app.get('/start_bot_logic', async (req, res) => {
    if (botStatus.running) {
        return res.send('Bot đang chạy');
    }

    botStatus = {
        running: true,
        startTime: new Date(),
        currentPosition: null,
        totalProfit: 0,
        totalLoss: 0,
        netPNL: 0
    };

    addLog('🚀 Bot đã khởi động');
    res.send('Bot đã khởi động');

    // Bắt đầu giao dịch
    setInterval(() => {
        if (botStatus.running) openPosition();
    }, 5000);
});

// API dừng bot
app.get('/stop_bot_logic', async (req, res) => {
    if (!botStatus.running) {
        return res.send('Bot chưa chạy');
    }

    await closePosition('Dừng bot thủ công');
    botStatus.running = false;
    addLog('🛑 Bot đã dừng');
    res.send('Bot đã dừng');
});

// API trạng thái bot
app.get('/api/status', (req, res) => {
    res.json(botStatus);
});

// API đọc log
app.get('/api/logs', (req, res) => {
    try {
        const logs = fs.readFileSync(BOT_LOG_FILE, 'utf-8');
        res.send(logs);
    } catch (error) {
        res.status(500).send('Lỗi đọc log');
    }
});

app.listen(WEB_SERVER_PORT, () => {
    addLog(`🌐 Server chạy tại http://localhost:${WEB_SERVER_PORT}`);
});
