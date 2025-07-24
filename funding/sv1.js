// sv1.js (BẢN SỬA LỖI HỒI QUY & CHUẨN HÓA - 24/07/2025)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.003;
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

// Hàm tính toán giờ funding chuẩn cho các sàn không cung cấp nextFundingTime qua API
function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16]; // Các mốc giờ funding phổ biến
    let nextHourUTC = -1;

    for (const hour of fundingHoursUTC) {
        if (now.getUTCHours() < hour) {
            nextHourUTC = hour;
            break;
        }
    }

    const nextFundingDate = new Date(now.getTime());
    nextFundingDate.setUTCMinutes(0, 0, 0); // Reset phút, giây, ms về 0

    if (nextHourUTC !== -1) {
        nextFundingDate.setUTCHours(nextHourUTC);
    } else {
        // Nếu đã qua tất cả các mốc trong ngày, lấy mốc đầu tiên của ngày hôm sau
        nextFundingDate.setUTCDate(now.getUTCDate() + 1);
        nextFundingDate.setUTCHours(fundingHoursUTC[0]);
    }
    return nextFundingDate.getTime();
}

async function fetchExchangeData(exchangeId) {
    const exchange = exchanges[exchangeId];
    try {
        await exchange.loadMarkets();
        const fundingRatesRaw = await exchange.fetchFundingRates();
        const processedRates = {};

        for (const rate of Object.values(fundingRatesRaw)) {
            const symbol = cleanSymbol(rate.symbol);
            const marketInfo = exchange.markets[rate.symbol];

            if (rate && typeof rate.fundingRate === 'number' && rate.fundingRate < 0 && marketInfo) {
                let timestamp;
                let maxLeverage;

                // ===================================================================
                // === ÁP DỤNG LOGIC RIÊNG BIỆT CHO TỪNG SÀN ĐỂ TRÁNH LỖI HỒI QUY ===
                // ===================================================================
                switch (exchangeId) {
                    case 'binanceusdm':
                    case 'okx':
                        // LOGIC GỐC - ĐANG CHẠY TỐT CHO BINANCE & OKX
                        timestamp = rate.nextFundingTime || rate.fundingTimestamp;
                        maxLeverage = marketInfo.limits?.leverage?.max || 25; // Dùng logic cũ, an toàn
                        break;

                    case 'bingx':
                        // LOGIC ĐÚNG DÀNH RIÊNG CHO BINGX
                        timestamp = calculateNextStandardFundingTime(); // BingX không trả về next funding time
                        maxLeverage = parseFloat(marketInfo.info?.leverage_ratio) || 20; // BingX dùng 'leverage_ratio'
                        break;

                    case 'bitget':
                        // LOGIC RIÊNG CHO BITGET
                        timestamp = calculateNextStandardFundingTime(); // Bitget cũng không trả về next funding time
                        maxLeverage = marketInfo.limits?.leverage?.max || parseFloat(marketInfo.info?.maxLeverage) || 20;
                        break;
                        
                    default:
                        // Fallback an toàn cho sàn mới nếu có
                        timestamp = rate.nextFundingTime || calculateNextStandardFundingTime();
                        maxLeverage = marketInfo.limits?.leverage?.max || 20;
                        break;
                }

                processedRates[symbol] = {
                    symbol: symbol,
                    fundingRate: rate.fundingRate,
                    fundingTimestamp: timestamp,
                    maxLeverage: maxLeverage
                };
            }
        }
        return { id: exchangeId, status: 'success', rates: processedRates };
    } catch (e) {
        console.warn(`- Lỗi khi lấy dữ liệu từ ${exchangeId.toUpperCase()}: ${e.constructor.name} - ${e.message}`);
        return { id: exchangeId, status: 'error', rates: {} };
    }
}


// ----- CÁC HÀM CÒN LẠI GIỮ NGUYÊN -----

async function updateAllData() {
    console.log(`[${new Date().toLocaleTimeString()}] Bắt đầu cập nhật dữ liệu...`);
    const results = await Promise.all(EXCHANGE_IDS.map(id => fetchExchangeData(id)));
    
    results.forEach(result => {
        if (result.status === 'success') {
            exchangeData[result.id] = { rates: result.rates };
        }
    });

    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`✅ Cập nhật dữ liệu thành công!`);
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
                const exchange1Id = EXCHANGE_IDS[i];
                const exchange2Id = EXCHANGE_IDS[j];
                const rate1 = exchangeData[exchange1Id]?.rates[symbol];
                const rate2 = exchangeData[exchange2Id]?.rates[symbol];

                if (!rate1 || !rate2) continue;

                const fundingDiff = Math.abs(rate1.fundingRate - rate2.fundingRate);
                if (fundingDiff < FUNDING_DIFFERENCE_THRESHOLD) continue;
                
                const commonLeverage = Math.min(rate1.maxLeverage, rate2.maxLeverage);
                
                let fee = 5;
                if (commonLeverage <= 25) fee = 5;
                else if (commonLeverage <= 50) fee = 10;
                else if (commonLeverage <= 75) fee = 15;
                else if (commonLeverage <= 100) fee = 20;
                else if (commonLeverage <= 125) fee = 25;
                else fee = 30;

                const estimatedPnl = (100 * commonLeverage * fundingDiff) - fee;

                if (estimatedPnl <= MINIMUM_PNL_THRESHOLD) continue;

                const currentOpportunity = {
                    coin: symbol,
                    exchanges: `${exchange1Id.replace('usdm', '')} / ${exchange2Id.replace('usdm', '')}`,
                    nextFundingTime: rate1.fundingTimestamp || rate2.fundingTimestamp,
                    commonLeverage: commonLeverage,
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
            console.log(`[${now.toLocaleTimeString()}] Trong khung giờ hoạt động. Đang cập nhật và tính toán...`);
            await updateAllData();
            calculateArbitrageOpportunities();
            console.log(`   => Đã tìm thấy ${arbitrageOpportunities.length} cơ hội arbitrage.`);
        } else {
            console.log(`[${now.toLocaleTimeString()}] Ngoài khung giờ hoạt động, chờ...`);
        }
    }, 60 * 1000);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Lỗi Server: Không thể đọc file index.html');
                return;
            }
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
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('404 Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ (Bản Sửa Lỗi Hồi Quy) đang chạy tại http://localhost:${PORT}`);
    await updateAllData();
    calculateArbitrageOpportunities();
    masterLoop();
});
