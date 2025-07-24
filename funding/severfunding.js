// severfunding.js (BẢN 9 - CHẾ ĐỘ "BẮT DỮ LIỆU THÔ")

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https'); 
const { URL } = require('url');

const PORT = 5000;
const REFRESH_INTERVAL_MINUTES = 5;

// Hàm fetchData được sửa lại để luôn trả về body dạng text
function fetchDataRaw(url) {
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
                    return reject(new Error(`Yêu cầu thất bại: Mã ${res.statusCode} tại ${url}. Body nhận được: ${body}`));
                }
                // Luôn trả về body dạng text
                resolve(body); 
            });
        });
        req.on('error', (err) => reject(new Error(`Lỗi mạng khi gọi ${url}: ${err.message}`)));
        req.end();
    });
}

// Hàm cập nhật chỉ để in log, không xử lý dữ liệu phức tạp
async function updateFundingRates() {
    console.log(`\n\n[BẮT ĐẦU CHU KỲ BẮT DỮ LIỆU THÔ...]`);
    
    const endpoints = {
        bingx: 'https://open-api.bingx.com/openApi/swap/v2/ticker/fundingRate',
        okx: 'https://www.okx.com/api/v5/public/instruments?instType=SWAP'
    };

    const results = await Promise.allSettled(Object.values(endpoints).map(fetchDataRaw));
    const [bingxRes, okxRes] = results;

    // --- BINGX ---
    console.log(`\n--- DỮ LIỆU THÔ TỪ BINGX ---`);
    if (bingxRes.status === 'rejected') {
        console.error(`[BINGX LỖI] ${bingxRes.reason.message}`);
    } else {
        console.log(`[BINGX BODY]: ${bingxRes.value}`);
    }

    // --- OKX ---
    console.log(`\n--- DỮ LIỆU THÔ TỪ OKX ---`);
    if (okxRes.status === 'rejected') {
        console.error(`[OKX LỖI] ${okxRes.reason.message}`);
    } else {
        console.log(`[OKX BODY]: ${okxRes.value}`);
    }

    console.log(`\n--- KẾT THÚC CHU KỲ BẮT DỮ LIỆU THÔ ---\n`);
}

// Server đơn giản chỉ để chạy hàm update
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: "Debug mode is running. Check PM2 logs." }));
});

server.listen(PORT, async () => {
    console.log(`✅ Server đang chạy ở chế độ "Bắt dữ liệu thô" trên port ${PORT}.`);
    console.log(`   Hãy kiểm tra log của PM2 để xem kết quả.`);
    
    await updateFundingRates();
    setInterval(updateFundingRates, REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
