// severfunding.js (BẢN 11 - TÍCH HỢP LOGIC ARBITRAGE)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001;

// ----- CẤU HÌNH -----
// Các sàn sẽ được sử dụng
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];

// Ngưỡng chênh lệch funding để kích hoạt tính toán (%pnl)
const FUNDING_DIFFERENCE_THRESHOLD = 0.003; // 0.3%

// Ngưỡng %pnl ước tính tối thiểu để hiển thị
const MINIMUM_PNL_THRESHOLD = 15;

// ----- BIẾN TOÀN CỤC -----
let exchangeData = {}; // Lưu trữ dữ liệu từ các sàn (markets, funding rates)
let arbitrageOpportunities = []; // Lưu kết quả tính toán arbitrage
let lastFullUpdateTimestamp = null;

// Khởi tạo các đối tượng sàn CCXT
const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    // CCXT v4 yêu cầu 'new (ccxt[id])()'
    const exchangeClass = ccxt[id];
    exchanges[id] = new exchangeClass();
});

// Hàm dọn dẹp tên biểu tượng (symbol)
const cleanSymbol = (symbol) => {
    return symbol.replace('/USDT', '').replace(':USDT', '');
};

/**
 * Hàm lấy dữ liệu funding rates và thông tin thị trường từ một sàn.
 * @param {string} exchangeId - ID của sàn (ví dụ: 'binanceusdm')
 * @returns {Promise<Object>} - Dữ liệu của sàn
 */
async function fetchExchangeData(exchangeId) {
    const exchange = exchanges[exchangeId];
    try {
        // Tải thông tin thị trường (bao gồm maxLeverage)
        await exchange.loadMarkets();
        const markets = exchange.markets;

        // Lấy funding rates
        const fundingRatesRaw = await exchange.fetchFundingRates();

        const processedRates = {};
        for (const rate of Object.values(fundingRatesRaw)) {
            const symbol = cleanSymbol(rate.symbol);
            const marketInfo = markets[rate.symbol];

            if (rate && typeof rate.fundingRate === 'number' && rate.fundingRate < 0 && marketInfo) {
                processedRates[symbol] = {
                    symbol: symbol,
                    fundingRate: rate.fundingRate,
                    fundingTimestamp: rate.fundingTimestamp,
                    // Lấy max leverage, một số sàn có cấu trúc khác nhau
                    maxLeverage: marketInfo.limits?.leverage?.max || marketInfo.info?.maxLeverage || 75 // Mặc định 75 nếu không tìm thấy
                };
            }
        }
        return { id: exchangeId, status: 'success', rates: processedRates, markets: markets };
    } catch (e) {
        console.error(`- Lỗi khi lấy dữ liệu từ ${exchangeId.toUpperCase()}: ${e.message}`);
        return { id: exchangeId, status: 'error', rates: {}, markets: {} };
    }
}

/**
 * Cập nhật dữ liệu từ tất cả các sàn.
 */
async function updateAllData() {
    console.log(`[${new Date().toISOString()}] Bắt đầu cập nhật dữ liệu funding rates...`);
    const results = await Promise.all(EXCHANGE_IDS.map(id => fetchExchangeData(id)));

    results.forEach(result => {
        if (result.status === 'success') {
            exchangeData[result.id] = { rates: result.rates };
        }
    });
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log("✅ Cập nhật dữ liệu funding thành công!");
}


/**
 * Logic tính toán cơ hội Arbitrage theo 6 bước.
 */
function calculateArbitrageOpportunities() {
    const opportunities = [];
    const allSymbols = new Set();
    
    // Thu thập tất cả các symbol duy nhất trên các sàn
    EXCHANGE_IDS.forEach(id => {
        if (exchangeData[id]) {
            Object.keys(exchangeData[id].rates).forEach(symbol => allSymbols.add(symbol));
        }
    });

    // Bước 1 -> 5: Lặp qua từng symbol và từng cặp sàn
    allSymbols.forEach(symbol => {
        let bestOpportunityForSymbol = null;

        for (let i = 0; i < EXCHANGE_IDS.length; i++) {
            for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
                const exchange1Id = EXCHANGE_IDS[i];
                const exchange2Id = EXCHANGE_IDS[j];

                const rate1 = exchangeData[exchange1Id]?.rates[symbol];
                const rate2 = exchangeData[exchange2Id]?.rates[symbol];

                // Yêu cầu coin phải có trên cả 2 sàn
                if (!rate1 || !rate2) continue;

                // Bước 1: Tính chênh lệch funding
                const fundingDiff = Math.abs(rate1.fundingRate - rate2.fundingRate);
                if (fundingDiff < FUNDING_DIFFERENCE_THRESHOLD) continue;
                
                // Bước 2: Tính max lev chung (lấy giá trị nhỏ hơn)
                const commonLeverage = Math.min(rate1.maxLeverage, rate2.maxLeverage);

                // Bước 3: Tính phí dựa trên đòn bẩy chung
                let fee = 0;
                if (commonLeverage <= 25) fee = 5;
                else if (commonLeverage <= 50) fee = 10;
                else if (commonLeverage <= 75) fee = 15;
                else if (commonLeverage <= 100) fee = 20;
                else if (commonLeverage <= 125) fee = 25;
                else fee = 30; // Cho các trường hợp > 125

                // Bước 4: Áp dụng công thức tính %pnl ước tính
                // Chú ý: fundingRate là số âm, diff là số dương.
                const estimatedPnl = 100 * commonLeverage * fundingDiff - fee;
                
                // Kiểm tra điều kiện PNL
                if (estimatedPnl <= MINIMUM_PNL_THRESHOLD) continue;
                
                // Bước 5: Chọn cặp sàn có PNL cao nhất cho coin này
                const currentOpportunity = {
                    coin: symbol,
                    exchanges: `${exchange1Id.split('usdm')[0]} / ${exchange2Id.split('usdm')[0]}`,
                    nextFundingTime: rate1.fundingTimestamp, // Giả sử thời gian funding là như nhau
                    estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                };

                if (!bestOpportunityForSymbol || currentOpportunity.estimatedPnl > bestOpportunityForSymbol.estimatedPnl) {
                    bestOpportunityForSymbol = currentOpportunity;
                }
            }
        }
        
        if (bestOpportunityForSymbol) {
            opportunities.push(bestOpportunityForSymbol);
        }
    });
    
    // Bước 6: Sắp xếp kết quả theo PnL từ cao đến thấp
    arbitrageOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
}


/**
 * Vòng lặp chính để kiểm soát thời gian tính toán
 */
function masterLoop() {
    setInterval(async () => {
        const now = new Date();
        const currentMinute = now.getMinutes();

        // Chỉ tính toán từ phút 10 đến 59
        if (currentMinute >= 10 && currentMinute <= 59) {
            console.log(`[${now.toISOString()}] Phút ${currentMinute}, trong khung giờ hoạt động. Đang cập nhật và tính toán...`);
            await updateAllData(); // Cập nhật dữ liệu mới nhất
            calculateArbitrageOpportunities(); // Tính toán lại
            console.log(`   => Đã tìm thấy ${arbitrageOpportunities.length} cơ hội arbitrage.`);
        } else {
            // Ngoài khung giờ, giữ nguyên kết quả của phút 59
            console.log(`[${now.toISOString()}] Phút ${currentMinute}, ngoài khung giờ hoạt động. Đang chờ...`);
        }
    }, 60 * 1000); // Chạy mỗi phút
}

// ----- KHỞI TẠO SERVER HTTP -----
const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) { res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'}); res.end('Lỗi: Không tìm thấy file index.html'); return; }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/api/data' && req.method === 'GET') {
        // Trả về cấu trúc dữ liệu mới
        const responseData = {
            lastUpdated: lastFullUpdateTimestamp,
            arbitrageData: arbitrageOpportunities,
            rawRates: {
                binance: Object.values(exchangeData.binanceusdm?.rates || {}).sort((a,b) => a.fundingRate - b.fundingRate),
                bingx: Object.values(exchangeData.bingx?.rates || {}).sort((a,b) => a.fundingRate - b.fundingRate),
                okx: Object.values(exchangeData.okx?.rates || {}).sort((a,b) => a.fundingRate - b.fundingRate),
                bitget: Object.values(exchangeData.bitget?.rates || {}).sort((a,b) => a.fundingRate - b.fundingRate),
            }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    console.log(`👨‍💻 Giao diện người dùng: http://localhost:${PORT}/`);
    console.log(`🤖 Endpoint dữ liệu: http://localhost:${PORT}/api/data`);
    
    // Chạy lần đầu để có dữ liệu ngay lập tức
    console.log("Đang lấy dữ liệu lần đầu...");
    await updateAllData();
    calculateArbitrageOpportunities();
    console.log("Khởi tạo hoàn tất, bắt đầu vòng lặp chính.");

    // Bắt đầu vòng lặp chính
    masterLoop();
});
