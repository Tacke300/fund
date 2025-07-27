const http = require('http');
const https = require('https'); // Dùng module https native của Node.js
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const { URLSearchParams } = require('url'); // Sử dụng URLSearchParams để xây dựng query string

// Import các API Key và Secret từ file config.js
const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('./config.js');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let serverTimeOffset = 0; // Để đồng bộ thời gian với Binance API

// Biến mới để lưu trữ phản hồi thô cho mục đích gỡ lỗi trên dashboard
let debugRawLeverageResponses = {
    binanceusdm: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    bingx: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    bitget: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null }
};

const BINANCE_BASE_HOST = 'fapi.binance.com'; // Hằng số cho Binance Host
const BINGX_BASE_HOST = 'open-api.bingx.com'; // Hằng số cho BingX Host

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

// Hàm sleep để chờ giữa các request
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Hàm này giúp trích xuất maxLeverage từ market info nếu fetchLeverageTiers không có
// (Chủ yếu dùng cho OKX/Bitget nếu cần fallback)
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

// === CÁC HÀM SAO CHÉP TỪ BẢN MÃ BOT GIAO DỊCH CỦA BẠN VÀ CHỈNH SỬA ===

function createSignature(queryString, apiSecret) { return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex'); }

async function makeHttpRequest(method, hostname, path, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            port: 443,
            path: path,
            method: method,
            headers: { ...headers, 'User-Agent': 'NodeJS-Arbitrage-Client' },
            timeout: 20000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                const contentType = res.headers['content-type'] || '';
                try {
                    // Kiểm tra Content-Type
                    if (!contentType.includes('application/json')) {
                        return reject({
                            code: 'UNEXPECTED_CONTENT_TYPE',
                            msg: `Phản hồi không phải JSON: Content-Type là ${contentType}.`,
                            url: `${hostname}${path}`,
                            rawResponse: data, // BAO GỒM TOÀN BỘ DATA THÔ (kể cả HTML)
                            statusCode: res.statusCode
                        });
                    }

                    const responseJson = JSON.parse(data);
                    
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(JSON.stringify(responseJson)); // Trả về JSON string để hàm gọi parse lại
                    } else {
                        let errorDetails = {
                            code: res.statusCode,
                            msg: `HTTP Lỗi: ${res.statusCode} ${res.statusMessage}`,
                            url: `${hostname}${path}`,
                            rawResponse: data, // BAO GỒM TOÀN BỘ DATA THÔ CẢ KHI CÓ LỖI HTTP VÀ LÀ JSON
                            parsedResponse: responseJson,
                            statusCode: res.statusCode
                        };
                        reject(errorDetails);
                    }
                } catch (e) {
                    reject({
                        code: 'JSON_PARSE_ERROR',
                        msg: `${e.message} (khi parse response từ ${hostname}${path}).`,
                        rawResponse: data, // BAO GỒM TOÀN BỘ DATA THÔ KHI LỖI PARSE JSON
                        statusCode: res.statusCode || 'N/A' // Lỗi parse có thể không có statusCode
                    });
                }
            });
        });

        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: `${e.message} (khi gọi ${hostname}${path})` }));
        req.on('timeout', () => {
            req.destroy();
            reject({ code: 'TIMEOUT_ERROR', msg: `Request timed out sau ${options.timeout / 1000}s (khi gọi ${hostname}${path})` });
        });

        if (postData && (method === 'POST' || method === 'PUT')) req.write(postData);
        req.end();
    });
}

async function callSignedBinanceAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!binanceApiKey || !binanceApiSecret) {
        throw new Error("Lỗi: Thiếu Binance API Key/Secret.");
    }
    const timestamp = Date.now() + serverTimeOffset;
    const recvWindow = 5000;
    let queryString = new URLSearchParams(params).toString();
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, binanceApiSecret);

    let requestPath;
    let requestBody = '';
    const headers = { 'X-MBX-APIKEY': binanceApiKey };

    if (method === 'GET' || method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
    } else if (method === 'POST' || method === 'PUT') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Phương thức API không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BINANCE_BASE_HOST, requestPath, headers, requestBody);
        return JSON.parse(rawData);
    } catch (error) {
        if (error.code === -1021 && error.msg && error.msg.toLowerCase().includes("timestamp")) {
            console.warn(`[BINANCE_API] ⚠️ Lỗi timestamp. Thử đồng bộ thời gian.`);
            await syncServerTime(); // Thử đồng bộ lại thời gian
        }
        throw error; // Ném lỗi gốc để hàm gọi có thể truy cập rawResponse
    }
}

async function callPublicBinanceAPI(fullEndpointPath, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const fullPathWithQuery = `${fullEndpointPath}${queryString ? '?' + queryString : ''}`;
    try {
        const rawData = await makeHttpRequest('GET', BINANCE_BASE_HOST, fullPathWithQuery, {});
        return JSON.parse(rawData);
    } catch (error) {
        throw error; // Ném lỗi gốc để hàm gọi có thể truy cập rawResponse
    }
}

async function syncServerTime() {
    try {
        const d = await callPublicBinanceAPI('/fapi/v1/time');
        serverTimeOffset = d.serverTime - Date.now();
        console.log(`[TIME] Đồng bộ thời gian Binance server: Offset ${serverTimeOffset}ms.`);
    } catch (e) {
        console.error(`[TIME] ❌ Lỗi đồng bộ thời gian Binance: ${e.msg || e.message}.`);
        throw new Error(`Lỗi đồng bộ thời gian Binance: ${e.msg || e.message}`);
    }
}

// Hàm fetch BingX max leverage cho một symbol cụ thể (theo đề xuất của bạn, với retry)
async function fetchBingxMaxLeverage(symbol, retries = 3) {
    if (!bingxApiKey || !bingxApiSecret) {
        console.warn(`[BINGX] ⚠️ Thiếu API Key/Secret cho BingX.`);
        return null;
    }

    for (let i = 0; i < retries; i++) {
        const params = `symbol=${symbol}`;
        const timestamp = Date.now();
        const query = `${params}×tamp=${timestamp}`;
        const signature = createSignature(query, bingxApiSecret); // Sử dụng createSignature đã có
        const urlPath = `/openApi/swap/v2/trade/leverage?${params}×tamp=${timestamp}&signature=${signature}`;
        const headers = { 'X-BX-APIKEY': bingxApiKey };

        try {
            const rawRes = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath, headers);
            const data = JSON.parse(rawRes); // makeHttpRequest đã đảm bảo là JSON hoặc đã reject

            if (data.code === 0 && data.data?.leverage) {
                return parseInt(data.data.leverage, 10);
            } else {
                console.warn(`[BINGX] Phản hồi leverage cho ${symbol} không hợp lệ (Lần ${i+1}/${retries}): code ${data.code}, msg: ${data.msg || 'N/A'}.`);
                if (data.code === 1015 || data.code === 429) { // Cloudflare rate limit hoặc generic rate limit
                    const delay = 2 ** i * 1000; // Exponential backoff
                    console.warn(`[BINGX] Bị rate limit hoặc lỗi 1015. Thử lại sau ${delay / 1000}ms.`);
                    await sleep(delay);
                    continue; // Thử lại
                }
                // Đối với các lỗi khác, không thử lại
                break;
            }
        } catch (e) {
            let logMsg = `[BINGX] Lỗi lấy leverage cho ${symbol} (Lần ${i+1}/${retries}): ${e.msg || e.message}`;
            if (e.rawResponse) {
                logMsg += ` Raw: ${e.rawResponse.substring(0, 500)}...`; // Log HTML thô nếu có
            }
            console.warn(logMsg);

            if (e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT_ERROR' || (e.code >= 500 && e.code < 600)) { // Thử lại khi có lỗi mạng, timeout, hoặc lỗi server
                const delay = 2 ** i * 1000;
                console.warn(`[BINGX] Lỗi tạm thời. Thử lại sau ${delay / 1000}ms.`);
                await sleep(delay);
                continue; // Thử lại
            } else if (e.code === 'UNEXPECTED_CONTENT_TYPE' || e.code === 'JSON_PARSE_ERROR') {
                 console.warn(`[BINGX] Lỗi định dạng phản hồi hoặc parse JSON. Thử lại sau 1s.`);
                 await sleep(1000); // Đợi một chút, có thể là do bị chặn tạm thời
                 continue;
            }
            break; // Đối với các lỗi khác, không thử lại
        }
    }
    return null; // Tất cả các lần thử lại đều thất bại
}


// Hàm khởi tạo bộ nhớ đệm đòn bẩy cho tất cả các sàn
async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id];
        newCache[id] = {}; // Đảm bảo luôn khởi tạo cache cho sàn này

        try {
            let fetchedLeverageData = {};
            let leverageSource = "Unknown";
            let currentRawDebug = { status: 'thất bại', timestamp: new Date(), data: 'N/A', error: null }; // Để lưu vào debugRawLeverageResponses

            if (id === 'binanceusdm') {
                // Đối với Binance, LUÔN dùng REST API trực tiếp từ bản mã bot của bạn
                try {
                    const binanceRawLeverage = await callSignedBinanceAPI('/fapi/v1/leverageBracket', 'GET'); // Gọi không có symbol để lấy tất cả
                    if (Array.isArray(binanceRawLeverage)) {
                        for (const item of binanceRawLeverage) {
                            const symbolCleaned = cleanSymbol(item.symbol);
                            if (item.brackets && Array.isArray(item.brackets) && item.brackets.length > 0) {
                                // Lấy maxLeverage từ các bậc (brackets)
                                const maxLeverage = Math.max(...item.brackets.map(b => b.leverage));
                                if (maxLeverage > 0) {
                                    fetchedLeverageData[symbolCleaned] = maxLeverage;
                                }
                            }
                        }
                        leverageSource = "Binance REST API";
                        currentRawDebug = { status: 'thành công', timestamp: new Date(), data: JSON.stringify(binanceRawLeverage), error: null };
                    } else {
                        console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Phản hồi từ Binance REST API không phải là mảng hoặc trống.`);
                        leverageSource = "Binance REST API (phản hồi không mong đợi)";
                        currentRawDebug = { status: 'thất bại (phản hồi không mong đợi)', timestamp: new Date(), data: JSON.stringify(binanceRawLeverage), error: null };
                    }
                } catch (e) {
                    let logMsg = `[CACHE] ❌ ${id.toUpperCase()}: Lỗi khi lấy đòn bẩy qua Binance REST API: ${e.msg || e.message}.`;
                    if (e.rawResponse) {
                        logMsg += ` Raw: ${e.rawResponse.substring(0, 500)}...`;
                    }
                    console.error(logMsg);
                    leverageSource = "Binance REST API (lỗi)";
                    currentRawDebug = { status: `thất bại (${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.rawResponse || 'N/A', error: { code: e.code, msg: e.msg || e.message } };
                }
            }
            else if (id === 'bingx') {
                // Đối với BingX, áp dụng giải pháp của bạn: loadMarkets rồi gọi API riêng từng cặp
                leverageSource = "BingX REST API /trade/leverage";
                try {
                    await exchange.loadMarkets(true); // Cần loadMarkets để lấy danh sách symbol
                    const bingxMarkets = Object.values(exchange.markets).filter(m => m.swap && m.quote === 'USDT');
                    console.log(`[CACHE] ${id.toUpperCase()}: Tìm thấy ${bingxMarkets.length} cặp swap USDT. Đang lấy đòn bẩy từng cặp...`);

                    let firstRawResponseForDebug = null; // Chỉ lưu phản hồi đầu tiên cho mục đích debug
                    let firstErrorForDebug = null;

                    for (const market of bingxMarkets) {
                        const formattedSymbol = market.symbol.replace('/', '-').replace(':USDT', '');
                        try {
                            const maxLev = await fetchBingxMaxLeverage(formattedSymbol);
                            if (maxLev && maxLev > 1) {
                                fetchedLeverageData[cleanSymbol(market.symbol)] = maxLev;
                            }
                            if (firstRawResponseForDebug === null && !firstErrorForDebug) {
                                // Nếu thành công, lưu một mẫu phản hồi thành công (không có rawResponse trong makeHttpRequest thành công)
                                // Sẽ cần một cách tinh vi hơn để lấy rawResponse của một request thành công để debug
                            }
                        } catch (e) {
                             if (firstErrorForDebug === null) { // Lưu lỗi đầu tiên cho mục đích debug
                                firstErrorForDebug = { code: e.code, msg: e.msg || e.message, rawResponse: e.rawResponse || 'N/A', statusCode: e.statusCode || 'N/A' };
                            }
                            // console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không lấy được đòn bẩy cho ${market.symbol} qua REST API. (Kiểm tra logs BingX API để biết chi tiết)`);
                        }
                        await sleep(250); // Thêm độ trễ giữa các yêu cầu để tránh rate limit
                    }
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Hoàn tất lấy đòn bẩy cho ${Object.keys(fetchedLeverageData).length} cặp.`);
                    currentRawDebug = { status: 'thành công', timestamp: new Date(), data: `Lấy ${Object.keys(fetchedLeverageData).length} cặp.`, error: firstErrorForDebug }; // Data ở đây chỉ là tổng kết
                    if (firstErrorForDebug) currentRawDebug.status = 'thành công (có lỗi riêng lẻ)';

                } catch (e) {
                    let logMsg = `[CACHE] ❌ ${id.toUpperCase()}: Lỗi chung khi lấy đòn bẩy BingX: ${e.msg || e.message}.`;
                    if (e.rawResponse) {
                        logMsg += ` Raw: ${e.rawResponse.substring(0, 500)}...`;
                    }
                    console.error(logMsg);
                    leverageSource = "BingX REST API (lỗi chung)";
                    currentRawDebug = { status: `thất bại (${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.rawResponse || 'N/A', error: { code: e.code, msg: e.msg || e.message } };
                }
            }
            else { // Đối với OKX và Bitget - giữ nguyên logic CCXT (có fallback loadMarkets)
                if (exchange.has['fetchLeverageTiers']) {
                    try {
                        const leverageTiers = await exchange.fetchLeverageTiers();
                        for (const symbol in leverageTiers) {
                            const tiers = leverageTiers[symbol];
                            if (Array.isArray(tiers) && tiers.length > 0) {
                                const numericLeverages = tiers.map(t => typeof t.leverage === 'number' ? t.leverage : parseFloat(t.leverage)).filter(l => !isNaN(l) && l > 0);
                                const parsedMaxLeverage = numericLeverages.length > 0 ? parseInt(Math.max(...numericLeverages), 10) : 0;
                                if (parsedMaxLeverage > 0) {
                                    fetchedLeverageData[cleanSymbol(symbol)] = parsedMaxLeverage;
                                }
                            }
                        }
                        leverageSource = "CCXT fetchLeverageTiers";
                        currentRawDebug = { status: 'thành công', timestamp: new Date(), data: `Lấy ${Object.keys(fetchedLeverageData).length} cặp.`, error: null };
                    } catch(e) {
                        let logMsg = `[CACHE] ⚠️ ${id.toUpperCase()}: Lỗi khi gọi fetchLeverageTiers: ${e.message}. Fallback sang loadMarkets.`;
                        if (e.rawResponse) {
                            logMsg += ` Raw: ${e.rawResponse.substring(0, 500)}...`;
                        }
                        console.warn(logMsg);
                        leverageSource = "CCXT loadMarkets fallback (từ fetchLeverageTiers lỗi)";
                        await exchange.loadMarkets(true); // Tải lại markets để đảm bảo dữ liệu mới nhất
                        for (const market of Object.values(exchange.markets)) {
                            if (market.swap && market.quote === 'USDT') {
                                const symbolCleaned = cleanSymbol(market.symbol);
                                const maxLeverage = getMaxLeverageFromMarketInfo(market);
                                if (maxLeverage !== null && maxLeverage > 0) {
                                    fetchedLeverageData[symbolCleaned] = maxLeverage;
                                } else {
                                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
                                }
                            }
                        }
                        currentRawDebug = { status: `thành công (fallback với lỗi ${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: `Lấy ${Object.keys(fetchedLeverageData).length} cặp.`, error: { code: e.code, msg: e.msg || e.message } };
                    }
                } else { // Fallback to loadMarkets nếu sàn không có fetchLeverageTiers
                    console.log(`[CACHE] ${id.toUpperCase()}: fetchLeverageTiers không khả dụng. Dùng loadMarkets...`);
                    await exchange.loadMarkets(true);
                    for (const market of Object.values(exchange.markets)) {
                        if (market.swap && market.quote === 'USDT') {
                            const symbolCleaned = cleanSymbol(market.symbol);
                            const maxLeverage = getMaxLeverageFromMarketInfo(market);
                            if (maxLeverage !== null && maxLeverage > 0) {
                                fetchedLeverageData[symbolCleaned] = maxLeverage;
                            } else {
                                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
                            }
                        }
                    }
                    leverageSource = "CCXT loadMarkets";
                    currentRawDebug = { status: 'thành công', timestamp: new Date(), data: `Lấy ${Object.keys(fetchedLeverageData).length} cặp.`, error: null };
                }
            }

            newCache[id] = fetchedLeverageData;
            const count = Object.keys(newCache[id]).length;
            if (count > 0) {
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy (${leverageSource}).`);
            } else {
                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không lấy được đòn bẩy nào (${leverageSource}).`);
                currentRawDebug.status = 'thất bại (không có đòn bẩy)';
            }
            debugRawLeverageResponses[id] = currentRawDebug; // Cập nhật biến debug toàn cục
            return { id, status: 'fulfilled' };
        } catch (e) {
            let errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
            if (e instanceof ccxt.AuthenticationError) {
                errorMessage = `LỖI XÁC THỰC! Vui lòng kiểm tra lại API Key/Secret của ${id.toUpperCase()}. Chi tiết: ${e.message}.`;
            } else if (e instanceof ccxt.NetworkError) {
                errorMessage = `Lỗi mạng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
            }
            // Log raw response nếu có
            if (e.rawResponse) {
                errorMessage += ` Raw: ${e.rawResponse.substring(0, 500)}...`;
            }
            console.error(`[CACHE] ❌ ${id.toUpperCase()}: ${errorMessage}`);
            newCache[id] = {};
            debugRawLeverageResponses[id] = { status: `thất bại (${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.rawResponse || 'N/A', error: { code: e.code, msg: e.msg || e.message } };
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
            // Log raw response nếu có
            if (e.rawResponse) {
                errorMessage += ` Raw: ${e.rawResponse.substring(0, 500)}...`;
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

    // Đồng bộ thời gian trước khi gọi các API cần ký (Binance)
    try {
        await syncServerTime();
    } catch (e) {
        console.error(`[LOOP] ❌ Không thể đồng bộ thời gian, có thể ảnh hưởng đến các yêu cầu API được ký. ${e.message}`);
        // Tiếp tục chạy nhưng các yêu cầu ký có thể thất bại
    }

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
            },
            // Thêm dữ liệu debug thô vào phản hồi API
            debugRawLeverageResponses: debugRawLeverageResponses 
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
