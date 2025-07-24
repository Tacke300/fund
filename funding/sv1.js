// sv1.js (BẢN 3 - SỬA LỖI & TỐI ƯU HÓA)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001; // Sử dụng port 5001 theo yêu cầu

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.003; // 0.3%
const MINIMUM_PNL_THRESHOLD = 15;

// ----- BIẾN TOÀN CỤC -----
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    exchanges[id] = new exchangeClass();
});

const cleanSymbol = (symbol) => {
    return symbol.replace('/USDT', '').replace(':USDT', '');
};

async function fetchExchangeData(exchangeId) {
    const exchange = exchanges[exchangeId];
    try {
        await exchange.loadMarkets();
        const markets = exchange.markets;
        const fundingRatesRaw = await exchange.fetchFundingRates();

        const processedRates = {};
        for (const rate of Object.values(fundingRatesRaw)) {
            const symbol = cleanSymbol(rate.symbol);
            const marketInfo = markets[rate.symbol];

            if (rate && typeof rate.fundingRate === 'number' && rate.fundingRate < 0 && marketInfo) {
                processedRates[symbol] = {
                    symbol: symbol,
                    fundingRate: rate.fundingRate,
                    // Giữ nguyên logic sửa lỗi thời gian funding
                    fundingTimestamp: rate.fundingTimestamp || rate.nextFundingTime,
                    maxLeverage: marketInfo.limits?.leverage?.max || marketInfo.info?.maxLeverage || 75
                };
            }
        }
        return { id: exchangeId, status: 'success', rates: processedRates };
    } catch (e) {
        // Giảm log lỗi không cần thiết, chỉ báo lỗi khi thực sự có vấn đề
        if (e.message.includes('fetchFundingRates')) {
           console.warn(`- Cảnh báo từ ${exchangeId.toUpperCase()}: Không thể lấy funding rates. ${e.message}`);
        } else {
           console.error(`- Lỗi nghiêm trọng từ ${exchangeId.toUpperCase()}: ${e.message}`);
        }
        return { id: exchangeId, status: 'error', rates: {} };
    }
}

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

function calculateArbitrageOpportunities() {
    const opportunities = [];
    const allSymbols = new Set();
    
    EXCHANGE_IDS.forEach(id => {
        if (exchangeData[id]) {
            Object.keys(exchangeData[id].rates).forEach(symbol => allSymbols.add(symbol));
        }
    });

    allSymbols.forEach(symbol => {
        let bestOpportunityForSymbol = null;

        for (let i = 0; i < EXCHANGE_IDS.length; i++) {
            for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
                const exchange1Id = EXCHANGE_IDS[i];
                const exchange2Id = EXCHANGE_IDS[j];

                const rate1 = exchangeData[exchange1Id]?.rates[symbol];
                const rate2 = exchangeData[exchange2Id]?.rates[symbol];

                if (!rate1 || !rate2) continue;

                // ===== SỬA LỖI #1: Bỏ dòng kiểm tra thời gian funding quá chặt chẽ =====
                // Dòng 'if (!rate1.fundingTimestamp || !rate2.fundingTimestamp) continue;' đã được XÓA BỎ.
                // Việc này đảm bảo các cặp vẫn được tính toán dù một trong hai sàn không có dữ liệu thời gian.

                const fundingDiff = Math.abs(rate1.fundingRate - rate2.fundingRate);
                if (fundingDiff < FUNDING_DIFFERENCE_THRESHOLD) continue;
                
                const commonLeverage = Math.min(rate1.maxLeverage, rate2.maxLeverage);

                let fee = 0;
                if (commonLeverage <= 25) fee = 5;
                else if (commonLeverage <= 50) fee = 10;
                else if (commonLeverage <= 75) fee = 15;
                else if (commonLeverage <= 100) fee = 20;
                else if (commonLeverage <= 125) fee = 25;
                else fee = 30;

                const estimatedPnl = 100 * commonLeverage * fundingDiff - fee;
                
                if (estimatedPnl <= MINIMUM_PNL_THRESHOLD) continue;
                
                const currentOpportunity = {
                    coin: symbol,
                    exchanges: `${exchange1Id.replace('usdm', '')} / ${exchange2Id.replace('usdm', '')}`,
                    // ===== SỬA LỖI #2: Ưu tiên lấy thời gian funding có sẵn =====
                    // Sẽ lấy thời gian của rate1, nếu không có sẽ lấy của rate2.
                    nextFundingTime: rate1.fundingTimestamp || rate2.fundingTimestamp || null,
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
    
    arbitrageOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
}

function masterLoop() {
    setInterval(async () => {
        const now = new Date();
        const currentMinute = now.getMinutes();

        if (currentMinute >= 10 && currentMinute <= 59) {
            console.log(`[${now.toISOString()}] Phút ${currentMinute}, trong khung giờ hoạt động. Đang cập nhật và tính toán...`);
            await updateAllData();
            calculateArbitrageOpportunities();
            console.log(`   => Đã tìm thấy ${arbitrageOpportunities.length} cơ hội arbitrage.`);
        } else {
            console.log(`[${now.toISOString()}] Phút ${currentMinute}, ngoài khung giờ hoạt động. Giữ nguyên kết quả cũ.`);
        }
    }, 60 * 1000);
}

// Giữ nguyên phần server và API endpoint
const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) { res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'}); res.end('Lỗi: Không tìm thấy file index.html'); return; }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/api/data' && req.method === 'GET') {
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
    console.log(`✅ Máy chủ dữ liệu BẢN 3 đang chạy tại http://localhost:${PORT}`);
    console.log(`👨‍💻 Giao diện người dùng: http://localhost:${PORT}/`);
    console.log(`🤖 Endpoint dữ liệu: http://localhost:${PORT}/api/data`);
    
    console.log("Đang lấy dữ liệu lần đầu...");
    await updateAllData();
    calculateArbitrageOpportunities();
    console.log("Khởi tạo hoàn tất, bắt đầu vòng lặp chính.");

    masterLoop();
});
