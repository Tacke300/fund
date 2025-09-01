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

async function fetchBitgetValidFuturesSymbols() {
    console.log('[BITGET_SYMBOLS] 🔄 Đang tải danh sách symbol Futures hợp lệ từ Bitget...');
    try {
        const rawData = await makeHttpRequest('GET', BITGET_NATIVE_REST_HOST, '/api/mix/v1/market/contracts?productType=umcbl');
        const json = JSON.parse(rawData);
        if (json.code === '00000' && Array.isArray(json.data)) {
            bitgetValidFuturesSymbolSet.clear();
            json.data.forEach(contract => {
                if (contract.symbol) bitgetValidFuturesSymbolSet.add(contract.symbol);
            });
            console.log(`[BITGET_SYMBOLS] ✅ Đã tải ${bitgetValidFuturesSymbolSet.size} symbol Futures hợp lệ từ Bitget.`);
        } else {
            console.error(`[BITGET_SYMBOLS] ❌ Lỗi khi tải danh sách symbol Futures Bitget: Code ${json.code}`);
        }
    } catch (e) {
        console.error(`[BITGET_SYMBOLS] ❌ Lỗi request khi tải danh sách symbol Futures Bitget: ${e.message}`);
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

async function fetchKucoinActiveContracts() {
    try {
        const rawData = await makeHttpRequest('GET', KUCOIN_FUTURES_HOST, '/api/v1/contracts/active');
        const json = JSON.parse(rawData);
        if (json.code === '200000' && Array.isArray(json.data)) return json.data;
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
    let isFirstBatch = true;
    console.log(`[KUCOIN_DATA] Bắt đầu lấy funding rates cho ${symbols.length} symbol theo lô ${batchSize}...`);
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const promises = batch.map(symbol =>
            makeHttpRequest('GET', KUCOIN_FUTURES_HOST, `/api/v1/funding-rate?symbol=${symbol}`)
                .then(rawData => ({ symbol, response: JSON.parse(rawData) }))
                .catch(e => ({ symbol, error: e.message }))
        );
        const responses = await Promise.all(responses);

        if (isFirstBatch && responses.length > 0) {
            console.log(`[KUCOIN_DEBUG] Dữ liệu thô của symbol đầu tiên (${responses[0].symbol}):`, JSON.stringify(responses[0].response, null, 2));
            isFirstBatch = false;
        }

        allFundingRates.push(...responses);
        debugRawLeverageResponses['kucoin'].status = `Funding Batch (${i + batch.length}/${symbols.length})`;
        if (i + batchSize < symbols.length) await sleep(150);
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
        exchangeData['kucoin'] = { rates: {} };
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
        if (!isNaN(maxLeverage) && maxLeverage > 0) kucoinLeverage[cleanedSym] = maxLeverage;

        const fundingInfo = fundingRateResults.find(fr => fr.symbol === contract.symbol);

        if (fundingInfo && fundingInfo.response && fundingInfo.response.code === '200000') {
            const fundingData = fundingInfo.response.data;
            const fundingRate = parseFloat(fundingData.fundingFeeRate);
            const fundingTimestamp = parseInt(fundingData.nextFundingFeeTime, 10);
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
    console.log('[DATA] Bắt đầu làm mới funding rates cho các sàn (trừ KuCoin)...');
    const otherExchangeIds = EXCHANGE_IDS.filter(id => id !== 'kucoin');
    const resultsSummary = [];

    const fundingPromises = otherExchangeIds.map(async (id) => {
        let processedRates = {};
        let successCount = 0;
        try {
            await exchanges[id].loadMarkets(true);
            const fundingRatesRaw = await exchanges[id].fetchFundingRates();
            leverageCache[id] = {};
            for (const [symbol, market] of Object.entries(exchanges[id].markets)) {
                if (market.swap && market.symbol.includes('USDT')) {
                    const cleaned = cleanSymbol(symbol);
                    leverageCache[id][cleaned] = market.limits?.leverage?.max || null;
                }
            }

            for (const rate of Object.values(fundingRatesRaw)) {
                if (!rate.symbol.includes('USDT')) continue;
                const symbolCleaned = cleanSymbol(rate.symbol);
                let fundingTimestampValue = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();
                processedRates[symbolCleaned] = {
                    symbol: symbolCleaned,
                    fundingRate: rate.fundingRate,
                    fundingTimestamp: fundingTimestampValue,
                    maxLeverage: leverageCache[id][symbolCleaned] || null
                };
                successCount++;
            }
            resultsSummary.push(`${id.toUpperCase()}: ${successCount} cặp`);
            debugRawLeverageResponses[id].status = `Hoàn tất (${successCount} cặp)`;
        } catch (e) {
            resultsSummary.push(`${id.toUpperCase()}: LỖI`);
            debugRawLeverageResponses[id].status = `Lỗi: ${e.message}`;
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
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;
            if (!exchange1Rates || !exchange2Rates || Object.keys(exchange1Rates).length === 0 || Object.keys(exchange2Rates).length === 0) continue;

            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);
            for (const symbol of commonSymbols) {
                const r1 = exchange1Rates[symbol], r2 = exchange2Rates[symbol];
                if (!r1.maxLeverage || r1.maxLeverage <= 0 || !r2.maxLeverage || r2.maxLeverage <= 0) continue;

                let longEx, shortEx, longR, shortR;
                if (r1.fundingRate > r2.fundingRate) { shortEx = exchange1Id; shortR = r1; longEx = exchange2Id; longR = r2; }
                else { shortEx = exchange2Id; shortR = r2; longEx = exchange1Id; longR = r1; }

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
                        exchanges: `${shortEx.replace('usdm', '')} / ${longEx.replace('usdm', '')}`,
                        fundingDiff: parseFloat(fundingDiff.toFixed(6)),
                        nextFundingTime: finalFundingTime,
                        commonLeverage: parseFloat(commonLeverage.toFixed(2)),
                        estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                        isImminent: minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES,
                    });
                }
            }
        }
    }
    arbitrageOpportunities = allFoundOpportunities.sort((a, b) => a.nextFundingTime - b.nextFundingTime || b.estimatedPnl - a.estimatedPnl);
}

async function masterLoop() {
    clearTimeout(loopTimeoutId);
    console.log(`\n[MASTER_LOOP] Bắt đầu vòng lặp chính lúc ${new Date().toLocaleTimeString()}...`);
    
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
    const delaySeconds = (60 - now.getSeconds() + 2);
    const delayMs = (delaySeconds % 60) * 1000 || 60000;
    console.log(`[SCHEDULER] Vòng lặp chính kế tiếp sau ${Math.round(delayMs / 1000)} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delayMs);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            res.writeHead(err ? 500 : 200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(err ? 'Lỗi đọc file' : content);
        });
    } else if (req.url === '/api/data' && req.method === 'GET') {
        const responseData = { lastUpdated: lastFullUpdateTimestamp, arbitrageData: arbitrageOpportunities, rawRates: exchangeData, debugRawLeverageResponses };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu đang chạy tại http://localhost:${PORT}`);
    EXCHANGE_IDS.forEach(id => {
        if (!exchangeData[id]) exchangeData[id] = { rates: {} };
        if (!leverageCache[id]) leverageCache[id] = {};
    });

    await fetchBitgetValidFuturesSymbols();
    masterLoop();
});
