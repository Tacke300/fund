// sv1.js (BẢN CUỐI CÙNG - SỬA LỖI TÍNH TOÁN & GIỮ NGUYÊN TÍNH NĂNG)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
// YÊU CẦU 1: CỨ TRÊN 15% LÀ HIỂN THỊ
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15; // Ngưỡng để kích hoạt hiệu ứng nhấp nháy

// ----- BIẾN TOÀN CỤC -----
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    exchanges[id] = new exchangeClass({ 'options': { 'defaultType': 'swap' } });
});

const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '');

// Hàm tính toán thời gian chuẩn (dùng làm phương án dự phòng)
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
        // Bỏ qua lỗi timeout của BingX để không spam console
        if (!(exchangeId === 'bingx' && e instanceof ccxt.RequestTimeout)) {
            console.warn(`- Lỗi khi lấy dữ liệu từ ${exchangeId.toUpperCase()}: ${e.constructor.name} - ${e.message}`);
        }
        return { id: exchangeId, status: 'error', rates: {} };
    }
}

async function updateAllData() {
    console.log(`[${new Date().toISOString()}] Bắt đầu cập nhật dữ liệu...`);
    const results = await Promise.all(EXCHANGE_IDS.map(id => fetchAndProcessDataForExchange(id)));
    exchangeData = {};
    results.forEach(result => {
        if (result.status === 'success') {
            exchangeData[result.id] = { rates: result.rates };
        }
    });
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log("✅ Cập nhật dữ liệu thành công!");
}

// YÊU CẦU 2: HÀM LOGIC LẤY THỜI GIAN FUNDING ƯU TIÊN (ĐÃ SỬA LẠI CHO CHÍNH XÁC)
function getAuthoritativeFundingTime(symbol) {
    const binanceTime = exchangeData.binanceusdm?.rates[symbol]?.fundingTimestamp;
    const okxTime = exchangeData.okx?.rates[symbol]?.fundingTimestamp;

    // Ưu tiên 1: Nếu có cả Binance và OKX, lấy thời gian xa hơn (an toàn hơn)
    if (binanceTime && okxTime) return Math.max(binanceTime, okxTime);
    // Ưu tiên 2: Nếu chỉ có 1 trong 2, lấy cái đó
    if (binanceTime) return binanceTime;
    if (okxTime) return okxTime;
    // Ưu tiên 3: Nếu không có cả 2, tính thời gian chuẩn
    return calculateNextStandardFundingTime();
}

// === PHẦN QUAN TRỌNG NHẤT: LOGIC TÍNH TOÁN ĐÃ ĐƯỢC KHÔI PHỤC VÀ NÂNG CẤP ĐÚNG CÁCH ===
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

                // --- BƯỚC 1: TÍNH TOÁN CƠ BẢN (LOGIC ỔN ĐỊNH GỐC) ---
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
                const estimatedPnl = fundingDiff * commonLeverage * 100;

                // --- BƯỚC 2: LỌC THEO NGƯỠNG PNL (YÊU CẦU 1) ---
                if (estimatedPnl <= MINIMUM_PNL_THRESHOLD) continue;
                
                // --- BƯỚC 3: SAU KHI ĐÃ CÓ CƠ HỘI HỢP LỆ, ÁP DỤNG CÁC LOGIC NÂNG CAO ---
                
                // Áp dụng logic thời gian ưu tiên (Yêu cầu 2)
                const finalFundingTime = getAuthoritativeFundingTime(symbol);

                // Đánh dấu cơ hội sắp tới (Để làm hiệu ứng nhấp nháy)
                const minutesUntilFunding = (finalFundingTime - Date.now()) / (1000 * 60);
                const isImminent = minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES;

                const currentOpportunity = {
                    coin: symbol,
                    exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                    fundingDiff: parseFloat(fundingDiff.toFixed(6)),
                    nextFundingTime: finalFundingTime,
                    commonLeverage: commonLeverage,
                    estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                    isImminent: isImminent,
                };

                // Tìm cơ hội tốt nhất cho symbol này
                if (!bestOpportunityForSymbol || currentOpportunity.estimatedPnl > bestOpportunityForSymbol.estimatedPnl) {
                    bestOpportunityForSymbol = currentOpportunity;
                }
            }
        }
        if (bestOpportunityForSymbol) {
            opportunities.push(bestOpportunityForSymbol);
        }
    });
    
    // YÊU CẦU 3: SẮP XẾP 2 CẤP ĐỘ
    arbitrageOpportunities = opportunities.sort((a, b) => {
        if (a.nextFundingTime < b.nextFundingTime) return -1;
        if (a.nextFundingTime > b.nextFundingTime) return 1;
        return b.estimatedPnl - a.estimatedPnl;
    });
}


// ----- CÁC HÀM KHỞI ĐỘNG VÀ MÁY CHỦ (Không thay đổi) -----
function masterLoop() {
    setInterval(async () => {
        console.log(`[${new Date().toISOString()}] Đang cập nhật và tính toán...`);
        await updateAllData();
        calculateArbitrageOpportunities();
        console.log(`   => Tìm thấy ${arbitrageOpportunities.length} cơ hội arbitrage thỏa mãn điều kiện.`);
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
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi) đang chạy tại http://localhost:${PORT}`);
    await updateAllData();
    calculateArbitrageOpportunities();
    masterLoop();
});
