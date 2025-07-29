const http = require('http');
const https = require = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const { URLSearchParams } = require('url');
const WebSocket = require('ws'); // <-- Đảm bảo WebSocket được import

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
const BINGX_CONCURRENT_FETCH_LIMIT = 4; // Số symbol lấy đồng thời trong 1 lô (áp dụng cho cả lev và funding)
const BINGX_DELAY_BETWEEN_BATCHES_MS = 5000; // Độ trễ giữa các lô (áp dụng cho cả lev và funding)
const BINGX_SINGLE_REQUEST_DELAY_MS = 500; // Độ trễ nhỏ nếu cần cho 1 số API call đơn lẻ (ví dụ retry)

const DELAY_BEFORE_BINGX_MS = 60000; // 60 giây delay trước khi BingX bắt đầu lấy dữ liệu

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let leverageSchedulerId = null;

// Thêm biến toàn cục để lưu trữ danh sách symbol hợp lệ của Bitget Futures
let bitgetValidFuturesSymbolSet = new Set(); 

let debugRawLeverageResponses = {
    binanceusdm: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    bingx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    // Thêm wsStatus cho Bitget
    bitget: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null, wsStatus: 'DISCONNECTED' }
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

// Hàm cleanSymbol được làm cho mạnh mẽ hơn để xử lý USDT lặp lại
// Mục đích chính: chuyển đổi bất kỳ định dạng nào sang BASEUSDT (ví dụ: BTCUSDT)
// để dùng làm khóa cache nội bộ và cho các sàn khác.
const cleanSymbol = (symbol) => {
    let cleaned = symbol.toUpperCase();
    
    // Loại bỏ các ký tự phân tách phổ biến (/, :, _)
    cleaned = cleaned.replace(/[\/:_]/g, '');
    
    // Loại bỏ hậu tố WebSocket của Bitget nếu có (e.g., "_UMCBL")
    cleaned = cleaned.replace('_UMCBL', '');

    // Chuẩn hóa để chỉ có một 'USDT' ở cuối, ngay cả khi có 'USDTUSDT'
    // Regex này sẽ tìm một hoặc nhiều lần lặp của 'USDT' ở cuối và thay thế bằng một 'USDT' duy nhất.
    cleaned = cleaned.replace(/(USDT)+$/, 'USDT'); 

    // Nếu sau các bước trên mà symbol không kết thúc bằng USDT, thêm USDT
    if (!cleaned.endsWith('USDT')) {
        cleaned = cleaned + 'USDT';
    }
    return cleaned;
};


// Sửa lỗi cú pháp missing ')'
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
    return parsedLeverage;
}

// Lấy toàn bộ symbol future từ BingX API trực tiếp (được dùng cho Funding Rates)
async function getBingxSymbolsDirect() {
    const urlPath = '/openApi/swap/v2/quote/contracts';
    try {
        const data = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath);
        const json = JSON.parse(data);
        if (json.code === 0 && Array.isArray(json.data)) {
            // LỌC: Chỉ lấy các symbol có 'USDT' trong tên
            const symbols = json.data.filter(item => item.symbol.includes('USDT')).map(item => item.symbol);
            return symbols;
        } else {
            console.error(`[BINGX_SYMBOLS] Lỗi khi lấy danh sách symbol BingX: Code ${json.code}, Msg: ${json.msg}. Raw: ${data.substring(0, Math.min(data.length, 200))}`);
            return [];
        }
    }
    catch (e) {
        console.error(`[BINGX_SYMBOLS] Lỗi request khi lấy danh sách symbol BingX: ${e.msg || e.message}`);
        return [];
    }
}

// Lấy funding rate + time cho 1 symbol từ BingX API trực tiếp
async function getBingxFundingRateDirect(symbol) {
    const urlPath = `/openApi/swap/v2/quote/fundingRate?symbol=${encodeURIComponent(symbol)}`;
    try {
        const data = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath);
        const json = JSON.parse(data);
        if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
            const firstData = json.data[0];
            // console.log(`[BINGX_FUNDING_DEBUG_FIRSTDATA] ${symbol}: ${JSON.stringify(firstData)}`); // Debug log

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
                symbol: firstData.symbol,
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
                    // LỌC BINANCE: Chỉ lấy các cặp có 'USDT'
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
                // THAY ĐỔI: Lưu mẫu dữ liệu đòn bẩy vào debugRawLeverageResponses.data
                if (successCount > 0) {
                    const sampleSymbols = Object.keys(currentFetchedLeverageDataMap).slice(0, 40); // Lấy tối đa 40 cặp
                    const sampleData = {};
                    sampleSymbols.forEach(sym => {
                        sampleData[sym] = currentFetchedLeverageDataMap[sym];
                    });
                    debugRawLeverageResponses[id].data = {
                        count: successCount,
                        sample: sampleData
                    };
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã lấy ${successCount} cặp đòn bẩy USDT. Mẫu (${Object.keys(sampleData).length} cặp) được lưu.`);
                } else {
                    debugRawLeverageResponses[id].data = 'Không có dữ liệu đòn bẩy hợp lệ nào được tìm thấy.';
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Không có dữ liệu đòn bẩy hợp lệ nào được tìm thấy.`);
                }

            }
        }
        else if (id === 'bingx') {
            await exchange.loadMarkets(true);
            const bingxMarkets = Object.values(exchange.markets)
                .filter(m => m.swap && m.symbol.includes('USDT')); // LỌC BINGX: Đảm bảo là swap và có 'USDT' trong symbol

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
                    const formattedSymbol = market.symbol.replace('/', '-').replace(':USDT', '');
                    const parsedMaxLeverage = await fetchBingxMaxLeverage(formattedSymbol);
                    fetchedCount++;
                    debugRawLeverageResponses[id].status = `Đòn bẩy đang tải (${fetchedCount}/${totalSymbols} | ${successCount} thành công)`;
                    debugRawLeverageResponses[id].timestamp = new Date();
                    if (parsedMaxLeverage !== null && parsedMaxLeverage > 0) {
                        currentFetchedLeverageDataMap[cleanSymbol(market.symbol)] = parsedMaxLeverage;
                        successCount++;
                    }
                    return true;
                });
                await Promise.allSettled(chunkPromises);
                
                if (marketChunks.indexOf(chunk) < marketChunks.length - 1) {
                    await sleep(BINGX_DELAY_BETWEEN_BATCHES_MS);
                }
            }
            status = `Đòn bẩy hoàn tất (${successCount} cặp)`;
            console.log(`[CACHE] ✅ ${id.toUpperCase()}: Hoàn tất lấy dữ liệu đòn bẩy cho ${Object.keys(currentFetchedLeverageDataMap).length} cặp. (${successCount} cặp được parse thành công)`);
            
            // THAY ĐỔI: Lưu mẫu dữ liệu đòn bẩy BingX vào debugRawLeverageResponses.data
            if (successCount > 0) {
                const sampleSymbols = Object.keys(currentFetchedLeverageDataMap).slice(0, 40); // Lấy tối đa 40 cặp
                const sampleData = {};
                sampleSymbols.forEach(sym => {
                    sampleData[sym] = currentFetchedLeverageDataMap[sym];
                });
                debugRawLeverageResponses[id].data = {
                    count: successCount,
                    sample: sampleData
                }; // Lưu đối tượng mẫu
                console.log(`[DEBUG_BINGX_LEVERAGE] Mẫu dữ liệu đòn bẩy BingX (${Object.keys(sampleData).length} cặp):`);
                Object.keys(sampleData).forEach(sym => { 
                    console.log(`  - ${sym}: ${sampleData[sym]}x`);
                });
                if (Object.keys(currentFetchedLeverageDataMap).length > 40) {
                    console.log(`  ... và ${Object.keys(currentFetchedLeverageDataMap).length - 40} cặp khác.`);
                }
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
                    // LỌC OKX/BITGET: Chỉ lấy các cặp SWAP VÀ CÓ 'USDT'
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
                // THAY ĐỔI: Lưu mẫu dữ liệu đòn bẩy vào debugRawLeverageResponses.data
                if (successCount > 0) {
                    const sampleSymbols = Object.keys(currentFetchedLeverageDataMap).slice(0, 40);
                    const sampleData = {};
                    sampleSymbols.forEach(sym => {
                        sampleData[sym] = currentFetchedLeverageDataMap[sym];
                    });
                    debugRawLeverageResponses[id].data = {
                        count: successCount,
                        sample: sampleData
                    };
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã lấy ${successCount} cặp đòn bẩy USDT. Mẫu (${Object.keys(sampleData).length} cặp) được lưu.`);
                } else {
                    debugRawLeverageResponses[id].data = 'Không có dữ liệu đòn bẩy hợp lệ nào được tìm thấy.';
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Không có dữ liệu đòn bẩy hợp lệ nào được tìm thấy.`);
                }
            } else {
                console.log(`[CACHE] ${id.toUpperCase()}: fetchLeverageTiers không khả dụng. Dùng loadMarkets...`);
                let loadMarketsSuccessCount = 0;
                for (const market of Object.values(exchange.markets)) {
                    // LỌC OKX/BITGET: Chỉ lấy các cặp SWAP VÀ CÓ 'USDT'
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
                // THAY ĐỔI: Lưu mẫu dữ liệu đòn bẩy vào debugRawLeverageResponses.data
                if (loadMarketsSuccessCount > 0) {
                    const sampleSymbols = Object.keys(currentFetchedLeverageDataMap).slice(0, 40);
                    const sampleData = {};
                    sampleSymbols.forEach(sym => {
                        sampleData[sym] = currentFetchedLeverageDataMap[sym];
                    });
                    debugRawLeverageResponses[id].data = {
                        count: loadMarketsSuccessCount,
                        sample: sampleData
                    };
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã lấy ${loadMarketsSuccessCount} cặp đòn bẩy USDT. Mẫu (${Object.keys(sampleData).length} cặp) được lưu.`);
                } else {
                    debugRawLeverageResponses[id].data = 'Không có dữ liệu đòn bẩy hợp lệ nào được tìm thấy.';
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Không có dữ liệu đòn bẩy hợp lệ nào được tìm thấy.`);
                }
            }
        }
        
        // CẬP NHẬT leverageCache[id]
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
        leverageCache[id] = {}; // Đặt rỗng nếu lỗi để tránh lỗi lan truyền
    } finally {
        return { id, processedData: currentFetchedLeverageDataMap, status, error };
    }
}

async function performFullLeverageUpdate() {
    console.log('\n[LEVERAGE_SCHEDULER] 🔄 Bắt đầu cập nhật TOÀN BỘ đòn bẩy cho tất cả các sàn... (được kích hoạt)');
    const nonBingxExchangeIds = EXCHANGE_IDS.filter(id => id !== 'bingx');
    const bingxExchangeId = EXCHANGE_IDS.find(id => id === 'bingx');

    // Giai đoạn 1: Lấy dữ liệu đòn bẩy cho các sàn non-BingX song song
    const nonBingxLeveragePromises = nonBingxExchangeIds.map(id => updateLeverageForExchange(id, null));
    const nonBingxResults = await Promise.all(nonBingxLeveragePromises);
    
    // Cập nhật trạng thái và cache cho các sàn non-BingX ngay
    nonBingxResults.forEach(res => {
        if (res) {
            debugRawLeverageResponses[res.id].status = res.status;
            debugRawLeverageResponses[res.id].timestamp = new Date();
            debugRawLeverageResponses[res.id].error = res.error;
        }
    });

    // Giai đoạn 2: Nếu có BingX, đợi 60s rồi mới lấy dữ liệu BingX
    if (bingxExchangeId) {
        console.log(`[LEVERAGE_SCHEDULER] ⏳ Đã cập nhật đòn bẩy cho các sàn khác. Đợi ${DELAY_BEFORE_BINGX_MS / 1000} giây trước khi cập nhật BingX...`);
        await sleep(DELAY_BEFORE_BINGX_MS);
        const bingxResult = await updateLeverageForExchange(bingxExchangeId, null);
        if (bingxResult) {
            debugRawLeverageResponses[bingxResult.id].status = bingxResult.status;
            debugRawLeverageResponses[bingxResult.id].timestamp = new Date();
            debugRawLeverageResponses[bingxResult.id].error = bingxResult.error;
        }
    }
    console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất cập nhật TOÀN BỘ đòn bẩy.');
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

    // Giai đoạn 1: Lấy dữ liệu đòn bẩy mục tiêu cho các sàn non-BingX song song
    const nonBingxLeveragePromises = nonBingxExchangeIds.map(id => updateLeverageForExchange(id, symbolsArray));
    const nonBingxResults = await Promise.all(nonBingxLeveragePromises);

    nonBingxResults.forEach(res => {
        if (res) {
            debugRawLeverageResponses[res.id].status = res.status;
            debugRawLeverageResponses[res.id].timestamp = new Date();
            debugRawLeverageResponses[res.id].error = res.error;
        }
    });
    
    // Giai đoạn 2: Nếu có BingX, đợi 60s rồi mới lấy dữ liệu BingX
    if (bingxExchangeId) {
        console.log(`[LEVERAGE_SCHEDULER] ⏳ Đã cập nhật đòn bẩy mục tiêu cho các sàn khác. Đợi ${DELAY_BEFORE_BINGX_MS / 1000} giây trước khi cập nhật BingX...`);
        await sleep(DELAY_BEFORE_BINGX_MS);
        const bingxResult = await updateLeverageForExchange(bingxExchangeId, symbolsArray);
        if (bingxResult) {
            debugRawLeverageResponses[bingxResult.id].status = bingxResult.status;
            debugRawLeverageResponses[bingxResult.id].timestamp = new Date();
            debugRawLeverageResponses[bingxResult.id].error = bingxResult.error;
        }
    }
    console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất cập nhật đòn bẩy MỤC TIÊU.');
}

// ==========================================================
// BẮT ĐẦU LOGIC BITGET WEBSOCKET CLIENT (ĐƯỢC KHÔI PHỤC VÀ TÍCH HỢP LẠI)
// ==========================================================

let bitgetFundingRatesWsCache = {}; // Cache để lưu trữ dữ liệu từ WebSocket
let wsBitget = null; // Biến giữ kết nối WebSocket
let subscribedSymbols = new Set(); // Theo dõi các symbol đã subscribe

const BITGET_WS_URL = 'wss://ws.bitget.com/mix/v1/stream';
const RECONNECT_INTERVAL_MS = 10000; // Thử kết nối lại sau 10 giây
const PING_INTERVAL_MS = 30 * 1000; // Ping mỗi 30 giây để giữ kết nối sống
let pingIntervalId = null;
let reconnectTimeoutId = null;

// Helper để chuyển đổi symbol từ CCXT (BTC/USDT) sang định dạng của Bitget WS (BTCUSDT_UMCBL)
// LƯU Ý: Hàm này tạo ra symbol có _UMCBL, được dùng cho cả WS và Native REST API của Bitget
function formatSymbolForBitgetWS(symbol) {
    return cleanSymbol(symbol) + '_UMCBL';
}

// Helper để chuyển đổi symbol từ Bitget WS (BTCUSDT_UMCBL) sang định dạng cache (BTCUSDT)
function cleanSymbolFromBitgetWS(wsInstId) {
    return wsInstId.replace('_UMCBL', '');
}

// Hàm mới để lấy danh sách các symbol Futures hợp lệ từ Bitget API
async function fetchBitgetValidFuturesSymbols() {
    console.log('[BITGET_SYMBOLS] 🔄 Đang tải danh sách symbol Futures hợp lệ từ Bitget...');
    try {
        const apiPath = '/api/mix/v1/market/contracts?productType=umcbl';
        const rawData = await makeHttpRequest('GET', BITGET_NATIVE_REST_HOST, apiPath);
        const json = JSON.parse(rawData);

        if (json.code === '00000' && Array.isArray(json.data)) {
            bitgetValidFuturesSymbolSet.clear(); // Xóa danh sách cũ
            json.data.forEach(contract => {
                if (contract.symbol) {
                    bitgetValidFuturesSymbolSet.add(contract.symbol); // Thêm symbol đầy đủ (_UMCBL)
                }
            });
            console.log(`[BITGET_SYMBOLS] ✅ Đã tải ${bitgetValidFuturesSymbolSet.size} symbol Futures hợp lệ từ Bitget.`);
            return bitgetValidFuturesSymbolSet;
        } else {
            console.error(`[BITGET_SYMBOLS] ❌ Lỗi khi tải danh sách symbol Futures Bitget: Code ${json.code}, Msg: ${json.msg || 'N/A'}. Raw: ${rawData.substring(0, Math.min(rawData.length, 200))}`);
            return new Set(); // Trả về tập hợp rỗng nếu lỗi
        }
    } catch (e) {
        console.error(`[BITGET_SYMBOLS] ❌ Lỗi request khi tải danh sách symbol Futures Bitget: ${e.msg || e.message}`);
        return new Set();
    }
}


function initializeBitgetWebSocket(exchangeInstance) {
    if (!exchangeInstance) {
        console.error('[BITGET_WS_INIT] Lỗi: Cần truyền instance CCXT của Bitget để khởi tạo WebSocket.');
        return;
    }
    debugRawLeverageResponses['bitget'].wsStatus = getBitgetWsState();

    if (wsBitget && (wsBitget.readyState === WebSocket.OPEN || wsBitget.readyState === WebSocket.CONNECTING)) {
        console.log('[BITGET_WS_INIT] WebSocket Bitget đã hoặc đang kết nối.');
        return;
    }

    console.log('[BITGET_WS_INIT] 🔄 Đang khởi tạo kết nối WebSocket Bitget...');
    wsBitget = new WebSocket(BITGET_WS_URL);
    debugRawLeverageResponses['bitget'].wsStatus = getBitgetWsState();

    wsBitget.onopen = async () => {
        console.log('[BITGET_WS] ✅ Kết nối WebSocket Bitget đã mở.');
        debugRawLeverageResponses['bitget'].wsStatus = getBitgetWsState();
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }

        try {
            await exchangeInstance.loadMarkets(true);
            
            // Đảm bảo danh sách symbol hợp lệ được tải cho WebSocket subscription
            if (bitgetValidFuturesSymbolSet.size === 0) {
                console.log('[BITGET_WS_INIT] Valid Bitget Futures symbols not loaded for WS. Attempting to fetch...');
                await fetchBitgetValidFuturesSymbols(); // Chờ để lấy danh sách symbol hợp lệ
                if (bitgetValidFuturesSymbolSet.size === 0) {
                    console.error('[BITGET_WS_INIT] ❌ Không thể tải danh sách symbol Bitget hợp lệ cho WS. Không thể subscribe.');
                    wsBitget.close(); // Đóng để thử kết nối lại
                    return;
                }
            }

            const allUsdtPerpetuals = Object.values(exchangeInstance.markets)
                .filter(m => m.swap && m.symbol.includes('USDT'));

            if (allUsdtPerpetuals.length > 0) {
                const subscribeArgs = allUsdtPerpetuals
                    // Chỉ subscribe các symbol đã được xác nhận là hợp lệ trên Bitget Futures
                    .filter(m => bitgetValidFuturesSymbolSet.has(formatSymbolForBitgetWS(m.symbol))) 
                    .map(m => {
                        const instId = formatSymbolForBitgetWS(m.symbol);
                        subscribedSymbols.add(instId);
                        return {
                            instType: 'mc', // U-based perpetual
                            channel: 'funding_rate',
                            instId: instId
                        };
                    });
                
                // Gửi subscribe theo lô
                const BATCH_SIZE = 50;
                for (let i = 0; i < subscribeArgs.length; i += BATCH_SIZE) {
                    const batch = subscribeArgs.slice(i, i + BATCH_SIZE);
                    const subscribeMessage = {
                        op: 'subscribe',
                        args: batch
                    };
                    if (batch.length > 0) { // Chỉ gửi nếu có cặp để subscribe
                        wsBitget.send(JSON.stringify(subscribeMessage));
                        console.log(`[BITGET_WS] Đã gửi yêu cầu subscribe cho lô ${i/BATCH_SIZE + 1} (${batch.length} cặp).`);
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
                console.log(`[BITGET_WS] Đã gửi yêu cầu subscribe funding_rate cho tổng cộng ${allUsdtPerpetuals.filter(m => bitgetValidFuturesSymbolSet.has(formatSymbolForBitgetWS(m.symbol))).length} cặp.`);
            } else {
                console.warn('[BITGET_WS] Không tìm thấy cặp USDT perpetual nào để subscribe trên Bitget.');
            }

            pingIntervalId = setInterval(() => {
                if (wsBitget.readyState === WebSocket.OPEN) {
                    wsBitget.send(JSON.stringify({ op: 'ping' }));
                }
            }, PING_INTERVAL_MS);

        } catch (error) {
            console.error('[BITGET_WS] ❌ Lỗi khi tải thị trường hoặc subscribe: ', error.message);
            wsBitget.close();
        }
    };

    wsBitget.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.op === 'pong') {
            return;
        }
        if (data.event === 'subscribe') {
            console.log(`[BITGET_WS] Subscribe phản hồi: ${JSON.stringify(data.arg)} - ${data.success ? 'Thành công' : 'Thất bại'}`);
            if (!data.success) {
                console.warn(`[BITGET_WS] Subscribe thất bại cho args: ${JSON.stringify(data.arg)}, code: ${data.code}, msg: ${data.msg}`);
            }
        } else if (data.action === 'update' && data.data && data.data.length > 0) {
            data.data.forEach(item => {
                const cacheKey = cleanSymbol(item.symbol || cleanSymbolFromBitgetWS(item.instId));

                if (item.symbol && typeof item.fundingRate === 'string' && item.nextSettleTime) {
                    const parsedFundingRate = parseFloat(item.fundingRate);
                    const parsedNextSettleTime = parseInt(item.nextSettleTime, 10);

                    if (!isNaN(parsedFundingRate) && !isNaN(parsedNextSettleTime) && parsedNextSettleTime > 0) {
                        bitgetFundingRatesWsCache[cacheKey] = {
                            fundingRate: parsedFundingRate,
                            nextFundingTime: parsedNextSettleTime
                        };
                    } else {
                        console.warn(`[BITGET_WS_PARSE_WARN] ⚠️ Không thể parse fundingRate/nextSettleTime cho ${cacheKey}. ` +
                                     `fundingRate: '${item.fundingRate}' (type: ${typeof item.fundingRate}), ` +
                                     `nextSettleTime: '${item.nextSettleTime}' (type: ${typeof item.nextSettleTime}). ` +
                                     `Dữ liệu thô của item: ${JSON.stringify(item)}`);
                    }
                } else {
                    console.warn(`[BITGET_WS_DATA_WARN] ⚠️ Dữ liệu funding rate thiếu các trường cần thiết (symbol, fundingRate, nextSettleTime) cho ${cacheKey}. ` +
                                 `Item: ${JSON.stringify(item)}`);
                }
            });
        } else {
            // console.warn(`[BITGET_WS_UNHANDLED_MESSAGE] Nhận được tin nhắn Bitget WS không được xử lý: ${JSON.stringify(data)}`);
        }
    };

    wsBitget.onclose = (event) => {
        console.warn(`[BITGET_WS] ⚠️ Kết nối WebSocket Bitget đóng: Code=${event.code}, Reason=${event.reason}.`);
        debugRawLeverageResponses['bitget'].wsStatus = getBitgetWsState();
        if (pingIntervalId) {
            clearInterval(pingIntervalId);
            pingIntervalId = null;
        }
        wsBitget = null;

        if (event.code !== 1000 && event.code !== 1005) {
            console.log(`[BITGET_WS] Thử kết nối lại sau ${RECONNECT_INTERVAL_MS / 1000}s...`);
            reconnectTimeoutId = setTimeout(() => initializeBitgetWebSocket(exchangeInstance), RECONNECT_INTERVAL_MS);
        }
    };

    wsBitget.onerror = (error) => {
        console.error(`[BITGET_WS] ❌ Lỗi WebSocket Bitget:`, error.message);
        debugRawLeverageResponses['bitget'].wsStatus = getBitgetWsState();
        wsBitget.close();
    };
}

function getBitgetFundingRateFromWsCache(symbol) {
    const cleanedSymbol = cleanSymbol(symbol);
    return bitgetFundingRatesWsCache[cleanedSymbol] || null;
}

function getBitgetWsState() {
    if (!wsBitget) return 'DISCONNECTED';
    switch (wsBitget.readyState) {
        case WebSocket.CONNECTING: return 'CONNECTING';
        case WebSocket.OPEN: return 'OPEN';
        case WebSocket.CLOSING: return 'CLOSING';
        case WebSocket.CLOSED: return 'CLOSED';
        default: return 'UNKNOWN';
    }
}
// ==========================================================
// KẾT THÚC LOGIC BITGET WEBSOCKET CLIENT
// ==========================================================

// Hàm mới để lấy funding rates của Bitget từ API native của họ
// SỬA ĐỔI QUAN TRỌNG: Điều chỉnh cách gọi API native của Bitget để khắc phục 400 Bad Request
async function fetchBitgetFundingRatesNativeApi(exchangeInstance, leverageCache) {
    let processedRates = {};
    let successCount = 0;
    let currentError = null;
    
    // Đảm bảo danh sách symbol hợp lệ được tải trước khi gọi API funding
    if (bitgetValidFuturesSymbolSet.size === 0) {
        console.log('[BITGET_FUNDING] Valid Bitget Futures symbols not loaded for REST API. Attempting to fetch...');
        await fetchBitgetValidFuturesSymbols(); // Chờ để lấy danh sách symbol hợp lệ
        if (bitgetValidFuturesSymbolSet.size === 0) {
            console.error('[BITGET_FUNDING] ❌ Không thể tải danh sách symbol Bitget hợp lệ. Bỏ qua lấy funding rates.');
            return { processedRates: {}, status: 'Funding thất bại (không có symbol hợp lệ)', error: { code: 'NO_VALID_SYMBOLS', msg: 'Could not fetch valid Bitget symbols.' } };
        }
    }

    try {
        await exchangeInstance.loadMarkets(true);
        const bitgetMarkets = Object.values(exchangeInstance.markets)
            .filter(m => m.swap && m.symbol.includes('USDT'));

        console.log(`[DATA] 🎯 Bitget (Native API): Bắt đầu lấy funding rates cho ${bitgetMarkets.length} cặp (trước lọc).`);

        // Lọc các symbol chỉ bao gồm những cặp hợp lệ trên Bitget Futures
        const marketsToFetch = bitgetMarkets.filter(market => {
            const apiRequestSymbol = formatSymbolForBitgetWS(market.symbol);
            if (bitgetValidFuturesSymbolSet.has(apiRequestSymbol)) {
                return true;
            } else {
                console.warn(`[DATA] ⚠️ Bitget (Native API): Bỏ qua ${market.symbol} (${apiRequestSymbol}) - Không tồn tại trong danh sách symbol hợp lệ của Bitget.`);
                return false;
            }
        });

        console.log(`[DATA] 🎯 Bitget (Native API): Sẽ lấy funding rates cho ${marketsToFetch.length} cặp (sau lọc).`);

        // Thực hiện tuần tự để tránh bị rate limit cho API native
        for (const market of marketsToFetch) {
            const ccxtSymbol = market.symbol; // Ví dụ: BTC/USDT
            // Bitget Native REST API yêu cầu tham số 'symbol' trong URL có hậu tố '_UMCBL'
            const apiRequestSymbol = formatSymbolForBitgetWS(ccxtSymbol); 
            
            // Khóa cache sẽ luôn là định dạng BASEUSDT
            const cacheKey = cleanSymbol(ccxtSymbol);

            const maxLeverageParsed = leverageCache['bitget']?.[cacheKey] || null;

            try {
                // Sử dụng endpoint và tham số chính xác
                const apiPath = `/api/mix/v1/market/funding-time?symbol=${apiRequestSymbol}`;
                const rawData = await makeHttpRequest('GET', BITGET_NATIVE_REST_HOST, apiPath);
                const json = JSON.parse(rawData);

                if (json.code === '00000' && json.data) {
                    // Dữ liệu có thể là một mảng, lấy phần tử đầu tiên
                    const fundingData = Array.isArray(json.data) ? json.data[0] : json.data;
                    
                    if (!fundingData) {
                        console.warn(`[DATA] ❌ Bitget (Native API): Không nhận được dữ liệu funding cho ${apiRequestSymbol}. Raw: ${rawData.substring(0, Math.min(rawData.length, 200))}`);
                        continue;
                    }

                    const { fundingRate, nextFundingTime } = fundingData;
                    const parsedFundingRate = parseFloat(fundingRate);
                    const parsedNextFundingTime = parseInt(nextFundingTime, 10);

                    if (!isNaN(parsedFundingRate) && typeof parsedNextFundingTime === 'number' && parsedNextFundingTime > 0) {
                        processedRates[cacheKey] = { // Lưu vào cache bằng khóa đã clean
                            symbol: cacheKey, 
                            fundingRate: parsedFundingRate,
                            fundingTimestamp: parsedNextFundingTime,
                            maxLeverage: maxLeverageParsed
                        };
                        successCount++;
                    } else {
                        console.warn(`[DATA] ❌ Bitget (Native API): Dữ liệu funding rate/timestamp không hợp lệ cho ${apiRequestSymbol}. ` +
                                     `Rate: '${fundingRate}' (type: ${typeof fundingRate}), ` +
                                     `NextFundingTime: '${nextFundingTime}' (type: ${typeof nextFundingTime}). ` +
                                     `Raw Data: ${JSON.stringify(fundingData)}`);
                    }
                } else {
                    console.warn(`[DATA] ❌ Bitget (Native API): Lỗi phản hồi API cho ${apiRequestSymbol}. Code: ${json.code}, Msg: ${json.msg || 'N/A'}. ` +
                                 `Raw: ${rawData.substring(0, Math.min(rawData.length, 200))}`);
                }
            } catch (e) {
                console.error(`[DATA] ❌ Bitget (Native API): Lỗi khi gọi API cho ${apiRequestSymbol}: ${e.msg || e.message}.`);
                currentError = { code: e.code, msg: e.message };
            }
            await sleep(50); // 50ms delay giữa mỗi lần fetch symbol
        }
        console.log(`[DATA] 🎉 Bitget (Native API): Hoàn tất lấy dữ liệu funding. Thành công ${successCount} cặp.`);
        return { processedRates, status: `Funding hoàn tất (${successCount} cặp)`, error: null };
    } catch (e) {
        let errorMessage = `Lỗi nghiêm trọng khi lấy funding từ Bitget Native API: ${e.message}.`;
        console.error(`[DATA] ❌ ${errorMessage}`);
        return { processedRates: {}, status: `Funding thất bại (lỗi: ${e.code || 'UNKNOWN'})`, error: { code: e.code, msg: e.message } };
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

async function fetchFundingRatesForAllExchanges() {
    console.log('[DATA] Bắt đầu làm mới funding rates cho tất cả các sàn...');
    debugRawLeverageResponses['bitget'].wsStatus = getBitgetWsState(); 

    const nonBingxExchangeIds = EXCHANGE_IDS.filter(id => id !== 'bingx');
    const bingxExchangeId = EXCHANGE_IDS.find(id => id === 'bingx');

    // Giai đoạn 1: Lấy dữ liệu funding rates cho các sàn non-BingX song song (bao gồm Binance, OKX, Bitget)
    const initialFundingPromises = nonBingxExchangeIds.map(async (id) => {
        let processedRates = {};
        let currentStatus = 'Đang tải funding...';
        let currentTimestamp = new Date();
        let currentError = null;

        try {
            // Đối với Bitget, chúng ta sẽ gọi API Native của họ để lấy funding rates
            if (id === 'bitget') {
                const bitgetFundingResult = await fetchBitgetFundingRatesNativeApi(exchanges[id], leverageCache);
                processedRates = bitgetFundingResult.processedRates;
                currentStatus = bitgetFundingResult.status;
                currentError = bitgetFundingResult.error;
            } else { // Các sàn khác (Binance, OKX) sử dụng CCXT fetchFundingRates
                await exchanges[id].loadMarkets(true);
                const exchange = exchanges[id];
                const fundingRatesRaw = await exchange.fetchFundingRates();
                let successCount = 0;
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

                    let fundingTimestamp = null;
                    if (typeof rate.nextFundingTime === 'number' && rate.nextFundingTime > 0) {
                        fundingTimestamp = rate.nextFundingTime;
                    } else if (typeof rate.fundingTimestamp === 'number' && rate.fundingTimestamp > 0) {
                        fundingTimestamp = rate.fundingTimestamp;
                    }
                    else if (exchanges[id].markets[rate.symbol]?.info?.nextFundingTime && typeof exchanges[id].markets[rate.symbol].info.nextFundingTime === 'number' && exchanges[id].markets[rate.symbol].info.nextFundingTime > 0) {
                         fundingTimestamp = exchanges[id].markets[rate.symbol].info.nextFundingTime;
                    }
                    if (!fundingTimestamp || fundingTimestamp <= 0) {
                        fundingTimestamp = calculateNextStandardFundingTime();
                    }

                    if (typeof rate.fundingRate === 'number' && !isNaN(rate.fundingRate) && typeof fundingTimestamp === 'number' && fundingTimestamp > 0) {
                        processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: rate.fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverageParsed };
                        successCount++;
                    } else {
                        console.warn(`[DATA] ⚠️ ${id.toUpperCase()}: Bỏ qua ${rate.symbol} - Funding rate hoặc timestamp không hợp lệ hoặc thiếu. Rate: ${rate.fundingRate}, Timestamp: ${fundingTimestamp}.`);
                    }
                }
                currentStatus = `Funding hoàn tất (${successCount} cặp)`;
                console.log(`[DATA] ✅ ${id.toUpperCase()}: Đã lấy thành công ${successCount} funding rates.`);
            }
        } catch (e) {
            let errorMessage = `Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}.`;
            console.error(`[DATA] ❌ ${id.toUpperCase()}: ${errorMessage}`);
            currentStatus = `Funding thất bại (lỗi: ${e.code || 'UNKNOWN'})`;
            currentError = { code: e.code, msg: e.message };
        } finally {
            exchangeData = { ...exchangeData, [id]: { rates: processedRates } };
            debugRawLeverageResponses[id].status = currentStatus;
            debugRawLeverageResponses[id].timestamp = new Date();
            // THAY ĐỔI: Lưu mẫu dữ liệu funding vào debugRawLeverageResponses.data
            if (Object.keys(processedRates).length > 0) {
                const sampleSymbols = Object.keys(processedRates).slice(0, 40);
                const sampleData = {};
                sampleSymbols.forEach(sym => {
                    const data = processedRates[sym];
                    sampleData[sym] = { 
                        fundingRate: data.fundingRate, 
                        fundingTimestamp: data.fundingTimestamp, 
                        nextFundingTimeUTC: new Date(data.fundingTimestamp).toISOString() 
                    };
                });
                debugRawLeverageResponses[id].data = {
                    count: Object.keys(processedRates).length,
                    sample: sampleData
                };
                console.log(`[DATA] ✅ ${id.toUpperCase()}: Đã lấy thành công ${Object.keys(processedRates).length} funding rates. Mẫu (${Object.keys(sampleData).length} cặp) được lưu.`);
            } else {
                debugRawLeverageResponses[id].data = 'Không có dữ liệu funding hợp lệ nào được tìm thấy.';
                console.log(`[DATA] ✅ ${id.toUpperCase()}: Không có dữ liệu funding hợp lệ nào được tìm thấy.`);
            }
            debugRawLeverageResponses[id].error = currentError;
            if (id === 'bitget') {
                debugRawLeverageResponses[id].wsStatus = getBitgetWsState();
            }
            calculateArbitrageOpportunities();
            return { id };
        }
    });

    await Promise.all(initialFundingPromises);

    // Giai đoạn 2: Nếu có BingX, đợi 60s rồi mới lấy dữ liệu BingX
    if (bingxExchangeId) {
        console.log(`[DATA] ⏳ Đã cập nhật funding rates cho các sàn khác. Đợi ${DELAY_BEFORE_BINGX_MS / 1000} giây trước khi cập nhật BingX...`);
        await sleep(DELAY_BEFORE_BINGX_MS);

        let processedRates = {};
        let currentStatus = 'Đang tải funding...';
        let currentTimestamp = new Date();
        let currentError = null;

        try {
            console.log(`[DEBUG_FUNDING] Gọi BingX API trực tiếp để lấy danh sách symbol và funding rates...`);
            const symbols = await getBingxSymbolsDirect();
            console.log(`[DEBUG_FUNDING] BingX: Có tổng ${symbols.length} symbols (USDT). Bắt đầu lấy funding rates (theo lô)...`);

            let fetchedCount = 0;
            let successCount = 0;
            const marketChunks = [];
            for (let i = 0; i < symbols.length; i += BINGX_CONCURRENT_FETCH_LIMIT) {
                marketChunks.push(symbols.slice(i, i + BINGX_CONCURRENT_FETCH_LIMIT));
            }

            for (const chunk of marketChunks) {
                const chunkPromises = chunk.map(async (symbol) => {
                    const result = await getBingxFundingRateDirect(symbol);
                    fetchedCount++;
                    debugRawLeverageResponses[bingxExchangeId].status = `Funding đang tải (${fetchedCount}/${symbols.length} | ${successCount} thành công)`;
                    debugRawLeverageResponses[bingxExchangeId].timestamp = new Date();
                    
                    if (result && typeof result.fundingRate === 'number' && result.fundingTime) {
                        const symbolCleaned = cleanSymbol(result.symbol);
                        const maxLeverageParsed = leverageCache[bingxExchangeId]?.[symbolCleaned] || null;

                        processedRates[symbolCleaned] = {
                            symbol: symbolCleaned,
                            fundingRate: result.fundingRate,
                            fundingTimestamp: result.fundingTime,
                            maxLeverage: maxLeverageParsed
                        };
                        successCount++;
                        return true;
                    }
                    return false;
                });
                await Promise.allSettled(chunkPromises);
                
                if (marketChunks.indexOf(chunk) < marketChunks.length - 1) {
                    await sleep(BINGX_DELAY_BETWEEN_BATCHES_MS);
                }
            }
            currentStatus = `Funding hoàn tất (${successCount} cặp)`;
            console.log(`[DATA] ✅ BingX: Đã lấy thành công ${successCount} funding rates từ API trực tiếp.`);
            
            // THAY ĐỔI: Lưu mẫu dữ liệu funding BingX vào debugRawLeverageResponses.bingx.data
            if (successCount > 0) {
                const sampleSymbols = Object.keys(processedRates).slice(0, 40); // Lấy tối đa 40 cặp
                const sampleData = {};
                sampleSymbols.forEach(sym => {
                    const data = processedRates[sym];
                    sampleData[sym] = { 
                        fundingRate: data.fundingRate, 
                        fundingTimestamp: data.fundingTimestamp, 
                        nextFundingTimeUTC: new Date(data.fundingTimestamp).toISOString() 
                    };
                });
                debugRawLeverageResponses[bingxExchangeId].data = {
                    count: successCount,
                    sample: sampleData
                };
                console.log(`[DEBUG_BINGX_FUNDING] Mẫu dữ liệu funding BingX (${Object.keys(sampleData).length} cặp):`);
                Object.keys(sampleData).forEach(sym => {
                    const data = sampleData[sym];
                    console.log(`  - ${sym}: Rate: ${data.fundingRate}, Next Funding: ${data.nextFundingTimeUTC}`);
                });
                if (Object.keys(processedRates).length > 40) {
                    console.log(`  ... và ${Object.keys(processedRates).length - 40} cặp khác.`);
                }
            } else {
                debugRawLeverageResponses[bingxExchangeId].data = 'Không có dữ liệu funding hợp lệ nào được tìm thấy.';
            }
            console.log(`[DEBUG_BINGX_FUNDING_PROCESSED] BingX processedRates count: ${Object.keys(processedRates).length}`);

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
            calculateArbitrageOpportunities();
        }
    }

    console.log('[DATA] 🎉 Hoàn tất làm mới funding rates.');
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
    
    await fetchFundingRatesForAllExchanges(); 
    lastFullUpdateTimestamp = new Date().toISOString(); 

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    if (TARGETED_LEVERAGE_REFRESH_MINUTES.includes(currentMinute) && currentSecond < 5) {
        console.log(`[LEVERAGE_SCHEDULER] 🎯 Kích hoạt cập nhật đòn bẩy MỤC TIÊU (${currentMinute} phút) SAU KHI DỮ LIỆU FUNDING ĐƯỢC LẤY HOÀN TẤT.`);
        performTargetedLeverageUpdate();
    }

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

function scheduleLeverageUpdates() {
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentHour = now.getUTCHours();
    const currentSecond = now.getUTCSeconds();

    if (currentHour === FULL_LEVERAGE_REFRESH_AT_HOUR && currentMinute === 0 && currentSecond < 5) {
        console.log('[LEVERAGE_SCHEDULER] 🔥 Kích hoạt cập nhật TOÀN BỘ đòn bẩy (00:00 UTC).');
        performFullLeverageUpdate();
    }

    if (currentMinute === 59 && currentSecond >= 30 && currentSecond < 35) {
        const nowMs = Date.now();
        if (!scheduleLeverageUpdates.lastSpecialTrigger || (nowMs - scheduleLeverageUpdates.lastSpecialTrigger > 30 * 1000)) {
            console.log('[SPECIAL_UPDATE] ⏰ Kích hoạt cập nhật ĐẶC BIỆT (phút 59 giây 30).');
            performFullLeverageUpdate();
            scheduleLeverageUpdates.lastSpecialTrigger = nowMs;
        }
    }
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
            },
            debugRawLeverageResponses: debugRawLeverageResponses
        };
        console.log(`[API_DATA] Gửi dữ liệu đến frontend. Total arbitrage ops: ${responseData.arbitrageData.length}. ` +
            `Binance Funds: ${Object.keys(responseData.rawRates.binance).length}. ` +
            `OKX Funds: ${Object.keys(responseData.rawRates.okx).length}. ` +
            `BingX Funds: ${Object.keys(responseData.rawRates.bingx).length}. ` +
            `Bitget Funds: ${Object.keys(responseData.rawRates.bitget).length}. ` +
            `Bitget WS Status: ${responseData.debugRawLeverageResponses.bitget.wsStatus}.`); // Cập nhật log
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, async () => { // Đảm bảo server.listen là async để có thể dùng await
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    
    // Tải danh sách symbol Futures hợp lệ của Bitget một lần khi khởi động
    // Điều này sẽ được sử dụng bởi cả WebSocket và Native API calls
    await fetchBitgetValidFuturesSymbols();

    performFullLeverageUpdate();
    masterLoop();
    initializeBitgetWebSocket(exchanges['bitget']); // Khởi tạo WS Bitget

    setInterval(() => {
        scheduleLeverageUpdates();
    }, 1000);
});
