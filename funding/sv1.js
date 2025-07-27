const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const Binance = require('node-binance-api');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
// !!! VUI LÒNG KIỂM TRA LẠI CỰC KỲ CẨN THẬN CÁC API KEY VÀ SECRET NÀY !!!
// Đảm bảo không có khoảng trắng thừa, không thiếu ký tự.
// Kiểm tra trên trang quản lý API của sàn để đảm bảo quyền truy cập đọc dữ liệu thị trường và tài khoản.
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88TzvmC3SpT9nEf4fcDf0pEnFzoTc';
const bingxApiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOB9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA'; // Vui lòng dán key thật của bạn
const bingxApiSecret = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVWbdAYa0go6Nohye1n7PS4XOcOmQXYnUs1YRei5RvLPg'; // Vui lòng dán secret thật của bạn
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';


// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;

const binanceClient = new Binance().options({ APIKEY: binanceApiKey, APISECRET: binanceApiSecret });

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
const formatBingXApiSymbol = (ccxtSymbol) => {
    let base = ccxtSymbol.replace(/\/USDT/g, '').replace(/:USDT/g, '').replace(/\/USDC/g, '').replace(/:USDC/g, '').replace(/-USDT$/g, '').replace(/-USDC$/g, '');
    return `${base.toUpperCase()}-USDT`;
};

function signBingX(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// === BINANCE: LẤY ĐÒN BẨY BẰNG DIRECT API (node-binance-api) ===
// Phương thức này đã sử dụng API trực tiếp (node-binance-api) như bạn yêu cầu
async function getBinanceLeverageDirectAPI() {
    let leverages = {};
    try {
        const leverageInfo = await binanceClient.futuresLeverageBracket();
        if (!Array.isArray(leverageInfo)) { console.warn(`[CACHE] ⚠️ BINANCEUSDM: futuresLeverageBracket không trả về mảng hợp lệ.`); return {}; }
        leverageInfo.forEach(info => {
            const cleanS = cleanSymbol(info.symbol);
            if (info.brackets && info.brackets.length > 0) {
                const parsedLeverage = parseFloat(info.brackets[0].initialLeverage);
                if (!isNaN(parsedLeverage) && parsedLeverage > 0) leverages[cleanS] = parsedLeverage;
            }
        });
        return leverages;
    } catch (e) {
        let errorMessage = `Lỗi khi lấy đòn bẩy: ${e.message}.`;
        // Kiểm tra lỗi xác thực từ node-binance-api
        if (e.code === -1022 || (e.response && e.response.data && e.response.data.code === -1022)) {
            errorMessage = `Lỗi xác thực (Signature Invalid). Vui lòng kiểm tra lại API Key/Secret của BinanceUSDM. Chi tiết: ${JSON.stringify(e.response?.data || e.message)}.`;
        }
        console.error(`[CACHE] ❌ BINANCEUSDM: ${errorMessage}`);
        return {};
    }
}

// === BINGX: LẤY ĐÒN BẨY BẰNG DIRECT API (fetch) ===
// Phương thức này đã sử dụng API trực tiếp (fetch) như bạn yêu cầu
async function getBingXLeverageDirectAPI() {
    const leverages = {};
    if (!bingxApiKey || !bingxApiSecret) { console.error('[CACHE] ❌ BINGX: Thiếu API Key hoặc Secret để lấy đòn bẩy.'); return {}; }

    try {
        const bingxCCXT = exchanges['bingx'];
        await bingxCCXT.loadMarkets(true);
        const markets = Object.values(bingxCCXT.markets).filter(m => m.swap && m.quote === 'USDT');
        if (markets.length === 0) { console.warn(`[CACHE] ⚠️ BINGX: loadMarkets trả về 0 thị trường USDT Swap. Không thể lấy đòn bẩy.`); return {}; }

        const BINGX_REQUEST_DELAY_MS = 100;
        for (const market of markets) {
            const cleanS = cleanSymbol(market.symbol);
            const bingxApiSymbol = formatBingXApiSymbol(market.symbol);
            try {
                const timestamp = Date.now().toString();
                const recvWindow = "15000"; 
                // Sử dụng URLSearchParams để xây dựng queryString một cách an toàn và chính xác
                const params = new URLSearchParams({
                    recvWindow: recvWindow,
                    symbol: bingxApiSymbol,
                    timestamp: timestamp // Đã sửa lỗi chính tả 'xtamp' thành 'timestamp'
                });
                const queryString = params.toString();
                const signature = signBingX(queryString, bingxApiSecret);
                const url = `https://open-api.bingx.com/openApi/swap/v2/trade/leverage?${queryString}&signature=${signature}`;

                const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });

                if (!res.ok) {
                    const errorText = await res.text();
                    let errorMessage = `Phản hồi API không OK cho ${bingxApiSymbol} (Leverage). Status: ${res.status}. Raw: ${errorText}.`;
                    try {
                        const errorJson = JSON.parse(errorText);
                        if (errorJson.code === 100413) {
                            errorMessage = `Lỗi xác thực API (Incorrect apiKey) cho ${bingxApiSymbol} (Leverage). Vui lòng kiểm tra lại API Key/Secret của BingX. Chi tiết: ${errorJson.msg}.`;
                        } else if (errorJson.code === 100421) {
                            errorMessage = `Lỗi Timestamp hoặc Timestamp không khớp cho ${bingxApiSymbol} (Leverage). Chi tiết: ${errorJson.msg}.`;
                        }
                    } catch (parseError) { /* ignore parse error */ }
                    console.error(`[CACHE] ❌ BINGX: ${errorMessage}`);
                    leverages[cleanS] = null; continue;
                }
                const json = await res.json();

                let maxLeverageFound = null;
                if (json && json.code === 0 && json.data) {
                    const longLev = parseFloat(json.data.maxLongLeverage);
                    const shortLev = parseFloat(json.data.maxShortLeverage);
                    if (!isNaN(longLev) && !isNaN(shortLev) && (longLev > 0 || shortLev > 0)) {
                        maxLeverageFound = Math.max(longLev, shortLev);
                    }
                } else {
                    console.warn(`[CACHE] ⚠️ BINGX: Lỗi hoặc không có 'data' cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                }
                leverages[cleanS] = maxLeverageFound;
            } catch (e) {
                console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy đòn bẩy cho ${bingxApiSymbol}: ${e.message}.`);
                leverages[cleanS] = null;
            }
            await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
        }
        return leverages;
    } catch (e) {
        let errorMessage = `Lỗi tổng quát khi lấy đòn bẩy cho BINGX: ${e.message}.`;
        try {
            const errorJson = JSON.parse(e.message.replace('bingx ', '')); // Cố gắng parse lỗi từ BingX
            if (errorJson.code === 100413) {
                errorMessage = `Lỗi xác thực API (Incorrect apiKey). Vui lòng kiểm tra lại API Key/Secret của BingX. Chi tiết: ${errorJson.msg}.`;
            }
        } catch (parseError) { /* ignore parse error */ }
        console.error(`[CACHE] ❌ ${errorMessage}`);
        return {};
    }
}

// === OKX & BITGET: LẤY ĐÒN BẨY BẰNG CCXT (loadMarkets hoặc fetchLeverageTiers) ===
function getMaxLeverageFromMarketInfo(market, exchangeId) {
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) return market.limits.leverage.max;
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

async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id];
        newCache[id] = {};
        try {
            if (id === 'binanceusdm') {
                // Đã xử lý qua getBinanceLeverageDirectAPI()
                newCache[id] = await getBinanceLeverageDirectAPI();
            } else if (id === 'bingx') {
                // Đã xử lý qua getBingXLeverageDirectAPI()
                newCache[id] = await getBingXLeverageDirectAPI();
            } else if (exchange.has['fetchLeverageTiers']) {
                const leverageTiers = await exchange.fetchLeverageTiers();
                for (const symbol in leverageTiers) {
                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        const parsedMaxLeverage = parseInt(Math.max(...tiers.map(t => t.leverage)), 10);
                        if (!isNaN(parsedMaxLeverage) && parsedMaxLeverage > 0) {
                            newCache[id][cleanSymbol(symbol)] = parsedMaxLeverage;
                        }
                    }
                }
            } else { // Fallback to loadMarkets
                await exchange.loadMarkets(true);
                for (const market of Object.values(exchange.markets)) {
                    if (market.swap && market.quote === 'USDT') {
                        const symbolCleaned = cleanSymbol(market.symbol);
                        const maxLeverage = getMaxLeverageFromMarketInfo(market, id);
                        newCache[id][symbolCleaned] = maxLeverage; 
                        if (maxLeverage === null || maxLeverage <= 0) {
                            console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol}.`);
                        }
                    }
                }
            }
            const count = Object.values(newCache[id]).filter(v => typeof v === 'number' && v > 0).length;
            if (count > 0) {
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy.`);
            } else {
                console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Không lấy được đòn bẩy nào.`);
            }
            return { id, status: 'fulfilled' };
        } catch (e) {
            console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`);
            newCache[id] = {}; 
            return { id, status: 'rejected', reason: e.message };
        }
    });
    await Promise.allSettled(promises);
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
}

// === BINANCE: LẤY FUNDING RATES VÀ NEXT FUNDING BẰNG DIRECT API (node-binance-api) ===
// Phương thức này đã sử dụng API trực tiếp (node-binance-api) như bạn yêu cầu
async function getBinanceFundingRatesDirectAPI() {
    try {
        const fundingRatesRaw = await binanceClient.futuresFundingRate();
        if (!Array.isArray(fundingRatesRaw)) { console.warn(`[DATA] ⚠️ BINANCEUSDM: futuresFundingRate không trả về mảng hợp lệ.`); return []; }
        const filteredData = fundingRatesRaw.map(item => ({
            symbol: item.symbol, fundingRate: parseFloat(item.fundingRate), fundingTimestamp: item.fundingTime 
        })).filter(item => item.symbol.endsWith('USDT') && !isNaN(item.fundingRate) && typeof item.fundingTimestamp === 'number' && item.fundingTimestamp > 0);
        return filteredData;
    } catch (e) {
        let errorMessage = `Lỗi khi lấy funding rates: ${e.message}.`;
        // Kiểm tra lỗi xác thực từ node-binance-api
        if (e.code === -1022 || (e.response && e.response.data && e.response.data.code === -1022)) {
            errorMessage = `Lỗi xác thực (Signature Invalid). Vui lòng kiểm tra lại API Key/Secret của BinanceUSDM. Chi tiết: ${JSON.stringify(e.response?.data || e.message)}.`;
        }
        console.error(`[DATA] ❌ BINANCEUSDM: ${errorMessage}`);
        return [];
    }
}

// === BINGX: LẤY FUNDING RATES VÀ NEXT FUNDING BẰNG DIRECT API (fetch) ===
// Phương thức này đã sử dụng API trực tiếp (fetch) như bạn yêu cầu
async function getBingXFundingRatesDirectAPI() {
    return new Promise(async (resolve, reject) => {
        if (!bingxApiKey) { console.error('[DATA] ❌ BINGX: Thiếu API Key để lấy funding rate.'); return resolve([]); }
        try {
            const bingxCCXT = exchanges['bingx'];
            await bingxCCXT.loadMarkets(true);
            const markets = Object.values(bingxCCXT.markets).filter(m => m.swap && m.quote === 'USDT');
            if (markets.length === 0) { console.warn(`[DATA] ⚠️ BINGX: loadMarkets trả về 0 thị trường USDT Swap.`); return resolve([]); }

            const BINGX_REQUEST_DELAY_MS = 100;
            const processedDataMap = new Map(); 

            for (const market of markets) {
                const cleanS = cleanSymbol(market.symbol);
                const bingxApiSymbol = formatBingXApiSymbol(market.symbol);
                try {
                    // API BingX funding rate không cần signature hay timestamp, chỉ cần symbol và X-BX-APIKEY
                    const url = `https://open-api.bingx.com/openApi/swap/v2/quote/fundingRate?symbol=${bingxApiSymbol}`; 

                    const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });
                    if (!res.ok) {
                        const errorText = await res.text();
                        let errorMessage = `Phản hồi API không OK cho ${bingxApiSymbol} (Funding Rate). Status: ${res.status}. Raw: ${errorText}.`;
                        try {
                            const errorJson = JSON.parse(errorText);
                            if (errorJson.code === 100413) {
                                errorMessage = `Lỗi xác thực API (Incorrect apiKey) cho ${bingxApiSymbol} (Funding Rate). Vui lòng kiểm tra lại API Key/Secret của BingX. Chi tiết: ${errorJson.msg}.`;
                            } else if (errorJson.code === 109400) {
                                errorMessage = `Symbol không tồn tại trên BingX cho ${bingxApiSymbol} (Funding Rate). Chi tiết: ${errorJson.msg}.`;
                            }
                        } catch (parseError) { /* ignore parse error */ }
                        console.error(`[DATA] ❌ BINGX: ${errorMessage}`);
                        await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS)); continue;
                    }
                    const json = await res.json();

                    if (json && json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
                        json.data.sort((a, b) => b.fundingTime - a.fundingTime);
                        const latestData = json.data[0];

                        const fundingRate = parseFloat(latestData.fundingRate);
                        const fundingTimestamp = parseInt(latestData.fundingTime, 10);

                        if (!isNaN(fundingRate) && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                            processedDataMap.set(cleanS, { symbol: cleanS, fundingRate: fundingRate, fundingTimestamp: fundingTimestamp });
                        }
                    } else if (json && json.code === 0 && json.data === null) {
                        // Không có dữ liệu funding rate cho symbol này, không phải lỗi
                    } else {
                        console.warn(`[DATA] ⚠️ BINGX: Lỗi hoặc dữ liệu không hợp lệ từ /quote/fundingRate cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                    }
                } catch (e) {
                    console.error(`[DATA] ❌ BINGX: Lỗi khi lấy funding rate cho ${bingxApiSymbol}: ${e.message}.`);
                }
                await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
            }
            return Array.from(processedDataMap.values());
        } catch (e) {
            reject(new Error(`Lỗi tổng quát khi lấy API BingX Funding Rate: ${e.message}.`));
        }
    });
}

// Hàm tính toán thời gian funding tiêu chuẩn nếu không có từ API
function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);
    const nextFundingDate = new Date(now);
    if (nextHourUTC === undefined) { nextHourUTC = fundingHoursUTC[0]; nextFundingDate.setUTCDate(now.getUTCDate() + 1); }
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
    return nextFundingDate.getTime();
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
    
    // Ưu tiên cập nhật leverage cache trước
    await initializeLeverageCache(); 

    // Lấy dữ liệu funding rate từ tất cả các sàn. Sử dụng Promise.allSettled để không bị chặn bởi lỗi
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData; 

    // Tính toán cơ hội arbitrage
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
            }
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
