// severfunding.js (BẢN SỬA LỖI CUỐI CÙNG - GIỮ NGUYÊN BINANCE/BYBIT, SỬA OKX/BITGET)

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https'); 
const { URL } = require('url'); 

const PORT = 5000;
const REFRESH_INTERVAL_MINUTES = 5;

let cachedData = {
    lastUpdated: null,
    rates: { bitget: [], bybit: [], okx: [], binance: [] }
};

function fetchData(url) {
    return new Promise((resolve, reject) => {
        const urlObject = new URL(url);
        const options = {
            hostname: urlObject.hostname,
            path: urlObject.pathname + urlObject.search,
            method: 'GET',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
            }
        };
        
        const req = https.get(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`Yêu cầu thất bại: Mã ${res.statusCode} tại ${url}.`));
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Lỗi phân tích JSON từ ${url}.`));
                }
            });
        });
        req.on('error', (err) => reject(new Error(`Lỗi mạng khi gọi ${url}: ${err.message}`)));
        req.end();
    });
}

async function updateFundingRates() {
    console.log(`[${new Date().toISOString()}] Đang cập nhật dữ liệu funding rates...`);
    
    // Sử dụng endpoint tickers cho OKX và Bitget, giữ nguyên endpoint cũ cho Binance/Bybit
    const endpoints = {
        binance: 'https://fapi.binance.com/fapi/v1/premiumIndex',
        bybit: 'https://api.bybit.com/v5/market/tickers?category=linear',
        okx: 'https://www.okx.com/api/v5/market/tickers?instType=SWAP', 
        bitget: 'https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl'
    };

    const results = await Promise.allSettled(Object.values(endpoints).map(fetchData));
    const [binanceRes, bybitRes, okxRes, bitgetRes] = results;

    const newData = {};

    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            const exchangeName = Object.keys(endpoints)[index];
            console.error(`- Lỗi khi lấy dữ liệu từ ${exchangeName}: ${result.reason.message}`);
        }
    });

    // Xử lý Binance
    const binanceData = (binanceRes.status === 'fulfilled' && Array.isArray(binanceRes.value)) ? binanceRes.value : [];
    newData.binance = binanceData.map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.lastFundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);

    // Xử lý Bybit
    const bybitData = (bybitRes.status === 'fulfilled' ? bybitRes.value?.result?.list : []) || [];
    newData.bybit = bybitData.map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.fundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);

    // Xử lý OKX (theo cấu trúc của endpoint /tickers)
    const okxData = (okxRes.status === 'fulfilled' ? okxRes.value?.data : []) || [];
    newData.okx = okxData.map(item => ({ symbol: item.instId, fundingRate: parseFloat(item.fundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);
    
    // Xử lý Bitget (theo cấu trúc của endpoint /tickers)
    const bitgetData = (bitgetRes.status === 'fulfilled' ? bitgetRes.value?.data : []) || [];
    newData.bitget = bitgetData.map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.fundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);

    cachedData = {
        lastUpdated: new Date().toISOString(),
        rates: newData
    };
    
    console.log("✅ Cập nhật dữ liệu thành công!");
    console.log(`   - Binance: ${newData.binance.length} cặp, Bybit: ${newData.bybit.length} cặp, OKX: ${newData.okx.length} cặp, Bitget: ${newData.bitget.length} cặp.`);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Lỗi Server: Không thể đọc file index.html.');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
    } else if (req.url === '/api/rates' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cachedData));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    console.log(`👨‍💻 Giao diện người dùng: http://localhost:${PORT}/`);
    console.log(`🤖 Endpoint cho bot: http://localhost:${PORT}/api/rates`);
    
    await updateFundingRates();
    
    setInterval(updateFundingRates, REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
