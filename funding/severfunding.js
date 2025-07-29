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
const MINIMUM_PNL_THRESHOLD = 1;
const IMMINENT_THRESHOLD_MINUTES = 15;

// Cấu hình cho setInterval để cập nhật leverage định kỳ
const FULL_LEVERAGE_REFRESH_AT_HOUR = 0; // Giờ UTC để refresh toàn bộ leverage
const TARGETED_LEVERAGE_REFRESH_MINUTES = [15, 30, 45, 55, 59]; // Các phút để refresh leverage mục tiêu

// Cấu hình BingX: Lấy theo lô, độ trễ giữa các lô
const BINGX_CONCURRENT_FETCH_LIMIT = 4; // Số symbol lấy đồng thời trong 1 lô (áp dụng cho cả lev và funding)
const BINGX_DELAY_BETWEEN_BATCHES_MS = 5000; // Độ trễ giữa các lô (áp dụng cho cả lev và funding)
const BINGX_SINGLE_REQUEST_DELAY_MS = 500; // Độ trễ nhỏ nếu cần cho 1 số API call đơn lẻ (ví dụ retry)

const DELAY_BEFORE_BINGX_MS = 60000; // 60 giây delay trước khi BingX bắt đầu lấy dữ liệu (cho cả fund và lev)

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let isFirstMasterLoopRun = true; // Flag để chạy full update lần đầu tiên

let debugRawLeverageResponses = {
    binanceusdm: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    bingx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    bitget: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null }
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
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if (okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if (bitgetApiPassword) config.password = bitgetApiPassword; }
    else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
});

// Sửa lỗi tên coin: Xử lý các định dạng /USDT, :USDT, -USDT, hoặc USDT ở cuối
const cleanSymbol = (symbol) => symbol.replace(/(\/|:|-)?USDT$/, '');

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
                let logMsg = `[BINGX] Lỗi lấy leverage cho ${symbol} (Lần ${i + 1}/${retries}): ${e.msg || e.message}`;
                if (lastError.rawResponse) {
                    logMsg += ` Raw: ${lastError.rawResponse.substring(0, Math.min(lastError.rawResponse.length, 500))}...`;
                }
                console.warn(logMsg);
                bingxErrorLogCache[errorSignature] = now;
            }

            if (e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT_ERROR' || (e.statusCode >= 500 && e.statusCode < 600) || e.statusCode === 429 || e.code === 100410) {
                const delay = 2 ** i * BINGX_SINGLE_REQUEST_DELAY_MS;
                console.warn(`[BINGX] Lỗi tạm thời (có thể do rate limit/mạng). Thử lại sau ${delay / 1000}s.`);
                await sleep(delay);
                continue;
            } else if (e.statusCode === 400 || e.statusCode === 401 || e.statusCode === 403 || e.code === 1015) {
                if (i < retries - 1) {
                    console.warn(`[BINGX] Lỗi định dạng phản hồi/xác thực. Thử lại sau ${BINGX_SINGLE_REQUEST_DELAY_MS / 1000}s.`);
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

// Lấy funding rate + time cho 1 symbol từ BingX API trực tiếp
async function getBingxFundingRateDirect(symbol, retries = 3) {
    let lastRawData = 'N/A';
    let lastError = null;

    for (let i = 0; i < retries; i++) {
        const urlPath = `/openApi/swap/v2/quote/fundingRate?symbol=${encodeURIComponent(symbol)}`;
        try {
            const data = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath);
            lastRawData = data;
            const json = JSON.parse(data);
            if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
                const firstData = json.data[0];
                
                if (typeof firstData.fundingRate !== 'string') {
                    console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingRate không phải string. Type: ${typeof firstData.fundingRate}. Value: ${firstData.fundingRate}`);
                    lastError = { code: 'PARSE_ERROR', msg: 'FundingRate not string', rawResponse: data };
                } else if (isNaN(parseFloat(firstData.fundingRate))) {
                    console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingRate không parse được số. Value: ${firstData.fundingRate}`);
                    lastError = { code: 'PARSE_ERROR', msg: 'FundingRate not parsable number', rawResponse: data };
                } else if (!firstData.fundingTime || parseInt(firstData.fundingTime, 10) <= 0) { 
                    console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingTime bị thiếu hoặc không hợp lệ. Value: ${firstData.fundingTime}. Bỏ qua.`);
                    lastError = { code: 'PARSE_ERROR', msg: 'FundingTime missing or invalid', rawResponse: data };
                } else {
                    return { // Success path
                        symbol: firstData.symbol,
                        fundingRate: parseFloat(firstData.fundingRate),
                        fundingTime: parseInt(firstData.fundingTime, 10)
                    };
                }
            } else {
                lastError = { code: json.code, msg: json.msg || 'Invalid API Response Structure', type: 'API_RESPONSE_ERROR', rawResponse: data };
            }
            if (lastError && i < retries - 1) {
                await sleep(BINGX_SINGLE_REQUEST_DELAY_MS);
                continue;
            }
            break;
        } catch (e) {
            lastError = { code: e.code, msg: e.msg || e.message, statusCode: e.statusCode || 'N/A', type: 'HTTP_ERROR', rawResponse: e.rawResponse || lastRawData };

            const errorSignature = `${e.code}-${e.statusCode}-${e.msg?.substring(0, 50)}`;
            const now = Date.now();
            if (!bingxErrorLogCache[errorSignature] || (now - bingxErrorLogCache[errorSignature] > BINGX_ERROR_LOG_COOLDOWN_MS)) {
                let logMsg = `[BINGX_FUNDING] Lỗi request khi lấy funding rate cho ${symbol} (Lần ${i+1}/${retries}): ${e.msg || e.message}`;
                if (lastError.rawResponse) {
                    logMsg += ` Raw: ${lastError.rawResponse.substring(0, Math.min(lastError.rawResponse.length, 500))}...`;
                }
                console.warn(logMsg);
                bingxErrorLogCache[errorSignature] = now;
            }

            if (e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT_ERROR' || (e.statusCode >= 500 && e.statusCode < 600) || e.statusCode === 429 || e.code === 100410) {
                const delay = 2 ** i * BINGX_SINGLE_REQUEST_DELAY_MS;
                console.warn(`[BINGX_FUNDING] Lỗi tạm thời (có thể do rate limit/mạng). Thử lại sau ${delay / 1000}s.`);
                await sleep(delay);
                continue;
            } else if (e.statusCode === 400 || e.statusCode === 401 || e.statusCode === 403 || e.code === 1015) {
                 if (i < retries - 1) {
                    console.warn(`[BINGX_FUNDING] Lỗi định dạng phản hồi/xác thực. Thử lại sau ${BINGX_SINGLE_REQUEST_DELAY_MS / 1000}s.`);
                    await sleep(BINGX_SINGLE_REQUEST_DELAY_MS);
                    continue;
                 }
            }
            break;
        }
    }
    return null;
}


/**
 * Cập nhật Max Leverage cho một sàn cụ thể.
 * @param {string} id ID của sàn giao dịch (e.g., 'binanceusdm', 'bingx').
 * @param {string[]} [symbolsToUpdate] Mảng các symbol cần cập nhật. Nếu null, cập nhật tất cả.
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
                console.log(`[LEVERAGE] ✅ Binance: Đã lấy ${successCount} cặp đòn bẩy USDT từ API trực tiếp.`);

            }
        }
        else if (id === 'bingx') {
            // Độ trễ 60s của BingX khi lấy leverage cũng được áp dụng ở đây
            console.log(`[LEVERAGE] ⏳ Đợi ${DELAY_BEFORE_BINGX_MS / 1000} giây trước khi BingX bắt đầu lấy leverage...`);
            await sleep(DELAY_BEFORE_BINGX_MS);

            await exchange.loadMarkets(true);
            const bingxMarkets = Object.values(exchange.markets)
                .filter(m => m.swap && m.symbol.includes('USDT'));

            const marketsToFetch = symbolsToUpdate && symbolsToUpdate.length > 0
                ? bingxMarkets.filter(market => symbolsToUpdate.includes(cleanSymbol(market.symbol)))
                : bingxMarkets;

            const totalSymbols = marketsToFetch.length;

            console.log(`[LEVERAGE] ${id.toUpperCase()}: Bắt đầu lấy dữ liệu đòn bẩy cho ${totalSymbols} cặp (loại: ${updateType})...`);

            let fetchedCount = 0;
            let successCount = 0;
            const marketChunks = [];
            for (let i = 0; i < marketsToFetch.length; i += BINGX_CONCURRENT_FETCH_LIMIT) {
                marketChunks.push(marketsToFetch.slice(i, i + BINGX_CONCURRENT_FETCH_LIMIT));
            }
            for (const chunk of marketChunks) {
                const chunkPromises = chunk.map(async market => {
                    const formattedSymbol = cleanSymbol(market.symbol); 
                    const parsedMaxLeverage = await fetchBingxMaxLeverage(market.symbol.replace('/', '-').replace(':USDT', '')); 
                    fetchedCount++;
                    debugRawLeverageResponses[id].status = `Đòn bẩy đang tải (${fetchedCount}/${totalSymbols} | ${successCount} thành công)`;
                    debugRawLeverageResponses[id].timestamp = new Date();
                    if (parsedMaxLeverage !== null && parsedMaxLeverage > 0) {
                        currentFetchedLeverageDataMap[formattedSymbol] = parsedMaxLeverage; // Lưu trữ với tên đã clean
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
            console.log(`[LEVERAGE] ✅ ${id.toUpperCase()}: Hoàn tất lấy dữ liệu đòn bẩy cho ${Object.keys(currentFetchedLeverageDataMap).length} cặp. (${successCount} cặp được parse thành công)`);
            if (successCount > 0) {
                const sampleSymbols = Object.keys(currentFetchedLeverageDataMap).slice(0, 3);
                console.log(`[DEBUG_BINGX_LEVERAGE] Mẫu dữ liệu đòn bẩy BingX:`);
                sampleSymbols.forEach(sym => {
                    console.log(`  - ${sym}: ${currentFetchedLeverageDataMap[sym]}x`);
                });
                if (Object.keys(currentFetchedLeverageDataMap).length > 3) {
                    console.log(`  ... và ${Object.keys(currentFetchedLeverageDataMap).length - 3} cặp khác.`);
                }
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
                console.log(`[LEVERAGE] ✅ ${id.toUpperCase()}: Đã lấy ${successCount} cặp đòn bẩy USDT từ fetchLeverageTiers.`);
            } else {
                console.log(`[LEVERAGE] ${id.toUpperCase()}: fetchLeverageTiers không khả dụng. Dùng loadMarkets...`);
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
                        console.warn(`[LEVERAGE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
                    }
                }
                status = `Đòn bẩy hoàn tất (loadMarkets, ${loadMarketsSuccessCount} cặp)`;
                debugRawLeverageResponses[id].data = `Đã lấy ${loadMarketsSuccessCount} cặp.`;
                console.log(`[LEVERAGE] ✅ ${id.toUpperCase()}: Đã lấy ${loadMarketsSuccessCount} cặp đòn bẩy USDT từ loadMarkets.`);
            }
        }

        // CẬP NHẬT leverageCache[id]
        if (symbolsToUpdate) {
            symbolsToUpdate.forEach(sym => {
                if (currentFetchedLeverageDataMap[sym]) {
                    leverageCache[id][sym] = currentFetchedLeverageDataMap[sym];
                }
            });
            console.log(`[LEVERAGE] ✅ ${id.toUpperCase()}: Đã cập nhật ${Object.keys(leverageCache[id]).length} cặp đòn bẩy mục tiêu.`);
        } else {
            leverageCache[id] = currentFetchedLeverageDataMap;
            console.log(`[LEVERAGE] ✅ ${id.toUpperCase()}: Tổng số mục đòn bẩy hiện tại: ${Object.keys(leverageCache[id]).length}.`);
        }

    } catch (e) {
        let errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
        console.error(`[LEVERAGE] ❌ ${id.toUpperCase()}: ${errorMessage}`);
        status = `Đòn bẩy thất bại (lỗi chung: ${e.code || 'UNKNOWN'})`;
        error = { code: e.code, msg: e.message };
        leverageCache[id] = {}; // Đặt rỗng nếu lỗi để tránh lỗi lan truyền
    } finally {
        return { id, processedData: currentFetchedLeverageDataMap, status, error };
    }
}

// Hàm mới: Lấy funding rates cho một sàn cụ thể
async function fetchFundingRatesForExchange(id) {
    let processedRates = {};
    let currentStatus = 'Đang tải funding...';
    let currentTimestamp = new Date();
    let currentError = null;

    try {
        if (id === 'bingx') {
            // BingX có độ trễ 60s riêng trước khi bắt đầu
            console.log(`[FUNDING] ⏳ Đợi ${DELAY_BEFORE_BINGX_MS / 1000} giây trước khi BingX bắt đầu lấy funding...`);
            await sleep(DELAY_BEFORE_BINGX_MS);

            console.log(`[FUNDING] Gọi BingX API trực tiếp để lấy danh sách symbol và funding rates...`);
            const symbols = await getBingxSymbolsDirect();
            console.log(`[FUNDING] BingX: Có tổng ${symbols.length} symbols (USDT). Bắt đầu lấy funding rates (theo lô)...`);

            let fetchedCount = 0;
            let successCount = 0;
            const marketChunks = [];
            for (let i = 0; i < symbols.length; i += BINGX_CONCURRENT_FETCH_LIMIT) {
                marketChunks.push(symbols.slice(i, i + BINGX_CONCURRENT_FETCH_LIMIT));
            }

            for (const chunk of marketChunks) {
                const chunkPromises = chunk.map(async (symbol) => {
                    const result = await getBingxFundingRateDirect(symbol); // Giờ đã có retry bên trong
                    fetchedCount++;
                    // Cập nhật status cho BingX Funding
                    debugRawLeverageResponses[id].status = `Funding đang tải (${fetchedCount}/${symbols.length} | ${successCount} thành công)`;
                    debugRawLeverageResponses[id].timestamp = new Date();

                    if (result && typeof result.fundingRate === 'number' && result.fundingTime) {
                        const symbolCleaned = cleanSymbol(result.symbol);
                        // Chỉ cập nhật funding info, leverage sẽ được cập nhật sau
                        processedRates[symbolCleaned] = {
                            symbol: symbolCleaned,
                            fundingRate: result.fundingRate,
                            fundingTimestamp: result.fundingTime,
                            maxLeverage: leverageCache[id]?.[symbolCleaned] || null // Giữ leverage cũ nếu có
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
            console.log(`[FUNDING] ✅ BingX: Đã lấy thành công ${successCount} funding rates từ API trực tiếp.`);
        } else { // Binance, OKX, Bitget (dùng CCXT)
            await exchanges[id].loadMarkets(true);
            const exchange = exchanges[id];
            const fundingRatesRaw = await exchange.fetchFundingRates();
            let successCount = 0;
            for (const rate of Object.values(fundingRatesRaw)) {
                if (rate.type && rate.type !== 'swap' && rate.type !== 'future') continue;
                if (rate.info?.contractType && rate.info.contractType !== 'PERPETUAL') continue;
                if (!rate.symbol.includes('USDT')) continue;

                const symbolCleaned = cleanSymbol(rate.symbol);
                const maxLeverageParsed = leverageCache[id]?.[symbolCleaned] || null;

                let fundingTimestamp = 0; // Initialize to 0 for strict check
                let debugSource = 'none'; 

                // --- Bắt đầu phần sửa lỗi Bitget Timestamp: undefined ---
                if (id === 'bitget') {
                    const originalSymbol = rate.symbol; 

                    // 1. Ưu tiên rate.info.nextUpdate từ fetchFundingRates raw info (nếu có)
                    if (rate.info?.nextUpdate) {
                        const parsedNextUpdate = parseInt(rate.info.nextUpdate, 10);
                        if (!isNaN(parsedNextUpdate) && parsedNextUpdate > 0) {
                            fundingTimestamp = parsedNextUpdate;
                            debugSource = 'rate.info.nextUpdate';
                        } else {
                            console.debug(`[FUNDING_DEBUG] ${id.toUpperCase()} - ${originalSymbol}: (Attempt 1) raw rate.info.nextUpdate: '${rate.info.nextUpdate}' (parsed: ${parsedNextUpdate}) is not a valid timestamp.`);
                        }
                    }
                    // 2. Fallback to CCXT's standard fields (fundingTimestamp or nextFundingTime)
                    if (fundingTimestamp <= 0) { 
                        const ccxtTimestamp = rate.fundingTimestamp || rate.nextFundingTime;
                        if (typeof ccxtTimestamp === 'number' && ccxtTimestamp > 0) {
                            fundingTimestamp = ccxtTimestamp;
                            debugSource = 'ccxt_standard_number';
                        } else if (typeof ccxtTimestamp === 'string') { 
                             const parsedCcxtTimestamp = parseInt(ccxtTimestamp, 10);
                             if (!isNaN(parsedCcxtTimestamp) && parsedCcxtTimestamp > 0) {
                                 fundingTimestamp = parsedCcxtTimestamp;
                                 debugSource = 'ccxt_standard_parsed_string';
                             }
                        }
                        if (fundingTimestamp <= 0) { 
                            console.debug(`[FUNDING_DEBUG] ${id.toUpperCase()} - ${originalSymbol}: (Attempt 2) raw CCXT standard fields (fundingTimestamp: '${rate.fundingTimestamp}', nextFundingTime: '${rate.nextFundingTime}') are not valid timestamps.`);
                        }
                    }
                    // 3. Last resort: check the market info directly for nextFundingTime 
                    if (fundingTimestamp <= 0) {
                        const marketInfoNextFundingTime = exchanges[id].markets[originalSymbol]?.info?.nextFundingTime;
                        if (marketInfoNextFundingTime) {
                            const parsedMarketInfoTime = parseInt(marketInfoNextFundingTime, 10);
                            if (!isNaN(parsedMarketInfoTime) && parsedMarketInfoTime > 0) {
                                fundingTimestamp = parsedMarketInfoTime;
                                debugSource = 'market_info_fallback';
                                console.debug(`[FUNDING_DEBUG] ${id.toUpperCase()} - ${originalSymbol}: (Attempt 3) Lấy nextFundingTime từ market info fallback: ${fundingTimestamp}`);
                            } else {
                                console.debug(`[FUNDING_DEBUG] ${id.toUpperCase()} - ${originalSymbol}: (Attempt 3) market info nextFundingTime: '${marketInfoNextFundingTime}' is not valid.`);
                            }
                        }
                    }
                } else { // For Binance, OKX
                    fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime;
                    debugSource = 'ccxt_standard';
                }
                // --- Kết thúc phần sửa lỗi Bitget Timestamp: undefined ---

                // Validate both funding rate and timestamp
                if (typeof rate.fundingRate !== 'number' || isNaN(rate.fundingRate) || fundingTimestamp <= 0 || isNaN(fundingTimestamp)) {
                    console.error(`[FUNDING] ❌ ${id.toUpperCase()}: Funding rate (${rate.fundingRate}) hoặc timestamp (${fundingTimestamp}, nguồn: ${debugSource}) không hợp lệ hoặc không thực tế cho ${rate.symbol}. Bỏ qua.`);
                    continue;
                }

                processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: rate.fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverageParsed };
                successCount++;
            }
            currentStatus = `Funding hoàn tất (${successCount} cặp)`;
            console.log(`[FUNDING] ✅ ${id.toUpperCase()}: Đã lấy thành công ${successCount} funding rates.`);
        }
    } catch (e) {
        let errorMessage = `Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}.`;
        console.error(`[FUNDING] ❌ ${id.toUpperCase()}: ${errorMessage}`);
        currentStatus = `Funding thất bại (lỗi: ${e.code || 'UNKNOWN'})`;
        currentError = { code: e.code, msg: e.message };
    } finally {
        exchangeData = { ...exchangeData, [id]: { rates: processedRates } };
        debugRawLeverageResponses[id].status = currentStatus;
        debugRawLeverageResponses[id].timestamp = new Date();
        debugRawLeverageResponses[id].error = currentError;
    }
}


function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData)); // Dùng bản sao để tránh thay đổi trong lúc lặp

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

                // Lấy leverage từ leverageCache, nơi mà leverage được cập nhật riêng
                const parsedMaxLeverage1 = leverageCache[exchange1Id]?.[symbol] || null; 
                const parsedMaxLeverage2 = leverageCache[exchange2Id]?.[symbol] || null; 

                if (typeof parsedMaxLeverage1 !== 'number' || parsedMaxLeverage1 <= 0 ||
                    typeof parsedMaxLeverage2 !== 'number' || parsedMaxLeverage2 <= 0) {
                    continue;
                }

                // Đảm bảo funding rate và timestamp đều hợp lệ
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

// Hàm nội bộ để thực hiện cập nhật đòn bẩy đầy đủ (cho setInterval)
async function performFullLeverageUpdateInternal() {
    console.log('[LEVERAGE_SCHEDULER] 🔥 Kích hoạt cập nhật TOÀN BỘ đòn bẩy (từ setInterval).');
    const promises = EXCHANGE_IDS.map(id => updateLeverageForExchange(id, null));
    try {
        await Promise.all(promises);
        console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất cập nhật TOÀN BỘ đòn bẩy từ setInterval.');
        calculateArbitrageOpportunities(); // Recalculate after leverage update
    } catch (err) {
        console.error('[LEVERAGE_SCHEDULER] ❌ Lỗi cập nhật TOÀN BỘ đòn bẩy từ setInterval:', err.message);
    }
}

// Hàm nội bộ để thực hiện cập nhật đòn bẩy mục tiêu (cho setInterval)
async function performTargetedLeverageUpdateInternal() {
    console.log(`[LEVERAGE_SCHEDULER] 🎯 Kích hoạt cập nhật đòn bẩy MỤC TIÊU (từ setInterval).`);
    const activeSymbols = Array.from(new Set(arbitrageOpportunities.map(op => op.coin)));
    if (activeSymbols.length > 0) {
        const promises = EXCHANGE_IDS.map(id => updateLeverageForExchange(id, activeSymbols));
        try {
            await Promise.all(promises);
            console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất cập nhật đòn bẩy MỤC TIÊU từ setInterval.');
            calculateArbitrageOpportunities(); // Recalculate after leverage update
        } catch (err) {
            console.error('[LEVERAGE_SCHEDULER] ❌ Lỗi cập nhật đòn bẩy MỤC TIÊU từ setInterval:', err.message);
        }
    } else {
        console.log('[LEVERAGE_SCHEDULER] Không có cơ hội arbitrage nào. Bỏ qua cập nhật đòn bẩy mục tiêu.');
    }
}


// Hàm điều phối các cập nhật leverage (Full hoặc Targeted) - Chức năng chạy bởi setInterval
function scheduleLeverageUpdates() {
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentHour = now.getUTCHours();
    const currentSecond = now.getUTCSeconds();

    // Cập nhật TOÀN BỘ đòn bẩy vào 00:00 UTC hàng ngày
    if (currentHour === FULL_LEVERAGE_REFRESH_AT_HOUR && currentMinute === 0 && currentSecond < 5) {
        // Thêm cooldown để tránh kích hoạt nhiều lần trong cùng một giây nếu setInterval jitter
        const nowMs = Date.now();
        if (!scheduleLeverageUpdates.lastFullTrigger || (nowMs - scheduleLeverageUpdates.lastFullTrigger > 30 * 1000)) {
            performFullLeverageUpdateInternal(); 
            scheduleLeverageUpdates.lastFullTrigger = nowMs;
        }
    }
    // Cập nhật đòn bẩy MỤC TIÊU vào các phút đã định (15, 30, 45, 55, 59)
    else if (TARGETED_LEVERAGE_REFRESH_MINUTES.includes(currentMinute) && currentSecond < 5) {
        // Thêm cooldown để tránh kích hoạt nhiều lần trong cùng một giây nếu setInterval jitter
        const nowMs = Date.now();
        if (!scheduleLeverageUpdates.lastTargetedTrigger || (nowMs - scheduleLeverageUpdates.lastTargetedTrigger > 30 * 1000)) {
            performTargetedLeverageUpdateInternal();
            scheduleLeverageUpdates.lastTargetedTrigger = nowMs;
        }
    }
}


async function masterLoop() {
    console.log(`\n[MASTER_LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})...`);
    try {
        await syncBinanceServerTime();
    } catch (error) {
        console.error("[MASTER_LOOP] Lỗi đồng bộ thời gian Binance, có thể ảnh hưởng đến các lệnh ký. Thử lại ở vòng lặp sau.");
    }

    const now = new Date();
    const currentHourUTC = now.getUTCHours();
    const currentMinuteUTC = now.getUTCMinutes();
    const isScheduledFullDataRefresh = (currentHourUTC === 0 && currentMinuteUTC === 0);

    if (isFirstMasterLoopRun || isScheduledFullDataRefresh) {
        console.log(`[MASTER_LOOP] 🔥 Thực hiện cập nhật DỮ LIỆU ĐẦY ĐỦ (lần đầu hoặc 00:00 UTC)...`);
        isFirstMasterLoopRun = false; // Reset flag sau lần chạy đầu tiên

        const nonBingxExchangeIds = EXCHANGE_IDS.filter(id => id !== 'bingx');
        const bingxExchangeId = 'bingx';

        // Phase 1: Fetch Funding Rates and Max Leverage for Binance, OKX, Bitget concurrently
        console.log("[MASTER_LOOP] 🚀 Bước 1: Bắt đầu lấy dữ liệu Funding & Leverage cho Binance, OKX, Bitget...");
        const nonBingxCombinedFetchPromises = nonBingxExchangeIds.map(async (id) => {
            console.log(`[MASTER_LOOP]   -> Bắt đầu xử lý ${id.toUpperCase()} (Funding & Leverage)...`);
            await fetchFundingRatesForExchange(id); // Lấy Funding trước
            await updateLeverageForExchange(id);    // Sau đó lấy Leverage
            console.log(`[MASTER_LOOP]   -> Hoàn tất xử lý ${id.toUpperCase()}.`);
        });
        await Promise.all(nonBingxCombinedFetchPromises); // Wait for ALL non-BingX exchanges to complete both funding and leverage
        console.log("[MASTER_LOOP] ✅ Bước 1: Hoàn tất lấy dữ liệu Funding & Leverage cho Binance, OKX, Bitget.");

        // --- KIỂM TRA ĐIỀU KIỆN NGHIÊM NGẶT CHO BITGET TRƯỚC KHI CHẠY BINGX ---
        const bitgetFundsCount = Object.keys(exchangeData.bitget?.rates || {}).length;
        const bitgetLeverageCount = Object.keys(leverageCache.bitget || {}).length;

        if (bitgetFundsCount === 0 || bitgetLeverageCount === 0) {
            console.error(`[MASTER_LOOP] ❌ LỖI NGHIÊM TRỌNG: Bitget không lấy được đủ dữ liệu! Funds: ${bitgetFundsCount} cặp, Leverage: ${bitgetLeverageCount} cặp. Dừng xử lý BingX trong vòng lặp này.`);
            // Continue to calculate arbitrage with available data, then schedule next loop.
            // Do NOT proceed to BingX steps.
        } else {
            console.log(`[MASTER_LOOP] ✅ Kiểm tra Bitget OK. Funds: ${bitgetFundsCount} cặp, Leverage: ${bitgetLeverageCount} cặp.`);
            // Update HTML data after Phase 1 (Binance, OKX, Bitget are fully updated)
            calculateArbitrageOpportunities();
            console.log("[MASTER_LOOP] Dữ liệu HTML (Funding & Leverage Binance, OKX, Bitget) đã sẵn sàng.");

            // Phase 2: Handle BingX Funding Rates
            if (bingxExchangeId) {
                console.log(`[MASTER_LOOP] 🚀 Bước 2: Bắt đầu lấy dữ liệu Funding cho ${bingxExchangeId.toUpperCase()}...`);
                await fetchFundingRatesForExchange(bingxExchangeId);
                console.log(`[MASTER_LOOP] ✅ Bước 2: Hoàn tất lấy dữ liệu Funding cho ${bingxExchangeId.toUpperCase()}.`);
                
                // Update HTML data after BingX Funding (now HTML contains funding for all 4, but leverage only for 3)
                calculateArbitrageOpportunities();
                console.log(`[MASTER_LOOP] Dữ liệu HTML (bao gồm Funding của ${bingxExchangeId.toUpperCase()}) đã được cập nhật.`);

                // Phase 3: Delay 30 seconds (specifically for BingX leverage)
                console.log(`[MASTER_LOOP] ⏳ Bước 3: Đã lấy funding rates cho ${bingxExchangeId.toUpperCase()}. Đợi 30 giây trước khi lấy đòn bẩy...`);
                await sleep(30 * 1000); 

                // Phase 4: Fetch BingX Max Leverage
                console.log(`[MASTER_LOOP] 🚀 Bước 4: Bắt đầu lấy dữ liệu Leverage cho ${bingxExchangeId.toUpperCase()}...`);
                // updateLeverageForExchange('bingx') đã tự có độ trễ 60s và độ trễ giữa các lô bên trong
                await updateLeverageForExchange(bingxExchangeId); 
                console.log(`[MASTER_LOOP] ✅ Bước 4: Hoàn tất lấy dữ liệu Leverage cho ${bingxExchangeId.toUpperCase()}.`);
                
                // Final update for HTML data (all 4 exchanges are fully updated)
                calculateArbitrageOpportunities();
                console.log(`[MASTER_LOOP] Dữ liệu HTML (bao gồm Leverage của ${bingxExchangeId.toUpperCase()}) đã được cập nhật hoàn chỉnh.`);
            }
        }
    } else {
        console.log("[MASTER_LOOP] 💡 Chỉ cập nhật cơ hội arbitrage từ dữ liệu hiện có (Không phải 00:00 UTC).");
        calculateArbitrageOpportunities();
    }

    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[MASTER_LOOP] 🎉 Vòng lặp hoàn tất. Tìm thấy ${arbitrageOpportunities.length} cơ hội.`);
    scheduleNextLoop();
}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId);
    const now = new Date();
    const delaySeconds = (60 - now.getSeconds() + 5) % 60; // Thêm 5 giây để đảm bảo không chạy quá sớm
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
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
            `BingX Leverage Status: ${responseData.debugRawLeverageResponses.bingx.status}.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    
    // Bắt đầu vòng lặp chính để khởi tạo toàn bộ quá trình lấy dữ liệu
    masterLoop(); 

    // Khôi phục setInterval để kích hoạt các cập nhật đòn bẩy định kỳ
    setInterval(() => {
        scheduleLeverageUpdates(); 
    }, 1000); 
});
