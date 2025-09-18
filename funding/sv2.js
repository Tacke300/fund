const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const { URLSearchParams } = require('url');
// const WebSocket = require('ws'); // Đã loại bỏ WebSocket

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
const MINIMUM_PNL_THRESHOLD = 1; 
const IMMINENT_THRESHOLD_MINUTES = 15;

const FULL_LEVERAGE_REFRESH_AT_HOUR = 0;
const TARGETED_LEVERAGE_REFRESH_MINUTES = [15, 30, 45, 55, 59];

// Cấu hình BingX: Lấy theo lô, độ trễ giữa các lô
const BINGX_CONCURRENT_FETCH_LIMIT = 3;
const BINGX_DELAY_BETWEEN_BATCHES_MS = 6000;
const BINGX_SINGLE_REQUEST_DELAY_MS = 1000;

const DELAY_BEFORE_BINGX_MS = 60000; // 60 giây delay trước khi BingX bắt đầu lấy dữ liệu

// Cấu hình cập nhật BingX ưu tiên (5 phút)
const BINGX_PRIORITY_UPDATE_INTERVAL_MINUTES = 5; // Cập nhật ưu tiên mỗi 5 phút
const BINGX_PRIORITY_UPDATE_COOLDOWN_MS = 30 * 1000; // Cooldown cho các request liên tục trong cập nhật ưu tiên

// Cấu hình cập nhật BingX siêu ưu tiên (phút 55 tới 58)
const BINGX_SUPER_PRIORITY_WINDOW_START_MINUTE = 55; // Bắt đầu từ phút này
const BINGX_SUPER_PRIORITY_WINDOW_END_MINUTE = 59; // Kết thúc trước phút này (tức là phút 58 là cuối cùng)
const BINGX_SUPER_PRIORITY_UPDATE_INTERVAL_SECONDS = 60; // Cập nhật mỗi 60 giây trong cửa sổ

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;

let bitgetValidFuturesSymbolSet = new Set(); 

let debugRawLeverageResponses = {
    binanceusdm: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    bingx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    bitget: { status: 'Đang tải đòn bòn bẩy...', timestamp: null, data: 'N/A', error: null } 
};

const BINGX_BASE_HOST = 'open-api.bingx.com';
const BINANCE_BASE_HOST = 'fapi.binance.com';
const BITGET_NATIVE_REST_HOST = 'api.bitget.com'; 
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


// ----- BIẾN TRẠNG THÁI MỚI VÀ ĐIỀU CHỈNH -----
let isBingxPriorityUpdateActive = false;     // Biến cờ cho cập nhật ưu tiên 5 phút của BingX
let isBingxSuperPriorityUpdateActive = false; // Biến cờ cho cập nhật ưu tiên cao (phút 55-58)
let bingxContinuousLoopTimeoutId = null;
let bingxPriorityLoopTimeoutId = null;
let bingxSuperPriorityLoopTimeoutId = null; // ID timeout cho vòng lặp siêu ưu tiên
let lastBingxFullUpdateStartTime = null; 
let bingxNextPriorityUpdateTime = 0; 


// ----- HÀM HỖ TRỢ CHUNG -----
const cleanSymbol = (symbol) => {
    let cleaned = symbol.toUpperCase();
    cleaned = cleaned.replace('_UMCBL', ''); 
    cleaned = cleaned.replace(/[\/:_]/g, ''); 
    cleaned = cleaned.replace(/-USDT$/, 'USDT'); 
    cleaned = cleaned.replace(/^\d+/, ''); 
    cleaned = cleaned.replace(/(\D+)\d+USDT$/, '$1USDT'); 
    const usdtIndex = cleaned.indexOf('USDT');
    if (usdtIndex !== -1) {
        cleaned = cleaned.substring(0, usdtIndex) + 'USDT';
    } else if (symbol.toUpperCase().includes('USDT') && !cleaned.endsWith('USDT')) { 
        cleaned = cleaned + 'USDT';
    }
    return cleaned;
};


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
        console.log(`[TIME_SYNC] ✅ Đồng bộ thời gian Binance. Lệch: ${binanceServerTimeOffset} ms.`);
    } catch (error) {
        console.error(`[TIME_SYNC] ❌ Lỗi đồng bộ thời gian Binance: ${error.msg || error.message}.`);
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
        console.error(`[BINANCE_API] Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}. Path: ${requestPath}`);
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

                    if (!isNaN(maxLongLev) && maxLongLev > 0 && !isNaN(maxShortLev) && maxShortLev > 0) {
                        parsedLeverage = Math.max(maxLongLev, maxShortLev);
                        return parsedLeverage;
                    } else {
                        lastError = { code: parsedJson.code, msg: 'No valid maxLongLeverage/maxShortLeverage found in data', type: 'API_RESPONSE_PARSE_ERROR', rawResponse: rawRes };
                    }
                } else {
                    lastError = { code: parsedJson.code, msg: parsedJson.msg || 'Invalid API Response Structure', type: 'API_RESPONSE_ERROR', rawResponse: rawRes };
                }
            } catch (jsonParseError) {
                lastError = { code: 'JSON_PARSE_ERROR', msg: jsonParseError.message, type: 'JSON_PARSE_ERROR', rawResponse: rawRes };
            }

            if (lastError && lastError.type !== 'HTTP_ERROR' && i < retries - 1) {
                await sleep(BINGX_SINGLE_REQUEST_DELAY_MS);
                continue;
            }
            break;
        } catch (e) {
            lastError = { code: e.code, msg: e.msg || e.message, statusCode: e.statusCode || 'N/A', type: 'HTTP_ERROR', rawResponse: e.rawResponse || lastRawData };

            const errorSignature = `${e.code}-${e.statusCode}-${e.msg?.substring(0, 50)}`;
            const now = Date.now();
            if (!bingxErrorLogCache[errorSignature] || (now - bingxErrorLogCache[errorSignature] > BINGX_ERROR_LOG_COOLDOWN_MS)) {
                let logMsg = `[BINGX] Lỗi lấy leverage cho ${symbol} (Lần ${i+1}/${retries}): ${e.msg || e.message}`;
                if (lastError.rawResponse) {
                    logMsg += ` Raw: ${lastError.rawResponse.substring(0, Math.min(lastError.rawResponse.length, 500))}...`;
                }
                console.warn(logMsg);
                bingxErrorLogCache[errorSignature] = now;
            }

            if (e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT_ERROR' || (e.statusCode >= 500 && e.statusCode < 600) || e.code === 100410) {
                const delay = 2 ** i * BINGX_SINGLE_REQUEST_DELAY_MS;
                console.warn(`[BINGX] Lỗi tạm thời (có thể do rate limit). Thử lại sau ${delay / 1000}s.`);
                await sleep(delay);
                continue;
            } else if (e.statusCode === 400 || e.statusCode === 401 || e.statusCode === 403 || e.code === 1015 || e.code === 429) {
                 if (i < retries - 1) {
                    console.warn(`[BINGX] Lỗi định dạng phản hồi/xác thực/rate limit. Thử lại sau ${BINGX_SINGLE_REQUEST_DELAY_MS / 1000}s.`);
                    await sleep(BINGX_SINGLE_REQUEST_DELAY_MS);
                    continue;
                 }
            }
            break;
        }
    }
    if (parsedLeverage === null) {
        console.error(`[BINGX_LEVERAGE_FINAL_FAIL] ❌ Không thể lấy max leverage cho ${symbol} sau ${retries} lần thử. Lỗi cuối: ${lastError?.msg || 'N/A'}`);
    }
    return parsedLeverage;
}

async function getBingxSymbolsDirect() {
    const urlPath = '/openApi/swap/v2/quote/contracts';
    try {
        const data = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath);
        const json = JSON.parse(data);
        if (json.code === 0 && Array.isArray(json.data)) {
            const symbols = json.data.filter(item => item.symbol.includes('USDT')).map(item => item.symbol);
            return symbols;
        } else {
            console.error(`[BINGX_SYMBOLS] Lỗi khi lấy danh sách symbol BingX: Code ${json.code}, Msg: ${json.msg}. Raw: ${data.substring(0, Math.min(data.length, 200))}`);
            return [];
        }
    } catch (e) {
        console.error(`[BINGX_SYMBOLS] Lỗi request khi lấy danh sách symbol BingX: ${e.msg || e.message}`);
        return [];
    }
}

async function getBingxFundingRateDirect(symbol) {
    const urlPath = `/openApi/swap/v2/quote/fundingRate?symbol=${encodeURIComponent(symbol)}`;
    try {
        const data = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath);
        const json = JSON.parse(data);
        if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
            const firstData = json.data[0];

            if (typeof firstData.fundingRate !== 'string') {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingRate không phải string. Type: ${typeof firstData.fundingRate}. Value: ${firstData.fundingRate}`);
                return null;
            }
            if (isNaN(parseFloat(firstData.fundingRate))) {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingRate không parse được số. Value: ${firstData.fundingRate}`);
                return null;
            }
            if (!firstData.fundingTime) {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingTime bị thiếu hoặc null. Value: ${firstData.fundingTime}`);
                return null;
            }
            
            return {
                symbol: cleanSymbol(firstData.symbol), 
                fundingRate: parseFloat(firstData.fundingRate),
                fundingTime: parseInt(firstData.fundingTime, 10)
            };
        } else {
            console.warn(`[BINGX_FUNDING] Không có dữ liệu funding hoặc lỗi API cho ${symbol}. Code: ${json.code}, Msg: ${json.msg || 'N/A'}. Raw: ${data.substring(0, Math.min(data.length, 200))}`);
            return null;
        }
    } catch (e) {
        console.warn(`[BINGX_FUNDING] Lỗi request khi lấy funding rate cho ${symbol}: ${e.msg || e.message}.`);
        if (e.rawResponse) {
             console.warn(`[BINGX_FUNDING_RAW] ${symbol} Raw response: ${e.rawResponse.substring(0, Math.min(e.rawResponse.length, 500))}`);
        }
        return null;
    }
}

// Hàm mới để lấy funding time từ Bitget Native REST API (đã khôi phục)
async function fetchBitgetFundingTimeNativeApi(apiSymbol) {
    try {
        const formattedApiSymbol = apiSymbol.includes('_UMCBL') ? apiSymbol : `${apiSymbol}_UMCBL`;
        const apiPath = `/api/mix/v1/market/funding-time?symbol=${encodeURIComponent(formattedApiSymbol)}`;
        const rawData = await makeHttpRequest('GET', BITGET_NATIVE_REST_HOST, apiPath);
        const json = JSON.parse(rawData);

        if (json.code === '00000' && json.data) {
            const fundingData = Array.isArray(json.data) ? json.data[0] : json.data;
            if (fundingData && fundingData.fundingTime) {
                const parsedFundingTime = parseInt(fundingData.fundingTime, 10);
                if (!isNaN(parsedFundingTime) && parsedFundingTime > 0) {
                    return parsedFundingTime;
                }
            }
        }
        // console.warn(`[BITGET_FUNDING_TIME_NATIVE] ⚠️ Không lấy được fundingTime hợp lệ cho ${apiSymbol}. Raw: ${rawData.substring(0, Math.min(rawData.length, 200))}`); // Tắt log này
        return null;
    } catch (e) {
        console.error(`[BITGET_FUNDING_TIME_NATIVE] ❌ Lỗi khi lấy funding time cho ${apiSymbol} từ native API: ${e.msg || e.message}.`);
        return null;
    }
}


/**
 * Cập nhật Max Leverage cho một sàn cụ thể.
 * @param {string} id ID của sàn giao dịch (e.g., 'binanceusdm', 'bingx').
 * @param {string[]} [symbolsToUpdate] Mảng các symbol cần cập nhật.
 * @returns {Promise<{ id: string, processedData: Object, status: string, error: object | null }>}
*/
async function updateLeverageForExchange(id, symbolsToUpdate = null) {
    const exchange = exchanges[id];
    let currentFetchedLeverageDataMap = {};
    const updateType = symbolsToUpdate ? 'mục tiêu' : 'toàn bộ';
    let status = `Đang tải đòn bẩy (${updateType})...`;
    let error = null;

    debugRawLeverageResponses[id].status = status;
    debugRawLeverageResponses[id].timestamp = new Date();
    debugRawLeverageResponses[id].error = null;

    try {
        if (id === 'binanceusdm') {
            await syncBinanceServerTime();
            const leverageBracketsResponse = await callSignedBinanceAPI('/fapi/v1/leverageBracket', 'GET');

            let successCount = 0;
            if (Array.isArray(leverageBracketsResponse)) {
                for (const item of leverageBracketsResponse) {
                    if (!item.symbol.includes('USDT')) {
                        continue;
                    }
                    const cleanedSym = cleanSymbol(item.symbol);
                    if (symbolsToUpdate && !symbolsToUpdate.includes(cleanedSym)) {
                        continue;
                    }
                    if (item.symbol && Array.isArray(item.brackets) && item.brackets.length > 0) {
                        const firstBracket = item.brackets.find(b => b.bracket === 1) || item.brackets[0];
                        const maxLeverage = parseInt(firstBracket.initialLeverage, 10);
                        if (!isNaN(maxLeverage) && maxLeverage > 0) {
                            currentFetchedLeverageDataMap[cleanedSym] = maxLeverage; 
                            successCount++;
                        }
                    }
                }
                status = `Đòn bẩy hoàn tất (${successCount} cặp)`;
                debugRawLeverageResponses[id].data = `Đã lấy ${successCount} cặp.`; 
                console.log(`[CACHE] ✅ Binance: Đã lấy ${successCount} cặp đòn bẩy USDT từ API trực tiếp.`);

            }
        }
        else if (id === 'bingx') {
            await exchange.loadMarkets(true);
            const bingxMarkets = Object.values(exchange.markets)
                .filter(m => m.swap && m.symbol.includes('USDT')); 

            const marketsToFetch = symbolsToUpdate && symbolsToUpdate.length > 0
                ? bingxMarkets.filter(market => symbolsToUpdate.includes(cleanSymbol(market.symbol)))
                : bingxMarkets;

            const totalSymbols = marketsToFetch.length;

            console.log(`[CACHE] ${id.toUpperCase()}: Bắt đầu lấy dữ liệu đòn bẩy cho ${totalSymbols} cặp (loại: ${updateType})...`);

            let fetchedCount = 0;
            let successCount = 0;
            const marketChunks = [];
            for (let i = 0; i < marketsToFetch.length; i += BINGX_CONCURRENT_FETCH_LIMIT) {
                marketChunks.push(marketsToFetch.slice(i, i + BINGX_CONCURRENT_FETCH_LIMIT));
            }

            for (const chunk of marketChunks) {
                const chunkPromises = chunk.map(async market => {
                    const formattedSymbolForAPI = market.symbol.replace('/', '-').replace(':USDT', ''); 
                    const parsedMaxLeverage = await fetchBingxMaxLeverage(formattedSymbolForAPI);
                    fetchedCount++;
                    debugRawLeverageResponses[id].status = `Đang tải đòn bẩy BingX (${fetchedCount}/${totalSymbols})`;
                    debugRawLeverageResponses[id].timestamp = new Date();
                    if (parsedMaxLeverage !== null && parsedMaxLeverage > 0) {
                        const cleanedSymForCache = cleanSymbol(market.symbol); 
                        currentFetchedLeverageDataMap[cleanedSymForCache] = parsedMaxLeverage; 
                        successCount++;
                    } else {
                        console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không lấy được leverage hợp lệ cho ${market.symbol}.`);
                    }
                    return true;
                });
                await Promise.allSettled(chunkPromises);
                
                if (marketChunks.indexOf(chunk) < marketChunks.length - 1) {
                    await sleep(BINGX_DELAY_BETWEEN_BATCHES_MS);
                }
            }
            status = `Đòn bẩy BingX hoàn tất (${successCount} cặp)`;
            console.log(`[CACHE] ✅ ${id.toUpperCase()}: Hoàn tất lấy dữ liệu đòn bẩy cho ${Object.keys(currentFetchedLeverageDataMap).length} cặp. (${successCount} cặp được parse thành công)`);
            
            if (successCount > 0) {
                debugRawLeverageResponses[id].data = `Đã lấy ${successCount} cặp đòn bẩy.`; 
            } else {
                debugRawLeverageResponses[id].data = 'Không có dữ liệu đòn bẩy hợp lệ nào được tìm thấy.';
            }

        }
        else { // OKX và Bitget: Dùng CCXT (fetchLeverageTiers + loadMarkets fallback)
            await exchange.loadMarkets(true);
            
            let successCount = 0;
            if (exchange.has['fetchLeverageTiers']) {
                const leverageTiers = await exchange.fetchLeverageTiers();
                for (const symbol in leverageTiers) {
                    const cleanedSym = cleanSymbol(symbol);
                    if (symbolsToUpdate && !symbolsToUpdate.includes(cleanedSym)) {
                        continue;
                    }
                    const market = exchange.markets[symbol];
                    if (!market || !market.swap || !market.symbol.includes('USDT')) {
                        continue;
                    }

                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        const numericLeverages = tiers.map(t => typeof t.leverage === 'number' ? t.leverage : parseFloat(t.leverage)).filter(l => !isNaN(l) && l > 0);
                        const parsedMaxLeverage = numericLeverages.length > 0 ? parseInt(Math.max(...numericLeverages), 10) : 0;
                        if (parsedMaxLeverage > 0) {
                            currentFetchedLeverageDataMap[cleanedSym] = parsedMaxLeverage;
                            successCount++;
                        }
                    }
                }
                status = `Đòn bẩy hoàn tất (${successCount} cặp)`;
                debugRawLeverageResponses[id].data = `Đã lấy ${successCount} cặp.`;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã lấy ${successCount} cặp đòn bẩy USDT từ fetchLeverageTiers.`);
            } else {
                console.log(`[CACHE] ${id.toUpperCase()}: fetchLeverageTiers không khả dụng. Dùng loadMarkets...`);
                let loadMarketsSuccessCount = 0;
                for (const market of Object.values(exchange.markets)) {
                    if (!market.swap || !market.symbol.includes('USDT')) {
                        continue;
                    }

                    const cleanedSym = cleanSymbol(market.symbol);
                    if (symbolsToUpdate && !symbolsToUpdate.includes(cleanedSym)) {
                        continue;
                    }
                    const maxLeverage = getMaxLeverageFromMarketInfo(market);
                    if (maxLeverage !== null && maxLeverage > 0) {
                        currentFetchedLeverageDataMap[cleanedSym] = maxLeverage;
                        loadMarketsSuccessCount++;
                    } else {
                        // console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`); // Tắt log này
                    }
                }
                status = `Đòn bẩy hoàn tất (loadMarkets, ${loadMarketsSuccessCount} cặp)`;
                debugRawLeverageResponses[id].data = `Đã lấy ${loadMarketsSuccessCount} cặp.`;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã lấy ${loadMarketsSuccessCount} cặp đòn bẩy USDT từ loadMarkets.`);
            }
        }
        
        if (symbolsToUpdate) {
            symbolsToUpdate.forEach(sym => {
                if (currentFetchedLeverageDataMap[sym]) {
                    leverageCache[id][sym] = currentFetchedLeverageDataMap[sym];
                }
            });
            console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã cập nhật ${Object.keys(leverageCache[id]).length} cặp đòn bẩy mục tiêu.`);
        } else {
            leverageCache[id] = currentFetchedLeverageDataMap;
            console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số mục đòn bẩy hiện tại: ${Object.keys(leverageCache[id]).length}.`);
        }

    } catch (e) {
        let errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
        console.error(`[CACHE] ❌ ${id.toUpperCase()}: ${errorMessage}`);
        status = `Đòn bẩy thất bại (lỗi chung: ${e.code || 'UNKNOWN'})`;
        error = { code: e.code, msg: e.message };
        leverageCache[id] = {}; 
    } finally {
        return { id, processedData: currentFetchedLeverageDataMap, status, error };
    }
}

async function performFullLeverageUpdate() {
    console.log('\n[LEVERAGE_SCHEDULER] 🔄 Bắt đầu cập nhật TOÀN BỘ đòn bẩy cho tất cả các sàn... (được kích hoạt)');
    const nonBingxExchangeIds = EXCHANGE_IDS.filter(id => id !== 'bingx');
    const bingxExchangeId = EXCHANGE_IDS.find(id => id === 'bingx');

    const nonBingxLeveragePromises = nonBingxExchangeIds.map(id => updateLeverageForExchange(id, null));
    const nonBingxResults = await Promise.all(nonBingxLeveragePromises);
    
    nonBingxResults.forEach(res => {
        if (res) {
            debugRawLeverageResponses[res.id].status = res.status;
            debugRawLeverageResponses[res.id].timestamp = new Date();
            debugRawLeverageResponses[res.id].error = res.error;
        }
    });

    if (bingxExchangeId) {
        console.log(`[LEVERAGE_SCHEDULER] ⏳ Bắt đầu cập nhật đòn bẩy BingX trong nền sau ${DELAY_BEFORE_BINGX_MS / 1000} giây.`);
        setTimeout(async () => {
            const bingxResult = await updateLeverageForExchange(bingxExchangeId, null);
            if (bingxResult) {
                debugRawLeverageResponses[bingxResult.id].status = bingxResult.status;
                debugRawLeverageResponses[bingxResult.id].timestamp = new Date();
                debugRawLeverageResponses[bingxResult.id].error = bingxResult.error;
                console.log('[LEVERAGE_SCHEDULER] ✅ Cập nhật đòn bẩy BingX trong nền hoàn tất.');
            }
        }, DELAY_BEFORE_BINGX_MS);
    }
    console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất kích hoạt cập nhật đòn bẩy TOÀN BỘ (trừ BingX đang chạy nền).');
}

async function performTargetedLeverageUpdate() {
    console.log('\n[LEVERAGE_SCHEDULER] 🎯 Bắt đầu cập nhật đòn bẩy MỤC TIÊU...');
    const activeSymbols = new Set();
    arbitrageOpportunities.forEach(op => activeSymbols.add(op.coin));

    if (activeSymbols.size === 0) {
        console.log('[LEVERAGE_SCHEDULER] Không có cơ hội arbitrage nào. Bỏ qua cập nhật đòn bẩy mục tiêu.');
        EXCHANGE_IDS.forEach(id => {
            debugRawLeverageResponses[id].status = 'Đòn bẩy bỏ qua (không có cơ hội)';
            debugRawLeverageResponses[id].timestamp = new Date();
            debugRawLeverageResponses[id].error = null;
        });
        return;
    }

    console.log(`[LEVERAGE_SCHEDULER] 🎯 Bắt đầu cập nhật đòn bẩy MỤC TIÊU cho ${activeSymbols.size} symbol.`);
    const symbolsArray = Array.from(activeSymbols);
    const nonBingxExchangeIds = EXCHANGE_IDS.filter(id => id !== 'bingx');
    const bingxExchangeId = EXCHANGE_IDS.find(id => id === 'bingx');

    const nonBingxLeveragePromises = nonBingxExchangeIds.map(id => updateLeverageForExchange(id, symbolsArray));
    const nonBingxResults = await Promise.all(nonBingxLeveragePromises);

    nonBingxResults.forEach(res => {
        if (res) {
            debugRawLeverageResponses[res.id].status = res.status;
            debugRawLeverageResponses[res.id].timestamp = new Date();
            debugRawLeverageResponses[res.id].error = res.error;
        }
    });
    
    if (bingxExchangeId) {
        console.log(`[LEVERAGE_SCHEDULER] ⏳ Đã cập nhật đòn bẩy mục tiêu cho các sàn khác. Bắt đầu cập nhật BingX trong nền sau ${DELAY_BEFORE_BINGX_MS / 1000} giây.`);
        setTimeout(async () => {
            const bingxResult = await updateLeverageForExchange(bingxExchangeId, symbolsArray);
            if (bingxResult) {
                debugRawLeverageResponses[bingxResult.id].status = bingxResult.status;
                debugRawLeverageResponses[bingxResult.id].timestamp = new Date();
                debugRawLeverageResponses[bingxResult.id].error = bingxResult.error;
                console.log('[LEVERAGE_SCHEDULER] ✅ Cập nhật đòn bẩy BingX mục tiêu trong nền hoàn tất.');
            }
        }, DELAY_BEFORE_BINGX_MS);
    }
    console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất kích hoạt cập nhật đòn bẩy MỤC TIÊU (trừ BingX đang chạy nền).');
}


async function fetchBitgetValidFuturesSymbols() {
    console.log('[BITGET_SYMBOLS] 🔄 Đang tải danh sách symbol Futures hợp lệ từ Bitget...');
    try {
        const apiPath = '/api/mix/v1/market/contracts?productType=umcbl';
        const rawData = await makeHttpRequest('GET', BITGET_NATIVE_REST_HOST, apiPath);
        const json = JSON.parse(rawData);

        if (json.code === '00000' && Array.isArray(json.data)) {
            bitgetValidFuturesSymbolSet.clear(); 
            json.data.forEach(contract => {
                if (contract.symbol) {
                    bitgetValidFuturesSymbolSet.add(contract.symbol); 
                }
            });
            console.log(`[BITGET_SYMBOLS] ✅ Đã tải ${bitgetValidFuturesSymbolSet.size} symbol Futures hợp lệ từ Bitget.`);
            if (bitgetValidFuturesSymbolSet.size === 0) {
                 console.warn('[BITGET_SYMBOLS] ⚠️ Bitget Native API trả về 0 symbol hợp lệ. Có thể ảnh hưởng đến việc lấy data.');
            }
            return bitgetValidFuturesSymbolSet;
        } else {
            console.error(`[BITGET_SYMBOLS] ❌ Lỗi khi tải danh sách symbol Futures Bitget: Code ${json.code}, Msg: ${json.msg || 'N/A'}. Raw: ${rawData.substring(0, Math.min(rawData.length, 200))}`);
            return new Set(); 
        }
    } catch (e) {
        console.error(`[BITGET_SYMBOLS] ❌ Lỗi request khi tải danh sách symbol Futures Bitget: ${e.msg || e.message}`);
        return new Set();
    }
}


function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16]; 
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);
    const nextFundingDate = new Date(now);

    if (nextHourUTC === undefined) { 
        nextHourUTC = fundingHoursUTC[0]; 
        nextFundingDate.setUTCDate(now.getUTCDate() + 1); 
    }
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0); 
    return nextFundingDate.getTime();
}

/**
 * Kiểm tra xem có đang trong khoảng thời gian tạm dừng cập nhật (phút 59 đến phút 2 UTC) hay không.
 * @returns {boolean} True nếu đang tạm dừng, ngược lại là false.
 */
function isFundingUpdatePaused() {
    const now = new Date();
    const utcMinute = now.getUTCMinutes();
    // Tạm dừng từ phút 59 đến hết phút 2 (tức là 59, 00, 01, 02)
    return utcMinute === 59 || utcMinute === 0 || utcMinute === 1 || utcMinute === 2;
}

/**
 * Kiểm tra xem có đang trong cửa sổ cập nhật siêu ưu tiên BingX (phút 55 đến phút 59 UTC) hay không.
 * @returns {boolean} True nếu đang trong cửa sổ, ngược lại là false.
 */
function isBingxInSuperPriorityWindow() {
    const now = new Date();
    const utcMinute = now.getUTCMinutes();
    return utcMinute >= BINGX_SUPER_PRIORITY_WINDOW_START_MINUTE && utcMinute < BINGX_SUPER_PRIORITY_WINDOW_END_MINUTE;
}

/**
 * Tính toán độ trễ để đợi đến đầu phút 55 UTC tiếp theo.
 * @returns {number} Thời gian chờ (ms).
 */
function calculateDelayToNextBingxSuperPriorityWindow() {
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();
    const currentMs = now.getUTCMilliseconds();

    let delayMs;

    if (currentMinute < BINGX_SUPER_PRIORITY_WINDOW_START_MINUTE) {
        // Vẫn trong cùng giờ, trước phút 55
        delayMs = (BINGX_SUPER_PRIORITY_WINDOW_START_MINUTE - currentMinute) * 60 * 1000 
                  - currentSecond * 1000 - currentMs;
    } else {
        // Đã qua phút 55 trong giờ hiện tại, hoặc đang ở phút 55 trở đi
        // Lập lịch cho phút 55 của giờ tiếp theo
        delayMs = (60 - currentMinute + BINGX_SUPER_PRIORITY_WINDOW_START_MINUTE) * 60 * 1000 
                  - currentSecond * 1000 - currentMs;
    }
    // Đảm bảo có độ trễ tối thiểu để tránh vòng lặp tức thời trên cạnh phút
    return Math.max(1000, delayMs); 
}


/**
 * Cập nhật funding rates cho các sàn non-BingX.
 * @returns {Promise<void>}
 */
async function fetchFundingRatesForAllExchanges() {
    if (isFundingUpdatePaused()) {
        console.log('[DATA] ⏸️ Tạm dừng cập nhật funding rates non-BingX từ phút 59 đến phút 2 UTC.');
        return;
    }
    console.log('[DATA] Bắt đầu làm mới funding rates cho các sàn non-BingX...');

    const nonBingxExchangeIds = EXCHANGE_IDS.filter(id => id !== 'bingx');
    const nonBingxResultsSummary = []; 

    const nonBingxFundingPromises = nonBingxExchangeIds.map(async (id) => {
        let processedRates = {};
        let currentStatus = 'Đang tải funding...';
        let currentError = null;
        let successCount = 0; 

        try {
            await exchanges[id].loadMarkets(true);
            const exchange = exchanges[id];
            const fundingRatesRaw = await exchange.fetchFundingRates();
            
            if (id === 'bitget' && bitgetValidFuturesSymbolSet.size === 0) {
                await fetchBitgetValidFuturesSymbols();
                if (bitgetValidFuturesSymbolSet.size === 0) {
                    currentError = { code: 'NO_VALID_SYMBOLS', msg: 'Could not fetch valid Bitget symbols.' };
                    throw new Error('Failed to load valid Bitget symbols for funding rates.');
                }
            }

            for (const rate of Object.values(fundingRatesRaw)) {
                if (rate.type && rate.type !== 'swap' && rate.type !== 'future') {
                     continue;
                }
                if (rate.info?.contractType && rate.info.contractType !== 'PERPETUAL') {
                    continue;
                }
                if (!rate.symbol.includes('USDT')) { 
                    continue;
                }
                
                const symbolCleaned = cleanSymbol(rate.symbol);
                const maxLeverageParsed = leverageCache[id]?.[symbolCleaned] || null;

                let fundingRateValue = rate.fundingRate; 
                let fundingTimestampValue = rate.fundingTimestamp || rate.nextFundingTime; 

                if (id === 'bitget') {
                    const bitgetApiSymbol = cleanSymbol(rate.symbol); 
                    const symbolForNativeApi = bitgetApiSymbol.includes('_UMCBL') ? bitgetApiSymbol : `${bitgetApiSymbol}_UMCBL`;

                    if (!bitgetValidFuturesSymbolSet.has(symbolForNativeApi)) {
                        continue; 
                    }
                    
                    const nativeFundingTime = await fetchBitgetFundingTimeNativeApi(bitgetApiSymbol);
                    if (nativeFundingTime !== null) {
                        fundingTimestampValue = nativeFundingTime; 
                    } else {
                        if (!fundingTimestampValue || fundingTimestampValue <= 0) {
                            fundingTimestampValue = calculateNextStandardFundingTime(); 
                        }
                    }
                }
                
                if (!fundingTimestampValue || fundingTimestampValue <= 0) {
                    fundingTimestampValue = calculateNextStandardFundingTime();
                }

                if (typeof fundingRateValue === 'number' && !isNaN(fundingRateValue) && typeof fundingTimestampValue === 'number' && fundingTimestampValue > 0) {
                    processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: fundingRateValue, fundingTimestamp: fundingTimestampValue, maxLeverage: maxLeverageParsed };
                    successCount++;
                } else {
                    // YÊU CẦU 1: Tắt log cập nhật funding trừ bingx
                    // console.warn(`[DATA] ⚠️ ${id.toUpperCase()}: Bỏ qua ${rate.symbol} - Funding rate hoặc timestamp không hợp lệ hoặc thiếu. Rate: ${fundingRateValue}, Timestamp: ${fundingTimestampValue}.`);
                }
            }
            currentStatus = `Funding hoàn tất (${successCount} cặp)`;
            nonBingxResultsSummary.push(`${id.toUpperCase()}: ${successCount} cặp`);
        } catch (e) {
            let errorMessage = `Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}.`;
            console.error(`[DATA] ❌ ${id.toUpperCase()}: ${errorMessage}`);
            currentStatus = `Funding thất bại (lỗi: ${e.code || 'UNKNOWN'})`;
            currentError = { code: e.code, msg: e.message };
            nonBingxResultsSummary.push(`${id.toUpperCase()}: LỖI (${e.code || 'UNKNOWN'})`);
        } finally {
            exchangeData = { ...exchangeData, [id]: { rates: processedRates } };
            debugRawLeverageResponses[id].status = currentStatus;
            debugRawLeverageResponses[id].timestamp = new Date();
            debugRawLeverageResponses[id].data = `Đã lấy ${Object.keys(processedRates).length} cặp.`;
            debugRawLeverageResponses[id].error = currentError;
            return { id };
        }
    });

    await Promise.all(nonBingxFundingPromises);
    console.log(`[DATA] ✅ Hoàn tất làm mới funding rates cho các sàn non-BingX: ${nonBingxResultsSummary.join(', ')}. Tính toán cơ hội lần đầu.`);
    calculateArbitrageOpportunities(); 
}


/**
 * Thực hiện một vòng cập nhật đầy đủ funding rates cho tất cả các symbol BingX.
 * @returns {Promise<number>} Số lượng symbol được cập nhật thành công.
 */
async function performBingxFundingRateUpdateRound() {
    const bingxExchangeId = 'bingx';
    let processedRates = {};
    let currentStatus = 'Đang tải funding...';
    let currentError = null;
    let successCount = 0;

    console.log(`[BINGX_CONTINUOUS] 🔄 Bắt đầu vòng cập nhật funding rates BingX đầy đủ...`);
    lastBingxFullUpdateStartTime = Date.now(); 

    try {
        const symbols = await getBingxSymbolsDirect(); 
        let fetchedCount = 0; 
        const marketChunks = [];
        for (let i = 0; i < symbols.length; i += BINGX_CONCURRENT_FETCH_LIMIT) {
            marketChunks.push(symbols.slice(i, i + BINGX_CONCURRENT_FETCH_LIMIT));
        }

        for (const chunk of marketChunks) {
            if (isBingxPriorityUpdateActive) {
                console.log(`[BINGX_CONTINUOUS] ⏸️ Tạm dừng vòng cập nhật BingX đầy đủ vì cập nhật ưu tiên (5 phút) đang chạy.`);
                throw new Error('Priority update active, pausing full BingX update.');
            }
            if (isBingxSuperPriorityUpdateActive) {
                console.log(`[BINGX_CONTINUOUS] ⏸️ Tạm dừng vòng cập nhật BingX đầy đủ vì cập nhật siêu ưu tiên đang chạy.`);
                throw new Error('Super priority update active, pausing full BingX update.');
            }
            if (isFundingUpdatePaused()) {
                console.log(`[BINGX_CONTINUOUS] ⏸️ Tạm dừng vòng cập nhật BingX đầy đủ do tạm dừng chung (phút 59-2 UTC).`);
                throw new Error('Global update paused, pausing full BingX update.');
            }

            const chunkPromises = chunk.map(async (symbol) => {
                const result = await getBingxFundingRateDirect(symbol); 
                fetchedCount++;
                debugRawLeverageResponses[bingxExchangeId].status = `Đang tải funding BingX (${fetchedCount}/${symbols.length})`;
                debugRawLeverageResponses[bingxExchangeId].timestamp = new Date();
                
                if (result && typeof result.fundingRate === 'number' && result.fundingTime) {
                    const symbolCleanedForStore = cleanSymbol(result.symbol); 
                    const maxLeverageParsed = leverageCache[bingxExchangeId]?.[symbolCleanedForStore] || null;

                    processedRates[symbolCleanedForStore] = { 
                        symbol: symbolCleanedForStore, 
                        fundingRate: result.fundingRate,
                        fundingTimestamp: result.fundingTime,
                        maxLeverage: maxLeverageParsed
                    };
                    successCount++; 
                } else {
                    console.warn(`[DEBUG_FUNDING] ⚠️ BingX: Không lấy được funding rate hợp lệ cho ${symbol}.`);
                }
                return false;
            });
            await Promise.allSettled(chunkPromises);
            
            if (marketChunks.indexOf(chunk) < marketChunks.length - 1) {
                await sleep(BINGX_DELAY_BETWEEN_BATCHES_MS);
            }
        }
        currentStatus = `Funding BingX hoàn tất (${successCount} cặp)`;
        console.log(`[BINGX_CONTINUOUS] ✅ BingX: Đã lấy thành công ${successCount} funding rates từ API trực tiếp.`);
        
        if (successCount > 0) {
            debugRawLeverageResponses[bingxExchangeId].data = `Đã lấy ${successCount} cặp funding.`;
        } else {
            debugRawLeverageResponses[bingxExchangeId].data = 'Không có dữ liệu funding hợp lệ nào được tìm thấy.';
        }

    } catch (e) {
        if (e.message.includes('Priority update active') || e.message.includes('Super priority update active') || e.message.includes('Global update paused')) {
            console.log(`[BINGX_CONTINUOUS] Vòng cập nhật BingX đầy đủ đã tạm dừng.`);
        } else {
            let errorMessage = `Lỗi khi lấy funding từ ${bingxExchangeId.toUpperCase()}: ${e.message}.`;
            console.error(`[BINGX_CONTINUOUS] ❌ ${bingxExchangeId.toUpperCase()}: ${errorMessage}`);
            currentStatus = `Funding thất bại (lỗi: ${e.code || 'UNKNOWN'})`;
            currentError = { code: e.code, msg: e.message };
        }
        successCount = 0; 
    } finally {
        exchangeData = { ...exchangeData, [bingxExchangeId]: { rates: processedRates } };
        calculateArbitrageOpportunities(); 
        return successCount;
    }
}


/**
 * Vòng lặp liên tục để cập nhật funding rates của BingX.
 */
async function bingxContinuousFundingLoop() {
    clearTimeout(bingxContinuousLoopTimeoutId); 

    const now = Date.now();

    if (isFundingUpdatePaused()) {
        console.log('[BINGX_LOOP] ⏸️ BingX Continuous Loop: Tạm dừng từ phút 59 đến phút 2 UTC. Kiểm tra lại sau 30 giây.');
        bingxContinuousLoopTimeoutId = setTimeout(bingxContinuousFundingLoop, 30 * 1000); 
        return;
    }

    if (isBingxPriorityUpdateActive) {
        console.log('[BINGX_LOOP] ⏳ BingX Continuous Loop: Cập nhật ưu tiên (5 phút) đang chạy. Đợi 10 giây...');
        bingxContinuousLoopTimeoutId = setTimeout(bingxContinuousFundingLoop, 10 * 1000); 
        return;
    }

    if (isBingxSuperPriorityUpdateActive) {
        console.log('[BINGX_LOOP] ⏳ BingX Continuous Loop: Cập nhật siêu ưu tiên đang chạy. Đợi 10 giây...');
        bingxContinuousLoopTimeoutId = setTimeout(bingxContinuousFundingLoop, 10 * 1000); 
        return;
    }
    
    try {
        const startTime = Date.now();
        console.log(`[BINGX_LOOP] 🚀 Bắt đầu vòng lặp cập nhật BingX đầy đủ lúc ${new Date().toLocaleTimeString()}...`);
        const updatedCount = await performBingxFundingRateUpdateRound();
        const endTime = Date.now();
        const durationMinutes = ((endTime - startTime) / (1000 * 60)).toFixed(2);
        
        console.log(`[BINGX_LOOP] ✅ Hoàn tất 1 vòng cập nhật BingX đầy đủ cho ${updatedCount} cặp. Mất ${durationMinutes} phút.`);

    } catch (error) {
        console.error(`[BINGX_LOOP] ❌ Lỗi trong vòng lặp cập nhật BingX đầy đủ: ${error.message}`);
    } finally {
        bingxContinuousLoopTimeoutId = setTimeout(bingxContinuousFundingLoop, 0); 
    }
}


/**
 * Lập lịch và thực hiện cập nhật funding rate ưu tiên (5 phút) cho BingX.
 */
async function bingxPriorityUpdateScheduler() {
    clearTimeout(bingxPriorityLoopTimeoutId); 

    const now = Date.now();

    if (isFundingUpdatePaused()) {
        console.log('[BINGX_PRIORITY] ⏸️ Tạm dừng cập nhật ưu tiên BingX từ phút 59 đến phút 2 UTC. Kiểm tra lại sau 30 giây.');
        bingxNextPriorityUpdateTime = now + 30 * 1000; 
        bingxPriorityLoopTimeoutId = setTimeout(bingxPriorityUpdateScheduler, 30 * 1000);
        return;
    }

    if (isBingxSuperPriorityUpdateActive) {
        console.log('[BINGX_PRIORITY] ⏳ Cập nhật ưu tiên (5 phút) tạm dừng vì siêu ưu tiên đang chạy. Kiểm tra lại sau 10 giây.');
        bingxPriorityLoopTimeoutId = setTimeout(bingxPriorityUpdateScheduler, 10 * 1000);
        return;
    }

    if (now < bingxNextPriorityUpdateTime) {
        const remainingDelay = bingxNextPriorityUpdateTime - now;
        console.log(`[BINGX_PRIORITY] ⏳ Chờ đến lượt cập nhật ưu tiên BingX (5 phút). Còn ${Math.ceil(remainingDelay / 1000)} giây.`);
        bingxPriorityLoopTimeoutId = setTimeout(bingxPriorityUpdateScheduler, remainingDelay);
        return;
    }

    bingxNextPriorityUpdateTime = now + BINGX_PRIORITY_UPDATE_INTERVAL_MINUTES * 60 * 1000;

    const bingxExchangeId = 'bingx';
    const prioritySymbols = arbitrageOpportunities
        .filter(op => op.details.shortExchange === bingxExchangeId.replace('usdm', '') || op.details.longExchange === bingxExchangeId.replace('usdm', ''))
        .filter(op => op.estimatedPnl >= MINIMUM_PNL_THRESHOLD)
        .map(op => op.coin);
    
    const uniquePrioritySymbols = Array.from(new Set(prioritySymbols));

    if (uniquePrioritySymbols.length === 0) {
        console.log('[BINGX_PRIORITY] Không có coin BingX nào đủ điều kiện ưu tiên (5 phút). Đặt lịch chạy tiếp theo.');
        bingxPriorityLoopTimeoutId = setTimeout(bingxPriorityUpdateScheduler, BINGX_PRIORITY_UPDATE_INTERVAL_MINUTES * 60 * 1000);
        return;
    }

    console.log(`\n[BINGX_PRIORITY] 🔥 Bắt đầu cập nhật ưu tiên (5 phút) BingX cho ${uniquePrioritySymbols.length} coin: ${uniquePrioritySymbols.join(', ')}`);
    isBingxPriorityUpdateActive = true; 

    let successfulPriorityUpdates = 0;
    try {
        const symbolsToFetchInBatch = uniquePrioritySymbols; 
        
        const batchSize = BINGX_CONCURRENT_FETCH_LIMIT; 
        for (let i = 0; i < symbolsToFetchInBatch.length; i += batchSize) {
            const batch = symbolsToFetchInBatch.slice(i, i + batchSize);
            const batchPromises = batch.map(async (cleanSym) => {
                const bingxMarket = Object.values(exchanges[bingxExchangeId].markets).find(m => cleanSymbol(m.symbol) === cleanSym);
                if (!bingxMarket) {
                    console.warn(`[BINGX_PRIORITY] ⚠️ Không tìm thấy market BingX cho symbol sạch: ${cleanSym}`);
                    return null;
                }
                const formattedSymbolForAPI = bingxMarket.symbol.replace('/', '-').replace(':USDT', '');

                const result = await getBingxFundingRateDirect(formattedSymbolForAPI);
                if (result && typeof result.fundingRate === 'number' && result.fundingTime) {
                    // YÊU CẦU 2: Log raw dữ liệu coin ưu tiên
                    console.log(`[BINGX_PRIORITY_RAW_DATA] ✅ Coin ưu tiên: ${cleanSym}, Raw Funding Data: ${JSON.stringify(result)}`);
                    const maxLeverageParsed = leverageCache[bingxExchangeId]?.[cleanSym] || null;
                    exchangeData[bingxExchangeId].rates[cleanSym] = {
                        symbol: cleanSym,
                        fundingRate: result.fundingRate,
                        fundingTimestamp: result.fundingTime,
                        maxLeverage: maxLeverageParsed
                    };
                    successfulPriorityUpdates++;
                } else {
                    console.warn(`[BINGX_PRIORITY] ⚠️ Lỗi cập nhật ưu tiên funding cho ${cleanSym}.`);
                }
            });
            await Promise.allSettled(batchPromises);
            if (i + batchSize < symbolsToFetchInBatch.length) {
                await sleep(BINGX_PRIORITY_UPDATE_COOLDOWN_MS); 
            }
        }

        console.log(`[BINGX_PRIORITY] ✅ Hoàn tất cập nhật ưu tiên (5 phút) BingX cho ${successfulPriorityUpdates} coin.`);
    } catch (error) {
        console.error(`[BINGX_PRIORITY] ❌ Lỗi trong quá trình cập nhật ưu tiên (5 phút) BingX: ${error.message}`);
    } finally {
        isBingxPriorityUpdateActive = false; 
        calculateArbitrageOpportunities(); 
        const delay = bingxNextPriorityUpdateTime - now;
        bingxPriorityLoopTimeoutId = setTimeout(bingxPriorityUpdateScheduler, Math.max(0, delay));
    }
}


/**
 * Vòng lặp liên tục để cập nhật funding rates siêu ưu tiên cho BingX trong cửa sổ phút 55-58.
 */
async function bingxSuperPriorityUpdateLoop() {
    clearTimeout(bingxSuperPriorityLoopTimeoutId); 
    const bingxExchangeId = 'bingx';
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();
    const currentMs = now.getUTCMilliseconds();

    // 1. Kiểm tra cửa sổ thời gian
    if (!isBingxInSuperPriorityWindow()) {
        if (isBingxSuperPriorityUpdateActive) { // Nếu vừa kết thúc cửa sổ
            console.log(`[BINGX_SUPER_PRIORITY] 🏁 Cửa sổ cập nhật siêu ưu tiên BingX đã đóng.`);
            isBingxSuperPriorityUpdateActive = false; 
        }
        const delay = calculateDelayToNextBingxSuperPriorityWindow();
        console.log(`[BINGX_SUPER_PRIORITY] 😴 Đợi đến phút ${BINGX_SUPER_PRIORITY_WINDOW_START_MINUTE} để bắt đầu lại. Còn ${Math.ceil(delay / 1000)} giây.`);
        bingxSuperPriorityLoopTimeoutId = setTimeout(bingxSuperPriorityUpdateLoop, delay);
        return;
    }

    // 2. Kiểm tra tạm dừng chung
    if (isFundingUpdatePaused()) {
        console.log('[BINGX_SUPER_PRIORITY] ⏸️ Tạm dừng siêu ưu tiên BingX từ phút 59 đến phút 2 UTC. Kiểm tra lại sau 30 giây.');
        bingxSuperPriorityLoopTimeoutId = setTimeout(bingxSuperPriorityUpdateLoop, 30 * 1000); 
        return;
    }

    // Nếu đến đây, chúng ta đang trong cửa sổ siêu ưu tiên và không bị tạm dừng
    isBingxSuperPriorityUpdateActive = true; 

    const prioritySymbols = arbitrageOpportunities
        .filter(op => op.details.shortExchange === bingxExchangeId.replace('usdm', '') || op.details.longExchange === bingxExchangeId.replace('usdm', ''))
        .filter(op => op.estimatedPnl >= MINIMUM_PNL_THRESHOLD)
        .map(op => op.coin);
    
    const uniqueSuperPrioritySymbols = Array.from(new Set(prioritySymbols));

    if (uniqueSuperPrioritySymbols.length === 0) {
        console.log('[BINGX_SUPER_PRIORITY] Không có coin BingX nào đủ điều kiện siêu ưu tiên. Tiếp tục vòng lặp.');
        // YÊU CẦU 3: Cập nhật mỗi phút
        let nextRunDelayMs = (60 - currentSecond) * 1000 - currentMs;
        nextRunDelayMs = Math.max(1000, nextRunDelayMs);
        bingxSuperPriorityLoopTimeoutId = setTimeout(bingxSuperPriorityUpdateLoop, nextRunDelayMs); 
        return;
    }

    console.log(`\n[BINGX_SUPER_PRIORITY] 🚀 Bắt đầu vòng cập nhật siêu ưu tiên BingX (${new Date().toLocaleTimeString()}) cho ${uniqueSuperPrioritySymbols.length} coin.`);
    const startTime = Date.now();
    let successfulUpdates = 0;

    try {
        const symbolsToFetchInBatch = uniqueSuperPrioritySymbols;
        const batchSize = BINGX_CONCURRENT_FETCH_LIMIT; 

        for (let i = 0; i < symbolsToFetchInBatch.length; i += batchSize) {
            const batch = symbolsToFetchInBatch.slice(i, i + batchSize);
            const batchPromises = batch.map(async (cleanSym) => {
                const bingxMarket = Object.values(exchanges[bingxExchangeId].markets).find(m => cleanSymbol(m.symbol) === cleanSym);
                if (!bingxMarket) {
                    console.warn(`[BINGX_SUPER_PRIORITY] ⚠️ Không tìm thấy market BingX cho symbol sạch: ${cleanSym}`);
                    return null;
                }
                const formattedSymbolForAPI = bingxMarket.symbol.replace('/', '-').replace(':USDT', '');

                const result = await getBingxFundingRateDirect(formattedSymbolForAPI);
                if (result && typeof result.fundingRate === 'number' && result.fundingTime) {
                    // YÊU CẦU 2: Log raw dữ liệu coin siêu ưu tiên
                    console.log(`[BINGX_SUPER_PRIORITY_RAW_DATA] ✅ Coin siêu ưu tiên: ${cleanSym}, Raw Funding Data: ${JSON.stringify(result)}`);
                    const maxLeverageParsed = leverageCache[bingxExchangeId]?.[cleanSym] || null;
                    exchangeData[bingxExchangeId].rates[cleanSym] = {
                        symbol: cleanSym,
                        fundingRate: result.fundingRate,
                        fundingTimestamp: result.fundingTime,
                        maxLeverage: maxLeverageParsed
                    };
                    successfulUpdates++;
                } else {
                    console.warn(`[BINGX_SUPER_PRIORITY] ⚠️ Lỗi cập nhật siêu ưu tiên funding cho ${cleanSym}.`);
                }
            });
            await Promise.allSettled(batchPromises);
            // Giảm độ trễ giữa các lô nhỏ hơn trong cửa sổ siêu ưu tiên để tăng tần suất cập nhật
            // Cần sửa lại logic này nếu muốn cập nhật 1 phút 1 lần cho toàn bộ vòng lặp thay vì từng batch
            // Nếu không muốn độ trễ giữa các batch nhỏ, có thể comment/xóa sleep này.
            // Hiện tại, yêu cầu là "1 phút 1 lần" cho *toàn bộ* phần siêu ưu tiên,
            // nên việc sleep giữa các batch có thể giữ hoặc bỏ tùy theo mục tiêu chi tiết.
            // Để đảm bảo 1 phút 1 lần cho toàn bộ vòng lặp, chúng ta sẽ chỉ đặt timeout ở cuối.
            // if (i + batchSize < symbolsToFetchInBatch.length) {
            //     await sleep(BINGX_SINGLE_REQUEST_DELAY_MS); 
            // }
        }

        const endTime = Date.now();
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(1);
        console.log(`[BINGX_SUPER_PRIORITY] ✅ Hoàn tất 1 vòng cập nhật siêu ưu tiên cho ${successfulUpdates} coin. Mất ${durationSeconds} giây.`);

    } catch (error) {
        console.error(`[BINGX_SUPER_PRIORITY] ❌ Lỗi trong vòng lặp siêu ưu tiên BingX: ${error.message}`);
    } finally {
        calculateArbitrageOpportunities(); 
        
        // YÊU CẦU 3: Lập lịch để chạy vòng tiếp theo 1 phút 1 lần nếu vẫn trong cửa sổ
        let nextRunDelayMs;
        if (isBingxInSuperPriorityWindow()) {
            // Đang trong cửa sổ (phút 55-58), lên lịch cho đầu phút tiếp theo
            const remainingSecondsInMinute = 60 - currentSecond;
            const remainingMsInMinute = remainingSecondsInMinute * 1000 - currentMs;
            nextRunDelayMs = Math.max(1000, remainingMsInMinute); // Đảm bảo độ trễ tối thiểu 1 giây
        } else {
            // Đã ra khỏi cửa sổ, lên lịch cho lần bắt đầu cửa sổ tiếp theo
            nextRunDelayMs = calculateDelayToNextBingxSuperPriorityWindow();
            isBingxSuperPriorityUpdateActive = false; // Tắt cờ khi rời khỏi cửa sổ
        }
        
        console.log(`[BINGX_SUPER_PRIORITY_SCHEDULER] Lập lịch chạy tiếp theo sau ${Math.ceil(nextRunDelayMs / 1000)} giây.`);
        bingxSuperPriorityLoopTimeoutId = setTimeout(bingxSuperPriorityUpdateLoop, nextRunDelayMs);
    }
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

                let fundingDiff = shortRate.fundingRate - longRate.fundingRate;

                // THAY ĐỔI 2: Sửa logic tính fundingDiff nếu cả 2 sàn cùng âm hoặc cùng dương
                if (Math.sign(shortRate.fundingRate) === Math.sign(longRate.fundingRate)) {
                    const lowerAbsoluteFundingRate = Math.min(Math.abs(shortRate.fundingRate), Math.abs(longRate.fundingRate));
                    // Áp dụng điều kiện: "số chênh lệch đã tính - funding của sàn thấp hơn"
                    fundingDiff = fundingDiff - lowerAbsoluteFundingRate;
                }

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
    clearTimeout(loopTimeoutId); 
    console.log(`\n[MASTER_LOOP] Bắt đầu vòng lặp chính lúc ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})...`);
    
    try {
        await syncBinanceServerTime();
    } catch (error) {
        console.error("[MASTER_LOOP] Lỗi đồng bộ thời gian Binance, có thể ảnh hưởng đến các lệnh ký. Thử lại ở vòng lặp sau.");
    }
    
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentHour = now.getUTCHours();
    const currentSecond = now.getUTCSeconds();

    // 1. Cập nhật Funding Rates cho các sàn NON-BINGX (kiểm tra tạm dừng chung bên trong hàm)
    await fetchFundingRatesForAllExchanges(); 
    lastFullUpdateTimestamp = new Date().toISOString(); 

    // 2. Cập nhật Leverage (TOÀN BỘ hoặc MỤC TIÊU) dựa trên lịch trình (non-Bingx blocking, Bingx non-blocking)
    if (currentHour === FULL_LEVERAGE_REFRESH_AT_HOUR && currentMinute === 0 && currentSecond < 5) {
        console.log('[LEVERAGE_SCHEDULER] 🔥 Kích hoạt cập nhật TOÀN BỘ đòn bẩy (00:00 UTC).');
        await performFullLeverageUpdate();
    }
    else if (TARGETED_LEVERAGE_REFRESH_MINUTES.includes(currentMinute) && currentSecond < 5) {
        console.log(`[LEVERAGE_SCHEDULER] 🎯 Kích hoạt cập nhật đòn bẩy MỤC TIÊU (${currentMinute} phút).`);
        await performTargetedLeverageUpdate();
    }
    // Logic cập nhật đặc biệt vào phút 59
    if (currentMinute === 59 && currentSecond >= 30 && currentSecond < 35) {
        const nowMs = Date.now(); 
        if (!masterLoop.lastSpecialLeverageTrigger || (nowMs - masterLoop.lastSpecialLeverageTrigger > 30 * 1000)) {
            console.log('[SPECIAL_UPDATE] ⏰ Kích hoạt cập nhật ĐẶC BIỆT đòn bẩy (phút 59 giây 30).');
            await performFullLeverageUpdate();
            masterLoop.lastSpecialLeverageTrigger = nowMs;
        }
    }

    console.log(`[MASTER_LOOP] ✅ Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp chính hoàn tất.`);
    scheduleNextLoop();
}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId); 
    const now = new Date();
    const delaySeconds = (60 - now.getSeconds() + 5) % 60; 
    const delayMs = (delaySeconds === 0 ? 60 : delaySeconds) * 1000;
    console.log(`[SCHEDULER] Vòng lặp chính kế tiếp sau ${delaySeconds.toFixed(0)} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delayMs);
}


// Biến để kiểm soát tần suất log API
let lastApiDataLogTime = 0;
const API_DATA_LOG_INTERVAL_MS = 30 * 1000;

// ----- KHỞI TẠO SERVER HTTP -----
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
            rawRates: exchangeData, 
            debugRawLeverageResponses: debugRawLeverageResponses
        };

        const now = Date.now();
        if (now - lastApiDataLogTime > API_DATA_LOG_INTERVAL_MS) {
            console.log(`[API_DATA] Gửi dữ liệu đến frontend. Total arbitrage ops: ${responseData.arbitrageData.length}. ` +
                `Binance Funds: ${Object.keys(responseData.rawRates.binanceusdm?.rates || {}).length}. ` +
                `OKX Funds: ${Object.keys(responseData.rawRates.okx?.rates || {}).length}. ` +
                `BingX Funds: ${Object.keys(responseData.rawRates.bingx?.rates || {}).length}. ` +
                `Bitget Funds: ${Object.keys(responseData.rawRates.bitget?.rates || {}).length}.`);
            lastApiDataLogTime = now;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

// Lắng nghe cổng và khởi chạy các tác vụ ban đầu
server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    
    // 1. Tải danh sách symbol Futures hợp lệ của Bitget một lần khi khởi động
    await fetchBitgetValidFuturesSymbols();
    
    // 2. Thực hiện cập nhật đòn bẩy đầy đủ lần đầu tiên để populate leverageCache
    console.log('[STARTUP] Kích hoạt cập nhật TOÀN BỘ đòn bẩy ban đầu.');
    await performFullLeverageUpdate(); 

    // Đảm bảo exchangeData cho BingX được khởi tạo rỗng nếu chưa có
    if (!exchangeData.bingx) {
        exchangeData.bingx = { rates: {} };
    }

    // 3. Bắt đầu các vòng lặp chính
    masterLoop(); 

    // Bắt đầu vòng lặp cập nhật funding rate liên tục cho BingX
    bingxContinuousFundingLoop(); 

    // Lập lịch cho vòng lặp cập nhật funding rate ưu tiên 5 phút của BingX
    bingxPriorityUpdateScheduler(); 

    // Lập lịch cho vòng lặp cập nhật funding rate siêu ưu tiên của BingX (phút 55-58)
    bingxSuperPriorityUpdateLoop();
});
