const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

// Import các API Key và Secret từ file config.js
const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('./config.js');

const PORT = 5005; 

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// Cấu hình cho việc lấy dữ liệu BingX song song (cho Leverage API)
const BINGX_CONCURRENT_FETCH_LIMIT = 2; // Giảm số lượng yêu cầu BingX được chạy song song tại một thời điểm
const BINGX_DELAY_BETWEEN_CONCURRENT_BATCHES_MS = 5000; // Độ trễ giữa các lô yêu cầu song song (5 giây)

// ----- BIẾN TOÀN CỤC -----
// Khởi tạo các biến với giá trị rỗng hoặc null để server có thể trả về ngay lập tức
let leverageCache = {}; 
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null; // Sẽ là null ban đầu, sau đó cập nhật khi dữ liệu sẵn sàng
let loopTimeoutId = null;

let debugRawLeverageResponses = {
    binanceusdm: { status: 'Đang tải...', timestamp: null, data: 'N/A', error: null },
    bingx: { status: 'Đang tải...', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'Đang tải...', timestamp: null, data: 'N/A', error: null },
    bitget: { status: 'Đang tải...', timestamp: null, data: 'N/A', error: null }
};

const BINGX_BASE_HOST = 'open-api.bingx.com';
const BINANCE_BASE_HOST = 'fapi.binance.com';
let binanceServerTimeOffset = 0;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = {
        'options': { 'defaultType': 'swap' },
        'enableRateLimit': true,
        'headers': {
            'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)',
        }
    };

    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }
    else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
});

const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                        .update(queryString)
                        .digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            port: 443,
            path: path,
            method: method,
            headers: { ...headers, 'User-Agent': 'Mozilla/5.0' },
            timeout: 20000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject({
                        code: res.statusCode,
                        msg: `HTTP Lỗi: ${res.statusCode} ${res.statusMessage}`,
                        url: `${hostname}${path}`,
                        rawResponse: data
                    });
                }
            });
        });

        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: `${e.message} (khi gọi ${hostname}${path})` }));
        req.on('timeout', () => {
            req.destroy();
            reject({ code: 'TIMEOUT_ERROR', msg: `Request timed out sau ${options.timeout / 1000}s (khi gọi ${hostname}${path})` });
        });

        if (postData && (method === 'POST' || method === 'PUT' || method === 'DELETE')) req.write(postData);
        req.end();
    });
}

async function syncBinanceServerTime() {
    try {
        const data = await makeHttpRequest('GET', BINANCE_BASE_HOST, '/fapi/v1/time');
        const parsedData = JSON.parse(data);
        const binanceServerTime = parsedData.serverTime;
        const localTime = Date.now();
        binanceServerTimeOffset = binanceServerTime - localTime;
        console.log(`[TIME SYNC] ✅ Đồng bộ thời gian Binance. Lệch: ${binanceServerTimeOffset} ms.`);
    } catch (error) {
        console.error(`[TIME SYNC] ❌ Lỗi đồng bộ thời gian Binance: ${error.msg || error.message}.`);
        binanceServerTimeOffset = 0;
        throw error;
    }
}

async function callSignedBinanceAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!binanceApiKey || !binanceApiSecret) {
        throw new Error("API Key hoặc Secret Key cho Binance chưa được cấu hình.");
    }
    const recvWindow = 5000;
    const timestamp = Date.now() + binanceServerTimeOffset;

    let queryString = Object.keys(params)
                                    .map(key => `${key}=${params[key]}`)
                                    .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, binanceApiSecret);

    let requestPath;
    let requestBody = '';
    const headers = {
        'X-MBX-APIKEY': binanceApiKey,
    };

    if (method === 'GET') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Method không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BINANCE_BASE_HOST, requestPath, headers, requestBody);
        return JSON.parse(rawData);
    } catch (error) {
        console.error(`[BINANCE API] Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}. Path: ${requestPath}`);
        if (error.code === 400 && error.rawResponse && error.rawResponse.includes('-2015')) {
            console.error("  -> LỖI XÁC THỰC! Kiểm tra API Key/Secret và quyền Futures Binance.");
        } else if (error.code === 400 && error.rawResponse && error.rawResponse.includes('-1021')) {
            console.error("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính hoặc chạy lại bot.");
        } else if (error.code === 429 || error.code === -1003) {
            console.error("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT). CẦN GIẢM TẦN SUẤT GỌI API HOẶC ĐỢI!");
        }
        throw error;
    }
}

const bingxErrorLogCache = {};
const BINGX_ERROR_LOG_COOLDOWN_MS = 5 * 60 * 1000;

async function fetchBingxMaxLeverage(symbol, retries = 3) {
    if (!bingxApiKey || !bingxApiSecret) {
        console.warn(`[BINGX] ⚠️ Thiếu API Key/Secret cho BingX.`);
        return null;
    }

    let lastRawData = 'N/A';
    let lastError = null;    
    let parsedLeverage = null;

    for (let i = 0; i < retries; i++) {
        const params = new URLSearchParams({
            symbol: symbol,
            timestamp: Date.now(),
            recvWindow: 5000
        }).toString();
        
        const signature = createSignature(params, bingxApiSecret);
        const urlPath = `/openApi/swap/v2/trade/leverage?${params}&signature=${signature}`; 

        const headers = { 'X-BX-APIKEY': bingxApiKey };

        try {
            const rawRes = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath, headers);
            lastRawData = rawRes; 
            lastError = null; 
            
            try {
                const parsedJson = JSON.parse(rawRes);
                if (parsedJson.code === 0 && parsedJson.data) {
                    const maxLongLev = parseInt(parsedJson.data.maxLongLeverage, 10);
                    const maxShortLev = parseInt(parsedJson.data.maxShortLeverage, 10);

                    console.log(`[DEBUG_BINGX_LEV] Sym: ${symbol}, Raw (partial): ${rawRes.substring(0, Math.min(rawRes.length, 300))}`);
                    console.log(`[DEBUG_BINGX_LEV] Sym: ${symbol}, maxLongLeverage: ${parsedJson.data.maxLongLeverage}, maxShortLeverage: ${parsedJson.data.maxShortLeverage}`);

                    if (!isNaN(maxLongLev) && maxLongLev > 0 && !isNaN(maxShortLev) && maxShortLev > 0) {
                        parsedLeverage = Math.max(maxLongLev, maxShortLev);
                        console.log(`[CACHE] ✅ BingX: Max leverage của ${symbol} là ${parsedLeverage} (REST API - maxLong/Short).`);
                        return parsedLeverage;
                    } else {
                        console.warn(`[CACHE] ⚠️ BingX: Phản hồi API hợp lệ nhưng không tìm thấy đòn bẩy tối đa hợp lệ (maxLongLeverage/maxShortLeverage) cho ${symbol}. Raw: ${rawRes.substring(0, Math.min(rawRes.length, 200))}`);
                        lastError = { code: parsedJson.code, msg: 'No valid maxLongLeverage/maxShortLeverage found in data', type: 'API_RESPONSE_PARSE_ERROR' };
                    }
                } else {
                    console.warn(`[CACHE] ⚠️ BingX: Phản hồi API không thành công (Code: ${parsedJson.code} != 0) hoặc không có 'data' cho ${symbol}. Msg: ${parsedJson.msg || 'N/A'}. Raw: ${rawRes.substring(0, Math.min(rawRes.length, 200))}`);
                    lastError = { code: parsedJson.code, msg: parsedJson.msg || 'Invalid API Response Structure', type: 'API_RESPONSE_ERROR' };
                }
            } catch (jsonParseError) {
                console.warn(`[CACHE] ⚠️ BingX: Lỗi parse JSON phản hồi cho ${symbol}. Raw: ${rawRes.substring(0, Math.min(rawRes.length, 200))}. Lỗi: ${jsonParseError.message}`);
                lastError = { code: 'JSON_PARSE_ERROR', msg: jsonParseError.message, type: 'JSON_PARSE_ERROR' };
            }

            if (i < retries - 1) {
                await sleep(500); // Small delay before retry
                continue;
            }
            break; 
        } catch (e) {
            lastError = { code: e.code, msg: e.msg || e.message, statusCode: e.statusCode || 'N/A', type: 'HTTP_ERROR' };
            lastRawData = e.rawResponse || lastRawData;

            const errorSignature = `${e.code}-${e.statusCode}-${e.msg?.substring(0, 50)}`;
            const now = Date.now();
            if (!bingxErrorLogCache[errorSignature] || (now - bingxErrorLogCache[errorSignature] > BINGX_ERROR_LOG_COOLDOWN_MS)) {
                let logMsg = `[BINGX] Lỗi lấy leverage cho ${symbol} (Lần ${i+1}/${retries}): ${e.msg || e.message}`;
                if (e.rawResponse) {
                    logMsg += ` Raw: ${e.rawResponse.substring(0, Math.min(e.rawResponse.length, 500))}...`;
                }
                console.warn(logMsg);
                bingxErrorLogCache[errorSignature] = now;
            }

            if (e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT_ERROR' || (e.statusCode >= 500 && e.statusCode < 600) || e.code === 100410) { 
                const delay = 2 ** i * 1000;
                console.warn(`[BINGX] Lỗi tạm thời (có thể do rate limit). Thử lại sau ${delay / 1000}ms.`);
                await sleep(delay);
                continue;
            } else if (e.statusCode === 400 || e.statusCode === 401 || e.statusCode === 403 || e.code === 1015 || e.code === 429) {
                 if (i < retries - 1) {
                    console.warn(`[BINGX] Lỗi định dạng phản hồi/xác thực/rate limit. Thử lại sau 1s.`);
                    await sleep(1000);
                    continue;
                 }
            }
            break;
        }
    }
    return parsedLeverage;
}

async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id];
        let fetchedLeverageDataMap = {};
        let leverageSource = "Unknown";
        let currentRawDebug = { status: 'Đang tải...', timestamp: new Date(), data: 'N/A', error: null }; // Cập nhật trạng thái

        try {
            if (id === 'binanceusdm') {
                leverageSource = "Binance REST API /fapi/v1/leverageBracket";
                try {
                    await syncBinanceServerTime(); 
                    const leverageBracketsResponse = await callSignedBinanceAPI('/fapi/v1/leverageBracket', 'GET');

                    let successCount = 0;
                    if (Array.isArray(leverageBracketsResponse)) {
                        for (const item of leverageBracketsResponse) {
                            if (item.symbol && Array.isArray(item.brackets) && item.brackets.length > 0) {
                                const firstBracket = item.brackets.find(b => b.bracket === 1) || item.brackets[0];
                                const maxLeverage = parseInt(firstBracket.initialLeverage, 10);
                                if (!isNaN(maxLeverage) && maxLeverage > 0) {
                                    fetchedLeverageDataMap[cleanSymbol(item.symbol)] = maxLeverage;
                                    successCount++;
                                }
                            }
                        }
                    }
                    currentRawDebug = { status: `thành công (${successCount} cặp API)`, timestamp: new Date(), data: `Đã lấy ${successCount} cặp từ API.`, error: null };
                    console.log(`[CACHE] ✅ Binance: Đã lấy ${successCount} cặp đòn bẩy từ API trực tiếp.`);

                } catch (e) {
                    let errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy Binance qua API trực tiếp: ${e.message}.`;
                    console.error(`[CACHE] ❌ Binance: ${errorMessage}`);
                    leverageSource = "Binance REST API (lỗi nghiêm trọng)";
                    currentRawDebug = { status: `thất bại (Binance API lỗi: ${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.rawResponse || e.message, error: { code: e.code, msg: e.message } };
                }
            }
            else if (id === 'bingx') {
                leverageSource = "BingX REST API /trade/leverage";
                try {
                    console.log(`[DEBUG] Gọi CCXT loadMarkets cho ${id.toUpperCase()} để lấy danh sách cặp...`);
                    await exchange.loadMarkets(true);
                    const bingxMarkets = Object.values(exchange.markets)
                        .filter(m => m.swap && m.quote === 'USDT');

                    console.log(`[CACHE] ${id.toUpperCase()}: Tìm thấy ${bingxMarkets.length} tổng số cặp swap USDT. Đang lấy dữ liệu đòn bẩy cho tất cả các cặp...`);

                    let successCount = 0;
                    const marketChunks = [];
                    for (let i = 0; i < bingxMarkets.length; i += BINGX_CONCURRENT_FETCH_LIMIT) {
                        marketChunks.push(bingxMarkets.slice(i, i + BINGX_CONCURRENT_FETCH_LIMIT));
                    }

                    for (const chunk of marketChunks) {
                        const chunkPromises = chunk.map(async market => {
                            const formattedSymbol = market.symbol.replace('/', '-').replace(':USDT', '');
                            const parsedMaxLeverage = await fetchBingxMaxLeverage(formattedSymbol);
                            if (parsedMaxLeverage !== null && parsedMaxLeverage > 0) {
                                fetchedLeverageDataMap[cleanSymbol(market.symbol)] = parsedMaxLeverage;
                                return true;
                            } else {
                                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không thể lấy đòn bẩy hợp lệ cho ${cleanSymbol(market.symbol)}. (Kiểm tra log chi tiết từ API BingX)`);
                                return false;
                            }
                        });
                        const results = await Promise.allSettled(chunkPromises);
                        successCount += results.filter(r => r.status === 'fulfilled' && r.value === true).length;

                        if (marketChunks.indexOf(chunk) < marketChunks.length - 1) {
                            await sleep(BINGX_DELAY_BETWEEN_CONCURRENT_BATCHES_MS);
                        }
                    }
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Hoàn tất lấy dữ liệu đòn bẩy cho ${Object.keys(fetchedLeverageDataMap).length} cặp. (${successCount} cặp được parse thành công)`);
                    currentRawDebug.status = `thành công (BingX API)`;
                    currentRawDebug.data = `Đã lấy ${Object.keys(fetchedLeverageDataMap).length} cặp. (${successCount} cặp parse thành công).`;

                } catch (e) {
                    console.error(`[CACHE] ❌ ${id.toUpperCase()}: Lỗi chung khi lấy dữ liệu BingX: ${e.msg || e.message}.`);
                    leverageSource = "BingX REST API (lỗi chung)";
                    currentRawDebug = { status: `thất bại (BingX API lỗi chung: ${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.rawResponse || e.message, error: { code: e.code, msg: e.message } };
                }
            }
            else { // OKX và Bitget: Dùng CCXT (fetchLeverageTiers + loadMarkets fallback)
                leverageSource = "CCXT fetchLeverageTiers";
                debugRawLeverageResponses[id].timestamp = new Date(); 

                try {
                    if (exchange.has['fetchLeverageTiers']) {
                        const leverageTiers = await exchange.fetchLeverageTiers();
                        let successCount = 0;
                        for (const symbol in leverageTiers) {
                            const tiers = leverageTiers[symbol];
                            if (Array.isArray(tiers) && tiers.length > 0) {
                                const numericLeverages = tiers.map(t => typeof t.leverage === 'number' ? t.leverage : parseFloat(t.leverage)).filter(l => !isNaN(l) && l > 0);
                                const parsedMaxLeverage = numericLeverages.length > 0 ? parseInt(Math.max(...numericLeverages), 10) : 0;
                                if (parsedMaxLeverage > 0) {
                                    fetchedLeverageDataMap[cleanSymbol(symbol)] = parsedMaxLeverage; 
                                    successCount++; 
                                }
                            }
                        }
                        currentRawDebug.status = `thành công (${successCount} cặp CCXT)`;
                        currentRawDebug.data = `Đã lấy ${successCount} cặp.`;
                    } else {
                        console.log(`[CACHE] ${id.toUpperCase()}: fetchLeverageTiers không khả dụng. Dùng loadMarkets...`);
                        await exchange.loadMarkets(true);
                        let loadMarketsSuccessCount = 0;
                        for (const market of Object.values(exchange.markets)) {
                            if (market.swap && market.quote === 'USDT') {
                                const symbolCleaned = cleanSymbol(market.symbol);
                                const maxLeverage = getMaxLeverageFromMarketInfo(market);
                                if (maxLeverage !== null && maxLeverage > 0) {
                                    fetchedLeverageDataMap[symbolCleaned] = maxLeverage; 
                                    loadMarketsSuccessCount++; 
                                } else {
                                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
                                }
                            }
                        }
                        leverageSource = "CCXT loadMarkets";
                        currentRawDebug.status = `thành công (loadMarkets, ${loadMarketsSuccessCount} cặp)`;
                        currentRawDebug.data = `Đã lấy ${loadMarketsSuccessCount} cặp.`;
                    }
                } catch(e) {
                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Lỗi khi gọi CCXT phương thức leverage: ${e.message}.`);
                    leverageSource = "CCXT (lỗi)";
                    currentRawDebug.status = `thất bại (${e.code || 'UNKNOWN'})`;
                    currentRawDebug.error = { code: e.code, msg: e.message };
                }
            }

            newCache[id] = fetchedLeverageDataMap; 
            const count = Object.keys(newCache[id]).length;
            if (count > 0) {
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số mục đòn bẩy đã lấy: ${count} (${leverageSource}).`);
            } else {
                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không lấy được mục đòn bẩy nào (${leverageSource}).`);
                currentRawDebug.status = 'thất bại (không có đòn bẩy)';
            }
            debugRawLeverageResponses[id] = currentRawDebug; 
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
            debugRawLeverageResponses[id] = { status: `thất bại (${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.rawResponse ? e.rawResponse.toString() : 'N/A', error: { code: e.code, msg: e.message } };
            return { id, status: 'rejected', reason: e.message };
        }
    });
    await Promise.allSettled(promises);
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
}

function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);
    const nextFundingDate = new Date(now);
    if (nextHourUTC === undefined) { nextHourUTC = fundingHoursUTC[0]; nextFundingDate.setUTCDate(now.getUTCDate() + 1); }
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
    return nextFundingDate.getTime();
}

async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            let processedRates = {};
            
            // Sử dụng ccxt.fetchFundingRates() cho tất cả các sàn
            const fundingRatesRaw = await exchange.fetchFundingRates();
            
            for (const rate of Object.values(fundingRatesRaw)) {
                const symbolCleaned = cleanSymbol(rate.symbol);
                const maxLeverageParsed = leverageCache[id]?.[symbolCleaned] || null; 
                
                const fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();

                if (typeof rate.fundingRate === 'number' && !isNaN(rate.fundingRate) && typeof fundingTimestamp === 'number' && fundingTimestamp > 0) {
                    processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: rate.fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverageParsed };
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
            if (!freshData[result.value?.id]) {
                freshData[result.value.id] = { rates: {} };
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

                const parsedMaxLeverage1 = rate1Data.maxLeverage;
                const parsedMaxLeverage2 = rate2Data.maxLeverage;

                if (typeof parsedMaxLeverage1 !== 'number' || parsedMaxLeverage1 <= 0 ||
                    typeof parsedMaxLeverage2 !== 'number' || parsedMaxLeverage2 <= 0) {
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

                const commonLeverage = Math.min(parsedMaxLeverage1, parsedMaxLeverage2);
                const estimatedPnl = fundingDiff * commonLeverage * 100;

                if (estimatedPnl >= MINIMUM_PNL_THRESHOLD) {
                    const finalFundingTime = Math.max(rate1Data.fundingTimestamp, rate2Data.fundingTimestamp);
                    const minutesUntilFunding = (finalFundingTime - Date.now()) / (1000 * 60);
                    const isImminent = minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES;

                    allFoundOpportunities.push({
                        coin: symbol,
                        // Điều chỉnh tên sàn hiển thị cho phù hợp với frontend (loại bỏ 'usdm')
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
                            shortLeverage: parsedMaxLeverage1,
                            longExchange: longExchange,
                            longRate: longRate.fundingRate,
                            longLeverage: parsedMaxLeverage2,
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

    try {
        await syncBinanceServerTime();
    } catch (error) {
        console.error("[LOOP] Lỗi đồng bộ thời gian Binance, có thể ảnh hưởng đến các lệnh ký. Thử lại ở vòng lặp sau.");
    }

    // Bước 1: Cập nhật bộ nhớ đệm đòn bẩy cho TẤT CẢ các sàn
    // initializeLeverageCache đã được thiết kế để cập nhật debugRawLeverageResponses
    await initializeLeverageCache();

    // Bước 2: Lấy dữ liệu funding rates cho TẤT CẢ các sàn
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData; // Cập nhật dữ liệu funding toàn cục

    // Bước 3: Tính toán cơ hội arbitrage với dữ liệu mới nhất
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
                // Đảm bảo khóa 'binance' để khớp với frontend HTML của bạn
                binance: Object.values(exchangeData.binanceusdm?.rates || {}), 
                bingx: Object.values(exchangeData.bingx?.rates || {}),
                okx: Object.values(exchangeData.okx?.rates || {}),
                bitget: Object.values(exchangeData.bitget?.rates || {}),
            },
            // Trả về debugRawLeverageResponses để frontend có thể hiển thị trạng thái tải
            debugRawLeverageResponses: debugRawLeverageResponses 
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, () => { // ĐÃ SỬA: Bỏ 'async' và 'await' ở đây
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    // KHÔNG SỬ DỤNG 'await' masterLoop() ở đây nữa.
    // Gọi masterLoop() để nó chạy ở chế độ nền.
    masterLoop(); 
    
    // Đặt lịch làm mới bộ nhớ đệm đòn bẩy định kỳ
    // setInterval này vẫn cần thiết để refresh leverage cache định kỳ ngoài chu kỳ masterLoop chính
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
