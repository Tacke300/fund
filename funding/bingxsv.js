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

const PORT = 5005; // Đảm bảo cổng này khớp với cổng bạn chạy

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 1; // ĐÃ SỬA: Từ 15 xuống 1
const IMMINENT_THRESHOLD_MINUTES = 15;

// Các khoảng thời gian cập nhật leverage
const FULL_LEVERAGE_REFRESH_AT_HOUR = 0; // Cập nhật toàn bộ leverage vào 00:00 UTC hàng ngày
const TARGETED_LEVERAGE_REFRESH_MINUTES = [15, 30, 45, 55, 59]; // Cập nhật leverage cho các symbol đang có cơ hội

// Cấu hình cho việc lấy dữ liệu BingX song song (cho Full Leverage API)
const BINGX_FULL_LEVERAGE_CONCURRENT_FETCH_LIMIT = 10; // ĐÃ SỬA: Từ 2 lên 40
const BINGX_FULL_LEVERAGE_DELAY_BETWEEN_BATCHES_MS = 5000;

// Cấu hình cho BingX Funding Rate API trực tiếp
const BINGX_FUNDING_RATE_DELAY_MS = 1000; // Độ trễ giữa mỗi yêu cầu Funding Rate cho BingX (1 giây)

// Cấu hình cho BingX Targeted Leverage API (từng symbol)
const BINGX_TARGETED_LEVERAGE_DELAY_MS = 1000; // Độ trễ giữa mỗi yêu cầu Leverage cho BingX khi cập nhật targeted (1 giây)

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null; // Dùng cho masterLoop
let leverageSchedulerId = null; // Dùng cho leverage update scheduler

// Khởi tạo trạng thái debug với 'Đang tải...'
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

                    if (!isNaN(maxLongLev) && maxLongLev > 0 && !isNaN(maxShortLev) && maxShortLev > 0) {
                        parsedLeverage = Math.max(maxLongLev, maxShortLev);
                        return parsedLeverage;
                    } else {
                        lastError = { code: parsedJson.code, msg: 'No valid maxLongLeverage/maxShortLeverage found in data', type: 'API_RESPONSE_PARSE_ERROR' };
                    }
                } else {
                    lastError = { code: parsedJson.code, msg: parsedJson.msg || 'Invalid API Response Structure', type: 'API_RESPONSE_ERROR' };
                }
            } catch (jsonParseError) {
                lastError = { code: 'JSON_PARSE_ERROR', msg: jsonParseError.message, type: 'JSON_PARSE_ERROR' };
            }

            if (i < retries - 1) {
                await sleep(500);
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
                console.warn(`[BINGX] Lỗi tạm thời (có thể do rate limit). Thử lại sau ${delay / 1000}s.`);
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

// ✅ Lấy toàn bộ symbol future từ BingX API trực tiếp (được dùng cho Funding Rates)
async function getBingxSymbolsDirect() {
    const urlPath = '/openApi/swap/v2/quote/contracts';
    try {
        const data = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath);
        const json = JSON.parse(data);
        if (json.code === 0 && Array.isArray(json.data)) {
            const symbols = json.data.map(item => item.symbol);
            return symbols;
        } else {
            console.error(`[BINGX_SYMBOLS] Lỗi khi lấy danh sách symbol BingX: Code ${json.code}, Msg: ${json.msg}`);
            return [];
        }
    } catch (e) {
        console.error(`[BINGX_SYMBOLS] Lỗi request khi lấy danh sách symbol BingX: ${e.msg || e.message}`);
        return [];
    }
}

// ✅ Lấy funding rate + time cho 1 symbol từ BingX API trực tiếp
async function getBingxFundingRateDirect(symbol) {
    const urlPath = `/openApi/swap/v2/quote/fundingRate?symbol=${encodeURIComponent(symbol)}`;
    try {
        const data = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath);
        const json = JSON.parse(data);
        if (json.code === 0 && json.data) {
            return {
                symbol: json.data.symbol,
                fundingRate: json.data.fundingRate,
                fundingTime: json.data.fundingTime // Đây chính là nextFundingTime
            };
        } else {
            // Log chi tiết hơn khi không có dữ liệu funding
            console.warn(`[BINGX_FUNDING] Không có dữ liệu funding hoặc lỗi API cho ${symbol}. Code: ${json.code}, Msg: ${json.msg || 'N/A'}`);
            return null;
        }
    } catch (e) {
        console.warn(`[BINGX_FUNDING] Lỗi request khi lấy funding rate cho ${symbol}: ${e.msg || e.message}`);
        return null;
    }
}

/**
 * Cập nhật Max Leverage cho một sàn cụ thể.
 * Hàm này cũng chịu trách nhiệm cập nhật debugRawLeverageResponses cho sàn đó.
 * @param {string} id ID của sàn giao dịch (e.g., 'binanceusdm', 'bingx').
 * @param {string[]} [symbolsToUpdate] Mảng các symbol cần cập nhật (chỉ cho cập nhật có mục tiêu). Nếu null/undefined, sẽ cập nhật tất cả.
 */
async function updateLeverageForExchange(id, symbolsToUpdate = null) {
    const exchange = exchanges[id];
    let fetchedLeverageDataMap = {};
    const updateType = symbolsToUpdate ? 'mục tiêu' : 'toàn bộ';

    // Ghi trạng thái ban đầu lên debugRawLeverageResponses
    debugRawLeverageResponses[id].status = `Đang tải đòn bẩy (${updateType})...`;
    debugRawLeverageResponses[id].timestamp = new Date();
    debugRawLeverageResponses[id].error = null;

    try { // MỘT KHỐI TRY LỚN DUY NHẤT BAO TRÙM TOÀN BỘ LOGIC HÀM
        // Luôn sử dụng dữ liệu leverage hiện có trong cache làm khởi điểm
        // để không bị mất dữ liệu của các symbol không được cập nhật trong lần chạy này
        if (leverageCache[id]) {
            fetchedLeverageDataMap = { ...leverageCache[id] };
        }

        if (id === 'binanceusdm') {
            await syncBinanceServerTime();
            const leverageBracketsResponse = await callSignedBinanceAPI('/fapi/v1/leverageBracket', 'GET');

            let successCount = 0;
            if (Array.isArray(leverageBracketsResponse)) {
                for (const item of leverageBracketsResponse) {
                    const cleanedSym = cleanSymbol(item.symbol);
                    // Nếu là cập nhật mục tiêu, chỉ cập nhật các symbol trong danh sách
                    if (symbolsToUpdate && !symbolsToUpdate.includes(cleanedSym)) {
                        continue;
                    }
                    if (item.symbol && Array.isArray(item.brackets) && item.brackets.length > 0) {
                        const firstBracket = item.brackets.find(b => b.bracket === 1) || item.brackets[0];
                        const maxLeverage = parseInt(firstBracket.initialLeverage, 10);
                        if (!isNaN(maxLeverage) && maxLeverage > 0) {
                            fetchedLeverageDataMap[cleanedSym] = maxLeverage;
                            successCount++;
                        }
                    }
                }
                debugRawLeverageResponses[id].status = `Đòn bẩy hoàn tất (${successCount} cặp)`;
                console.log(`[CACHE] ✅ Binance: Đã lấy ${successCount} cặp đòn bẩy từ API trực tiếp.`);

            }
        }
        else if (id === 'bingx') {
            await exchange.loadMarkets(true);
            const bingxMarkets = Object.values(exchange.markets)
                .filter(m => m.swap && m.quote === 'USDT');

            const marketsToFetch = symbolsToUpdate && symbolsToUpdate.length > 0
                ? bingxMarkets.filter(market => symbolsToUpdate.includes(cleanSymbol(market.symbol)))
                : bingxMarkets;

            const totalSymbols = marketsToFetch.length;

            console.log(`[CACHE] ${id.toUpperCase()}: Bắt đầu lấy dữ liệu đòn bẩy cho ${totalSymbols} cặp (loại: ${updateType})...`);

            let fetchedCount = 0;
            let successCount = 0;

            if (!symbolsToUpdate) { // Nếu là cập nhật toàn bộ, chạy theo lô
                const marketChunks = [];
                for (let i = 0; i < marketsToFetch.length; i += BINGX_FULL_LEVERAGE_CONCURRENT_FETCH_LIMIT) {
                    marketChunks.push(marketsToFetch.slice(i, i + BINGX_FULL_LEVERAGE_CONCURRENT_FETCH_LIMIT));
                }
                for (const chunk of marketChunks) {
                    const chunkPromises = chunk.map(async market => {
                        const formattedSymbol = market.symbol.replace('/', '-').replace(':USDT', '');
                        const parsedMaxLeverage = await fetchBingxMaxLeverage(formattedSymbol);
                        fetchedCount++;
                        if (parsedMaxLeverage !== null && parsedMaxLeverage > 0) {
                            fetchedLeverageDataMap[cleanSymbol(market.symbol)] = parsedMaxLeverage;
                            successCount++;
                        }
                        debugRawLeverageResponses[id].status = `Đòn bẩy đang tải (${fetchedCount}/${totalSymbols} | ${successCount} thành công)`;
                        debugRawLeverageResponses[id].timestamp = new Date();
                        return true;
                    });
                    await Promise.allSettled(chunkPromises);
                    if (marketChunks.indexOf(chunk) < marketChunks.length - 1) {
                        await sleep(BINGX_FULL_LEVERAGE_DELAY_BETWEEN_BATCHES_MS);
                    }
                }
            } else { // Nếu là cập nhật mục tiêu, chạy từng symbol
                for (const market of marketsToFetch) {
                    const formattedSymbol = market.symbol.replace('/', '-').replace(':USDT', '');
                    const parsedMaxLeverage = await fetchBingxMaxLeverage(formattedSymbol);
                    fetchedCount++;
                    if (parsedMaxLeverage !== null && parsedMaxLeverage > 0) {
                        fetchedLeverageDataMap[cleanSymbol(market.symbol)] = parsedMaxLeverage;
                        successCount++;
                    }
                    debugRawLeverageResponses[id].status = `Đòn bẩy đang tải (mục tiêu ${fetchedCount}/${totalSymbols} | ${successCount} thành công)`;
                    debugRawLeverageResponses[id].timestamp = new Date();
                    await sleep(BINGX_TARGETED_LEVERAGE_DELAY_MS);
                }
            }

            debugRawLeverageResponses[id].status = `Đòn bẩy hoàn tất (${successCount} cặp)`;
            console.log(`[CACHE] ✅ ${id.toUpperCase()}: Hoàn tất lấy dữ liệu đòn bẩy cho ${Object.keys(fetchedLeverageDataMap).length} cặp. (${successCount} cặp được parse thành công)`);

        }
        else { // OKX và Bitget: Dùng CCXT (fetchLeverageTiers + loadMarkets fallback)
            debugRawLeverageResponses[id].timestamp = new Date();

            let currentFetchedMap = {};
            if (exchange.has['fetchLeverageTiers']) {
                const leverageTiers = await exchange.fetchLeverageTiers();
                let successCount = 0;
                for (const symbol in leverageTiers) {
                    const cleanedSym = cleanSymbol(symbol);
                    if (symbolsToUpdate && !symbolsToUpdate.includes(cleanedSym)) {
                        continue;
                    }
                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        const numericLeverages = tiers.map(t => typeof t.leverage === 'number' ? t.leverage : parseFloat(t.leverage)).filter(l => !isNaN(l) && l > 0);
                        const parsedMaxLeverage = numericLeverages.length > 0 ? parseInt(Math.max(...numericLeverages), 10) : 0;
                        if (parsedMaxLeverage > 0) {
                            currentFetchedMap[cleanedSym] = parsedMaxLeverage;
                            successCount++;
                        }
                    }
                }
                debugRawLeverageResponses[id].status = `Đòn bẩy hoàn tất (${successCount} cặp)`;
                debugRawLeverageResponses[id].data = `Đã lấy ${successCount} cặp.`;
            } else {
                console.log(`[CACHE] ${id.toUpperCase()}: fetchLeverageTiers không khả dụng. Dùng loadMarkets...`);
                await exchange.loadMarkets(true);
                let loadMarketsSuccessCount = 0;
                for (const market of Object.values(exchange.markets)) {
                    const cleanedSym = cleanSymbol(market.symbol);
                    if (symbolsToUpdate && !symbolsToUpdate.includes(cleanedSym)) {
                        continue;
                    }
                    if (market.swap && market.quote === 'USDT') {
                        const maxLeverage = getMaxLeverageFromMarketInfo(market);
                        if (maxLeverage !== null && maxLeverage > 0) {
                            currentFetchedMap[cleanedSym] = maxLeverage;
                            loadMarketsSuccessCount++;
                        } else {
                            console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
                        }
                    }
                }
                debugRawLeverageResponses[id].status = `Đòn bẩy hoàn tất (loadMarkets, ${loadMarketsSuccessCount} cặp)`;
                debugRawLeverageResponses[id].data = `Đã lấy ${loadMarketsSuccessCount} cặp.`;
            }

            // Nếu là cập nhật mục tiêu, hãy kết hợp với dữ liệu cũ
            if (symbolsToUpdate) {
                symbolsToUpdate.forEach(sym => {
                    if (currentFetchedMap[sym]) {
                        fetchedLeverageDataMap[sym] = currentFetchedMap[sym];
                    } else if (leverageCache[id] && leverageCache[id][sym]) {
                        // Nếu không tìm thấy trong lần fetch này nhưng có trong cache, giữ giá trị cũ
                        fetchedLeverageDataMap[sym] = leverageCache[id][sym];
                    }
                });
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã cập nhật ${Object.keys(fetchedLeverageDataMap).length} cặp đòn bẩy mục tiêu.`);
            } else {
                // Nếu là cập nhật toàn bộ, thay thế hoàn toàn
                fetchedLeverageDataMap = currentFetchedMap;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã lấy ${Object.keys(fetchedLeverageDataMap).length} cặp đòn bẩy toàn bộ.`);
            }

        }

        // Cập nhật leverageCache và tính toán cơ hội ngay lập tức
        leverageCache[id] = fetchedLeverageDataMap; // Cập nhật cho sàn hiện tại
        const count = Object.keys(leverageCache[id]).length;
        console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số mục đòn bẩy hiện tại: ${count}.`);
        debugRawLeverageResponses[id].timestamp = new Date();
        debugRawLeverageResponses[id].error = null;
        calculateArbitrageOpportunities(); // Tính toán lại cơ hội sau mỗi lần cập nhật đòn bẩy của một sàn

    } catch (e) { // Đây là catch cho try lớn nhất của hàm updateLeverageForExchange
        let errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
        console.error(`[CACHE] ❌ ${id.toUpperCase()}: ${errorMessage}`);
        debugRawLeverageResponses[id].status = `Đòn bẩy thất bại (lỗi chung: ${e.code || 'UNKNOWN'})`;
        debugRawLeverageResponses[id].timestamp = new Date();
        debugRawLeverageResponses[id].error = { code: e.code, msg: e.message };
        leverageCache[id] = {}; // Đảm bảo là rỗng nếu có lỗi
        calculateArbitrageOpportunities(); // Tính lại cơ hội ngay cả khi lỗi
    }
}

// Hàm này sẽ chạy một lần lúc 00:00 UTC và lần đầu khởi động
async function performFullLeverageUpdate() {
    console.log('\n[LEVERAGE_SCHEDULER] 🔄 Bắt đầu cập nhật TOÀN BỘ đòn bẩy cho tất cả các sàn...');

    const nonBingxExchanges = EXCHANGE_IDS.filter(id => id !== 'bingx');
    const bingxExchange = EXCHANGE_IDS.find(id => id === 'bingx');

    // Chạy các sàn không phải BingX song song
    await Promise.all(nonBingxExchanges.map(id => updateLeverageForExchange(id, null)));

    // Sau đó chạy BingX
    if (bingxExchange) {
        await updateLeverageForExchange(bingxExchange, null);
    }
    console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất cập nhật TOÀN BỘ đòn bẩy.');
}

// Hàm này sẽ chạy vào các phút 15, 30, 45, 55, 59
async function performTargetedLeverageUpdate() {
    // Lấy danh sách các symbol đang có cơ hội
    const activeSymbols = new Set();
    arbitrageOpportunities.forEach(op => activeSymbols.add(op.coin));

    if (activeSymbols.size === 0) {
        console.log('[LEVERAGE_SCHEDULER] Không có cơ hội arbitrage nào. Bỏ qua cập nhật đòn bẩy mục tiêu.');
        // Cập nhật trạng thái cho tất cả các sàn là "Bỏ qua"
        EXCHANGE_IDS.forEach(id => {
            debugRawLeverageResponses[id].status = 'Đòn bẩy bỏ qua (không có cơ hội)';
            debugRawLeverageResponses[id].timestamp = new Date();
            debugRawLeverageResponses[id].error = null;
        });
        return;
    }

    console.log(`[LEVERAGE_SCHEDULER] 🎯 Bắt đầu cập nhật đòn bẩy MỤC TIÊU cho ${activeSymbols.size} symbol.`);

    const symbolsArray = Array.from(activeSymbols);
    const nonBingxExchanges = EXCHANGE_IDS.filter(id => id !== 'bingx');
    const bingxExchange = EXCHANGE_IDS.find(id => id === 'bingx');

    // Chạy các sàn không phải BingX song song
    await Promise.all(nonBingxExchanges.map(id => updateLeverageForExchange(id, symbolsArray)));

    // Sau đó chạy BingX
    if (bingxExchange) {
        await updateLeverageForExchange(bingxExchange, symbolsArray);
    }
    console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất cập nhật đòn bẩy MỤC TIÊU.');

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

// Hàm này lấy funding rates cho tất cả các sàn và CẬP NHẬT incremental
async function fetchFundingRatesForAllExchanges() {
    console.log('[DATA] Bắt đầu làm mới funding rates cho tất cả các sàn...');
    // Tạo một bản sao exchangeData tạm thời
    const tempExchangeData = { ...exchangeData };

    for (const id of EXCHANGE_IDS) {
        let processedRates = {};
        let currentStatus = 'Đang tải funding...';
        let currentTimestamp = new Date();
        let currentError = null;

        try {
            if (id === 'bingx') {
                console.log(`[DEBUG_FUNDING] Gọi BingX API trực tiếp để lấy danh sách symbol và funding rates...`);
                const symbols = await getBingxSymbolsDirect();
                console.log(`[DEBUG_FUNDING] BingX: Có tổng ${symbols.length} symbols. Bắt đầu lấy funding rates...`);

                let successCount = 0;
                for (let i = 0; i < symbols.length; i++) {
                    const result = await getBingxFundingRateDirect(symbols[i]);
                    if (result && result.fundingRate && result.fundingTime) {
                        const symbolCleaned = cleanSymbol(result.symbol);
                        const maxLeverageParsed = leverageCache[id]?.[symbolCleaned] || null;

                        processedRates[symbolCleaned] = {
                            symbol: symbolCleaned,
                            fundingRate: parseFloat(result.fundingRate),
                            fundingTimestamp: parseInt(result.fundingTime, 10), // Sử dụng fundingTime làm fundingTimestamp
                            maxLeverage: maxLeverageParsed
                        };
                        successCount++;
                    } else if (result && result.error) {
                        console.warn(`[DATA] ⚠️ BingX: Lỗi khi lấy funding rate cho ${symbols[i]}: ${result.error}`);
                    }
                    await sleep(BINGX_FUNDING_RATE_DELAY_MS);
                }
                currentStatus = `Funding hoàn tất (${successCount} cặp)`;
                console.log(`[DATA] ✅ BingX: Đã lấy thành công ${successCount} funding rates từ API trực tiếp.`);

            } else { // Cho Binance, OKX, Bitget, dùng CCXT's fetchFundingRates
                const exchange = exchanges[id];
                const fundingRatesRaw = await exchange.fetchFundingRates();
                let successCount = 0;
                for (const rate of Object.values(fundingRatesRaw)) {
                    const symbolCleaned = cleanSymbol(rate.symbol);
                    const maxLeverageParsed = leverageCache[id]?.[symbolCleaned] || null;

                    let fundingTimestamp;
                    // Bitget có thể dùng rate.info.nextUpdate
                    if (id === 'bitget' && rate.info?.nextUpdate) {
                        fundingTimestamp = parseInt(rate.info.nextUpdate, 10);
                    } else {
                        fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();
                    }

                    if (typeof rate.fundingRate === 'number' && !isNaN(rate.fundingRate) && typeof fundingTimestamp === 'number' && fundingTimestamp > 0) {
                        processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: rate.fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverageParsed };
                        successCount++;
                    } else {
                        console.warn(`[DATA] ⚠️ ${id.toUpperCase()}: Funding rate hoặc timestamp không hợp lệ cho ${rate.symbol}.`);
                    }
                }
                currentStatus = `Funding hoàn tất (${successCount} cặp)`;
                if (Object.keys(processedRates).length > 0) {
                    console.log(`[DATA] ✅ ${id.toUpperCase()}: Đã lấy thành công ${successCount} funding rates.`);
                } else {
                    console.warn(`[DATA] ⚠️ ${id.toUpperCase()}: Không lấy được funding rates nào.`);
                }
            }
            // CẬP NHẬT BIẾN TOÀN CỤC exchangeData VÀ debugRawLeverageResponses NGAY LẬP TỨC CHO SÀN HIỆN TẠI
            tempExchangeData[id] = { rates: processedRates };
            exchangeData = tempExchangeData; // Gán lại toàn bộ để frontend thấy
            debugRawLeverageResponses[id].status = currentStatus;
            debugRawLeverageResponses[id].timestamp = new Date();
            debugRawLeverageResponses[id].error = null; // Reset lỗi nếu thành công

            calculateArbitrageOpportunities(); // Tính toán lại cơ hội ngay sau khi funding của một sàn được cập nhật

        } catch (e) {
            let errorMessage = `Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}.`;
            console.error(`[DATA] ❌ ${id.toUpperCase()}: ${errorMessage}`);
            currentStatus = `Funding thất bại (lỗi: ${e.code || 'UNKNOWN'})`;
            currentError = { code: e.code, msg: e.message };

            tempExchangeData[id] = { rates: {} }; // Đảm bảo là rỗng nếu lỗi
            exchangeData = tempExchangeData; // Gán lại ngay cả khi lỗi
            debugRawLeverageResponses[id].status = currentStatus;
            debugRawLeverageResponses[id].timestamp = new Date();
            debugRawLeverageResponses[id].error = currentError;
            calculateArbitrageOpportunities(); // Tính lại cơ hội ngay cả khi có lỗi funding
        }
    }
    console.log('[DATA] 🎉 Hoàn tất làm mới funding rates.');

}

function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData)); // Tạo bản sao sâu

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

// masterLoop: Chỉ chịu trách nhiệm về chu kỳ cập nhật chính (chủ yếu là funding rates)
async function masterLoop() {
    console.log(`\n[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})...`);

    try {
        await syncBinanceServerTime();
    } catch (error) {
        console.error("[LOOP] Lỗi đồng bộ thời gian Binance, có thể ảnh hưởng đến các lệnh ký. Thử lại ở vòng lặp sau.");
    }

    await fetchFundingRatesForAllExchanges();

    // lastFullUpdateTimestamp chỉ cập nhật sau khi tất cả các vòng lặp đã xong.
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP] ✅ Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
    scheduleNextLoop(); // Đặt lịch vòng lặp funding rate tiếp theo

}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId);
    const now = new Date();
    const delaySeconds = (60 - now.getSeconds() + 5) % 60; // Bắt đầu vòng lặp vào phút tiếp theo + 5 giây
    const delayMs = (delaySeconds === 0 ? 60 : delaySeconds) * 1000;
    console.log(`[SCHEDULER] Vòng lặp kế tiếp sau ${delaySeconds.toFixed(0)} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delayMs);
}

// Hàm điều phối các cập nhật leverage (Full hoặc Targeted)
function scheduleLeverageUpdates() {
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentHour = now.getUTCHours();

    // Cập nhật TOÀN BỘ đòn bẩy vào 00:00 UTC hàng ngày
    // Đảm bảo chỉ chạy 1 lần vào giây đầu tiên của phút 00:00
    if (currentHour === FULL_LEVERAGE_REFRESH_AT_HOUR && currentMinute === 0 && now.getUTCSeconds() < 5) {
        console.log('[LEVERAGE_SCHEDULER] 🔥 Kích hoạt cập nhật TOÀN BỘ đòn bẩy (00:00 UTC).');
        performFullLeverageUpdate(); // Chạy nền
    }
    // Cập nhật đòn bẩy MỤC TIÊU vào các phút đã định
    else if (TARGETED_LEVERAGE_REFRESH_MINUTES.includes(currentMinute) && now.getUTCSeconds() < 5) {
        console.log(`[LEVERAGE_SCHEDULER] 🎯 Kích hoạt cập nhật đòn bẩy MỤC TIÊU (${currentMinute} phút).`);
        performTargetedLeverageUpdate(); // Chạy nền
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
            lastUpdated: lastFullUpdateTimestamp, // Đây là thời điểm vòng lặp funding cuối cùng hoàn tất
            arbitrageData: arbitrageOpportunities, // Luôn chứa dữ liệu mới nhất (đã cập nhật incremental)
            rawRates: {
                binance: Object.values(exchangeData.binanceusdm?.rates || {}),
                bingx: Object.values(exchangeData.bingx?.rates || {}),
                okx: Object.values(exchangeData.okx?.rates || {}),
                bitget: Object.values(exchangeData.bitget?.rates || {}),
            },
            debugRawLeverageResponses: debugRawLeverageResponses // Luôn chứa trạng thái debug chi tiết
        };
        // Log dữ liệu gửi đi để debug
        console.log(`[API_DATA] Gửi dữ liệu đến frontend. Total arbitrage ops: ${responseData.arbitrageData.length}.  ` +
            `BingX Leverage Status: ${responseData.debugRawLeverageResponses.bingx.status}.  ` +
            `BingX Funding Rates Count: ${Object.keys(responseData.rawRates.bingx).length}.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);

    // GỌI CÁC CHỨC NĂNG KHỞI TẠO BAN ĐẦU (chạy nền)
    // Sẽ chạy performFullLeverageUpdate ngay lập tức khi khởi động
    performFullLeverageUpdate();
    // masterLoop sẽ bắt đầu vòng lặp cập nhật funding rates hàng phút
    masterLoop();

    // Đặt lịch cho hàm điều phối cập nhật leverage (chạy mỗi phút để kiểm tra thời gian)
    // Sẽ chạy vào giây thứ 0 của mỗi phút
    // Hàm này sẽ tự gọi performFullLeverageUpdate hoặc performTargetedLeverageUpdate
    setInterval(() => {
        scheduleLeverageUpdates();
    }, (60 - new Date().getSeconds()) * 1000 || 60000); // Chạy vào đầu phút tới, sau đó mỗi 60 giây

});
