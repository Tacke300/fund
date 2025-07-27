const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto'); // Có thể không cần nữa nếu không dùng signBingX
const Binance = require('node-binance-api'); // Có thể không cần nữa nếu không dùng binanceClient

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
// Để nhận được kết quả như mong đợi trên HTML, các API Key và Secret DƯỚI ĐÂY phải chính xác
// và có đủ quyền 'chỉ đọc' trên Binance và BingX.
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88TzvmC3SpT9nEf4fcDf0pEnFzoTc';
const bingxApiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOB9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const bingxApiSecret = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVWbdAYa0go6Nohye1n7PS4XOcOmQXYnUs1YRei5RvLPg';
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';


// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;

// Loại bỏ binanceClient nếu không dùng các phương thức trực tiếp của node-binance-api nữa
// const binanceClient = new Binance().options({ APIKEY: binanceApiKey, APISECRET: binanceApiSecret });

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = { 'options': { 'defaultType': 'swap' } };

    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }
    else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
    exchanges[id].enableRateLimit = true;
});


const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

// Hàm signBingX không còn cần thiết nếu chỉ dùng CCXT cho BingX
// function signBingX(queryString, secret) {
//     return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
// }

// Hàm này giúp trích xuất maxLeverage từ market info nếu fetchLeverageTiers không có
function getMaxLeverageFromMarketInfo(market) {
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) return market.limits.leverage.max;
    if (typeof market?.info === 'object' && market.info !== null) {
        const possibleLeverageKeys = ['maxLeverage', 'leverage', 'initialLeverage', 'max_leverage'];
        for (const key of possibleLeverageKeys) {
            if (market.info.hasOwnProperty(key)) {
                const value = market.info[key];
                const leverage = parseInt(value, 10);
                if (!isNaN(leverage) && leverage > 1) return leverage;
            }
        }
    }
    return null;
}

// Hàm khởi tạo bộ nhớ đệm đòn bẩy cho tất cả các sàn (SỬ DỤNG CCXT cho tất cả)
async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id];
        newCache[id] = {};
        try {
            // Ưu tiên fetchLeverageTiers vì nó cung cấp thông tin đòn bẩy chi tiết nhất
            if (exchange.has['fetchLeverageTiers']) {
                const leverageTiers = await exchange.fetchLeverageTiers();
                for (const symbol in leverageTiers) {
                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        // Tìm đòn bẩy tối đa trong các bậc
                        const parsedMaxLeverage = parseInt(Math.max(...tiers.map(t => t.leverage)), 10);
                        if (!isNaN(parsedMaxLeverage) && parsedMaxLeverage > 0) {
                            newCache[id][cleanSymbol(symbol)] = parsedMaxLeverage;
                        }
                    }
                }
            } else { // Fallback to loadMarkets nếu fetchLeverageTiers không có hoặc không hoạt động
                await exchange.loadMarkets(true);
                for (const market of Object.values(exchange.markets)) {
                    // Chỉ lấy các cặp swap USDT
                    if (market.swap && market.quote === 'USDT') {
                        const symbolCleaned = cleanSymbol(market.symbol);
                        const maxLeverage = getMaxLeverageFromMarketInfo(market); // Sử dụng hàm trợ giúp
                        if (maxLeverage !== null && maxLeverage > 0) {
                            newCache[id][symbolCleaned] = maxLeverage; 
                        } else {
                            // Log cảnh báo nếu không tìm thấy đòn bẩy hợp lệ
                            console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
                        }
                    }
                }
            }
            const count = Object.values(newCache[id]).filter(v => typeof v === 'number' && v > 0).length;
            if (count > 0) {
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy.`);
            } else {
                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không lấy được đòn bẩy nào.`);
            }
            return { id, status: 'fulfilled' };
        } catch (e) {
            let errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
            // Cải thiện thông báo lỗi nếu là lỗi xác thực CCXT
            if (e instanceof ccxt.AuthenticationError) {
                errorMessage = `LỖI XÁC THỰC! Vui lòng kiểm tra lại API Key/Secret của ${id.toUpperCase()}. Chi tiết: ${e.message}.`;
            } else if (e instanceof ccxt.NetworkError) {
                errorMessage = `Lỗi mạng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
            }
            console.error(`[CACHE] ❌ ${id.toUpperCase()}: ${errorMessage}`);
            newCache[id] = {}; 
            return { id, status: 'rejected', reason: e.message };
        }
    });
    await Promise.allSettled(promises);
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
}

// Hàm tính toán thời gian funding tiêu chuẩn nếu không có từ API (Vẫn giữ nguyên)
function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);
    const nextFundingDate = new Date(now);
    if (nextHourUTC === undefined) { nextHourUTC = fundingHoursUTC[0]; nextFundingDate.setUTCDate(now.getUTCDate() + 1); }
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
    return nextFundingDate.getTime();
}

// Hàm tổng hợp để lấy Funding Rates cho tất cả các sàn (SỬ DỤNG CCXT cho tất cả)
async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            let processedRates = {};

            // Sử dụng fetchFundingRates của CCXT cho tất cả các sàn
            const fundingRatesRaw = await exchange.fetchFundingRates();
            for (const rate of Object.values(fundingRatesRaw)) {
                const symbolCleaned = cleanSymbol(rate.symbol);
                // Lấy maxLeverage từ cache đã được tạo bởi initializeLeverageCache()
                const maxLeverage = leverageCache[id]?.[symbolCleaned] || null;
                // ccxt.fetchFundingRates thường cung cấp nextFundingTime hoặc fundingTimestamp
                const fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();
                
                // Chỉ thêm vào nếu fundingRate và fundingTimestamp hợp lệ
                if (typeof rate.fundingRate === 'number' && !isNaN(rate.fundingRate) && typeof fundingTimestamp === 'number' && fundingTimestamp > 0) {
                    processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: rate.fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverage };
                } else {
                    console.warn(`[DATA] ⚠️ ${id.toUpperCase()}: Funding rate hoặc timestamp không hợp lệ cho ${rate.symbol}.`);
                }
            }

            if (Object.keys(processedRates).length > 0) {
                console.log(`[DATA] ✅ ${id.toUpperCase()}: Đã lấy thành công ${Object.keys(processedRates).length} funding rates.`);
            } else {
                console.warn(`[DATA] ⚠️ ${id.toUpperCase()}: Không lấy được funding rates nào.`);
            }
            return { id, status: 'fulfilled', rates: processedRates };
        } catch (e) {
            let errorMessage = `Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}.`;
            // Cải thiện thông báo lỗi nếu là lỗi xác thực CCXT
            if (e instanceof ccxt.AuthenticationError) {
                errorMessage = `LỖI XÁC THỰC! Vui lòng kiểm tra lại API Key/Secret của ${id.toUpperCase()}. Chi tiết: ${e.message}.`;
            } else if (e instanceof ccxt.NetworkError) {
                errorMessage = `Lỗi mạng khi lấy funding từ ${id.toUpperCase()}: ${e.message}.`;
            }
            console.error(`[DATA] ❌ ${id.toUpperCase()}: ${errorMessage}`);
            return { id, status: 'rejected', reason: e.message };
        }
    });
    const results = await Promise.allSettled(promises);

    results.forEach(result => {
        if (result.status === 'fulfilled') {
            freshData[result.value.id] = { rates: result.value.rates };
        } else {
            console.warn(`[DATA] ⚠️ ${result.value?.id?.toUpperCase() || 'UNKNOWN'}: Không thể cập nhật funding rates. Nguyên nhân: ${result.reason}.`);
            // Đảm bảo cấu trúc tồn tại dù có lỗi để tránh lỗi undefined khi truy cập sau này
            if (!exchangeData[result.value?.id]) { 
                exchangeData[result.value.id] = { rates: {} }; 
            }
        }
    });
    return freshData;
}


function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData)); 

    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;

            if (!exchange1Rates || !exchange2Rates || Object.keys(exchange1Rates).length === 0 || Object.keys(exchange2Rates).length === 0) {
                continue;
            }

            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);

            if (commonSymbols.length === 0) {
                continue;
            }

            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol];
                const rate2Data = exchange2Rates[symbol];

                if (typeof rate1Data.maxLeverage !== 'number' || rate1Data.maxLeverage <= 0 ||
                    typeof rate2Data.maxLeverage !== 'number' || rate2Data.maxLeverage <= 0) {
                    continue; 
                }

                if (typeof rate1Data.fundingRate !== 'number' || typeof rate2Data.fundingRate !== 'number' ||
                    !rate1Data.fundingTimestamp || rate1Data.fundingTimestamp <= 0 || !rate2Data.fundingTimestamp || rate2Data.fundingTimestamp <= 0) {
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

                if (fundingDiff <= FUNDING_DIFFERENCE_THRESHOLD) {
                    continue;
                }

                const commonLeverage = Math.min(longRate.maxLeverage, shortRate.maxLeverage);
                const estimatedPnl = fundingDiff * commonLeverage * 100;

                if (estimatedPnl >= MINIMUM_PNL_THRESHOLD) {
                    const finalFundingTime = Math.max(rate1Data.fundingTimestamp, rate2Data.fundingTimestamp);
                    const minutesUntilFunding = (finalFundingTime - Date.now()) / (1000 * 60);
                    const isImminent = minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES;

                    allFoundOpportunities.push({
                        coin: symbol,
                        exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                        fundingDiff: parseFloat(fundingDiff.toFixed(6)),
                        nextFundingTime: finalFundingTime,
                        nextFundingTimeUTC: new Date(finalFundingTime).toISOString(),
                        commonLeverage: parseFloat(commonLeverage.toFixed(2)),
                        estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                        isImminent: isImminent,
                        details: {
                            shortExchange: shortExchange,
                            shortRate: shortRate.fundingRate,
                            shortLeverage: shortRate.maxLeverage,
                            longExchange: longExchange,
                            longRate: longRate.fundingRate,
                            longLeverage: longRate.maxLeverage,
                            minutesUntilFunding: parseFloat(minutesUntilFunding.toFixed(1))
                        }
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
    console.log(`\n[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})...`);
    
    await initializeLeverageCache(); 
    const freshFundingData = await fetchFundingRatesForAllExchanges(); 
    exchangeData = freshFundingData; 

    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP] ✅ Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
    scheduleNextLoop();
}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId);
    const now = new Date();
    const delaySeconds = (60 - now.getSeconds() + 5) % 60; 
    const delayMs = (delaySeconds === 0 ? 60 : delaySeconds) * 1000; 
    console.log(`[SCHEDULER] Vòng lặp kế tiếp sau ${delaySeconds.toFixed(0)} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delayMs);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { 
                console.error('[SERVER] ❌ Lỗi khi đọc index.html:', err.message); 
                res.writeHead(500); 
                res.end('Lỗi khi đọc index.html'); 
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
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    await masterLoop(); 
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
