const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

// Import các API Key và Secret từ file config.js
// LƯU Ý: Bạn cần thêm key của KuCoin vào file config.js của mình
const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword // Thêm KuCoin
} = require('./config.js');

const PORT = 5005;

// ----- CẤU HÌNH -----
// Đã xóa 'bingx' và thêm 'kucoin'
const EXCHANGE_IDS = ['binanceusdm', 'okx', 'bitget', 'kucoin']; 
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 5; 
const IMMINENT_THRESHOLD_MINUTES = 15;

const FULL_LEVERAGE_REFRESH_AT_HOUR = 0;
const TARGETED_LEVERAGE_REFRESH_MINUTES = [15, 30, 45, 55, 59];

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;

let bitgetValidFuturesSymbolSet = new Set(); 

// Đã xóa 'bingx' và thêm 'kucoin'
let debugRawLeverageResponses = {
    binanceusdm: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    bitget: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    kucoin: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null }
};

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
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }
    // Thêm cấu hình cho KuCoin
    else if (id === 'kucoin') { config.apiKey = kucoinApiKey; config.secret = kucoinApiSecret; if(kucoinApiPassword) config.password = kucoinApiPassword; }
    else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
});

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
        return null;
    } catch (e) {
        console.error(`[BITGET_FUNDING_TIME_NATIVE] ❌ Lỗi khi lấy funding time cho ${apiSymbol} từ native API: ${e.msg || e.message}.`);
        return null;
    }
}

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
        // Logic chung cho OKX, Bitget, KuCoin sử dụng CCXT
        else { 
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
    console.log('\n[LEVERAGE_SCHEDULER] 🔄 Bắt đầu cập nhật TOÀN BỘ đòn bẩy cho tất cả các sàn...');
    
    const leveragePromises = EXCHANGE_IDS.map(id => updateLeverageForExchange(id, null));
    const results = await Promise.all(leveragePromises);
    
    results.forEach(res => {
        if (res) {
            debugRawLeverageResponses[res.id].status = res.status;
            debugRawLeverageResponses[res.id].timestamp = new Date();
            debugRawLeverageResponses[res.id].error = res.error;
        }
    });

    console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất cập nhật đòn bẩy TOÀN BỘ.');
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
    
    const leveragePromises = EXCHANGE_IDS.map(id => updateLeverageForExchange(id, symbolsArray));
    const results = await Promise.all(leveragePromises);

    results.forEach(res => {
        if (res) {
            debugRawLeverageResponses[res.id].status = res.status;
            debugRawLeverageResponses[res.id].timestamp = new Date();
            debugRawLeverageResponses[res.id].error = res.error;
        }
    });

    console.log('[LEVERAGE_SCHEDULER] ✅ Hoàn tất cập nhật đòn bẩy MỤC TIÊU.');
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

function isFundingUpdatePaused() {
    const now = new Date();
    const utcMinute = now.getUTCMinutes();
    return utcMinute === 59 || utcMinute === 0 || utcMinute === 1 || utcMinute === 2;
}

async function fetchFundingRatesForAllExchanges() {
    if (isFundingUpdatePaused()) {
        console.log('[DATA] ⏸️ Tạm dừng cập nhật funding rates từ phút 59 đến phút 2 UTC.');
        return;
    }
    console.log('[DATA] Bắt đầu làm mới funding rates cho tất cả các sàn...');

    const resultsSummary = []; 

    const fundingPromises = EXCHANGE_IDS.map(async (id) => {
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
                }
            }
            currentStatus = `Funding hoàn tất (${successCount} cặp)`;
            resultsSummary.push(`${id.toUpperCase()}: ${successCount} cặp`);
        } catch (e) {
            let errorMessage = `Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}.`;
            console.error(`[DATA] ❌ ${id.toUpperCase()}: ${errorMessage}`);
            currentStatus = `Funding thất bại (lỗi: ${e.code || 'UNKNOWN'})`;
            currentError = { code: e.code, msg: e.message };
            resultsSummary.push(`${id.toUpperCase()}: LỖI (${e.code || 'UNKNOWN'})`);
        } finally {
            exchangeData[id] = { rates: processedRates }; // Gán trực tiếp, không dùng spread
            debugRawLeverageResponses[id].status = currentStatus;
            debugRawLeverageResponses[id].timestamp = new Date();
            debugRawLeverageResponses[id].data = `Đã lấy ${Object.keys(processedRates).length} cặp.`;
            debugRawLeverageResponses[id].error = currentError;
            return { id };
        }
    });

    await Promise.all(fundingPromises);
    console.log(`[DATA] ✅ Hoàn tất làm mới funding rates: ${resultsSummary.join(', ')}. Tính toán cơ hội.`);
    calculateArbitrageOpportunities(); 
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

                if (Math.sign(shortRate.fundingRate) === Math.sign(longRate.fundingRate)) {
                    const lowerAbsoluteFundingRate = Math.min(Math.abs(shortRate.fundingRate), Math.abs(longRate.fundingRate));
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

    await fetchFundingRatesForAllExchanges(); 
    lastFullUpdateTimestamp = new Date().toISOString(); 

    if (currentHour === FULL_LEVERAGE_REFRESH_AT_HOUR && currentMinute === 0 && currentSecond < 5) {
        console.log('[LEVERAGE_SCHEDULER] 🔥 Kích hoạt cập nhật TOÀN BỘ đòn bẩy (00:00 UTC).');
        await performFullLeverageUpdate();
    }
    else if (TARGETED_LEVERAGE_REFRESH_MINUTES.includes(currentMinute) && currentSecond < 5) {
        console.log(`[LEVERAGE_SCHEDULER] 🎯 Kích hoạt cập nhật đòn bẩy MỤC TIÊU (${currentMinute} phút).`);
        await performTargetedLeverageUpdate();
    }
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
            console.log(`[API_DATA] Gửi dữ liệu. Ops: ${responseData.arbitrageData.length}. ` +
                `Binance: ${Object.keys(responseData.rawRates.binanceusdm?.rates || {}).length}. ` +
                `OKX: ${Object.keys(responseData.rawRates.okx?.rates || {}).length}. ` +
                `Bitget: ${Object.keys(responseData.rawRates.bitget?.rates || {}).length}. ` +
                `Kucoin: ${Object.keys(responseData.rawRates.kucoin?.rates || {}).length}.`);
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
    
    await fetchBitgetValidFuturesSymbols();
    
    console.log('[STARTUP] Kích hoạt cập nhật TOÀN BỘ đòn bẩy ban đầu.');
    await performFullLeverageUpdate(); 

    EXCHANGE_IDS.forEach(id => {
        if (!exchangeData[id]) {
            exchangeData[id] = { rates: {} };
        }
    });

    masterLoop(); 
});
