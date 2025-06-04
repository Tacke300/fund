// server.js
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url'); // Chỉ cần nếu bạn dùng ES module syntax, nhưng có vẻ bạn dùng CommonJS

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
    position: null, // Lưu thông tin vị thế hiện tại
    stats: {
        profit: 0,
        loss: 0,
        net: 0
    }
};

let botInterval; // Biến để lưu trữ ID của setInterval, giúp dừng bot dễ dàng hơn

// ==================== HÀM TIỆN ÍCH ====================
function log(message) {
    const time = new Date().toISOString();
    const entry = `[${time}] ${message}\n`;

    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry);
}

// ==================== API BINANCE ====================
async function binanceRequest(method, endpoint, params = {}, signed = false) {
    const baseUrl = 'https://fapi.binance.com'; // Futures API base URL
    let query = new URLSearchParams(params).toString();

    if (signed) {
        // Binance yêu cầu timestamp chính xác, trừ 1000ms để tránh lỗi lệch giờ nhỏ
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
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        // Xử lý lỗi từ Binance API
                        reject(new Error(`Binance API Error ${res.statusCode}: ${parsedData.msg || data}`));
                    } else {
                        resolve(parsedData);
                    }
                } catch (e) {
                    // Lỗi phân tích JSON hoặc dữ liệu không hợp lệ
                    reject(new Error(`Invalid JSON response or API error: ${data} - ${e.message}`));
                }
            });
        });

        req.on('error', reject); // Lỗi mạng
        req.end();
    });
}

// ==================== LOGIC GIAO DỊCH ====================

// Hàm đặt lệnh thực tế lên Binance
async function placeRealOrder(side, quantity) {
    try {
        log(`Đang đặt lệnh ${side} với số lượng ${quantity.toFixed(6)} cho ${config.symbol}...`);
        const order = await binanceRequest('POST', '/fapi/v1/order', {
            symbol: config.symbol,
            side: side,
            type: 'MARKET', // Lệnh thị trường
            quantity: quantity.toFixed(6), // Làm tròn 6 số thập phân
            newOrderRespType: 'FULL' // Nhận phản hồi đầy đủ từ Binance
        }, true);

        // console.log("Phản hồi từ Binance:", order); // Dùng để debug

        if (order && order.status === 'FILLED') {
            log(`✅ Đã khớp lệnh ${side} ${config.symbol} | ID: ${order.orderId} | Khối lượng: ${order.executedQty} | Giá: ${order.avgPrice}`);
            return order; // Trả về thông tin lệnh đã khớp
        } else {
            log(`⚠️ Lệnh ${side} không khớp hoàn toàn hoặc có lỗi: ${order ? JSON.stringify(order) : 'Không có phản hồi'}`);
            return null;
        }
    } catch (error) {
        log(`❌ Lỗi đặt lệnh thực tế: ${error.message}`);
    }
    return null;
}

// Hàm hủy tất cả các lệnh chờ
async function cancelAllOpenOrders() {
    try {
        log(`Đang hủy tất cả các lệnh chờ cũ (nếu có) cho ${config.symbol}...`);
        const response = await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', {
            symbol: config.symbol
        }, true);
        if (response && response.code === 200) {
            log(`Đã hủy các lệnh chờ cũ (nếu có) cho ${config.symbol}.`);
        } else {
            log(`Đã hủy các lệnh chờ cũ (nếu có) cho ${config.symbol}.`); // Binance trả về mảng rỗng nếu không có lệnh nào để hủy, không phải lỗi
        }
    } catch (error) {
        // Lỗi 20011 nếu không có lệnh chờ, không cần log là lỗi nghiêm trọng
        if (error.message.includes('code: 20011')) {
            log(`Không có lệnh chờ nào để hủy cho ${config.symbol}.`);
        } else {
            log(`❌ Lỗi khi hủy các lệnh chờ: ${error.message}`);
        }
    }
}


// Hàm mở giao dịch
async function openTrade() {
    if (!bot.running || bot.position) {
        return; // Không mở giao dịch nếu bot không chạy hoặc đã có vị thế
    }

    try {
        // Hủy các lệnh chờ cũ trước khi mở lệnh mới để tránh xung đột
        await cancelAllOpenOrders();

        // Lấy giá hiện tại
        const ticker = await binanceRequest('GET', '/fapi/v1/ticker/price', { symbol: config.symbol });
        const price = parseFloat(ticker.price);

        // Lấy số dư tài khoản
        const account = await binanceRequest('GET', '/fapi/v2/account', {}, true);
        const usdtBalance = parseFloat(account.availableBalance);

        if (usdtBalance < config.amount) {
            log(`Số dư không đủ để mở lệnh: ${usdtBalance} USDT < ${config.amount} USDT.`);
            bot.running = false; // Dừng bot nếu không đủ số dư
            return;
        }

        // Tính toán số lượng coin dựa trên số tiền và giá
        const quantity = config.amount / price;

        // Đặt lệnh MUA (BUY)
        const order = await placeRealOrder('BUY', quantity);

        if (order) {
            bot.position = {
                symbol: config.symbol,
                entryPrice: parseFloat(order.avgPrice), // Giá khớp lệnh thực tế
                quantity: parseFloat(order.executedQty), // Khối lượng khớp lệnh thực tế
                time: new Date()
            };
            log(`✅ Đã mở lệnh ${config.symbol} | Khối lượng: ${bot.position.quantity.toFixed(6)} | Giá: ${bot.position.entryPrice.toFixed(3)}`);

            // Đặt TP/SL sau khi mở lệnh thành công (ví dụ đơn giản)
            const takeProfitPrice = bot.position.entryPrice * 1.01; // Ví dụ: 1% lợi nhuận
            const stopLossPrice = bot.position.entryPrice * 0.99;   // Ví dụ: 1% lỗ

            log(`TP: ${takeProfitPrice.toFixed(3)}, SL: ${stopLossPrice.toFixed(3)}`);

            // Đặt lệnh SL
            // Binance API không cho phép đặt lệnh Stop Loss và Take Profit cùng lúc cho lệnh MARKET
            // Bạn cần đặt chúng dưới dạng lệnh chờ OCO (One Cancels the Other) hoặc riêng lẻ
            // Dưới đây là ví dụ đặt lệnh Stop Market và Take Profit Limit riêng lẻ.
            // Để đảm bảo an toàn, hãy nghiên cứu kỹ cách Binance Futures xử lý TP/SL.

            // Đặt lệnh Stop Loss (Stop Market Order)
            try {
                const slOrder = await binanceRequest('POST', '/fapi/v1/order', {
                    symbol: config.symbol,
                    side: 'SELL', // Để đóng lệnh MUA ban đầu
                    type: 'STOP_MARKET',
                    quantity: bot.position.quantity.toFixed(6),
                    stopPrice: stopLossPrice.toFixed(3),
                    closePosition: 'true' // Đảm bảo đóng toàn bộ vị thế
                }, true);
                log(`Đã đặt SL cho ${config.symbol} @ ${stopLossPrice.toFixed(3)}. ID: ${slOrder.orderId}`);
            } catch (slError) {
                log(`❌ Lỗi đặt SL: ${slError.message}`);
            }

            // Đặt lệnh Take Profit (Take Profit Market Order)
            try {
                const tpOrder = await binanceRequest('POST', '/fapi/v1/order', {
                    symbol: config.symbol,
                    side: 'SELL', // Để đóng lệnh MUA ban đầu
                    type: 'TAKE_PROFIT_MARKET',
                    quantity: bot.position.quantity.toFixed(6),
                    stopPrice: takeProfitPrice.toFixed(3), // Dùng stopPrice cho lệnh TP_MARKET
                    closePosition: 'true'
                }, true);
                log(`Đã đặt TP cho ${config.symbol} @ ${takeProfitPrice.toFixed(3)}. ID: ${tpOrder.orderId}`);
            } catch (tpError) {
                log(`❌ Lỗi đặt TP: ${tpError.message}`);
            }

        } else {
            log(`Không thể mở lệnh ${config.symbol}.`);
        }
    } catch (error) {
        log(`❌ Lỗi trong quá trình mở giao dịch: ${error.message}`);
    }
}

// Hàm đóng giao dịch
async function closeTrade(reason = 'Không rõ lý do') {
    if (!bot.position) {
        log('Không có vị thế nào để đóng.');
        return;
    }

    try {
        log(`Đang hủy tất cả các lệnh chờ mở cho ${config.symbol} trước khi đóng vị thế...`);
        await cancelAllOpenOrders(); // Hủy các lệnh SL/TP còn chờ

        const quantityToClose = bot.position.quantity;

        // Đặt lệnh BÁN (SELL) để đóng vị thế MUA
        log(`Đang đóng lệnh ${config.symbol} với khối lượng ${quantityToClose.toFixed(6)}...`);
        const closeOrder = await placeRealOrder('SELL', quantityToClose);

        if (closeOrder) {
            const pnl = (parseFloat(closeOrder.avgPrice) - bot.position.entryPrice) * bot.position.quantity;
            bot.stats.net += pnl;
            if (pnl >= 0) {
                bot.stats.profit += pnl;
            } else {
                bot.stats.loss += pnl;
            }

            log(`🔴 Đã đóng lệnh ${config.symbol} | PNL: ${pnl.toFixed(4)} | Lý do: ${reason}`);
            bot.position = null; // Reset vị thế
            return true;
        } else {
            log(`❌ Không thể đóng lệnh ${config.symbol}.`);
            return false;
        }
    } catch (error) {
        log(`❌ Lỗi trong quá trình đóng giao dịch: ${error.message}`);
        return false;
    }
}

// ==================== WEB SERVER ====================
const app = express();
app.use(express.json());
app.use(express.static('public')); // Thư mục chứa file index.html và các tài nguyên tĩnh

// API Cấu hình
app.post('/api/configure', (req, res) => {
    try {
        const { apiKey, secretKey, coinSymbol, initialAmount, applyDoubleStrategy, totalInvestment } = req.body;

        if (!apiKey || !secretKey || !coinSymbol || isNaN(parseFloat(initialAmount))) {
            throw new Error('Thiếu thông tin cấu hình hoặc định dạng không hợp lệ.');
        }

        config = {
            apiKey: apiKey.trim(),
            secretKey: secretKey.trim(),
            symbol: coinSymbol.trim().toUpperCase(),
            amount: parseFloat(initialAmount),
            doubleStrategy: applyDoubleStrategy === 'true', // Chuyển đổi chuỗi thành boolean
            totalInvestment: parseFloat(totalInvestment) || 0 // Đảm bảo là số
        };

        log(`⚙️ Cập nhật cấu hình: ${JSON.stringify(config)}`);
        res.json({ success: true, message: "Cấu hình đã được cập nhật." });

    } catch (error) {
        log(`❌ Lỗi cấu hình: ${error.message}`);
        res.status(400).json({ success: false, error: error.message });
    }
});

// API Điều khiển bot
app.get('/start_bot_logic', (req, res) => {
    if (bot.running) {
        return res.json({ success: false, message: 'Bot đang chạy.' });
    }

    // Kiểm tra cấu hình cần thiết
    if (!config.apiKey || !config.secretKey || !config.symbol || !config.amount) {
        return res.status(400).json({ success: false, message: 'Vui lòng cấu hình API Key, Secret Key, Symbol và Amount trước khi khởi động bot.' });
    }

    bot.running = true;
    log('🚀 Bot đã khởi động');

    // Dừng interval cũ nếu có để tránh chạy nhiều lần
    if (botInterval) clearInterval(botInterval);

    // Bắt đầu giao dịch lặp lại mỗi 5 giây
    botInterval = setInterval(() => {
        if (bot.running) {
            openTrade(); // Hàm này sẽ tự động kiểm tra xem có nên mở lệnh hay không
        } else {
            clearInterval(botInterval); // Dừng interval nếu bot đã dừng
            botInterval = null;
        }
    }, 5000); // Mở lệnh sau mỗi 5 giây (hoặc điều chỉnh theo nhu cầu)

    res.json({ success: true, message: 'Bot đã khởi động.' });
});

app.get('/stop_bot_logic', async (req, res) => {
    if (!bot.running) {
        return res.json({ success: false, message: 'Bot chưa chạy.' });
    }

    bot.running = false;
    if (botInterval) {
        clearInterval(botInterval);
        botInterval = null;
    }

    // Đóng vị thế hiện tại nếu có
    const closed = await closeTrade('Dừng thủ công');
    if (closed) {
        log('🛑 Bot đã dừng và vị thế đã được đóng.');
    } else {
        log('🛑 Bot đã dừng nhưng không thể đóng vị thế hiện tại.');
    }

    res.json({ success: true, message: 'Bot đã dừng.' });
});

// API Trạng thái
app.get('/api/status', (req, res) => {
    res.json({
        running: bot.running,
        position: bot.position,
        stats: bot.stats,
        currentConfig: { // Thêm thông tin cấu hình hiện tại để dễ debug
            symbol: config.symbol,
            amount: config.amount,
            doubleStrategy: config.doubleStrategy,
            totalInvestment: config.totalInvestment
        }
    });
});

// API Logs
app.get('/api/logs', (req, res) => {
    try {
        const logs = fs.readFileSync(LOG_FILE, 'utf-8');
        // Trả về logs dưới dạng HTML hoặc text để dễ đọc trên trình duyệt
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(logs);
    } catch (error) {
        res.status(500).send('Lỗi khi đọc file log: ' + error.message);
    }
});

// Phục vụ file tĩnh (ví dụ: index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); // Đảm bảo index.html nằm trong thư mục 'public'
});

// Khởi chạy server
app.listen(PORT, () => {
    log(`🌐 Server chạy tại http://localhost:${PORT}`);
});
