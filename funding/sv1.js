const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');

const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('./config.js');

const PORT = 5005;

const EXCHANGE_IDS = ['binanceusdm', 'okx', 'bitget', 'kucoin'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 5;
const IMMINENT_THRESHOLD_MINUTES = 15;
const FULL_LEVERAGE_REFRESH_AT_HOUR = 0;
const TARGETED_LEVERAGE_REFRESH_MINUTES = [15, 30, 45, 55, 59];

let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let bitgetValidFuturesSymbolSet = new Set();

let debugRawLeverageResponses = {
    binanceusdm: { status: '...', timestamp: null, data: 'N/A', error: null },
    okx: { status: '...', timestamp: null, data: 'N/A', error: null },
    bitget: { status: '...', timestamp: null, data: 'N/A', error: null },
    kucoin: { status: '...', timestamp: null, data: 'N/A', error: null }
};

const BINANCE_BASE_HOST = 'fapi.binance.com';
const BITGET_NATIVE_REST_HOST = 'api.bitget.com';
const KUCOIN_FUTURES_HOST = 'api-futures.kucoin.com';
let binanceServerTimeOffset = 0;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    if (id === 'kucoin') return;
    const exchangeClass = ccxt[id];
    const config = {
        'options': { 'defaultType': 'swap' },
        'enableRateLimit': true,
        'headers': { 'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)' }
    };
    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }
    exchanges[id] = new exchangeClass(config);
});

const cleanSymbol = (symbol) => {
    let cleaned = symbol.toUpperCase();
    if (cleaned.endsWith('M')) cleaned = cleaned.slice(0, -1);
    cleaned = cleaned.replace('XBT', 'BTC');
    cleaned = cleaned.replace('_UMCBL', '');
    cleaned = cleaned.replace(/[\/:_]/g, '');
    cleaned = cleaned.replace(/-USDT$/, 'USDT');
    const usdtIndex = cleaned.indexOf('USDT');
    if (usdtIndex !== -1) cleaned = cleaned.substring(0, usdtIndex) + 'USDT';
    return cleaned;
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function makeHttpRequest(method, hostname, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = { hostname, port: 443, path, method, headers: { ...headers, 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                else reject({ code: res.statusCode, msg: `HTTP Error: ${res.statusCode}`, url: `${hostname}${path}`, rawResponse: data });
            });
        });
        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: e.message }));
        req.on('timeout', () => { req.destroy(); reject({ code: 'TIMEOUT_ERROR', msg: 'Request timed out' }); });
        req.end();
    });
}

async function syncBinanceServerTime() {
    try {
        const data = await makeHttpRequest('GET', BINANCE_BASE_HOST, '/fapi/v1/time');
        const { serverTime } = JSON.parse(data);
        binanceServerTimeOffset = serverTime - Date.now();
    } catch (error) {
        console.error(`[TIME_SYNC] ❌ Lỗi đồng bộ thời gian Binance: ${error.msg || error.message}.`);
        binanceServerTimeOffset = 0;
    }
}

async function callSignedBinanceAPI(fullEndpointPath, params = {}) {
    const timestamp = Date.now() + binanceServerTimeOffset;
    const queryString = new URLSearchParams({ ...params, timestamp, recvWindow: 5000 }).toString();
    const signature = crypto.createHmac('sha256', binanceApiSecret).update(queryString).digest('hex');
    const url = `${fullEndpointPath}?${queryString}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': binanceApiKey };
    const rawData = await makeHttpRequest('GET', BINANCE_BASE_HOST, url, headers);
    return JSON.parse(rawData);
}

function getMaxLeverageFromMarketInfo(market) {
    if (market?.limits?.leverage?.max) return market.limits.leverage.max;
    if (market?.info?.maxLeverage) return parseInt(market.info.maxLeverage, 10);
    return null;
}

async function updateLeverageForExchange(id, symbolsToUpdate = null) {
    const exchange = exchanges[id];
    let currentLeverageData = {};
    const updateType = symbolsToUpdate ? 'mục tiêu' : 'toàn bộ';
    debugRawLeverageResponses[id] = { status: `Đang tải đòn bẩy (${updateType})...`, timestamp: new Date(), data: 'N/A', error: null };

    try {
        if (id === 'binanceusdm') {
            const leverageBrackets = await callSignedBinanceAPI('/fapi/v1/leverageBracket');
            for (const item of leverageBrackets) {
                const cleanedSym = cleanSymbol(item.symbol);
                if (symbolsToUpdate && !symbolsToUpdate.includes(cleanedSym)) continue;
                if (item.brackets[0]) {
                    currentLeverageData[cleanedSym] = parseInt(item.brackets[0].initialLeverage, 10);
                }
            }
        } else { // OKX, Bitget
            await exchange.loadMarkets(true);
            for (const market of Object.values(exchange.markets)) {
                if (!market.swap || !market.symbol.includes('USDT')) continue;
                const cleanedSym = cleanSymbol(market.symbol);
                if (symbolsToUpdate && !symbolsToUpdate.includes(cleanedSym)) continue;
                const maxLeverage = getMaxLeverageFromMarketInfo(market);
                if (maxLeverage) currentLeverageData[cleanedSym] = maxLeverage;
            }
        }

        if (symbolsToUpdate) {
            symbolsToUpdate.forEach(sym => {
                if (currentLeverageData[sym]) leverageCache[id][sym] = currentLeverageData[sym];
            });
        } else {
            leverageCache[id] = currentLeverageData;
        }
        
        debugRawLeverageResponses[id].status = `Hoàn tất (${Object.keys(currentLeverageData).length} cặp)`;
        console.log(`[LEVERAGE] ✅ ${id.toUpperCase()}: Đã cập nhật ${Object.keys(currentLeverageData).length} đòn bẩy (${updateType}).`);
    } catch (e) {
        debugRawLeverageResponses[id].status = `Lỗi: ${e.message}`;
        debugRawLeverageResponses[id].error = { msg: e.message };
        console.error(`[LEVERAGE] ❌ Lỗi khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}`);
    }
}

async function performFullLeverageUpdate() {
    console.log('[LEVERAGE_SCHEDULER] 🔄 Bắt đầu cập nhật TOÀN BỘ đòn bẩy...');
    const nonKucoinExchanges = EXCHANGE_IDS.filter(id => id !== 'kucoin');
    await Promise.all(nonKucoinExchanges.map(id => updateLeverageForExchange(id, null)));
}

async function performTargetedLeverageUpdate() {
    console.log('[LEVERAGE_SCHEDULER] 🎯 Bắt đầu cập nhật đòn bẩy MỤC TIÊU...');
    const activeSymbols = Array.from(new Set(arbitrageOpportunities.map(op => op.coin)));
    if (activeSymbols.length === 0) {
        console.log('[LEVERAGE_SCHEDULER] Không có cơ hội, bỏ qua cập nhật mục tiêu.');
        return;
    }
    const nonKucoinExchanges = EXCHANGE_IDS.filter(id => id !== 'kucoin');
    await Promise.all(nonKucoinExchanges.map(id => updateLeverageForExchange(id, activeSymbols)));
}

async function fetchBitgetValidFuturesSymbols() {
    try {
        const rawData = await makeHttpRequest('GET', BITGET_NATIVE_REST_HOST, '/api/mix/v1/market/contracts?productType=umcbl');
        const json = JSON.parse(rawData);
        if (json.code === '00000' && Array.isArray(json.data)) {
            bitgetValidFuturesSymbolSet = new Set(json.data.map(c => c.symbol));
            console.log(`[BITGET_SYMBOLS] ✅ Đã tải ${bitgetValidFuturesSymbolSet.size} symbol hợp lệ.`);
        }
    } catch (e) {
        console.error(`[BITGET_SYMBOLS] ❌ Lỗi tải symbol Bitget: ${e.message}`);
    }
}

function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);
    if (nextHourUTC === undefined) nextHourUTC = 24;
    const nextFundingDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextHourUTC));
    return nextFundingDate.getTime();
}

async function updateKucoinData() {
    console.log('[KUCOIN_DATA] 🔄 Bắt đầu cập nhật dữ liệu KuCoin (tối ưu hóa)...');
    debugRawLeverageResponses['kucoin'].status = 'Đang tải contracts...';
    try {
        const rawData = await makeHttpRequest('GET', KUCOIN_FUTURES_HOST, '/api/v1/contracts/active');
        const json = JSON.parse(rawData);
        if (json.code !== '200000' || !Array.isArray(json.data)) throw new Error(`API trả về lỗi: ${json.msg || 'Không rõ'}`);
        
        const processedRates = {};
        const kucoinLeverage = {};
        let successCount = 0;
        for (const contract of json.data) {
            const cleanedSym = cleanSymbol(contract.symbol);
            if (!cleanedSym.endsWith('USDT')) continue;

            const maxLeverage = parseInt(contract.maxLeverage, 10);
            const fundingRate = parseFloat(contract.fundingFeeRate);
            const fundingTimestamp = parseInt(contract.nextFundingRateDateTime, 10);

            if (!isNaN(maxLeverage) && maxLeverage > 0) kucoinLeverage[cleanedSym] = maxLeverage;
            if (!isNaN(fundingRate) && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                processedRates[cleanedSym] = {
                    symbol: cleanedSym,
                    fundingRate,
                    fundingTimestamp,
                    maxLeverage: kucoinLeverage[cleanedSym] || null
                };
                successCount++;
            }
        }
        leverageCache['kucoin'] = kucoinLeverage;
        exchangeData['kucoin'] = { rates: processedRates };
        debugRawLeverageResponses['kucoin'] = { status: `Hoàn tất (${successCount} cặp)`, timestamp: new Date(), data: `Đã lấy ${successCount} cặp.`, error: null };
        console.log(`[KUCOIN_DATA] ✅ Hoàn tất. Lấy được ${successCount} cặp dữ liệu từ 1 request.`);
    } catch (e) {
        console.error(`[KUCOIN_DATA] ❌ Lỗi nghiêm trọng: ${e.message}`);
        debugRawLeverageResponses['kucoin'] = { status: 'Lỗi nghiêm trọng', error: { msg: e.message }, timestamp: new Date() };
        exchangeData['kucoin'] = { rates: {} };
    }
}

async function fetchFundingRatesForOtherExchanges() {
    console.log('[DATA] Bắt đầu làm mới funding rates (trừ KuCoin)...');
    const otherExchangeIds = EXCHANGE_IDS.filter(id => id !== 'kucoin');
    const resultsSummary = [];
    const fundingPromises = otherExchangeIds.map(async (id) => {
        let processedRates = {};
        let successCount = 0;
        try {
            const fundingRatesRaw = await exchanges[id].fetchFundingRates();
            for (const rate of Object.values(fundingRatesRaw)) {
                if (!rate.symbol.includes('USDT')) continue;
                const symbolCleaned = cleanSymbol(rate.symbol);
                processedRates[symbolCleaned] = {
                    symbol: symbolCleaned,
                    fundingRate: rate.fundingRate,
                    fundingTimestamp: rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime(),
                    maxLeverage: leverageCache[id]?.[symbolCleaned] || null
                };
                successCount++;
            }
            resultsSummary.push(`${id.toUpperCase()}: ${successCount} cặp`);
        } catch (e) {
            resultsSummary.push(`${id.toUpperCase()}: LỖI`);
            console.error(`[DATA] ❌ Lỗi ${id.toUpperCase()}: ${e.message}`);
        } finally {
            exchangeData[id] = { rates: processedRates };
        }
    });
    await Promise.all(fundingPromises);
    console.log(`[DATA] ✅ Hoàn tất làm mới funding rates (trừ KuCoin): ${resultsSummary.join(', ')}.`);
}

function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));

    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const id1 = EXCHANGE_IDS[i], id2 = EXCHANGE_IDS[j];
            const rates1 = currentExchangeData[id1]?.rates, rates2 = currentExchangeData[id2]?.rates;
            if (!rates1 || !rates2) continue;

            const commonSymbols = Object.keys(rates1).filter(symbol => rates2[symbol]);

            for (const symbol of commonSymbols) {
                const r1 = rates1[symbol], r2 = rates2[symbol];
                if (!r1.maxLeverage || r1.maxLeverage <= 0 || !r2.maxLeverage || r2.maxLeverage <= 0) continue;

                let [longEx, shortEx, longR, shortR] = r1.fundingRate > r2.fundingRate ? [id2, id1, r2, r1] : [id1, id2, r1, r2];
                let fundingDiff = shortR.fundingRate - longR.fundingRate;
                if (Math.sign(shortR.fundingRate) === Math.sign(longR.fundingRate)) {
                    fundingDiff -= Math.min(Math.abs(shortR.fundingRate), Math.abs(longR.fundingRate));
                }

                if (fundingDiff <= FUNDING_DIFFERENCE_THRESHOLD) continue;

                const commonLeverage = Math.min(r1.maxLeverage, r2.maxLeverage);
                const estimatedPnl = fundingDiff * commonLeverage * 100;

                if (estimatedPnl >= MINIMUM_PNL_THRESHOLD) {
                    const finalFundingTime = Math.max(r1.fundingTimestamp, r2.fundingTimestamp);
                    const minutesUntilFunding = (finalFundingTime - Date.now()) / 60000;
                    allFoundOpportunities.push({
                        coin: symbol,
                        exchanges: `${shortEx.replace('usdm','')} / ${longEx.replace('usdm','')}`,
                        fundingDiff,
                        nextFundingTime: finalFundingTime,
                        commonLeverage,
                        estimatedPnl,
                        isImminent: minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES
                    });
                }
            }
        }
    }

    if (allFoundOpportunities.length === 0) {
        arbitrageOpportunities = [];
        return;
    }

    const sortedOpportunities = allFoundOpportunities.sort((a, b) => a.nextFundingTime - b.nextFundingTime || b.estimatedPnl - a.estimatedPnl);
    const nearestFundingTimestamp = sortedOpportunities[0].nextFundingTime;
    arbitrageOpportunities = sortedOpportunities.filter(op => op.nextFundingTime === nearestFundingTimestamp);
}

async function masterLoop() {
    clearTimeout(loopTimeoutId);
    console.log(`\n[MASTER_LOOP] Bắt đầu vòng lặp chính lúc ${new Date().toLocaleTimeString()}...`);
    
    await syncBinanceServerTime();

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentHour = now.getUTCHours();
    
    if (currentHour === FULL_LEVERAGE_REFRESH_AT_HOUR && currentMinute < 2) {
        await performFullLeverageUpdate();
    } else if (TARGETED_LEVERAGE_REFRESH_MINUTES.includes(currentMinute)) {
        await performTargetedLeverageUpdate();
    }
    
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
    const delaySeconds = 60 - now.getSeconds();
    console.log(`[SCHEDULER] Vòng lặp chính kế tiếp sau ${delaySeconds} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delaySeconds * 1000);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            res.writeHead(err ? 500 : 200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(err ? 'Lỗi đọc file' : content);
        });
    } else if (req.url === '/api/data' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lastUpdated: lastFullUpdateTimestamp, arbitrageData: arbitrageOpportunities, rawRates: exchangeData, debugRawLeverageResponses }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    EXCHANGE_IDS.forEach(id => {
        exchangeData[id] = { rates: {} };
        leverageCache[id] = {};
    });

    await fetchBitgetValidFuturesSymbols();
    await performFullLeverageUpdate();
    masterLoop();
});
