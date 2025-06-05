const express = require('express');
const https = require('https');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const app = express();
const PORT = 1234;

app.use(bodyParser.json());
app.use(express.static('.')); // Để phục vụ tệp HTML từ thư mục hiện tại

let API_KEY = ''; // Thay thế bằng API Key của bạn
let SECRET_KEY = ''; // Thay thế bằng Secret Key của bạn
let botRunning = false; // Trạng thái bot
let currentOpenPosition = null; // Vị thế đang mở

// Hàm tạo chữ ký cho API
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                 .update(queryString)
                 .digest('hex');
}

// Hàm gửi yêu cầu HTTP
async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            path: path,
            method: method,
            headers: headers,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(`HTTP Error: ${res.statusCode} ${res.statusMessage}`);
                }
            });
        });

        req.on('error', (e) => {
            reject(e.message);
        });

        if (method === 'POST' && postData) {
            req.write(postData);
        }
        req.end();
    });
}

// Hàm gọi API Binance đã ký
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        throw new Error("API Key hoặc Secret Key chưa được cấu hình.");
    }

    const recvWindow = 5000;
    const timestamp = Date.now();

    let queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
    const headers = {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest(method, 'fapi.binance.com', requestPath, headers);
        return JSON.parse(rawData);
    } catch (error) {
        throw error; // Ném lại lỗi để caller xử lý
    }
}

// Hàm gọi API Binance công khai
async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params)
                              .map(key => `${key}=${params[key]}`)
                              .join('&');
    const fullPathWithQuery = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');

    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest('GET', 'fapi.binance.com', fullPathWithQuery, headers);
        return JSON.parse(rawData);
    } catch (error) {
        throw error; // Ném lỗi để caller xử lý
    }
}

// Hàm đồng bộ thời gian với server Binance
async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        console.log(`Đồng bộ thời gian thành công: ${data.serverTime}`);
    } catch (error) {
        console.error(`Lỗi đồng bộ thời gian: ${error.message}.`);
    }
}

// Hàm để mở lệnh
async function openPosition(symbol, tradeDirection) {
    if (currentOpenPosition) {
        console.log(`Đã có vị thế mở (${currentOpenPosition.symbol}). Bỏ qua mở lệnh mới cho ${symbol}.`); 
        return;
    }

    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) {
        console.log(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
        return;
    }

    let quantity = 1; // Số lượng có thể điều chỉnh theo logic của bạn
    const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: orderSide,
            type: 'MARKET',
            quantity: quantity
        });
        currentOpenPosition = { symbol: symbol, side: tradeDirection };
        console.log(`Đã mở ${tradeDirection} ${symbol} với số lượng ${quantity}.`);
    } catch (error) {
        console.error(`Lỗi khi mở lệnh ${tradeDirection} cho ${symbol}: ${error.message}`);
    }
}

// Lấy giá hiện tại của một symbol
async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        return parseFloat(data.price);
    } catch (error) {
        console.error(`Lỗi lấy giá hiện tại cho ${symbol}: ${error.message}`);
        return null;
    }
}

// Endpoint lưu cấu hình cho bot
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey } = req.body;

    if (apiKey && secretKey) {
        API_KEY = apiKey;
        SECRET_KEY = secretKey;
        return res.json({ success: true, message: 'Cấu hình đã được lưu thành công.' });
    }

    return res.json({ success: false, message: 'API Key và Secret Key không hợp lệ.' });
});

// Điều khiển bot (start/stop)
app.get('/start_bot_logic', (req, res) => {
    syncServerTime(); // Đồng bộ thời gian mỗi khi khởi động bot
    botRunning = true; // Cập nhật trạng thái bot
    // Bắt đầu logic kinh doanh của bạn ở đây...
    console.log('Bot đã khởi động!');
    return res.send('Bot đã khởi động!');
});

app.get('/stop_bot_logic', (req, res) => {
    botRunning = false; // Cập nhật trạng thái bot
    console.log('Bot đã dừng lại.');
    return res.send('Bot đã dừng lại.');
});

// Bắt đầu server
app.listen(PORT, () => {
    console.log(`Server đang chạy trên cổng ${PORT}`);
});
