// severfunding.js (BẢN 5 - GIẢI PHÁP DỨT ĐIỂM BẰNG CCXT)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt'); // BẮT BUỘC DÙNG THƯ VIỆN CHUYÊN DỤNG

const PORT = 5000;
const REFRESH_INTERVAL_MINUTES = 5;

let cachedData = {
    lastUpdated: null,
    rates: { binance: [], bingx: [], okx: [], bitget: [] } 
};

// Khởi tạo các sàn giao dịch qua CCXT
const exchanges = {
    binance: new ccxt.binanceusdm(),
    bingx: new ccxt.bingx(), 
    okx: new ccxt.okx(),
    bitget: new ccxt.bitget()
};

/**
 * Hàm lấy funding rates từ một sàn cụ thể bằng CCXT
 * @param {string} exchangeName - Tên của sàn
 * @returns {Promise<Array>} - Mảng dữ liệu funding rate đã được chuẩn hóa
 */
async function fetchRatesForExchange(exchangeName) {
    try {
        const exchange = exchanges[exchangeName];
        // CCXT cung cấp một hàm chuẩn hóa để lấy funding rates
        const fundingRates = await exchange.fetchFundingRates();
        
        return Object.values(fundingRates)
            .filter(rate => rate && typeof rate.fundingRate === 'number' && rate.fundingRate < 0)
            .map(rate => ({
                // CCXT tự động chuẩn hóa symbol, ta chỉ cần bỏ dấu "/"
                symbol: rate.symbol.replace('/', ''), 
                fundingRate: rate.fundingRate
            }));
    } catch (e) {
        // Nếu có lỗi, in ra và trả về mảng rỗng
        console.error(`- Lỗi CCXT khi lấy dữ liệu từ ${exchangeName.toUpperCase()}: ${e.message}`);
        return [];
    }
}

async function updateFundingRates() {
    console.log(`[${new Date().toISOString()}] Đang cập nhật dữ liệu bằng CCXT...`);

    const exchangeKeys = Object.keys(exchanges);

    // Gọi API đồng thời cho tất cả các sàn
    const results = await Promise.all(
        exchangeKeys.map(key => fetchRatesForExchange(key))
    );

    const newRates = {};
    exchangeKeys.forEach((key, index) => {
        newRates[key] = results[index].sort((a,b) => a.fundingRate - b.fundingRate);
    });
    
    cachedData = {
        lastUpdated: new Date().toISOString(),
        rates: newRates
    };
    
    console.log("✅ Cập nhật dữ liệu thành công!");
    console.log(`   - Binance: ${cachedData.rates.binance.length} cặp, BingX: ${cachedData.rates.bingx.length} cặp, OKX: ${cachedData.rates.okx.length} cặp, Bitget: ${cachedData.rates.bitget.length} cặp.`);
}

// Phần server giữ nguyên, không cần thay đổi
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
