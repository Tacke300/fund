// severfunding.js (PHIÊN BẢN CCXT - ỔN ĐỊNH & ĐỒNG BỘ)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5000;
const REFRESH_INTERVAL_MINUTES = 5;

let cachedData = {
    lastUpdated: null,
    rates: { bitget: [], bybit: [], okx: [], binance: [] }
};

// Khởi tạo các sàn giao dịch qua CCXT
const exchanges = {
    binance: new ccxt.binanceusdm(),
    bybit: new ccxt.bybit(),
    okx: new ccxt.okx(),
    bitget: new ccxt.bitget()
};

/**
 * Hàm lấy funding rates từ một sàn cụ thể bằng CCXT
 * @param {string} exchangeName - Tên của sàn (vd: 'binance')
 * @returns {Promise<Array>} - Mảng các đối tượng funding rate
 */
async function fetchRatesForExchange(exchangeName) {
    try {
        const exchange = exchanges[exchangeName];
        // CCXT cung cấp một hàm chuẩn hóa để lấy funding rates
        const fundingRates = await exchange.fetchFundingRates();
        
        // Lọc và chuẩn hóa dữ liệu
        return Object.values(fundingRates)
            .filter(rate => rate && typeof rate.fundingRate === 'number' && rate.fundingRate < 0)
            .map(rate => ({
                // CCXT tự động chuẩn hóa symbol (vd: BTC/USDT -> BTCUSDT)
                symbol: rate.symbol.replace('/', ''), 
                fundingRate: rate.fundingRate
            }));
    } catch (e) {
        // Nếu có lỗi, in ra và trả về mảng rỗng
        console.error(`- Lỗi khi lấy dữ liệu từ ${exchangeName.toUpperCase()}: ${e.message}`);
        return [];
    }
}

async function updateFundingRates() {
    console.log(`[${new Date().toISOString()}] Đang cập nhật dữ liệu funding rates bằng CCXT...`);

    // Gọi API đồng thời cho tất cả các sàn
    const results = await Promise.all([
        fetchRatesForExchange('binance'),
        fetchRatesForExchange('bybit'),
        fetchRatesForExchange('okx'),
        fetchRatesForExchange('bitget')
    ]);

    const [binanceRates, bybitRates, okxRates, bitgetRates] = results;
    
    // Sắp xếp và lưu vào cache
    cachedData = {
        lastUpdated: new Date().toISOString(),
        rates: {
            binance: binanceRates.sort((a,b) => a.fundingRate - b.fundingRate),
            bybit: bybitRates.sort((a,b) => a.fundingRate - b.fundingRate),
            okx: okxRates.sort((a,b) => a.fundingRate - b.fundingRate),
            bitget: bitgetRates.sort((a,b) => a.fundingRate - b.fundingRate),
        }
    };
    
    console.log("✅ Cập nhật dữ liệu thành công!");
    console.log(`   - Binance: ${cachedData.rates.binance.length} cặp, Bybit: ${cachedData.rates.bybit.length} cặp, OKX: ${cachedData.rates.okx.length} cặp, Bitget: ${cachedData.rates.bitget.length} cặp.`);
}

// Phần server giữ nguyên, không cần thay đổi
const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Lỗi Server: Không thể đọc file index.html.'); return;
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
