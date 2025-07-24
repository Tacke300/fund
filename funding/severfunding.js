// severfunding.js (PHIÊN BẢN VÁ LỖI CUỐI CÙNG - GIỮ NGUYÊN CODE TỐT, THAY BYBIT -> BINGX, SỬA OKX)

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https'); 
const { URL } = require('url');
const ccxt = require('ccxt'); // Nhập ccxt, chỉ dùng cho OKX

const PORT = 5000;
const REFRESH_INTERVAL_MINUTES = 5;

let cachedData = {
    lastUpdated: null,
    // Cập nhật danh sách sàn
    rates: { binance: [], bingx: [], okx: [], bitget: [] } 
};

// =========================================================================
// PHẦN 1: HÀM fetchData CŨ, ĐÃ CHẠY TỐT -> GIỮ NGUYÊN 100%
// =========================================================================
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
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Yêu cầu thất bại: Mã ${res.statusCode} tại ${url}.`));
                try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Lỗi phân tích JSON từ ${url}.`)); }
            });
        });
        req.on('error', (err) => reject(new Error(`Lỗi mạng khi gọi ${url}: ${err.message}`)));
        req.end();
    });
}

// =============================================================
// PHẦN 2: HÀM CHUYÊN DỤNG DÙNG CCXT CHỈ ĐỂ "BẮN TỈA" OKX
// =============================================================
const okx_exchange = new ccxt.okx();
async function fetchOkxRates() {
    try {
        const fundingRates = await okx_exchange.fetchFundingRates();
        return Object.values(fundingRates)
            .filter(rate => rate && typeof rate.fundingRate === 'number' && rate.fundingRate < 0)
            .map(rate => ({ symbol: rate.symbol.replace('/', ''), fundingRate: rate.fundingRate }));
    } catch (e) {
        console.error(`- Lỗi CCXT khi lấy dữ liệu từ OKX: ${e.message}`);
        return [];
    }
}


// =====================================================
// PHẦN 3: HÀM CẬP NHẬT TỔNG HỢP (KẾT HỢP CẢ HAI CÁCH)
// =====================================================
async function updateFundingRates() {
    console.log(`[${new Date().toISOString()}] Đang cập nhật dữ liệu funding rates...`);
    
    // Các endpoint cho các sàn dùng cách cũ
    const endpoints = {
        binance: 'https://fapi.binance.com/fapi/v1/premiumIndex',
        bingx: 'https://open-api.bingx.com/openApi/swap/v2/ticker/price', // THAY BYBIT -> BINGX
        bitget: 'https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl'
    };

    // Gọi đồng thời: 3 sàn dùng cách cũ, riêng OKX dùng cách mới
    const results = await Promise.allSettled([
        fetchData(endpoints.binance),
        fetchData(endpoints.bingx),
        fetchOkxRates(), // <-- Gọi hàm CCXT đặc trị cho OKX
        fetchData(endpoints.bitget)
    ]);

    const [binanceRes, bingxRes, okxRes, bitgetRes] = results;
    const newData = {};

    // Xử lý Binance (code cũ đã chạy tốt)
    const binanceData = (binanceRes.status === 'fulfilled' && Array.isArray(binanceRes.value)) ? binanceRes.value : [];
    newData.binance = binanceData.map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.lastFundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);

    // Xử lý BingX (thêm mới)
    const bingxData = (bingxRes.status === 'fulfilled' ? bingxRes.value?.data : []) || [];
    newData.bingx = bingxData.map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.fundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);

    // Xử lý OKX (đã được xử lý bởi hàm CCXT)
    newData.okx = (okxRes.status === 'fulfilled' ? okxRes.value : []).sort((a,b) => a.fundingRate - b.fundingRate);
    
    // Xử lý Bitget (code cũ đã chạy tốt + chuẩn hóa tên)
    const bitgetData = (bitgetRes.status === 'fulfilled' ? bitgetRes.value?.data : []) || [];
    newData.bitget = bitgetData.map(item => ({ symbol: item.symbol.replace('_UMCBL', ''), fundingRate: parseFloat(item.fundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);

    cachedData = {
        lastUpdated: new Date().toISOString(),
        rates: newData
    };
    
    console.log("✅ Cập nhật dữ liệu thành công!");
    console.log(`   - Binance: ${newData.binance.length} cặp, BingX: ${newData.bingx.length} cặp, OKX: ${newData.okx.length} cặp, Bitget: ${newData.bitget.length} cặp.`);
}

// =========================================
// PHẦN 4: SERVER (GIỮ NGUYÊN 100%)
// =========================================
const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) { res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'}); res.end('Lỗi: Không tìm thấy file index.html'); return; }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
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
