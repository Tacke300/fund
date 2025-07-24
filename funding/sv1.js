// sv1.js (BẢN SỬA - TƯƠNG THÍCH VỚI HTML GỐC)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 10; // Đặt ngưỡng PNL theo %

// ----- BIẾN TOÀN CỤC -----
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    exchanges[id] = new exchangeClass({ 'options': { 'defaultType': 'swap' } });
});

const cleanSymbol = (symbol) => {
    return symbol.replace('/USDT', '').replace(':USDT', '');
};

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

async function fetchAndProcessDataForExchange(exchangeId) {
    const exchange = exchanges[exchangeId];
    try {
        await exchange.loadMarkets();
        const fundingRatesRaw = await exchange.fetchFundingRates();
        const processedRates = {};

        for (const rate of Object.values(fundingRatesRaw)) {
            const symbol = cleanSymbol(rate.symbol);
            const marketInfo = exchange.markets[rate.symbol];

            if (rate && typeof rate.fundingRate === 'number' && marketInfo) {
                let timestamp = rate.fundingTimestamp || rate.nextFundingTime || null;
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
        return { id: exchangeId, status: 'success', rates: processedRates };
    } catch (e) {
        console.warn(`- Lỗi khi lấy dữ liệu từ ${exchangeId.toUpperCase()}: ${e.constructor.name} - ${e.message}`);
        return { id: exchangeId, status: 'error', rates: {} };
    }
}

async function updateAllData() {
    console.log(`[${new Date().toISOString()}] Bắt đầu cập nhật dữ liệu...`);
    const results = await Promise.all(EXCHANGE_IDS.map(id => fetchAndProcessDataForExchange(id)));
    results.forEach(result => {
        if (result.status === 'success') {
            exchangeData[result.id] = { rates: result.rates };
        }
    });
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log("✅ Cập nhật dữ liệu thành công!");
}

// ===================================================================
// THAY ĐỔI CHÍNH NẰM Ở HÀM DƯỚI ĐÂY
// ===================================================================
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
                
                // Xác định sàn long/short để tạo chuỗi "Cặp Sàn" cho đúng
                let longExchange, shortExchange, longRate, shortRate;
                if (rate1Data.fundingRate > rate2Data.fundingRate) {
                    shortExchange = exchange1Id; shortRate = rate1Data;
                    longExchange = exchange2Id; longRate = rate2Data;
                } else {
                    shortExchange = exchange2Id; shortRate = rate2Data;
                    longExchange = exchange1Id; longRate = rate1Data;
                }

                const fundingDiff = shortRate.fundingRate - longRate.fundingRate;
                if (fundingDiff < FUNDING_DIFFERENCE_THRESHOLD) continue;

                const commonLeverage = Math.min(longRate.maxLeverage, shortRate.maxLeverage);
                
                // Thay đổi ở đây: Tính PNL dưới dạng phần trăm theo công thức: (Chênh lệch Funding) * Đòn bẩy * 100
                const estimatedPnl = fundingDiff * commonLeverage * 100;

                if (estimatedPnl <= MINIMUM_PNL_THRESHOLD) continue;

                // Thay đổi ở đây: Tạo đối tượng theo đúng cấu trúc mà HTML gốc cần
                const currentOpportunity = {
                    coin: symbol,
                    // 1. Tạo lại trường "exchanges" theo định dạng "SHORT_ON / LONG_ON"
                    exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                    // 2. Thêm trường "fundingDiff" để hiển thị ở cột mới
                    fundingDiff: parseFloat(fundingDiff.toFixed(6)),
                    nextFundingTime: longRate.fundingTimestamp || shortRate.fundingTimestamp,
                    commonLeverage: commonLeverage,
                    // 3. PNL bây giờ là %
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
        console.log(`[${new Date().toISOString()}] Đang cập nhật và tính toán...`);
        await updateAllData();
        calculateArbitrageOpportunities();
        console.log(`   => Đã tìm thấy ${arbitrageOpportunities.length} cơ hội arbitrage.`);
    }, 60 * 1000);
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
    console.log(`✅ Máy chủ dữ liệu (Tương thích HTML) đang chạy tại http://localhost:${PORT}`);
    await updateAllData();
    calculateArbitrageOpportunities();
    masterLoop();
});
