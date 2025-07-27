const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
// Các API Key và Secret DƯỚI ĐÂY phải chính xác
// và có đủ quyền 'chỉ đọc' trên Binance và BingX.
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc';
const bingxApiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const bingxApiSecret = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';
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

// Hàm này giúp trích xuất maxLeverage từ market info nếu fetchLeverageTiers không có
// Hàm này sẽ chỉ còn là fallback cho các sàn không có fetchLeverageTiers (ví dụ: OKX, Bitget nếu cần)
function getMaxLeverageFromMarketInfo(market) {
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) {
        return market.limits.leverage.max;
    }
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

// Hàm để ký request Binance (dùng cho REST API trực tiếp)
function signBinanceRequest(params, secret) {
    const queryString = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&'); // Sắp xếp các khóa để ký nhất quán
    const signature = crypto.createHmac('sha256', secret).update(queryString).digest('hex');
    return `${queryString}&signature=${signature}`;
}

// Hàm để lấy leverage từ Binance qua REST API trực tiếp (dùng Node.js's native https module)
async function fetchBinanceLeverageDirectly(apiKey, apiSecret) {
    const hostname = 'fapi.binance.com';
    const path = '/fapi/v1/leverageBracket';
    const timestamp = Date.now();
    const params = { timestamp: timestamp };

    const queryString = signBinanceRequest(params, apiSecret);

    const options = {
        hostname: hostname,
        path: `${path}?${queryString}`,
        method: 'GET',
        headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/json'
        }
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const responseJson = JSON.parse(data);
                    if (res.statusCode && res.statusCode >= 400) {
                        console.error(`[LEVERAGE] ❌ Lỗi HTTP ${res.statusCode} khi lấy đòn bẩy Binance qua REST API: ${responseJson.msg || 'Không rõ lỗi'}`);
                        return resolve({}); // Trả về đối tượng rỗng nếu có lỗi HTTP
                    }

                    const leverageData = {};
                    if (Array.isArray(responseJson)) {
                        for (const item of responseJson) {
                            const symbolCleaned = cleanSymbol(item.symbol);
                            if (item.brackets && Array.isArray(item.brackets) && item.brackets.length > 0) {
                                const maxLeverage = Math.max(...item.brackets.map(b => b.leverage));
                                if (maxLeverage > 0) {
                                    leverageData[symbolCleaned] = maxLeverage;
                                }
                            }
                        }
                    }
                    console.log(`[LEVERAGE] ✅ BINANCEUSDM: Đã lấy thành công ${Object.keys(leverageData).length} đòn bẩy qua REST API.`);
                    resolve(leverageData);
                } catch (e) {
                    console.error(`[LEVERAGE] ❌ Lỗi phân tích JSON hoặc xử lý dữ liệu Binance REST API: ${e.message}. Dữ liệu thô (có thể bị cắt ngắn): ${data.substring(0, 200)}...`);
                    resolve({});
                }
            });
        });

        req.on('error', (e) => {
            console.error(`[LEVERAGE] ❌ Lỗi mạng khi kết nối Binance REST API: ${e.message}`);
            resolve({}); // Trả về đối tượng rỗng nếu có lỗi mạng
        });

        req.end();
    });
}


// Hàm khởi tạo bộ nhớ đệm đòn bẩy cho tất cả các sàn (SỬ DỤNG CCXT và fallback REST API cho Binance)
async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id];
        newCache[id] = {}; // Đảm bảo luôn khởi tạo cache cho sàn này

        try {
            let leverageSource = "CCXT fetchLeverageTiers";
            let fetchedLeverageData = {};

            // Luôn thử fetchLeverageTiers trước nếu sàn hỗ trợ
            if (exchange.has['fetchLeverageTiers']) {
                try {
                    const leverageTiers = await exchange.fetchLeverageTiers();
                    for (const symbol in leverageTiers) {
                        const tiers = leverageTiers[symbol];
                        if (Array.isArray(tiers) && tiers.length > 0) {
                            const numericLeverages = tiers.map(t => typeof t.leverage === 'number' ? t.leverage : parseFloat(t.leverage)).filter(l => !isNaN(l) && l > 0);
                            const parsedMaxLeverage = numericLeverages.length > 0 ? parseInt(Math.max(...numericLeverages), 10) : 0;

                            if (!isNaN(parsedMaxLeverage) && parsedMaxLeverage > 0) {
                                fetchedLeverageData[cleanSymbol(symbol)] = parsedMaxLeverage;
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Lỗi khi gọi fetchLeverageTiers: ${e.message}.`);
                    leverageSource = "CCXT fetchLeverageTiers (lỗi)";
                }
            }

            // Xử lý logic fallback cho từng sàn
            if (Object.keys(fetchedLeverageData).length === 0) { // Nếu fetchLeverageTiers không lấy được gì
                if (id === 'binanceusdm') {
                    console.log(`[CACHE] ${id.toUpperCase()}: fetchLeverageTiers không lấy được đòn bẩy. Thử dùng REST API trực tiếp...`);
                    fetchedLeverageData = await fetchBinanceLeverageDirectly(binanceApiKey, binanceApiSecret);
                    leverageSource = "Binance REST API";
                }
                else if (id === 'bingx') {
                    // BingX's loadMarkets không chứa đòn bẩy. Nếu fetchLeverageTiers không hoạt động,
                    // việc lấy đòn bẩy qua REST API trực tiếp cho tất cả các cặp rất phức tạp
                    // và nằm ngoài phạm vi giải pháp "code thuần" mà không có thông tin chi tiết.
                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không lấy được đòn bẩy nào qua CCXT. Vui lòng kiểm tra quyền API hoặc hạn chế của sàn BingX. (Không có fallback REST API chung cho BingX).`);
                    leverageSource = "Không có đòn bẩy";
                }
                else { // OKX và Bitget (dùng loadMarkets nếu fetchLeverageTiers không có hoặc lỗi)
                    console.log(`[CACHE] ${id.toUpperCase()}: fetchLeverageTiers không lấy được đòn bẩy. Thử dùng loadMarkets...`);
                    await exchange.loadMarkets(true);
                    for (const market of Object.values(exchange.markets)) {
                        if (market.swap && market.quote === 'USDT') {
                            const symbolCleaned = cleanSymbol(market.symbol);
                            const maxLeverage = getMaxLeverageFromMarketInfo(market); // Hàm này dùng cho fallback
                            if (maxLeverage !== null && maxLeverage > 0) {
                                fetchedLeverageData[symbolCleaned] = maxLeverage;
                            } else {
                                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
                            }
                        }
                    }
                    leverageSource = "CCXT loadMarkets fallback";
                }
            }

            newCache[id] = fetchedLeverageData;
            const count = Object.keys(newCache[id]).length;
            if (count > 0) {
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy (${leverageSource}).`);
            } else {
                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không lấy được đòn bẩy nào (${leverageSource}).`);
            }
            return { id, status: 'fulfilled' };
        } catch (e) {
            let errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
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

                // Kiểm tra lại maxLeverage trước khi dùng
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
