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
let leverageCache = {}; // Sẽ lưu trữ số (từ CCXT) hoặc raw data string
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let serverTimeOffset = 0; // Để đồng bộ thời gian với Binance API (khi gọi trực tiếp)

// Biến mới để lưu trữ phản hồi thô hoặc lỗi từ API/CCXT cho mục đích gỡ lỗi trên dashboard
let debugRawLeverageResponses = {
    binanceusdm: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    bingx: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null },
    bitget: { status: 'chưa chạy', timestamp: null, data: 'N/A', error: null }
};

const BINANCE_BASE_HOST = 'fapi.binance.com'; // Hằng số cho Binance Host (khi gọi trực tiếp)
const BINGX_BASE_HOST = 'open-api.bingx.com'; // Hằng số cho BingX Host (khi gọi trực tiếp)

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = {
        'options': { 'defaultType': 'swap' },
        'enableRateLimit': true,
        // Thêm User-Agent cho CCXT Binance để giúp vượt qua WAF/Cloudflare
        'headers': {
            'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)', // CCXT User-Agent
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

// Hàm sleep để chờ giữa các request
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Hàm này giúp trích xuất maxLeverage từ market info nếu fetchLeverageTiers không có
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

// === CÁC HÀM GỌI API TRỰC TIẾP (SỬ DỤNG HTTPS NATIVE) ===

function createSignature(queryString, apiSecret) { return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex'); }

async function makeHttpRequest(method, hostname, path, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            port: 443,
            path: path,
            method: method,
            headers: { ...headers, 'User-Agent': 'Mozilla/5.0' }, // User-Agent: Mozilla/5.0
            timeout: 20000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data); // TRẢ VỀ CHUỖI DATA THÔ (JSON, HTML, Text,...)
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

        if (postData && (method === 'POST' || method === 'PUT')) req.write(postData);
        req.end();
    });
}

// callSignedBinanceAPI: Gọi API Binance có ký, trả về raw data string
async function callSignedBinanceAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!binanceApiKey || !binanceApiSecret) {
        throw new Error("Lỗi: Thiếu Binance API Key/Secret.");
    }
    const timestamp = Date.now() + serverTimeOffset;
    const recvWindow = 5000;
    
    // Xây dựng query string thủ công để đảm bảo đúng định dạng cho makeHttpRequest
    let queryStringParams = new URLSearchParams(params);
    queryStringParams.append('timestamp', timestamp);
    queryStringParams.append('recvWindow', recvWindow);
    
    const signature = createSignature(queryStringParams.toString(), binanceApiSecret);
    queryStringParams.append('signature', signature);

    let requestPath = `${fullEndpointPath}?${queryStringParams.toString()}`;
    let requestBody = ''; // Đối với GET, body là rỗng

    const headers = { 'X-MBX-APIKEY': binanceApiKey };

    let rawDataReceived = 'N/A'; // Biến để lưu trữ dữ liệu thô nhận được
    try {
        rawDataReceived = await makeHttpRequest(method, BINANCE_BASE_HOST, requestPath, headers, requestBody);
        // Lưu dữ liệu thô vào debugRawLeverageResponses ngay lập tức
        debugRawLeverageResponses.binanceusdm = { status: 'thành công', timestamp: new Date(), data: rawDataReceived, error: null };
        return rawDataReceived;
    } catch (error) {
        if (error.code === -1021 && error.msg && error.msg.toLowerCase().includes("timestamp")) {
            console.warn(`[BINANCE_API] ⚠️ Lỗi timestamp. Thử đồng bộ thời gian.`);
            await syncBinanceServerTime();
        }
        debugRawLeverageResponses.binanceusdm = {
            status: `thất bại (${error.code || 'UNKNOWN'})`,
            timestamp: new Date(),
            data: error.rawResponse || rawDataReceived,
            error: { code: error.code, msg: error.msg || error.message }
        };
        throw error;
    }
}

// syncBinanceServerTime: Đồng bộ thời gian riêng cho Binance (chỉ dùng khi gọi API Binance trực tiếp)
async function syncBinanceServerTime() {
    try {
        const rawData = await makeHttpRequest('GET', BINANCE_BASE_HOST, '/fapi/v1/time');
        const d = JSON.parse(rawData); 
        serverTimeOffset = d.serverTime - Date.now();
        console.log(`[TIME] Đồng bộ thời gian Binance server: Offset ${serverTimeOffset}ms.`);
    } catch (e) {
        console.error(`[TIME] ❌ Lỗi đồng bộ thời gian Binance: ${e.msg || e.message}.`);
        throw new Error(`Lỗi đồng bộ thời gian Binance: ${e.msg || e.message}`);
    }
}

// fetchBingxMaxLeverage: Lấy max leverage cho BingX từng symbol, trả về raw data string
const bingxErrorLogCache = {};
const BINGX_ERROR_LOG_COOLDOWN_MS = 5 * 60 * 1000; // 5 phút cooldown cho mỗi loại lỗi

async function fetchBingxMaxLeverage(symbol, retries = 3) {
    if (!bingxApiKey || !bingxApiSecret) {
        console.warn(`[BINGX] ⚠️ Thiếu API Key/Secret cho BingX.`);
        return null;
    }

    let lastRawData = 'N/A';
    let lastError = null;    
    
    for (let i = 0; i < retries; i++) {
        const params = `symbol=${symbol}`;
        const timestamp = Date.now();
        const recvWindow = 5000; 
        
        const query = `${params}×tamp=${timestamp}&recvWindow=${recvWindow}`; 
        const signature = createSignature(query, bingxApiSecret);
        const urlPath = `/openApi/swap/v2/trade/leverage?${query}&signature=${signature}`; 

        const headers = { 'X-BX-APIKEY': bingxApiKey };

        try {
            const rawRes = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath, headers);
            lastRawData = rawRes; 
            lastError = null; 
            
            // Cập nhật debugRawLeverageResponses cho BingX (tổng kết từ lần thử cuối cùng)
            debugRawLeverageResponses.bingx = { 
                status: 'thành công', 
                timestamp: new Date(),
                data: rawRes, 
                error: null
            };

            return rawRes; 

        } catch (e) {
            lastError = { code: e.code, msg: e.msg || e.message, statusCode: e.statusCode || 'N/A', type: 'HTTP_ERROR' };
            lastRawData = e.rawResponse || lastRawData;

            const errorSignature = `${e.code}-${e.statusCode}-${e.msg?.substring(0, 50)}`;
            const now = Date.now();
            if (!bingxErrorLogCache[errorSignature] || (now - bingxErrorLogCache[errorSignature] > BINGX_ERROR_LOG_COOLDOWN_MS)) {
                let logMsg = `[BINGX] Lỗi lấy leverage cho ${symbol} (Lần ${i+1}/${retries}): ${e.msg || e.message}`;
                if (e.rawResponse) {
                    logMsg += ` Raw: ${e.rawResponse.substring(0, 500)}...`;
                }
                console.warn(logMsg);
                bingxErrorLogCache[errorSignature] = now;
            }

            if (e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT_ERROR' || (e.statusCode >= 500 && e.statusCode < 600)) {
                const delay = 2 ** i * 1000;
                console.warn(`[BINGX] Lỗi tạm thời. Thử lại sau ${delay / 1000}ms.`);
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
    // Cập nhật debugRawLeverageResponses cho BingX (tổng kết từ lần thử cuối cùng)
    debugRawLeverageResponses.bingx = {
        status: lastError ? `thất bại (${lastError.code})` : 'thất bại (không rõ lý do)',
        timestamp: new Date(),
        data: lastRawData,
        error: lastError
    };
    return null;
}


// Hàm khởi tạo bộ nhớ đệm đòn bẩy cho tất cả các sàn
async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id];
        newCache[id] = {}; 

        let fetchedRawLeverageDataMap = {}; 
        let leverageSource = "Unknown";
        let currentRawDebug = { status: 'chưa chạy', timestamp: new Date(), data: 'N/A', error: null };

        try {
            if (id === 'binanceusdm') {
                // Binance: Ưu tiên CCXT, nếu lỗi thì fallback API trực tiếp
                leverageSource = "CCXT fetchLeverageTiers";
                try {
                    const leverageTiers = await exchange.fetchLeverageTiers();
                    let successCount = 0;
                    for (const symbol in leverageTiers) {
                        const tiers = leverageTiers[symbol];
                        if (Array.isArray(tiers) && tiers.length > 0) {
                            const numericLeverages = tiers.map(t => typeof t.leverage === 'number' ? t.leverage : parseFloat(t.leverage)).filter(l => !isNaN(l) && l > 0);
                            const parsedMaxLeverage = numericLeverages.length > 0 ? parseInt(Math.max(...numericLeverages), 10) : 0;
                            if (parsedMaxLeverage > 0) {
                                fetchedRawLeverageDataMap[cleanSymbol(symbol)] = parsedMaxLeverage; 
                                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Max leverage của ${cleanSymbol(symbol)} là ${parsedMaxLeverage} (CCXT).`); // LOG THÀNH CÔNG TỪ CCXT
                                successCount++;
                            }
                        }
                    }
                    currentRawDebug = { status: `thành công (${successCount} cặp CCXT)`, timestamp: new Date(), data: `Lấy ${successCount} cặp CCXT.`, error: null };

                    // Nếu CCXT không lấy được dữ liệu hoặc gặp lỗi, thử API trực tiếp
                    if (successCount === 0) {
                        console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: CCXT fetchLeverageTiers không lấy được đòn bẩy. Thử dùng Binance REST API trực tiếp...`);
                        leverageSource = "Binance REST API (fallback)";
                        try {
                            const rawResponse = await callSignedBinanceAPI('/fapi/v1/leverageBracket', 'GET'); 
                            fetchedRawLeverageDataMap['FULL_RAW_RESPONSE'] = rawResponse; 
                            currentRawDebug = { status: 'thành công (fallback REST API)', timestamp: new Date(), data: rawResponse, error: null };
                            
                            // Thử parse để tổ chức và log từng mục từ rawResponse (API trực tiếp)
                            let parsedApiSuccessCount = 0;
                            try {
                                const parsedJson = JSON.parse(rawResponse);
                                if (Array.isArray(parsedJson)) {
                                    for (const item of parsedJson) {
                                        const symbolCleaned = cleanSymbol(item.symbol);
                                        fetchedRawLeverageDataMap[symbolCleaned] = JSON.stringify(item); 
                                        if (item.brackets && Array.isArray(item.brackets) && item.brackets.length > 0) {
                                            const maxLev = parseInt(Math.max(...item.brackets.map(b => b.leverage)), 10);
                                            if (!isNaN(maxLev) && maxLev > 0) {
                                                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Max leverage của ${symbolCleaned} là ${maxLev} (REST API).`); // LOG THÀNH CÔNG TỪ REST API
                                                parsedApiSuccessCount++;
                                            }
                                        }
                                    }
                                } else {
                                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Phản hồi Binance API không phải mảng JSON. Dữ liệu thô vẫn được lưu.`);
                                }
                            } catch (e) { 
                                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Lỗi parse JSON phản hồi Binance API. Dữ liệu thô vẫn được lưu. ${e.message}`);
                            }
                            currentRawDebug.data = `Lấy ${parsedApiSuccessCount} cặp (fallback REST API). Full raw trong debugRawLeverageResponses.`;

                        } catch (e) {
                            console.error(`[CACHE] ❌ ${id.toUpperCase()}: Lỗi khi gọi Binance REST API (fallback): ${e.msg || e.message}.`);
                            leverageSource = "Binance REST API (fallback lỗi)";
                            currentRawDebug = { status: `thất bại (fallback REST API lỗi: ${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.rawResponse || 'N/A', error: { code: e.code, msg: e.message } };
                        }
                    }

                } catch (e) { 
                    let errorMessage = `Lỗi nghiêm trọng khi lấy đòn bẩy Binance qua CCXT: ${e.message}.`;
                    console.error(`[CACHE] ❌ ${id.toUpperCase()}: ${errorMessage}`);
                    leverageSource = "CCXT (lỗi nghiêm trọng)";
                    currentRawDebug = { status: `thất bại (CCXT lỗi nghiêm trọng: ${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.response ? e.response.toString() : e.message, error: { code: e.code, msg: e.message } };
                }
            }
            else if (id === 'bingx') {
                // BingX: Dùng API trực tiếp (theo yêu cầu "viết thủ công API call")
                leverageSource = "BingX REST API /trade/leverage";
                try {
                    await exchange.loadMarkets(true); 
                    const bingxMarkets = Object.values(exchange.markets).filter(m => m.swap && m.quote === 'USDT');
                    console.log(`[CACHE] ${id.toUpperCase()}: Tìm thấy ${bingxMarkets.length} cặp swap USDT. Đang lấy dữ liệu đòn bẩy thô từng cặp...`);

                    let successCount = 0;
                    for (const market of bingxMarkets) {
                        const formattedSymbol = market.symbol.replace('/', '-').replace(':USDT', '');
                        const rawLevData = await fetchBingxMaxLeverage(formattedSymbol); // Lấy raw data (string)
                        if (rawLevData) {
                            fetchedRawLeverageDataMap[cleanSymbol(market.symbol)] = rawLevData; 
                            // Thử parse để log
                            try {
                                const parsedJson = JSON.parse(rawLevData);
                                if (parsedJson.code === 0 && parsedJson.data?.leverage) {
                                    const maxLev = parseInt(parsedJson.data.leverage, 10);
                                    if (!isNaN(maxLev) && maxLev > 0) {
                                        console.log(`[CACHE] ✅ ${id.toUpperCase()}: Max leverage của ${cleanSymbol(market.symbol)} là ${maxLev} (REST API).`); // LOG THÀNH CÔNG TỪ BINGX REST API
                                        successCount++;
                                    }
                                } else {
                                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Phản hồi API BingX không hợp lệ cho ${cleanSymbol(market.symbol)}. Raw: ${rawLevData.substring(0, 100)}`);
                                }
                            } catch (e) {
                                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Lỗi parse JSON phản hồi BingX cho ${cleanSymbol(market.symbol)}. Raw: ${rawLevData.substring(0, 100)}`);
                            }
                        }
                        await sleep(5000); // Thêm độ trễ LỚN HƠN (5 giây) giữa các yêu cầu để tránh rate limit
                    }
                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Hoàn tất lấy dữ liệu đòn bẩy thô cho ${Object.keys(fetchedRawLeverageDataMap).length} cặp. (${successCount} cặp được parse thành công)`);
                    currentRawDebug.status = `thành công (BingX API)`;
                    currentRawDebug.data = `Lấy ${Object.keys(fetchedRawLeverageDataMap).length} cặp. (${successCount} cặp parse thành công).`;


                } catch (e) {
                    console.error(`[CACHE] ❌ ${id.toUpperCase()}: Lỗi chung khi lấy dữ liệu BingX: ${e.msg || e.message}.`);
                    leverageSource = "BingX REST API (lỗi chung)";
                    currentRawDebug.status = `thất bại (BingX API lỗi chung: ${e.code || 'UNKNOWN'})`;
                    currentRawDebug.error = { code: e.code, msg: e.message };
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
                                    fetchedRawLeverageDataMap[cleanSymbol(symbol)] = parsedMaxLeverage; 
                                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Max leverage của ${cleanSymbol(symbol)} là ${parsedMaxLeverage} (CCXT).`); // LOG THÀNH CÔNG TỪ CCXT
                                    successCount++;
                                }
                            }
                        }
                        currentRawDebug.status = `thành công (${successCount} cặp CCXT)`;
                        currentRawDebug.data = `Lấy ${successCount} cặp.`;
                    } else { // Fallback to loadMarkets
                        console.log(`[CACHE] ${id.toUpperCase()}: fetchLeverageTiers không khả dụng. Dùng loadMarkets...`);
                        await exchange.loadMarkets(true);
                        let successCount = 0;
                        for (const market of Object.values(exchange.markets)) {
                            if (market.swap && market.quote === 'USDT') {
                                const symbolCleaned = cleanSymbol(market.symbol);
                                const maxLeverage = getMaxLeverageFromMarketInfo(market);
                                if (maxLeverage !== null && maxLeverage > 0) {
                                    fetchedRawLeverageDataMap[symbolCleaned] = maxLeverage; 
                                    console.log(`[CACHE] ✅ ${id.toUpperCase()}: Max leverage của ${symbolCleaned} là ${maxLeverage} (loadMarkets).`); // LOG THÀNH CÔNG TỪ loadMarkets
                                    successCount++;
                                } else {
                                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} qua loadMarkets.`);
                                }
                            }
                        }
                        leverageSource = "CCXT loadMarkets";
                        currentRawDebug.status = `thành công (loadMarkets, ${successCount} cặp)`;
                        currentRawDebug.data = `Lấy ${successCount} cặp.`;
                    }
                } catch(e) {
                    console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Lỗi khi gọi CCXT phương thức leverage: ${e.message}.`);
                    leverageSource = "CCXT (lỗi)";
                    currentRawDebug.status = `thất bại (${e.code || 'UNKNOWN'})`;
                    currentRawDebug.error = { code: e.code, msg: e.message };
                }
            }

            newCache[id] = fetchedRawLeverageDataMap; 
            const count = Object.keys(newCache[id]).length;
            if (count > 0) {
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số mục đòn bẩy đã lấy: ${count} (${leverageSource}).`); // Tổng kết
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
            debugRawLeverageResponses[id] = { status: `thất bại (${e.code || 'UNKNOWN'})`, timestamp: new Date(), data: e.response ? e.response.toString() : 'N/A', error: { code: e.code, msg: e.message } };
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

            const fundingRatesRaw = await exchange.fetchFundingRates();
            for (const rate of Object.values(fundingRatesRaw)) {
                const symbolCleaned = cleanSymbol(rate.symbol);
                const maxLeverageRaw = leverageCache[id]?.[symbolCleaned] || null; 
                
                const fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();

                if (typeof rate.fundingRate === 'number' && !isNaN(rate.fundingRate) && typeof fundingTimestamp === 'number' && fundingTimestamp > 0) {
                    processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: rate.fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverageRaw };
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
            if (!exchangeData[result.value?.id]) {
                exchangeData[result.value.id] = { rates: {} };
            }
        }
    });
    return freshData;
}

function parseLeverageFromRawData(exchangeId, symbol, rawData) {
    if (typeof rawData === 'number') { 
        return rawData;
    }
    if (typeof rawData !== 'string' || rawData.trim() === '') { 
        return null;
    }

    try {
        const parsedJson = JSON.parse(rawData);
        if (exchangeId === 'binanceusdm') {
            if (parsedJson.brackets && Array.isArray(parsedJson.brackets) && parsedJson.brackets.length > 0) {
                const maxLeverage = Math.Max(...parsedJson.brackets.map(b => b.leverage));
                return !isNaN(maxLeverage) && maxLeverage > 0 ? maxLeverage : null;
            } 
            else if (Array.isArray(parsedJson)) { 
                const targetItem = parsedJson.find(item => cleanSymbol(item.symbol) === cleanSymbol(symbol));
                if (targetItem && targetItem.brackets && Array.isArray(targetItem.brackets)) {
                    const maxLeverage = Math.Max(...targetItem.brackets.map(b => b.leverage));
                    return !isNaN(maxLeverage) && maxLeverage > 0 ? maxLeverage : null;
                }
            }
        } else if (exchangeId === 'bingx') {
            if (parsedJson.code === 0 && parsedJson.data?.leverage) {
                const leverage = parseInt(parsedJson.data.leverage, 10);
                return !isNaN(leverage) && leverage > 1 ? leverage : null;
            }
        }
    } catch (e) {
    }
    return null; 
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

                const parsedMaxLeverage1 = parseLeverageFromRawData(exchange1Id, symbol, rate1Data.maxLeverage);
                const parsedMaxLeverage2 = parseLeverageFromRawData(exchange2Id, symbol, rate2Data.maxLeverage);

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
