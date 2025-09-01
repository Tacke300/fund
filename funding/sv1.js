const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('./config.js');

const PORT = 5005;

// ----- CẤU HÌNH -----
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

let debugRawLeverageResponses = {
    binanceusdm: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    okx: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    bitget: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null },
    kucoin: { status: 'Đang tải đòn bẩy...', timestamp: null, data: 'N/A', error: null }
};

const BINANCE_BASE_HOST = 'fapi.binance.com';
const BITGET_NATIVE_REST_HOST = 'api.bitget.com';
const KUCOIN_FUTURES_HOST = 'api-futures.kucoin.com';
let binanceServerTimeOffset = 0;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    if (id === 'kucoin') return; // Bỏ qua KuCoin trong ccxt init
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
    else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
});

// ----- HÀM HỖ TRỢ CHUNG -----
const cleanSymbol = (symbol) => {
    let cleaned = symbol.toUpperCase();
    if (cleaned.endsWith('M')) {
        cleaned = cleaned.slice(0, -1);
    }
    cleaned = cleaned.replace('XBT', 'BTC');
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

// ... Giữ lại các hàm tiện ích khác như syncBinanceServerTime, callSignedBinanceAPI ...
async function syncBinanceServerTime() {
    try {
        const data = await makeHttpRequest('GET', BINANCE_BASE_HOST, '/fapi/v1/time');
        const parsedData = JSON.parse(data);
        const binanceServerTime = parsedData.serverTime;
        const localTime = Date.now();
        binanceServerTimeOffset = binanceServerTime - localTime;
    } catch (error) {
        console.error(`[TIME_SYNC] ❌ Lỗi đồng bộ thời gian Binance: ${error.msg || error.message}.`);
        binanceServerTimeOffset = 0;
    }
}
async function callSignedBinanceAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!binanceApiKey || !binanceApiSecret) {
        throw new Error("API Key hoặc Secret Key cho Binance chưa được cấu hình.");
    }
    const recvWindow = 5000;
    const timestamp = Date.now() + binanceServerTimeOffset;
    let queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto.createHmac('sha256', binanceApiSecret).update(queryString).digest('hex');
    let requestPath;
    let requestBody = '';
    const headers = { 'X-MBX-APIKEY': binanceApiKey, };
    if (method === 'GET') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    try {
        const rawData = await makeHttpRequest(method, BINANCE_BASE_HOST, requestPath, headers, requestBody);
        return JSON.parse(rawData);
    } catch (error) {
        console.error(`[BINANCE_API] Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}. Path: ${requestPath}`);
        throw error;
    }
}
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
                if (!isNaN(parsedFundingTime) && parsedFundingTime > 0) return parsedFundingTime;
            }
        }
        return null;
    } catch (e) {
        console.error(`[BITGET_FUNDING_TIME_NATIVE] ❌ Lỗi khi lấy funding time cho ${apiSymbol} từ native API: ${e.msg || e.message}.`);
        return null;
    }
}

// ----- HÀM LẤY DỮ LIỆU KUCOIN MỚI -----

async function fetchKucoinActiveContracts() {
    try {
        const rawData = await makeHttpRequest('GET', KUCOIN_FUTURES_HOST, '/api/v1/contracts/active');
        const json = JSON.parse(rawData);
        if (json.code === '200000' && Array.isArray(json.data)) {
            return json.data;
        }
        console.error(`[KUCOIN_DATA] Lỗi khi lấy active contracts: ${json.msg || 'Unknown error'}`);
        return [];
    } catch (e) {
        console.error(`[KUCOIN_DATA] Lỗi request khi lấy active contracts: ${e.message}`);
        return [];
    }
}

async function fetchKucoinFundingRatesInBatches(symbols) {
    const batchSize = 20;
    const allFundingRates = [];
    console.log(`[KUCOIN_DATA] Bắt đầu lấy funding rates cho ${symbols.length} symbol theo lô ${batchSize}...`);

    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const promises = batch.map(symbol =>
            makeHttpRequest('GET', KUCOIN_FUTURES_HOST, `/api/v1/funding-rate?symbol=${symbol}`)
                .then(rawData => ({ symbol, data: JSON.parse(rawData).data }))
                .catch(e => ({ symbol, error: e.message }))
        );
        
        const responses = await Promise.all(promises);
        allFundingRates.push(...responses);
        debugRawLeverageResponses['kucoin'].status = `Funding Batch (${i + batch.length}/${symbols.length})`;
        
        if (i + batchSize < symbols.length) {
            await sleep(150);
        }
    }
    return allFundingRates;
}

async function updateKucoinData() {
    console.log('[KUCOIN_DATA] 🔄 Bắt đầu chu trình cập nhật dữ liệu KuCoin...');
    debugRawLeverageResponses['kucoin'].status = 'Đang tải contracts...';
    
    const activeContracts = await fetchKucoinActiveContracts();
    if (activeContracts.length === 0) {
        console.error('[KUCOIN_DATA] ❌ Không lấy được danh sách active contracts. Bỏ qua chu trình.');
        debugRawLeverageResponses['kucoin'].status = 'Lỗi tải contracts';
        return;
    }

    const symbols = activeContracts.map(c => c.symbol);
    const fundingRateResults = await fetchKucoinFundingRatesInBatches(symbols);
    
    const processedRates = {};
    let successCount = 0;
    const kucoinLeverage = {};

    for (const contract of activeContracts) {
        const cleanedSym = cleanSymbol(contract.symbol);
        const maxLeverage = parseInt(contract.maxLeverage, 10);
        if (!isNaN(maxLeverage) && maxLeverage > 0) {
            kucoinLeverage[cleanedSym] = maxLeverage;
        }

        const fundingInfo = fundingRateResults.find(fr => fr.symbol === contract.symbol);
        if (fundingInfo && !fundingInfo.error && fundingInfo.data) {
            const fundingRate = parseFloat(fundingInfo.data.fundingFeeRate);
            const fundingTimestamp = parseInt(fundingInfo.data.nextFundingFeeTime, 10);

            if (!isNaN(fundingRate) && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                processedRates[cleanedSym] = {
                    symbol: cleanedSym,
                    fundingRate: fundingRate,
                    fundingTimestamp: fundingTimestamp,
                    maxLeverage: kucoinLeverage[cleanedSym] || null
                };
                successCount++;
            }
        }
    }
    
    leverageCache['kucoin'] = kucoinLeverage;
    exchangeData['kucoin'] = { rates: processedRates };
    
    debugRawLeverageResponses['kucoin'].status = `Hoàn tất (${successCount} cặp)`;
    debugRawLeverageResponses['kucoin'].timestamp = new Date();
    debugRawLeverageResponses['kucoin'].data = `Đã lấy ${successCount} cặp.`;
    debugRawLeverageResponses['kucoin'].error = null;
    
    console.log(`[KUCOIN_DATA] ✅ Hoàn tất. Lấy được ${successCount} funding rates và ${Object.keys(kucoinLeverage).length} đòn bẩy.`);
}


async function fetchFundingRatesForOtherExchanges() {
    if (isFundingUpdatePaused()) {
        console.log('[DATA] ⏸️ Tạm dừng cập nhật funding rates từ phút 59 đến phút 2 UTC.');
        return;
    }
    console.log('[DATA] Bắt đầu làm mới funding rates cho các sàn (trừ KuCoin)...');

    const otherExchangeIds = EXCHANGE_IDS.filter(id => id !== 'kucoin');
    const resultsSummary = [];

    const fundingPromises = otherExchangeIds.map(async (id) => {
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
            }

            for (const rate of Object.values(fundingRatesRaw)) {
                if (!rate.symbol.includes('USDT')) continue;

                const symbolCleaned = cleanSymbol(rate.symbol);
                const maxLeverageParsed = leverageCache[id]?.[symbolCleaned] || null;
                let fundingRateValue = rate.fundingRate;
                let fundingTimestampValue = rate.fundingTimestamp || rate.nextFundingTime;

                if (id === 'bitget') {
                    const bitgetApiSymbol = cleanSymbol(rate.symbol);
                    const symbolForNativeApi = bitgetApiSymbol.includes('_UMCBL') ? bitgetApiSymbol : `${bitgetApiSymbol}_UMCBL`;
                    if (!bitgetValidFuturesSymbolSet.has(symbolForNativeApi)) continue;
                    const nativeFundingTime = await fetchBitgetFundingTimeNativeApi(bitgetApiSymbol);
                    if (nativeFundingTime !== null) fundingTimestampValue = nativeFundingTime;
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
            exchangeData[id] = { rates: processedRates };
            debugRawLeverageResponses[id].status = currentStatus;
            debugRawLeverageResponses[id].timestamp = new Date();
            debugRawLeverageResponses[id].data = `Đã lấy ${Object.keys(processedRates).length} cặp.`;
            debugRawLeverageResponses[id].error = currentError;
        }
    });

    await Promise.all(fundingPromises);
    console.log(`[DATA] ✅ Hoàn tất làm mới funding rates cho các sàn (trừ KuCoin): ${resultsSummary.join(', ')}.`);
}

function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));

    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;

            if (!exchange1Rates || !exchange2Rates || Object.keys(exchange1Rates).length === 0 || Object.keys(exchange2Rates).length === 0) continue;

            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);
            if (commonSymbols.length === 0) continue;

            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol];
                const rate2Data = exchange2Rates[symbol];

                const parsedMaxLeverage1 = rate1Data.maxLeverage;
                const parsedMaxLeverage2 = rate2Data.maxLeverage;

                if (typeof parsedMaxLeverage1 !== 'number' || parsedMaxLeverage1 <= 0 || typeof parsedMaxLeverage2 !== 'number' || parsedMaxLeverage2 <= 0) continue;
                if (typeof rate1Data.fundingRate !== 'number' || typeof rate2Data.fundingRate !== 'number' || !rate1Data.fundingTimestamp || !rate2Data.fundingTimestamp) continue;

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

                if (fundingDiff <= FUNDING_DIFFERENCE_THRESHOLD) continue;

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
                        commonLeverage: parseFloat(commonLeverage.toFixed(2)),
                        estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                        isImminent: isImminent,
                        details: {
                            shortExchange, shortRate: shortRate.fundingRate, shortLeverage: parsedMaxLeverage1,
                            longExchange, longRate: longRate.fundingRate, longLeverage: parsedMaxLeverage2,
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
    
    await syncBinanceServerTime();

    // Chạy các tác vụ song song
    await Promise.all([
        fetchFundingRatesForOtherExchanges(),
        updateKucoinData()
    ]);
    
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();

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

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
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

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);

    // Khởi tạo các biến
    EXCHANGE_IDS.forEach(id => {
        if (!exchangeData[id]) exchangeData[id] = { rates: {} };
        if (!leverageCache[id]) leverageCache[id] = {};
    });

    await fetchBitgetValidFuturesSymbols();
    
    // Bắt đầu vòng lặp chính
    masterLoop();
});
