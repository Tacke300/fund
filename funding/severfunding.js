// severfunding.js (BẢN 7 - CHẾ ĐỘ GỠ LỖI)

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https'); 
const { URL } = require('url');

const PORT = 5000;
const REFRESH_INTERVAL_MINUTES = 5;

let cachedData = {
    lastUpdated: null,
    rates: { binance: [], bingx: [], okx: [], bitget: [] } 
};

// Hàm fetchData cũ, đã chạy tốt -> Giữ nguyên
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
                try { resolve({ body: body, json: JSON.parse(body) }); } catch (e) { reject(new Error(`Lỗi phân tích JSON từ ${url}. Body thô: ${body}`)); }
            });
        });
        req.on('error', (err) => reject(new Error(`Lỗi mạng khi gọi ${url}: ${err.message}`)));
        req.end();
    });
}

// =====================================================
// HÀM CẬP NHẬT TỔNG HỢP VỚI LOG CHI TIẾT
// =====================================================
async function updateFundingRates() {
    console.log(`\n\n[BƯỚC 1] BẮT ĐẦU CHU KỲ CẬP NHẬT DỮ LIỆU...`);
    
    const endpoints = {
        binance: 'https://fapi.binance.com/fapi/v1/premiumIndex',
        bingx: 'https://open-api.bingx.com/openApi/swap/v2/ticker/fundingRate',
        okx: 'https://www.okx.com/api/v5/public/instruments?instType=SWAP', 
        bitget: 'https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl'
    };

    const results = await Promise.allSettled(Object.values(endpoints).map(fetchData));
    const [binanceRes, bingxRes, okxRes, bitgetRes] = results;
    const newData = {};

    console.log(`[BƯỚC 2] ĐÃ GỌI XONG API. BẮT ĐẦU PHÂN TÍCH...`);

    // --- PHÂN TÍCH BINGX ---
    console.log(`\n--- DEBUG BINGX ---`);
    if (bingxRes.status === 'rejected') {
        console.error(`[BINGX LỖI] API call thất bại: ${bingxRes.reason.message}`);
    } else {
        console.log(`[BINGX OK] API call thành công. Phân tích dữ liệu trả về...`);
        console.log(`[BINGX RAW BODY]: ${bingxRes.value.body}`); // IN RA TOÀN BỘ DỮ LIỆU THÔ
        const bingxJson = bingxRes.value.json;
        if (bingxJson && bingxJson.data && Array.isArray(bingxJson.data)) { // Sửa lại đường dẫn
             const bingxData = bingxJson.data;
             newData.bingx = bingxData.map(item => ({ symbol: item.symbol.replace('-', ''), fundingRate: parseFloat(item.fundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);
             console.log(`[BINGX OK] Đã xử lý thành công ${newData.bingx.length} cặp.`);
        } else {
            console.error(`[BINGX LỖI] Cấu trúc dữ liệu không đúng.`);
            newData.bingx = [];
        }
    }

    // --- PHÂN TÍCH OKX ---
    console.log(`\n--- DEBUG OKX ---`);
    if (okxRes.status === 'rejected') {
        console.error(`[OKX LỖI] API call thất bại: ${okxRes.reason.message}`);
    } else {
        console.log(`[OKX OK] API call thành công. Phân tích dữ liệu trả về...`);
        console.log(`[OKX RAW BODY]: ${okxRes.value.body}`); // IN RA TOÀN BỘ DỮ LIỆU THÔ
        const okxJson = okxRes.value.json;
        if (okxJson && Array.isArray(okxJson.data)) {
            const okxData = okxJson.data;
            newData.okx = okxData.map(item => ({ symbol: item.instId.replace('-SWAP', ''), fundingRate: parseFloat(item.fundingRate) })).filter(r => r && r.fundingRate < 0 && r.fundingRate !== 0).sort((a,b) => a.fundingRate - b.fundingRate);
            console.log(`[OKX OK] Đã xử lý thành công ${newData.okx.length} cặp.`);
        } else {
            console.error(`[OKX LỖI] Cấu trúc dữ liệu không đúng.`);
            newData.okx = [];
        }
    }
    console.log(`\n--- KẾT THÚC DEBUG ---\n`);

    // Xử lý Binance và Bitget (đã chạy tốt)
    const binanceData = (binanceRes.status === 'fulfilled' && Array.isArray(binanceRes.value.json)) ? binanceRes.value.json : [];
    newData.binance = binanceData.map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.lastFundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);
    
    const bitgetData = (bitgetRes.status === 'fulfilled' ? bitgetRes.value.json?.data : []) || [];
    newData.bitget = bitgetData.map(item => ({ symbol: item.symbol.replace('_UMCBL', ''), fundingRate: parseFloat(item.fundingRate) })).filter(r => r && r.fundingRate < 0).sort((a,b) => a.fundingRate - b.fundingRate);

    cachedData = {
        lastUpdated: new Date().toISOString(),
        rates: newData
    };
    
    console.log("✅ Cập nhật dữ liệu thành công!");
    console.log(`   - Binance: ${newData.binance.length} cặp, BingX: ${newData.bingx.length} cặp, OKX: ${newData.okx.length} cặp, Bitget: ${newData.bitget.length} cặp.`);
}

// Phần server giữ nguyên
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
