// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('httpss'); // Sử dụng module https gốc

const PORT = 3000;
const REFRESH_INTERVAL_MINUTES = 5; // Tự động cập nhật dữ liệu sau mỗi 5 phút

// Biến lưu trữ dữ liệu (hoạt động như một bộ nhớ đệm - cache)
let cachedData = {
    lastUpdated: null,
    rates: {
        bitget: [],
        bybit: [],
        okx: [],
        binance: []
    }
};

/**
 * Hàm tiện ích để thực hiện yêu cầu GET bằng module https gốc.
 * @param {string} url - URL để yêu cầu.
 * @returns {Promise<any>} - Promise với dữ liệu JSON.
 */
function fetchData(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`Yêu cầu thất bại với mã trạng thái: ${res.statusCode}`));
            }
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        }).on('error', (err) => reject(err));
    });
}

/**
 * Hàm chính để lấy và xử lý dữ liệu từ tất cả các sàn.
 */
async function updateFundingRates() {
    console.log(`[${new Date().toISOString()}] Đang cập nhật dữ liệu funding rates...`);
    
    const endpoints = {
        bitget: 'https://api.bitget.com/api/mix/v1/market/contracts?productType=umcbl',
        bybit: 'https://api.bybit.com/v5/market/tickers?category=linear',
        okx: 'https://www.okx.com/api/v5/public/funding-rate?instType=SWAP',
        binance: 'https://fapi.binance.com/fapi/v1/premiumIndex',
    };

    const results = await Promise.allSettled([
        fetchData(endpoints.bitget),
        fetchData(endpoints.bybit),
        fetchData(endpoints.okx),
        fetchData(endpoints.binance)
    ]);
    
    const newData = {};

    // Xử lý dữ liệu từng sàn và lọc funding âm
    newData.binance = results[0].status === 'fulfilled' ? (results[0].value || []).map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.lastFundingRate) })).filter(r => r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate) : [];
    newData.bybit = results[1].status === 'fulfilled' ? (results[1].value.result?.list || []).map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.fundingRate) })).filter(r => r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate) : [];
    newData.okx = results[2].status === 'fulfilled' ? (results[2].value.data || []).map(item => ({ symbol: item.instId, fundingRate: parseFloat(item.fundingRate) })).filter(r => r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate) : [];
    newData.bitget = results[3].status === 'fulfilled' ? (results[3].value.data || []).map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.fundingRate) })).filter(r => r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate) : [];

    // Cập nhật bộ nhớ đệm
    cachedData = {
        lastUpdated: new Date().toISOString(),
        rates: newData
    };
    
    console.log("✅ Cập nhật dữ liệu thành công!");
}


// --- Tạo Máy chủ HTTP ---
const server = http.createServer((req, res) => {
    // Định tuyến yêu cầu
    if (req.url === '/' && req.method === 'GET') {
        // --- PHỤC VỤ TRANG HTML CHO NGƯỜI DÙNG ---
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });

    } else if (req.url === '/api/rates' && req.method === 'GET') {
        // --- CUNG CẤP DỮ LIỆU JSON CHO BOT ---
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cachedData));
        
    } else {
        // Xử lý các yêu cầu khác (lỗi 404)
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
    }
});


// --- Khởi động Máy chủ và Lên lịch cập nhật ---
server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    console.log(`👨‍💻 Giao diện người dùng: http://localhost:${PORT}/`);
    console.log(`🤖 Endpoint cho bot: http://localhost:${PORT}/api/rates`);
    
    // 1. Chạy cập nhật lần đầu tiên ngay khi server khởi động
    await updateFundingRates();
    
    // 2. Lên lịch cập nhật định kỳ
    setInterval(updateFundingRates, REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
