// sv1.js (BẢN TỐI ƯU - CACHE ĐÒN BẨY & DỮ LIỆU CHÍNH XÁC)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_HOURS = 6;

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {}; // BỘ NHỚ ĐỆM CHO ĐÒN BẨY
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    exchanges[id] = new exchangeClass({ 'options': { 'defaultType': 'swap' } });
});

const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '');

// === LOGIC MỚI: QUẢN LÝ BỘ NHỚ ĐỆM ĐÒN BẨY ===
async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            await exchange.loadMarkets(true); // Tải lại market để có dữ liệu mới nhất
            newCache[id] = {};
            for (const market of Object.values(exchange.markets)) {
                if (market.swap && market.quote === 'USDT') {
                    const symbol = cleanSymbol(market.symbol);
                    // YÊU CẦU 1: Nếu không thấy maxLev, để là NULL
                    const maxLeverage = market.limits?.leverage?.max || market.info?.maxLeverage || null;
                    newCache[id][symbol] = maxLeverage;
                }
            }
            console.log(`[CACHE] ✅ Đã cache thành công đòn bẩy cho ${id.toUpperCase()}`);
        } catch (e) {
            console.warn(`[CACHE] ❌ Lỗi khi cache đòn bẩy cho ${id.toUpperCase()}: ${e.message}`);
        }
    }));
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
}


// === VÒNG LẶP CHÍNH SIÊU NHẸ ===
async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const results = await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            // Chỉ lấy funding rate, không load market ở đây nữa
            const fundingRatesRaw = await exchange.fetchFundingRates(); 
            const processedRates = {};
            for (const rate of Object.values(fundingRatesRaw)) {
                const symbol = cleanSymbol(rate.symbol);
                // Tra cứu đòn bẩy từ cache
                const maxLeverage = leverageCache[id]?.[symbol];

                // YÊU CẦU 2: Chỉ xử lý nếu coin có dữ liệu đòn bẩy
                if (maxLeverage !== undefined) { 
                     processedRates[symbol] = {
                        symbol: symbol,
                        fundingRate: rate.fundingRate,
                        fundingTimestamp: rate.fundingTimestamp || rate.nextFundingTime,
                        maxLeverage: maxLeverage // Lấy từ cache
                    };
                }
            }
            return { id, status: 'success', rates: processedRates };
        } catch (e) {
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) {
                console.warn(`- Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}`);
            }
            return { id, status: 'error', rates: {} };
        }
    }));
    
    results.forEach(result => {
        if (result.status === 'success') {
            freshData[result.id] = { rates: result.rates };
        }
    });
    return freshData;
}

// Hàm chuẩn hóa thời gian (đã tối ưu)
function standardizeFundingTimes(data) {
    const allSymbols = new Set();
    Object.values(data).forEach(ex => {
        if (ex.rates) Object.keys(ex.rates).forEach(symbol => allSymbols.add(symbol));
    });

    const authoritativeTimes = {};
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    
    allSymbols.forEach(symbol => {
        const binanceTime = data.binanceusdm?.rates[symbol]?.fundingTimestamp;
        const okxTime = data.okx?.rates[symbol]?.fundingTimestamp;

        if (binanceTime && okxTime) authoritativeTimes[symbol] = Math.max(binanceTime, okxTime);
        else if (binanceTime) authoritativeTimes[symbol] = binanceTime;
        else if (okxTime) authoritativeTimes[symbol] = okxTime;
        else { // Tính toán mặc định
             let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h) ?? fundingHoursUTC[0];
             const nextFundingDate = new Date(now);
             nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
             if(now.getUTCHours() >= fundingHoursUTC[fundingHoursUTC.length - 1]) {
                nextFundingDate.setUTCDate(now.getUTCDate() + 1);
             }
             authoritativeTimes[symbol] = nextFundingDate.getTime();
        }
    });

    Object.values(data).forEach(ex => {
        if (ex.rates) {
            Object.values(ex.rates).forEach(rate => {
                if (authoritativeTimes[rate.symbol]) {
                    rate.fundingTimestamp = authoritativeTimes[rate.symbol];
                }
            });
        }
    });
    return data;
}

function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));

    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;
            if (!exchange1Rates || !exchange2Rates) continue;

            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);
            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol], rate2Data = exchange2Rates[symbol];

                // Bỏ qua nếu bất kỳ coin nào không có dữ liệu đòn bẩy (bị null)
                if (!rate1Data.maxLeverage || !rate2Data.maxLeverage) {
                    continue;
                }

                let longExchange, shortExchange, longRate, shortRate;
                if (rate1Data.fundingRate > rate2Data.fundingRate) {
                    shortExchange = exchange1Id; shortRate = rate1Data;
                    longExchange = exchange2Id; longRate = rate2Data;
                } else {
                    shortExchange = exchange2Id; shortRate = rate2Data;
                    longExchange = exchange1Id; longRate = rate1Data;
                }

                const fundingDiff = shortRate.fundingRate - longRate.fundingRate;
                const commonLeverage = Math.min(longRate.maxLeverage, shortRate.maxLeverage);
                const estimatedPnl = fundingDiff * commonLeverage * 100;

                if (estimatedPnl >= MINIMUM_PNL_THRESHOLD) {
                    const finalFundingTime = rate1Data.fundingTimestamp;
                    const minutesUntilFunding = (finalFundingTime - Date.now()) / (1000 * 60);
                    const isImminent = minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES;

                    allFoundOpportunities.push({
                        coin: symbol,
                        exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                        fundingDiff: parseFloat(fundingDiff.toFixed(6)),
                        nextFundingTime: finalFundingTime,
                        commonLeverage: commonLeverage,
                        estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                        isImminent: isImminent,
                    });
                }
            }
        }
    }
    
    arbitrageOpportunities = allFoundOpportunities.sort((a, b) => {
        if (a.nextFundingTime < b.nextFundingTime) return -1;
        if (a.nextFundingTime > b.nextFundingTime) return 1;
        return b.estimatedPnl - a.estimatedPnl;
    });
}

async function masterLoop() {
    console.log(`[LOOP] Bắt đầu vòng lặp cập nhật...`);
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = standardizeFundingTimes(freshFundingData);
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP]   => Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
}

// ----- KHỞI ĐỘNG SERVER -----
const server = http.createServer((req, res) => {
    // ... (phần này không đổi)
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
    console.log(`✅ Máy chủ dữ liệu (Bản Tối Ưu) đang chạy tại http://localhost:${PORT}`);
    
    // 1. Khởi tạo cache đòn bẩy lần đầu tiên (quan trọng)
    await initializeLeverageCache();
    
    // 2. Chạy vòng lặp chính lần đầu tiên
    await masterLoop(); 
    
    // 3. Đặt lịch chạy lặp lại
    setInterval(masterLoop, 60 * 1000); // Cập nhật funding mỗi phút
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_HOURS * 60 * 60 * 1000); // Làm mới cache đòn bẩy mỗi 6 giờ
});
