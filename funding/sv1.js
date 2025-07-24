// sv1.js (BẢN TÁI CẤU TRÚC - XỬ LÝ RIÊNG BIỆT & LẤY TẤT CẢ FUNDING)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002; // Giảm ngưỡng để bắt được nhiều cơ hội hơn
const MINIMUM_PNL_THRESHOLD = 15;

// ----- BIẾN TOÀN CỤC -----
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    exchanges[id] = new exchangeClass({ 'options': { 'defaultType': 'swap' } }); // Đảm bảo lấy dữ liệu SWAP/PERP
});

const cleanSymbol = (symbol) => {
    return symbol.replace('/USDT', '').replace(':USDT', '');
};

// ----- CÁC HÀM XỬ LÝ DỮ LIỆU RIÊNG BIỆT CHO TỪNG SÀN -----

// Hàm "chữa cháy" cho Bitget khi không có timestamp
function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = -1;
    for (const hour of fundingHoursUTC) {
        if (now.getUTCHours() < hour) {
            nextHourUTC = hour;
            break;
        }
    }
    const nextFundingDate = new Date(now.getTime());
    nextFundingDate.setUTCHours(nextFundingDate.getUTCHours(), 0, 0, 0);
    if (nextHourUTC !== -1) {
        nextFundingDate.setUTCHours(nextHourUTC);
    } else {
        nextFundingDate.setUTCDate(now.getUTCDate() + 1);
        nextFundingDate.setUTCHours(0);
    }
    return nextFundingDate.getTime();
}

function processCommonData(rawRates, markets, exchangeId) {
    const processedRates = {};
    for (const rate of Object.values(rawRates)) {
        const symbol = cleanSymbol(rate.symbol);
        const marketInfo = markets[rate.symbol];

        // **YÊU CẦU 2: Bỏ điều kiện funding < 0 để lấy tất cả**
        if (rate && typeof rate.fundingRate === 'number' && marketInfo) {
            let timestamp = rate.fundingTimestamp || rate.nextFundingTime || null;

            // Áp dụng logic đặc biệt nếu cần
            if (exchangeId === 'bitget' && !timestamp) {
                timestamp = calculateNextStandardFundingTime();
            }

            processedRates[symbol] = {
                symbol: symbol,
                fundingRate: rate.fundingRate,
                fundingTimestamp: timestamp,
                maxLeverage: marketInfo.limits?.leverage?.max || marketInfo.info?.maxLeverage || 75
            };
        }
    }
    return processedRates;
}

// ----- HÀM ĐIỀU PHỐI VÀ LẤY DỮ LIỆU -----

// **YÊU CẦU 1: Tách logic xử lý, hàm này sẽ điều phối**
async function fetchAndProcessDataForExchange(exchangeId) {
    const exchange = exchanges[exchangeId];
    try {
        await exchange.loadMarkets();
        const fundingRatesRaw = await exchange.fetchFundingRates();

        // Gọi hàm xử lý chung, có thể thêm logic riêng nếu cần sau này
        const processedRates = processCommonData(fundingRatesRaw, exchange.markets, exchangeId);

        return { id: exchangeId, status: 'success', rates: processedRates };
    } catch (e) {
        console.warn(`- Lỗi khi lấy dữ liệu từ ${exchangeId.toUpperCase()}: ${e.constructor.name} - ${e.message}`);
        return { id: exchangeId, status: 'error', rates: {} };
    }
}

async function updateAllData() {
    console.log(`[${new Date().toISOString()}] Bắt đầu cập nhật dữ liệu...`);
    // Gọi hàm điều phối mới
    const results = await Promise.all(EXCHANGE_IDS.map(id => fetchAndProcessDataForExchange(id)));
    results.forEach(result => {
        if (result.status === 'success') {
            exchangeData[result.id] = { rates: result.rates };
        }
    });
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log("✅ Cập nhật dữ liệu thành công!");
}

function calculateArbitrageOpportunities() {
    const opportunities = [];
    const allSymbols = new Set();
    EXCHANGE_IDS.forEach(id => {
        if (exchangeData[id]) Object.keys(exchangeData[id].rates).forEach(symbol => allSymbols.add(symbol));
    });

    allSymbols.forEach(symbol => {
        let bestOpportunityForSymbol = null;

        for (let i = 0; i < EXCHANGE_IDS.length; i++) {
            for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
                const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
                const rate1Data = exchangeData[exchange1Id]?.rates[symbol], rate2Data = exchangeData[exchange2Id]?.rates[symbol];

                if (!rate1Data || !rate2Data) continue;

                // Xác định sàn nào có funding cao hơn (để SHORT) và thấp hơn (để LONG)
                let longExchange, shortExchange, longRate, shortRate;
                if (rate1Data.fundingRate > rate2Data.fundingRate) {
                    shortExchange = exchange1Id;
                    shortRate = rate1Data;
                    longExchange = exchange2Id;
                    longRate = rate2Data;
                } else {
                    shortExchange = exchange2Id;
                    shortRate = rate2Data;
                    longExchange = exchange1Id;
                    longRate = rate1Data;
                }

                // Chênh lệch funding luôn là số dương
                const fundingDiff = shortRate.fundingRate - longRate.fundingRate;

                if (fundingDiff < FUNDING_DIFFERENCE_THRESHOLD) continue;

                const commonLeverage = Math.min(longRate.maxLeverage, shortRate.maxLeverage);
                
                // Phí có thể được tính phức tạp hơn, tạm thời giữ nguyên
                let fee = 0;
                if (commonLeverage <= 25) fee = 5; else if (commonLeverage <= 50) fee = 10; else if (commonLeverage <= 75) fee = 15; else if (commonLeverage <= 100) fee = 20; else if (commonLeverage <= 125) fee = 25; else fee = 30;

                const estimatedPnl = 100 * commonLeverage * fundingDiff - fee;

                if (estimatedPnl <= MINIMUM_PNL_THRESHOLD) continue;

                const currentOpportunity = {
                    coin: symbol,
                    longOn: longExchange.replace('usdm', ''),
                    shortOn: shortExchange.replace('usdm', ''),
                    fundingDiff: parseFloat((fundingDiff * 100).toFixed(4)), // Hiển thị dưới dạng %
                    nextFundingTime: longRate.fundingTimestamp || shortRate.fundingTimestamp,
                    commonLeverage: commonLeverage,
                    estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                };

                if (!bestOpportunityForSymbol || currentOpportunity.estimatedPnl > bestOpportunityForSymbol.estimatedPnl) {
                    bestOpportunityForSymbol = currentOpportunity;
                }
            }
        }
        if (bestOpportunityForSymbol) opportunities.push(bestOpportunityForSymbol);
    });
    arbitrageOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
}


// ----- CÁC HÀM KHỞI ĐỘNG VÀ MÁY CHỦ (giữ nguyên) -----

function masterLoop() {
    setInterval(async () => {
        const now = new Date();
        const currentMinute = now.getMinutes();
        // Chạy liên tục để không bỏ lỡ cơ hội
        // if (currentMinute >= 10 && currentMinute <= 59) {
            console.log(`[${now.toISOString()}] Đang cập nhật và tính toán...`);
            await updateAllData();
            calculateArbitrageOpportunities();
            console.log(`   => Đã tìm thấy ${arbitrageOpportunities.length} cơ hội arbitrage.`);
        // } else {
        //     console.log(`[${now.toISOString()}] Phút ${currentMinute}, ngoài khung giờ hoạt động.`);
        // }
    }, 60 * 1000); // Cập nhật mỗi phút
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); res.end('Lỗi index.html'); return; }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/api/data' && req.method === 'GET') {
        const responseData = {
            lastUpdated: lastFullUpdateTimestamp,
            arbitrageData: arbitrageOpportunities,
            rawRates: {
                binance: Object.values(exchangeData.binanceusdm?.rates || {}),
                bingx: Object.values(exchangeData.bingx?.rates || {}),
                okx: Object.values(exchangeData.okx?.rates || {}),
                bitget: Object.values(exchangeData.bitget?.rates || {}),
            }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu BẢN TÁI CẤU TRÚC đang chạy tại http://localhost:${PORT}`);
    console.log("Khởi động lần đầu, đang lấy dữ liệu...");
    await updateAllData();
    calculateArbitrageOpportunities();
    console.log(`   => Đã tìm thấy ${arbitrageOpportunities.length} cơ hội arbitrage ban đầu.`);
    masterLoop();
});
