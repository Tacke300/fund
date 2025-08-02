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
const BINGX_CONCURRENT_FETCH_LIMIT = 4;
const BINGX_DELAY_BETWEEN_BATCHES_MS = 5000;
const BINGX_SINGLE_REQUEST_DELAY_MS = 500;

const DELAY_BEFORE_BINGX_MS = 60000; // 60 giây delay trước khi BingX bắt đầu lấy dữ liệu

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {}; // Sẽ lưu trữ funding rates và originalSymbol
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;

let bitgetValidFuturesSymbolSet = new Set();

let debugRawLeverageResponses = {
binanceusdm: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
bingx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
okx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
bitget: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null }
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

Generated code
if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }
else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

exchanges[id] = new exchangeClass(config);


});

// ----- HÀM HỖ TRỢ CHUNG (DEFINED BEFORE USE) -----
const cleanSymbol = (symbol) => {
let cleaned = symbol.toUpperCase();

Generated code
// 1. Loại bỏ hậu tố Bitget WS (dù không còn dùng WS để lấy funding, symbol có thể vẫn có dạng này)
cleaned = cleaned.replace('_UMCBL', ''); 

// 2. Xử lý các ký tự phân tách phổ biến (/, :, _)
cleaned = cleaned.replace(/[\/:_]/g, ''); 

// 3. Xử lý định dạng COIN-USDT của BingX (ví dụ: chuyển BTC-USDT thành BTCUSDT)
cleaned = cleaned.replace(/-USDT$/, 'USDT'); 

// 4. Loại bỏ các chữ số ở đầu symbol (ví dụ: 1000PEPEUSDT -> PEPEUSDT)
cleaned = cleaned.replace(/^\d+/, ''); 

// 5. Loại bỏ các chữ số nằm trong phần tên coin ngay trước 'USDT' (ví dụ: OMNI1USDT -> OMNIUSDT, BTC2USDT -> BTCUSDT)
// Regex này tìm kiếm phần không phải chữ số (coin name), sau đó là các chữ số, rồi đến USDT.
// Nó sẽ thay thế (chữ số + USDT) bằng chỉ USDT, giữ lại phần tên coin.
cleaned = cleaned.replace(/(\D+)\d+USDT$/, '$1USDT'); 

// 6. Đảm bảo symbol kết thúc bằng một 'USDT' duy nhất và loại bỏ mọi thứ sau nó
// Ví dụ: FOOUSDTUSDT -> FOOUSDT, PEPEUSDT_PERP -> PEPEUSDT, OMNIUSDT1 -> OMNIUSDT
const usdtIndex = cleaned.indexOf('USDT');
if (usdtIndex !== -1) {
    // Lấy phần trước 'USDT' và nối với 'USDT'
    cleaned = cleaned.substring(0, usdtIndex) + 'USDT';
} else if (symbol.toUpperCase().includes('USDT') && !cleaned.endsWith('USDT')) { 
    // Fallback: Nếu symbol gốc có USDT nhưng bị mất trong quá trình clean (ví dụ: ETHUSD.P), hãy thêm lại
    cleaned = cleaned + 'USDT';
}

return cleaned;
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

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

Generated code
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

async function syncBinanceServerTime() {
try {
const data = await makeHttpRequest('GET', BINANCE_BASE_HOST, '/fapi/v1/time');
const parsedData = JSON.parse(data);
const binanceServerTime = parsedData.serverTime;
const localTime = Date.now();
binanceServerTimeOffset = binanceServerTime - localTime;
console.log([TIME SYNC] ✅ Đồng bộ thời gian Binance. Lệch: ${binanceServerTimeOffset} ms.);
} catch (error) {
console.error([TIME SYNC] ❌ Lỗi đồng bộ thời gian Binance: ${error.msg || error.message}.);
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

Generated code
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

const bingxErrorLogCache = {};
const BINGX_ERROR_LOG_COOLDOWN_MS = 5 * 60 * 1000;

async function fetchBingxMaxLeverage(symbol, retries = 3) {
if (!bingxApiKey || !bingxApiSecret) {
console.warn([BINGX] ⚠️ Thiếu API Key/Secret cho BingX.);
return null;
}

Generated code
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

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
console.error([BINGX_SYMBOLS] Lỗi khi lấy danh sách symbol BingX: Code ${json.code}, Msg: ${json.msg}. Raw: ${data.substring(0, Math.min(data.length, 200))});
return [];
}
} catch (e) {
console.error([BINGX_SYMBOLS] Lỗi request khi lấy danh sách symbol BingX: ${e.msg || e.message});
return [];
}
}

async function getBingxFundingRateDirect(symbol) {
const urlPath = /openApi/swap/v2/quote/fundingRate?symbol=${encodeURIComponent(symbol)};
try {
const data = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath);
const json = JSON.parse(data);
if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
const firstData = json.data[0];

Generated code
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
            originalSymbol: firstData.symbol, // Lưu original symbol
            cleanedSymbol: cleanSymbol(firstData.symbol), // Lưu cleaned symbol để dùng làm key
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

// Hàm mới để lấy funding time từ Bitget Native REST API (đã khôi phục)
async function fetchBitgetFundingTimeNativeApi(apiSymbol) {
try {
// Bitget API symbol cho funding-time thường có dạng INST_ID (e.g., BTCUSDT_UMCBL)
// cleanSymbol đã loại bỏ _UMCBL, nên ta cần thêm lại nếu API gốc cần
const formattedApiSymbol = apiSymbol.includes('_UMCBL') ? apiSymbol : ${apiSymbol}_UMCBL;
const apiPath = /api/mix/v1/market/funding-time?symbol=${encodeURIComponent(formattedApiSymbol)};
const rawData = await makeHttpRequest('GET', BITGET_NATIVE_REST_HOST, apiPath);
const json = JSON.parse(rawData);

Generated code
if (json.code === '00000' && json.data) {
        const fundingData = Array.isArray(json.data) ? json.data[0] : json.data;
        if (fundingData && fundingData.fundingTime) {
            const parsedFundingTime = parseInt(fundingData.fundingTime, 10);
            if (!isNaN(parsedFundingTime) && parsedFundingTime > 0) {
                return parsedFundingTime;
            }
        }
    }
    console.warn(`[BITGET_FUNDING_TIME_NATIVE] ⚠️ Không lấy được fundingTime hợp lệ cho ${apiSymbol}. Raw: ${rawData.substring(0, Math.min(rawData.length, 200))}`);
    return null;
} catch (e) {
    console.error(`[BITGET_FUNDING_TIME_NATIVE] ❌ Lỗi khi lấy funding time cho ${apiSymbol} từ native API: ${e.msg || e.message}.`);
    return null;
}
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

/**

Cập nhật Max Leverage cho một sàn cụ thể.

@param {string} id ID của sàn giao dịch (e.g., 'binanceusdm', 'bingx').

@param {string[]} [symbolsToUpdate] Mảng các symbol cần cập nhật.

@returns {Promise<{ id: string, processedData: Object, status: string, error: object | null }>}
*/
async function updateLeverageForExchange(id, symbolsToUpdate = null) {
const exchange = exchanges[id];
let currentFetchedLeverageDataMap = {};
const updateType = symbolsToUpdate ? 'mục tiêu' : 'toàn bộ';
let status = Đang tải đòn bẩy (${updateType})...;
let error = null;

debugRawLeverageResponses[id].status = status;
debugRawLeverageResponses[id].timestamp = new Date();
debugRawLeverageResponses[id].error = null;

try {
if (id === 'binanceusdm') {
await syncBinanceServerTime();
const leverageBracketsResponse = await callSignedBinanceAPI('/fapi/v1/leverageBracket', 'GET');

Generated code
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
                     currentFetchedLeverageDataMap[cleanedSym] = maxLeverage; // Key đã clean
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
             const formattedSymbolForAPI = market.symbol.replace('/', '-').replace(':USDT', ''); // Format API request
             const parsedMaxLeverage = await fetchBingxMaxLeverage(formattedSymbolForAPI);
             fetchedCount++;
             debugRawLeverageResponses[id].status = `Đang tải đòn bẩy BingX (${fetchedCount}/${totalSymbols})`;
             debugRawLeverageResponses[id].timestamp = new Date();
             if (parsedMaxLeverage !== null && parsedMaxLeverage > 0) {
                 const cleanedSymForCache = cleanSymbol(market.symbol); // Clean symbol for cache key
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
         // Đã loại bỏ phần in dữ liệu mẫu 40 symbol ở đây
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
                 console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

} catch (e) {
let errorMessage = Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.;
console.error([CACHE] ❌ ${id.toUpperCase()}: ${errorMessage});
status = Đòn bẩy thất bại (lỗi chung: ${e.code || 'UNKNOWN'});
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

Generated code
// Giai đoạn 1: Lấy dữ liệu đòn bẩy cho các sàn non-BingX song song - CHỜ HOÀN TẤT
const nonBingxLeveragePromises = nonBingxExchangeIds.map(id => updateLeverageForExchange(id, null));
const nonBingxResults = await Promise.all(nonBingxLeveragePromises);

// Cập nhật trạng thái và cache cho các sàn non-BingX ngay sau khi chúng hoàn tất
nonBingxResults.forEach(res => {
    if (res) {
        debugRawLeverageResponses[res.id].status = res.status;
        debugRawLeverageResponses[res.id].timestamp = new Date();
        debugRawLeverageResponses[res.id].error = res.error;
    }
});

// Giai đoạn 2: Bắt đầu lấy dữ liệu BingX trong nền (KHÔNG DÙNG AWAIT TRỰC TIẾP)
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

async function performTargetedLeverageUpdate() {
console.log('\n[LEVERAGE_SCHEDULER] 🎯 Bắt đầu cập nhật đòn bẩy MỤC TIÊU...');
const activeSymbols = new Set();
arbitrageOpportunities.forEach(op => activeSymbols.add(op.coin));

Generated code
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

// Hàm mới để lấy danh sách các symbol Futures hợp lệ từ Bitget API
async function fetchBitgetValidFuturesSymbols() {
console.log('[BITGET_SYMBOLS] 🔄 Đang tải danh sách symbol Futures hợp lệ từ Bitget...');
try {
const apiPath = '/api/mix/v1/market/contracts?productType=umcbl';
const rawData = await makeHttpRequest('GET', BITGET_NATIVE_REST_HOST, apiPath);
const json = JSON.parse(rawData);

Generated code
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

function calculateNextStandardFundingTime() {
const now = new Date();
const fundingHoursUTC = [0, 8, 16];
let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);
const nextFundingDate = new Date(now);

Generated code
if (nextHourUTC === undefined) { 
    nextHourUTC = fundingHoursUTC[0]; 
    nextFundingDate.setUTCDate(now.getUTCDate() + 1); 
}
nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0); 
return nextFundingDate.getTime();
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

async function fetchFundingRatesForAllExchanges() {
console.log('[DATA] Bắt đầu làm mới funding rates cho tất cả các sàn...');

Generated code
const nonBingxExchangeIds = EXCHANGE_IDS.filter(id => id !== 'bingx');
const bingxExchangeId = EXCHANGE_IDS.find(id => id === 'bingx');

const nonBingxResultsSummary = []; // Để lưu tóm tắt kết quả của các sàn non-BingX

// Giai đoạn 1: Lấy dữ liệu funding rates cho các sàn non-BingX song song - CHỜ HOÀN TẤT
const nonBingxFundingPromises = nonBingxExchangeIds.map(async (id) => {
    let processedRates = {};
    let currentStatus = 'Đang tải funding...';
    let currentTimestamp = new Date();
    let currentError = null;
    let successCount = 0; 

    try {
        await exchanges[id].loadMarkets(true);
        const exchange = exchanges[id];
        const fundingRatesRaw = await exchange.fetchFundingRates();
        
        // Lấy danh sách symbol hợp lệ để lọc cho Bitget
        if (id === 'bitget' && bitgetValidFuturesSymbolSet.size === 0) {
            await fetchBitgetValidFuturesSymbols();
            if (bitgetValidFuturesSymbolSet.size === 0) {
                currentError = { code: 'NO_VALID_SYMBOLS', msg: 'Could not fetch valid Bitget symbols.' };
                throw new Error('Failed to load valid Bitget symbols for funding rates.');
            }
        }

        for (const rate of Object.values(fundingRatesRaw)) {
            // LỌC CHUNG: Chỉ lấy các cặp SWAP/PERPETUAL FUTURES VÀ CHỨA 'USDT'
            if (rate.type && rate.type !== 'swap' && rate.type !== 'future') {
                 continue;
            }
            if (rate.info?.contractType && rate.info.contractType !== 'PERPETUAL') {
                continue;
            }
            if (!rate.symbol.includes('USDT')) { 
                continue;
            }
            
            const originalSym = rate.symbol; // Lấy symbol gốc
            const cleanedSym = cleanSymbol(originalSym); // Clean để dùng làm key

            const maxLeverageParsed = leverageCache[id]?.[cleanedSym] || null;

            let fundingRateValue = rate.fundingRate; 
            let fundingTimestampValue = rate.fundingTimestamp || rate.nextFundingTime; 

            // Logic cho Bitget: chỉ sử dụng API gốc
            if (id === 'bitget') {
                // Cần original symbol để kiểm tra với bitgetValidFuturesSymbolSet
                const symbolForNativeApiCheck = originalSym.includes('_UMCBL') ? originalSym : `${originalSym}_UMCBL`;

                // Lọc symbol dựa trên danh sách hợp lệ từ API gốc.
                if (!bitgetValidFuturesSymbolSet.has(symbolForNativeApiCheck)) {
                    continue; 
                }
                
                const nativeFundingTime = await fetchBitgetFundingTimeNativeApi(originalSym); // Truyền original symbol
                if (nativeFundingTime !== null) {
                    fundingTimestampValue = nativeFundingTime; // Ưu tiên thời gian từ Native API
                } else {
                    // Nếu Native API không lấy được, fallback về CCXT hoặc tính toán
                    if (!fundingTimestampValue || fundingTimestampValue <= 0) {
                        fundingTimestampValue = calculateNextStandardFundingTime(); // Fallback cuối cùng
                    }
                }
            }
            
            // Fallback nếu không tìm thấy nextFundingTime/fundingTimestamp hợp lệ từ API
            if (!fundingTimestampValue || fundingTimestampValue <= 0) {
                fundingTimestampValue = calculateNextStandardFundingTime();
            }

            if (typeof fundingRateValue === 'number' && !isNaN(fundingRateValue) && typeof fundingTimestampValue === 'number' && fundingTimestampValue > 0) {
                processedRates[cleanedSym] = { 
                    originalSymbol: originalSym, // Lưu symbol gốc
                    cleanedSymbol: cleanedSym, // Lưu symbol đã clean
                    fundingRate: fundingRateValue,
                    fundingTimestamp: fundingTimestampValue,
                    maxLeverage: maxLeverageParsed
                };
                successCount++;
            } else {
                console.warn(`[DATA] ⚠️ ${id.toUpperCase()}: Bỏ qua ${originalSym} - Funding rate hoặc timestamp không hợp lệ hoặc thiếu. Rate: ${fundingRateValue}, Timestamp: ${fundingTimestampValue}.`);
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
        
        calculateArbitrageOpportunities(); // Tính toán cơ hội sau mỗi sàn hoàn tất (đặc biệt quan trọng với Promise.all)
        return { id };
    }
});

await Promise.all(nonBingxFundingPromises);
console.log(`[DATA] ✅ Hoàn tất làm mới funding rates cho các sàn non-BingX: ${nonBingxResultsSummary.join(', ')}. Tính toán cơ hội lần đầu.`);


// Giai đoạn 2: Bắt đầu lấy dữ liệu BingX trong nền (KHÔNG DÙNG AWAIT TRỰC TIẾP)
if (bingxExchangeId) {
    console.log(`[DATA] ⏳ Bắt đầu cập nhật funding rates BingX trong nền sau ${DELAY_BEFORE_BINGX_MS / 1000} giây.`);
    setTimeout(async () => {
        let processedRates = {};
        let currentStatus = 'Đang tải funding...';
        let currentError = null;
        let successCount = 0;

        try {
            const symbols = await getBingxSymbolsDirect(); 
            let fetchedCount = 0; 
            let bingxSuccessCount = 0; // Đổi tên biến để tránh nhầm lẫn với successCount tổng
            const marketChunks = [];
            for (let i = 0; i < symbols.length; i += BINGX_CONCURRENT_FETCH_LIMIT) {
                marketChunks.push(symbols.slice(i, i + BINGX_CONCURRENT_FETCH_LIMIT));
            }

            for (const chunk of marketChunks) {
                const chunkPromises = chunk.map(async (symbol) => {
                    const result = await getBingxFundingRateDirect(symbol); 
                    fetchedCount++;
                    debugRawLeverageResponses[bingxExchangeId].status = `Đang tải funding BingX (${fetchedCount}/${symbols.length})`;
                    debugRawLeverageResponses[bingxExchangeId].timestamp = new Date();
                    
                    if (result && typeof result.fundingRate === 'number' && result.fundingTime) {
                        const cleanedSymForStore = result.cleanedSymbol; 
                        const maxLeverageParsed = leverageCache[bingxExchangeId]?.[cleanedSymForStore] || null;

                        processedRates[cleanedSymForStore] = { 
                            originalSymbol: result.originalSymbol, // Lưu original symbol
                            cleanedSymbol: cleanedSymForStore, // Lưu cleaned symbol
                            fundingRate: result.fundingRate,
                            fundingTimestamp: result.fundingTime,
                            maxLeverage: maxLeverageParsed
                        };
                        bingxSuccessCount++; // Cập nhật biến đếm của BingX
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
            currentStatus = `Funding BingX hoàn tất (${bingxSuccessCount} cặp)`;
            console.log(`[DATA] ✅ BingX: Đã lấy thành công ${bingxSuccessCount} funding rates từ API trực tiếp.`);
            
            if (bingxSuccessCount > 0) {
                debugRawLeverageResponses[bingxExchangeId].data = `Đã lấy ${bingxSuccessCount} cặp funding.`;
            } else {
                debugRawLeverageResponses[bingxExchangeId].data = 'Không có dữ liệu funding hợp lệ nào được tìm thấy.';
            }

        } catch (e) {
            let errorMessage = `Lỗi khi lấy funding từ ${bingxExchangeId.toUpperCase()}: ${e.message}.`;
            console.error(`[DATA] ❌ ${bingxExchangeId.toUpperCase()}: ${errorMessage}`);
            currentStatus = `Funding thất bại (lỗi: ${e.code || 'UNKNOWN'})`;
            currentError = { code: e.code, msg: e.message };
        } finally {
            exchangeData = { ...exchangeData, [bingxExchangeId]: { rates: processedRates } };
            debugRawLeverageResponses[bingxExchangeId].status = currentStatus;
            debugRawLeverageResponses[bingxExchangeId].timestamp = new Date();
            debugRawLeverageResponses[bingxExchangeId].error = currentError;
            console.log('[DATA] ✅ Cập nhật funding rates BingX trong nền hoàn tất. Tính toán lại cơ hội.');
            calculateArbitrageOpportunities(); // Recalculate once BingX data is in
        }
    }, DELAY_BEFORE_BINGX_MS); // Bắt đầu BingX sau delay
}
console.log('[DATA] 🎉 Hoàn tất kích hoạt làm mới funding rates (trừ BingX đang chạy nền).');
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

function calculateArbitrageOpportunities() {
const allFoundOpportunities = [];
const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));

Generated code
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

        for (const cleanedSym of commonSymbols) { // Sử dụng cleanedSym làm key
            const rate1Data = exchange1Rates[cleanedSym];
            const rate2Data = exchange2Rates[cleanedSym];

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

            let longExchange, shortExchange, longRateData, shortRateData; // Đổi tên biến để tránh nhầm lẫn
            if (rate1Data.fundingRate > rate2Data.fundingRate) {
                shortExchange = exchange1Id; shortRateData = rate1Data;
                longExchange = exchange2Id; longRateData = rate2Data;
            } else {
                shortExchange = exchange2Id; shortRateData = rate2Data;
                longExchange = exchange1Id; longRateData = rate1Data;
            }

            const fundingDiff = shortRateData.fundingRate - longRateData.fundingRate;

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
                    coin: cleanedSym, // Đây là cleanedSymbol
                    exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                    fundingDiff: parseFloat(fundingDiff.toFixed(6)),
                    nextFundingTime: finalFundingTime,
                    nextFundingTimeUTC: new Date(finalFundingTime).toISOString(),
                    commonLeverage: parseFloat(commonLeverage.toFixed(2)),
                    estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                    isImminent: isImminent,
                    details: {
                        shortExchange: shortExchange,
                        shortRate: shortRateData.fundingRate,
                        shortLeverage: shortRateData.maxLeverage, // Sử dụng maxLeverage từ rateData
                        longExchange: longExchange,
                        longRate: longRateData.fundingRate,
                        longLeverage: longRateData.maxLeverage, // Sử dụng maxLeverage từ rateData
                        minutesUntilFunding: parseFloat(minutesUntilFunding.toFixed(1)),
                        // Thêm originalSymbol của từng sàn vào đây để bot sử dụng
                        shortOriginalSymbol: shortRateData.originalSymbol,
                        longOriginalSymbol: longRateData.originalSymbol
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

async function masterLoop() {
console.log(\n[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})...);

Generated code
try {
    await syncBinanceServerTime();
} catch (error) {
    console.error("[LOOP] Lỗi đồng bộ thời gian Binance, có thể ảnh hưởng đến các lệnh ký. Thử lại ở vòng lặp sau.");
}

const now = new Date();
const currentMinute = now.getUTCMinutes();
const currentHour = now.getUTCHours();
const currentSecond = now.getUTCSeconds();

// 1. Luôn cập nhật Funding Rates (non-Bingx blocking, Bingx non-blocking)
// fetchFundingRatesForAllExchanges sẽ tự gọi calculateArbitrageOpportunities sau khi non-Bingx xong
// và sau khi Bingx xong (nếu nó chạy nền và kịp)
await fetchFundingRatesForAllExchanges(); 
lastFullUpdateTimestamp = new Date().toISOString(); 

// calculateArbitrageOpportunities() đã được gọi trong fetchFundingRatesForAllExchanges
// -> không cần gọi lại ở đây nữa

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
    if (!masterLoop.lastSpecialTrigger || (nowMs - masterLoop.lastSpecialTrigger > 30 * 1000)) {
        console.log('[SPECIAL_UPDATE] ⏰ Kích hoạt cập nhật ĐẶC BIỆT (phút 59 giây 30).');
        await performFullLeverageUpdate();
        masterLoop.lastSpecialTrigger = nowMs;
    }
}

console.log(`[LOOP] ✅ Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
scheduleNextLoop();
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

function scheduleNextLoop() {
clearTimeout(loopTimeoutId);
const now = new Date();
const delaySeconds = (60 - now.getSeconds() + 5) % 60;
const delayMs = (delaySeconds === 0 ? 60 : delaySeconds) * 1000;
console.log([SCHEDULER] Vòng lặp kế tiếp sau ${delaySeconds.toFixed(0)} giây.);
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
// Cấu trúc rawRates sẽ trả về cả originalSymbol và cleanedSymbol
rawRates: exchangeData, // exchangeData đã chứa cấu trúc cần thiết
debugRawLeverageResponses: debugRawLeverageResponses
};

Generated code
const now = Date.now();
    if (now - lastApiDataLogTime > API_DATA_LOG_INTERVAL_MS) {
        console.log(`[API_DATA] Gửi dữ liệu đến frontend. Total arbitrage ops: ${responseData.arbitrageData.length}. ` +
            `Binance Funds: ${Object.keys(responseData.rawRates.binanceusdm?.rates || {}).length}. ` + // Sử dụng Object.keys để đếm số cặp
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
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

});

// Lắng nghe cổng và khởi chạy các tác vụ ban đầu
server.listen(PORT, async () => {
console.log(✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT});

Generated code
// 1. Tải danh sách symbol Futures hợp lệ của Bitget một lần khi khởi động
await fetchBitgetValidFuturesSymbols();

// 2. Thực hiện cập nhật đòn bẩy đầy đủ lần đầu tiên để populate leverageCache
// Chờ non-BingX hoàn tất, BingX kích hoạt chạy nền
console.log('[STARTUP] Kích hoạt cập nhật TOÀN BỘ đòn bẩy ban đầu.');
await performFullLeverageUpdate(); 

// 3. Bắt đầu vòng lặp chính của logic cập nhật dữ liệu
masterLoop();


});

