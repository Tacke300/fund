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
} = require('./config.js'); // Đảm bảo file này tồn tại và có các key

const PORT = 5005; // Cổng mới cho bot này

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001; // Ví dụ: 0.001%
const MINIMUM_PNL_THRESHOLD = 15; // Lãi suất ước tính tối thiểu (tính theo %)
const IMMINENT_THRESHOLD_MINUTES = 15; // Thời gian còn lại (phút) để funding rate là "sắp đến"
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30; // Tần suất làm mới bộ nhớ đệm đòn bẩy

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {}; // Lưu trữ số đòn bẩy đã parse cho mỗi symbol trên mỗi sàn
let exchangeData = {}; // Lưu trữ funding rates và các thông tin khác
let arbitrageOpportunities = []; // Các cơ hội chênh lệch đã tìm thấy
let lastFullUpdateTimestamp = null; // Thời gian cập nhật cuối cùng
let loopTimeoutId = null; // ID của setTimeout cho vòng lặp chính

// Biến để lưu trữ phản hồi thô hoặc lỗi từ API/CCXT cho mục đích gỡ lỗi trên dashboard
let debugRawLeverageResponses = {
    binanceusdm: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    bingx: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    bitget: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null }
};

const BINGX_BASE_HOST = 'open-api.bingx.com';
const BINANCE_BASE_HOST = 'fapi.binance.com';
let binanceServerTimeOffset = 0; // Offset thời gian cho Binance để đồng bộ (chỉ cần nếu gọi API ký)

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = {
        'options': { 'defaultType': 'swap' },
        'enableRateLimit': true, // Bật Rate Limit để CCXT tự động quản lý tốc độ gọi API
        'headers': {
            'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)', // User-Agent đề xuất bởi CCXT
        }
    };

    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }
    else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
});

// Hàm làm sạch tên symbol (ví dụ: BTC/USDT -> BTC)
const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

// Hàm sleep để tạm dừng chương trình
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Hàm trích xuất maxLeverage từ market info của CCXT (fallback)
function getMaxLeverageFromMarketInfo(market) {
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) {
        return market.limits.leverage.max;
    }
    if (typeof market?.info === 'object' && market.info !== null) {
        const possibleLeverageKeys = ['maxLeverage', 'leverage', 'initialLeverage', 'max_leverage', 'value'];
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

// === CÁC HÀM GỌI API TRỰC TIẾP (MỚI HOÀN TOÀN cho Binance & BingX) ===

// Tái sử dụng createSignature (có thể dùng cho các API ký khác nếu cần)
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                        .update(queryString)
                        .digest('hex');
}

// Hàm makeHttpRequest chung, điều chỉnh để xử lý timeout và log lỗi tốt hơn
async function makeHttpRequest(method, hostname, path, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            port: 443,
            path: path,
            method: method,
            headers: { ...headers, 'User-Agent': 'Mozilla/5.0' }, // User-Agent đề xuất
            timeout: 20000 // Tăng timeout lên 20 giây
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

// Hàm đồng bộ thời gian với server Binance (chỉ cần thiết nếu gọi API ký)
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

// Gọi API Binance có chữ ký (nếu cần cho các mục đích khác)
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
        console.error(`[BINANCE SIGNED API] Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}. Path: ${requestPath}`);
        if (error.code === 400 && error.rawResponse && error.rawResponse.includes('-2015')) {
            console.error("  -> LỖI XÁC THỰC! Kiểm tra API Key/Secret và quyền Futures Binance.");
        } else if (error.code === 400 && error.rawResponse && error.rawResponse.includes('-1021')) {
            console.error("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính hoặc chạy lại bot.");
        } else if (error.code === 429 || error.code === -1003) {
            console.error("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT).");
        }
        throw error;
    }
}

// Hàm lấy max leverage cho tất cả các symbol của Binance từ CCXT (mới)
async function fetchBinanceMaxLeverageFromCCXT() {
    const exchange = exchanges['binanceusdm'];
    const leverageMap = {};
    let statusMsg = 'chưa có dữ liệu';
    let rawData = 'N/A';
    let error = null;

    try {
        if (!exchange.apiKey || !exchange.secret) {
            throw new Error("API Key hoặc Secret Key cho Binance chưa được cấu hình.");
        }

        let successCount = 0;
        if (exchange.has['fetchLeverageTiers']) {
            console.log(`[DEBUG] Gọi CCXT fetchLeverageTiers cho Binance...`);
            const leverageTiers = await exchange.fetchLeverageTiers();
            rawData = JSON.stringify(leverageTiers); // Lưu phản hồi CCXT
            for (const symbol in leverageTiers) {
                const tiers = leverageTiers[symbol];
                if (Array.isArray(tiers) && tiers.length > 0) {
                    const numericLeverages = tiers.map(t => typeof t.leverage === 'number' ? t.leverage : parseFloat(t.leverage)).filter(l => !isNaN(l) && l > 0);
                    const parsedMaxLeverage = numericLeverages.length > 0 ? parseInt(Math.max(...numericLeverages), 10) : 0;
                    if (parsedMaxLeverage > 0) {
                        leverageMap[cleanSymbol(symbol)] = parsedMaxLeverage;
                        successCount++;
                    }
                }
            }
            statusMsg = `thành công (${successCount} cặp từ fetchLeverageTiers)`;
        } else {
            console.log(`[DEBUG] fetchLeverageTiers không khả dụng cho Binance. Dùng loadMarkets...`);
            await exchange.loadMarkets(true);
            rawData = JSON.stringify(exchange.markets); // Lưu phản hồi CCXT
            for (const market of Object.values(exchange.markets)) {
                if (market.swap && market.quote === 'USDT') {
                    const symbolCleaned = cleanSymbol(market.symbol);
                    const maxLeverage = getMaxLeverageFromMarketInfo(market);
                    if (maxLeverage !== null && maxLeverage > 0) {
                        leverageMap[symbolCleaned] = maxLeverage;
                        successCount++;
                    }
                }
            }
            statusMsg = `thành công (${successCount} cặp từ loadMarkets)`;
        }
        console.log(`[CACHE] ✅ Binance: Đã lấy ${successCount} cặp đòn bẩy. ${statusMsg}`);
    } catch (e) {
        statusMsg = `thất bại (${e.code || 'UNKNOWN'})`;
        error = { code: e.code, msg: e.message };
        console.error(`[CACHE] ❌ Binance: Lỗi khi lấy đòn bẩy: ${e.message}.`);
        if (e.response) rawData = e.response.toString();
    }
    return { leverageMap, statusMsg, rawData, error };
}


// Hàm lấy max leverage cho BingX từ CCXT loadMarkets (mới)
async function fetchBingxMaxLeverageFromCCXT() {
    const exchange = exchanges['bingx'];
    const leverageMap = {};
    let statusMsg = 'chưa có dữ liệu';
    let rawData = 'N/A';
    let error = null;

    try {
        if (!exchange.apiKey || !exchange.secret) {
            throw new Error("API Key hoặc Secret Key cho BingX chưa được cấu hình.");
        }

        console.log(`[DEBUG] Gọi CCXT loadMarkets cho BingX để lấy leverage...`);
        await exchange.loadMarkets(true);
        rawData = JSON.stringify(exchange.markets); // Lưu phản hồi CCXT

        let successCount = 0;
        // Lọc các cặp USDT-M Futures
        for (const market of Object.values(exchange.markets)) {
            if (market.swap && market.quote === 'USDT') {
                const symbolCleaned = cleanSymbol(market.symbol);
                const maxLeverage = getMaxLeverageFromMarketInfo(market); // Sử dụng hàm tiện ích
                if (maxLeverage !== null && maxLeverage > 0) {
                    leverageMap[symbolCleaned] = maxLeverage;
                    successCount++;
                } else {
                    // console.warn(`[CACHE] ⚠️ BingX: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`); // Giảm bớt log này
                }
            }
        }
        statusMsg = `thành công (${successCount} cặp từ loadMarkets)`;
        console.log(`[CACHE] ✅ BingX: Đã lấy ${successCount} cặp đòn bẩy. ${statusMsg}`);

    } catch (e) {
        statusMsg = `thất bại (${e.code || 'UNKNOWN'})`;
        error = { code: e.code, msg: e.message };
        console.error(`[CACHE] ❌ BingX: Lỗi khi lấy đòn bẩy: ${e.message}.`);
        if (e.response) rawData = e.response.toString();
    }
    return { leverageMap, statusMsg, rawData, error };
}


// Hàm khởi tạo bộ nhớ đệm đòn bẩy cho tất cả các sàn
async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        newCache[id] = {};
        let currentRawDebug = { status: 'chưa chạy', timestamp: new Date(), data: 'N/A', error: null };

        try {
            if (id === 'binanceusdm') {
                const { leverageMap, statusMsg, rawData, error } = await fetchBinanceMaxLeverageFromCCXT();
                newCache[id] = leverageMap;
                currentRawDebug = { status: statusMsg, timestamp: new Date(), data: rawData, error: error };
            } else if (id === 'bingx') {
                const { leverageMap, statusMsg, rawData, error } = await fetchBingxMaxLeverageFromCCXT();
                newCache[id] = leverageMap;
                currentRawDebug = { status: statusMsg, timestamp: new Date(), data: rawData, error: error };
            } else { // OKX và Bitget (tiếp tục dùng CCXT fetchLeverageTiers / loadMarkets)
                const exchange = exchanges[id];
                let fetchedLeverageDataMap = {};
                let successCount = 0;

                if (exchange.has['fetchLeverageTiers']) {
                    console.log(`[DEBUG] Gọi CCXT fetchLeverageTiers cho ${id.toUpperCase()}...`);
                    const leverageTiers = await exchange.fetchLeverageTiers();
                    currentRawDebug.data = JSON.stringify(leverageTiers);
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
                    currentRawDebug.status = `thành công (${successCount} cặp CCXT fetchLeverageTiers)`;
                } else {
                    console.log(`[DEBUG] ${id.toUpperCase()}: fetchLeverageTiers không khả dụng. Dùng loadMarkets...`);
                    await exchange.loadMarkets(true);
                    currentRawDebug.data = JSON.stringify(exchange.markets);
                    for (const market of Object.values(exchange.markets)) {
                        if (market.swap && market.quote === 'USDT') {
                            const symbolCleaned = cleanSymbol(market.symbol);
                            const maxLeverage = getMaxLeverageFromMarketInfo(market);
                            if (maxLeverage !== null && maxLeverage > 0) {
                                fetchedLeverageDataMap[symbolCleaned] = maxLeverage;
                                successCount++;
                            }
                        }
                    }
                    currentRawDebug.status = `thành công (${successCount} cặp CCXT loadMarkets)`;
                }
                newCache[id] = fetchedLeverageDataMap;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Đã lấy ${successCount} cặp đòn bẩy.`);
            }

            debugRawLeverageResponses[id] = currentRawDebug;
            return { id, status: 'fulfilled' };
        } catch (e) {
            const errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`;
            console.error(`[CACHE] ❌ ${id.toUpperCase()}: ${errorMessage}`);
            newCache[id] = {};
            debugRawLeverageResponses[id] = { status: `thất bại (${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.response ? e.response.toString() : 'N/A', error: { code: e.code, msg: e.message } };
            return { id, status: 'rejected', reason: e.message };
        }
    });
    await Promise.allSettled(promises);
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
}

// Hàm tính toán thời gian funding tiêu chuẩn tiếp theo
function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);
    const nextFundingDate = new Date(now);
    if (nextHourUTC === undefined) { nextHourUTC = fundingHoursUTC[0]; nextFundingDate.setUTCDate(now.getUTCDate() + 1); }
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
    return nextFundingDate.getTime();
}

// Hàm lấy funding rates cho tất cả các sàn
async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        try {
            let processedRates = {};
            const maxLeverageAvailable = leverageCache[id] || {}; // Đảm bảo có leverageCache cho sàn này

            if (id === 'binanceusdm') { // NEW BINANCE FUNDING RATE
                console.log(`[DEBUG] Gọi Binance API /fapi/v1/premiumIndex (public) cho funding rates...`);
                const premiumIndexData = await makeHttpRequest('GET', BINANCE_BASE_HOST, '/fapi/v1/premiumIndex');
                const parsedPremiumIndex = JSON.parse(premiumIndexData);
                if (Array.isArray(parsedPremiumIndex)) {
                    for (const item of parsedPremiumIndex) {
                        const symbolCleaned = cleanSymbol(item.symbol);
                        const fundingRate = parseFloat(item.lastFundingRate);
                        const fundingTimestamp = parseInt(item.nextFundingTime);
                        const maxLeverageParsed = maxLeverageAvailable[symbolCleaned] || null;

                        if (!isNaN(fundingRate) && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                            processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverageParsed };
                        }
                    }
                }
                console.log(`[DATA] ✅ Binance: Đã lấy thành công ${Object.keys(processedRates).length} funding rates từ API public.`);
            } else if (id === 'bingx') { // NEW BINGX FUNDING RATE
                console.log(`[DEBUG] Gọi BingX API /openApi/swap/v2/market/fundingRate (public) cho funding rates...`);
                const bingxFundingRatesRaw = await makeHttpRequest('GET', BINGX_BASE_HOST, '/openApi/swap/v2/market/fundingRate');
                const parsedBingxRates = JSON.parse(bingxFundingRatesRaw);
                if (parsedBingxRates.code === 0 && Array.isArray(parsedBingxRates.data)) {
                    for (const item of parsedBingxRates.data) {
                        const symbolCleaned = cleanSymbol(item.symbol);
                        const fundingRate = parseFloat(item.fundingRate);
                        const fundingTimestamp = parseInt(item.nextFundingTime); // Timestamp in milliseconds
                        const maxLeverageParsed = maxLeverageAvailable[symbolCleaned] || null;

                        if (!isNaN(fundingRate) && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                            processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverageParsed };
                        }
                    }
                }
                console.log(`[DATA] ✅ BingX: Đã lấy thành công ${Object.keys(processedRates).length} funding rates từ API public.`);
            } else { // OKX và Bitget (tiếp tục dùng CCXT fetchFundingRates)
                const exchange = exchanges[id];
                const fundingRatesRaw = await exchange.fetchFundingRates();
                for (const rate of Object.values(fundingRatesRaw)) {
                    const symbolCleaned = cleanSymbol(rate.symbol);
                    const maxLeverageParsed = maxLeverageAvailable[symbolCleaned] || null;

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
            // Giữ lại dữ liệu cũ nếu không thể cập nhật
            if (!exchangeData[result.value?.id]) {
                exchangeData[result.value.id] = { rates: {} };
            }
        }
    });
    return freshData;
}

// Hàm tính toán cơ hội chênh lệch
function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    // Tạo bản sao sâu để tránh thay đổi dữ liệu gốc trong quá trình tính toán
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
                const estimatedPnl = fundingDiff * commonLeverage * 100; // Ước tính PNL theo %

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
        // Ưu tiên các cơ hội có thời gian funding sớm hơn, sau đó là PNL cao hơn
        if (a.nextFundingTime < b.nextFundingTime) return -1;
        if (a.nextFundingTime > b.nextFundingTime) return 1;
        return b.estimatedPnl - a.estimatedPnl;
    });
}

// Vòng lặp chính của bot
async function masterLoop() {
    console.log(`\n[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})...`);

    // Đồng bộ thời gian Binance trước khi gọi các API của Binance (nếu có API ký)
    try {
        await syncBinanceServerTime();
    } catch (error) {
        console.error("[LOOP] Lỗi đồng bộ thời gian Binance, có thể ảnh hưởng đến các lệnh ký (nếu có). Tiếp tục...");
    }

    // Bước 1: Làm mới bộ nhớ đệm đòn bẩy cho tất cả các sàn
    await initializeLeverageCache();

    // Bước 2: Lấy funding rates cho tất cả các sàn
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData; // Cập nhật dữ liệu funding rates toàn cục

    // Bước 3: Tính toán cơ hội chênh lệch
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString(); // Cập nhật thời gian cập nhật cuối cùng
    console.log(`[LOOP] ✅ Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
    scheduleNextLoop();
}

// Lên lịch cho vòng lặp tiếp theo
function scheduleNextLoop() {
    clearTimeout(loopTimeoutId); // Xóa vòng lặp cũ nếu có
    const now = new Date();
    // Lên lịch để chạy vào giây thứ 5 của mỗi phút tiếp theo
    const delaySeconds = (60 - now.getSeconds() + 5) % 60;
    const delayMs = (delaySeconds === 0 ? 60 : delaySeconds) * 1000;
    console.log(`[SCHEDULER] Vòng lặp kế tiếp sau ${delaySeconds.toFixed(0)} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delayMs);
}

// === CÀI ĐẶT WEB SERVER ===
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
            rawRates: { // Hiển thị dữ liệu funding rates thô (đã xử lý)
                binance: Object.values(exchangeData.binanceusdm?.rates || {}),
                bingx: Object.values(exchangeData.bingx?.rates || {}),
                okx: Object.values(exchangeData.okx?.rates || {}),
                bitget: Object.values(exchangeData.bitget?.rates || {}),
            },
            debugRawLeverageResponses: debugRawLeverageResponses // Hiển thị thông tin debug về việc lấy leverage
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

// Khởi động server
server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    // Chạy vòng lặp chính lần đầu khi server khởi động
    await masterLoop();
    // Đặt lịch làm mới bộ nhớ đệm đòn bẩy định kỳ, độc lập với vòng lặp chính (chỉ làm mới leverage)
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
