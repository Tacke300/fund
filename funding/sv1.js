// sv1.js (BẢN SỬA LỖI SỐ 200)

const http = require('http'); 
const https = require('https'); 
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const Binance = require('node-binance-api');

const PORT = 5001;

// CẤU HÌNH
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;
const FUNDING_HISTORY_FULL_REFRESH_INTERVAL_MINUTES = 10; 
const FUNDING_HISTORY_CACHE_TTL_MINUTES = 60; 

// QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88TzvmC3SpT9nEf4fcDf0pEnFzoTc';
const bingxApiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const bingxApiSecret = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOXPVWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';


// BIẾN TOÀN CỤC
let leverageCache = {};
let fundingHistoryCache = {}; 
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let lastFullFundingHistoryRefreshTime = 0; 

const binanceClient = new Binance().options({
    APIKEY: binanceApiKey,
    APISECRET: binanceApiSecret
});

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = { 'options': { 'defaultType': 'swap' } }; 

    if (id === 'binanceusdm' && binanceApiKey && binanceApiSecret) { 
        config.apiKey = binanceApiKey; config.secret = binanceApiSecret; 
    } else if (id === 'bingx' && bingxApiKey && bingxApiSecret) { 
        config.apiKey = bingxApiKey; config.secret = bingxApiSecret; 
    } else if (id === 'okx' && okxApiKey && okxApiSecret) { 
        config.apiKey = okxApiKey; config.secret = okxApiSecret; 
        if(okxPassword) config.password = okxPassword; 
    } else if (id === 'bitget' && bitgetApiKey && bitgetApiSecret) { 
        config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; 
        if(bitgetApiPassword) config.password = bitgetApiPassword; 
    } else {
        console.warn(`[AUTH] ⚠️ Không có API Key/Secret hoặc thiếu cho ${id.toUpperCase()}. Sẽ chỉ dùng public API nếu có thể.`);
    }
    
    if (!exchanges[id]) { 
        exchanges[id] = new exchangeClass(config);
    }
});


const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

const formatBingXApiSymbol = (ccxtSymbol) => {
    let base = ccxtSymbol
        .replace(/\/USDT/g, '')     
        .replace(/:USDT/g, '')      
        .replace(/\/USDC/g, '')     
        .replace(/:USDC/g, '')      
        .replace(/-USDT$/g, '')     
        .replace(/-USDC$/g, '');    

    return `${base.toUpperCase()}-USDT`;
};


function signBingX(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function getBinanceLeverageDirectAPI() {
    let leverages = {};
    try {
        const leverageInfo = await binanceClient.futuresLeverageBracket(); 

        if (!leverageInfo || !Array.isArray(leverageInfo)) {
            console.warn(`[CACHE] ⚠️ BINANCEUSDM: futuresLeverageBracket không trả về dữ liệu hợp lệ (không phải mảng).`);
            return {};
        }

        leverageInfo.forEach(info => {
            const originalSymbol = info.symbol;
            const cleanS = cleanSymbol(originalSymbol);
            if (info.brackets && info.brackets.length > 0) {
                const rawLeverage = info.brackets[0].initialLeverage;
                const parsedLeverage = parseFloat(rawLeverage);
                if (!isNaN(parsedLeverage) && parsedLeverage > 0) {
                    leverages[cleanS] = parsedLeverage;
                } else {
                    console.warn(`[CACHE] ⚠️ BINANCEUSDM: Đòn bẩy không hợp lệ cho ${originalSymbol}: '${rawLeverage}' (parse: ${parsedLeverage})`);
                }
            } else {
                console.warn(`[CACHE] ⚠️ BINANCEUSDM: Không có thông tin bracket cho ${originalSymbol}.`);
            }
        });
        return leverages;

    } catch (e) {
        console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy đòn bẩy bằng node-binance-api: ${e.message}. VUI LÒNG KIỂM TRA QUYỀN HẠN API (ENABLE FUTURES) VÀ IP WHITELIST CỦA BẠN TRÊN BINANCE.`);
        return {};
    }
}

async function getBingXLeverageDirectAPI() {
    const leverages = {};
    if (!bingxApiKey || !bingxApiSecret) {
        console.error('[CACHE] ❌ BINGX: Thiếu API Key hoặc Secret để lấy đòn bẩy qua API /trade/leverage.');
        return {};
    }

    try {
        const bingxCCXT = exchanges['bingx']; 
        await bingxCCXT.loadMarkets(true);
        const markets = Object.values(bingxCCXT.markets).filter(m => m.swap && m.quote === 'USDT');

        if (markets.length === 0) {
            console.warn(`[CACHE] ⚠️ BINGX: loadMarkets trả về 0 thị trường USDT Swap. Không thể lấy đòn bẩy.`);
            return {};
        }

        const BINGX_REQUEST_DELAY_MS = 100; 
        for (const market of markets) {
            const ccxtSymbol = market.symbol; 
            const cleanS = cleanSymbol(ccxtSymbol); 
            const bingxApiSymbol = formatBingXApiSymbol(ccxtSymbol); 

            try {
                const timestamp = Date.now().toString(); 
                const recvWindow = "5000"; 
                
                const queryString = `recvWindow=${recvWindow}&symbol=${bingxApiSymbol}×tamp=${timestamp}`;
                const signature = signBingX(queryString, bingxApiSecret);

                const url = `https://open-api.bingx.com/openApi/swap/v2/trade/leverage?${queryString}&signature=${signature}`;
                
                const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });
                const json = await res.json();

                let maxLeverageFound = null;
                if (json && json.code === 0 && json.data) {
                    const longLev = parseFloat(json.data.maxLongLeverage); 
                    const shortLev = parseFloat(json.data.maxShortLeverage); 

                    if (!isNaN(longLev) && !isNaN(shortLev) && (longLev > 0 || shortLev > 0)) {
                        maxLeverageFound = Math.max(longLev, shortLev);
                    } else {
                        console.warn(`[CACHE] ⚠️ BINGX: Dữ liệu đòn bẩy (maxLongLeverage: '${json.data.maxLongLeverage}', maxShortLeverage: '${json.data.maxShortLeverage}') cho ${bingxApiSymbol} không phải số hoặc bằng 0.`);
                    }
                } else {
                    console.warn(`[CACHE] ⚠️ BINGX: Phản hồi API không thành công hoặc không có trường 'data' cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                }
                leverages[cleanS] = maxLeverageFound;

            } catch (e) {
                console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy đòn bẩy cho ${bingxApiSymbol} từ /trade/leverage: ${e.message}. VUI LÒNG KIỂM TRA API KEY VÀ SECRET CÓ ĐÚNG KHÔNG VÀ ĐÃ CẤP QUYỀN "PERPETUAL FUTURES" CHƯA.`);
                leverages[cleanS] = null;
            }
            await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
        }
        return leverages;

    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINGX: ${e.message}. VUI LÒNG KIỂM TRA API KEY BINGX.`);
        return {};
    }
}

function getMaxLeverageFromMarketInfo(market, exchangeId) {
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) return market.limits.leverage.max;
    if (typeof market?.info === 'object' && market.info !== null) { 
        for (const key in market.info) { 
            if (key.toLowerCase().includes('leverage')) { 
                const value = market.info[key]; 
                const leverage = parseInt(value, 10); 
                if (!isNaN(leverage) && leverage > 1) return leverage; 
            } 
        } 
    }
    return null;
}

async function initializeLeverageCache() {
    const newCache = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id]; 
        newCache[id] = {};
        try {
            if (id === 'binanceusdm') {
                const leverages = await getBinanceLeverageDirectAPI();
                newCache[id] = leverages;
            } else if (id === 'bingx') {
                const leverages = await getBingXLeverageDirectAPI();
                newCache[id] = leverages;
            }
            else if (exchange.has['fetchLeverageTiers']) { 
                const leverageTiers = await exchange.fetchLeverageTiers();
                for (const symbol in leverageTiers) {
                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        const maxLeverage = Math.max(...tiers.map(t => t.leverage));
                        const parsedMaxLeverage = parseInt(maxLeverage, 10);
                        if (!isNaN(parsedMaxLeverage) && parsedMaxLeverage > 0) {
                            newCache[id][cleanSymbol(symbol)] = parsedMaxLeverage;
                        }
                    }
                }
            } else { 
                await exchange.loadMarkets(true);
                for (const market of Object.values(exchange.markets)) {
                    if (market.swap && market.quote === 'USDT') {
                        const symbol = cleanSymbol(market.symbol);
                        const maxLeverage = getMaxLeverageFromMarketInfo(market, id);
                        newCache[id][symbol] = maxLeverage;
                    }
                }
            }
        } catch (e) { 
            console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}. VUI LÒNG KIỂM TRA API KEY, SECRET VÀ PASSPHRASE CỦA OKX/BITGET, VÀ ĐỒNG BỘ THỜI GIAN SERVER.`); 
            newCache[id] = {}; 
        }
    }));
    leverageCache = newCache;
}

async function getBinanceFundingRatesDirectAPI() {
    try {
        const fundingRatesRaw = await binanceClient.futuresFundingRate();
        
        if (!Array.isArray(fundingRatesRaw)) {
            console.warn(`[CACHE] ⚠️ BINANCEUSDM: futuresFundingRate không trả về mảng.`);
            return [];
        }

        const filteredData = fundingRatesRaw.map(item => ({
            symbol: item.symbol,
            fundingRate: parseFloat(item.fundingRate), 
            fundingTimestamp: item.fundingTime 
        })).filter(item => 
            item.symbol.endsWith('USDT') && 
            !isNaN(item.fundingRate) && 
            typeof item.fundingTimestamp === 'number' &&
            item.fundingTimestamp > 0
        );
        return filteredData;

    } catch (e) {
        console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy funding rates bằng node-binance-api: ${e.message}. VUI LÒNG KIỂM TRA IP WHITELIST CỦA BẠN TRÊN BINANCE.`);
        return [];
    }
}

function getBingXFundingRatesDirectAPI() {
    return new Promise(async (resolve, reject) => {
        if (!bingxApiKey) { 
            console.error('[CACHE] ❌ BINGX: Thiếu API Key để lấy funding rate qua API.');
            return reject(new Error('Thiếu API Key cho BingX.'));
        }

        try {
            const bingxCCXT = exchanges['bingx']; 
            await bingxCCXT.loadMarkets(true); 
            const markets = Object.values(bingxCCXT.markets).filter(m => m.swap && m.quote === 'USDT');

            if (markets.length === 0) {
                console.warn(`[CACHE] ⚠️ BINGX: loadMarkets trả về 0 thị trường USDT Swap. Không thể lấy funding rate.`);
                return resolve([]); 
            }

            const BINGX_REQUEST_DELAY_MS = 100;
            const processedData = [];

            for (const market of markets) {
                const ccxtSymbol = market.symbol; 
                const cleanS = cleanSymbol(ccxtSymbol); 
                const bingxApiSymbol = formatBingXApiSymbol(ccxtSymbol); 

                const url = `https://open-api.bingx.com/openApi/swap/v2/quote/fundingRate?symbol=${bingxApiSymbol}`;
                
                try {
                    const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });
                    const json = await res.json();

                    if (json && json.code === 0 && json.data) {
                        const fundingRate = parseFloat(json.data.fundingRate);
                        const fundingTimestamp = parseInt(json.data.nextFundingTime, 10);
                        if (!isNaN(fundingRate) && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                            processedData.push({
                                symbol: cleanS, 
                                fundingRate: fundingRate,
                                fundingTimestamp: fundingTimestamp
                            });
                        } else {
                            console.warn(`[CACHE] ⚠️ BINGX: Funding rate hoặc timestamp không hợp lệ cho ${bingxApiSymbol}. Data: ${JSON.stringify(json.data)}`);
                        }
                    } else {
                        console.warn(`[CACHE] ⚠️ BINGX: Lỗi hoặc dữ liệu không hợp lệ từ /quote/fundingRate cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                    }
                } catch (e) {
                    console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy funding rate cho ${bingxApiSymbol} từ /quote/fundingRate: ${e.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS)); 
            }
            resolve(processedData);

        } catch (e) {
            reject(new Error(`Lỗi tổng quát khi lấy API BingX Funding Rate: ${e.message}. VUI LÒNG KIỂM TRA API KEY BINGX.`));
        }
    });
}


async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id]; 
            let fundingRatesRaw;
            let processedRates = {};

            if (id === 'binanceusdm') {
                fundingRatesRaw = await getBinanceFundingRatesDirectAPI();
                for (const item of fundingRatesRaw) {
                    processedRates[cleanSymbol(item.symbol)] = {
                        symbol: cleanSymbol(item.symbol),
                        fundingRate: parseFloat(item.fundingRate), 
                        fundingTimestamp: item.fundingTimestamp,
                        maxLeverage: leverageCache[id]?.[cleanSymbol(item.symbol)] || null 
                    };
                }
            } else if (id === 'bingx') {
                fundingRatesRaw = await getBingXFundingRatesDirectAPI();
                for (const item of fundingRatesRaw) {
                    processedRates[item.symbol] = { 
                        symbol: item.symbol,
                        fundingRate: item.fundingRate,
                        fundingTimestamp: item.fundingTimestamp,
                        maxLeverage: leverageCache[id]?.[item.symbol] || null
                    };
                }
            }
            else { 
                fundingRatesRaw = await exchange.fetchFundingRates();
                for (const rate of Object.values(fundingRatesRaw)) {
                    const symbol = cleanSymbol(rate.symbol);
                    const maxLeverage = leverageCache[id]?.[symbol] || null;
                    
                    const fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();

                    processedRates[symbol] = {
                        symbol: symbol,
                        fundingRate: rate.fundingRate,
                        fundingTimestamp: fundingTimestamp,
                        maxLeverage: maxLeverage
                    };
                }
            }
            return { id, status: 'success', rates: processedRates };
        } catch (e) {
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) { 
                console.error(`- Lỗi nghiêm trọng khi lấy funding từ ${id.toUpperCase()}: ${e.message}`); 
            }
            return { id, status: 'error', rates: {} };
        }
    })).then(results => {
        results.forEach(result => { if (result.status === 'success') { freshData[result.id] = { rates: result.rates }; }});
    });
    return freshData;
}

function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h) ?? fundingHoursUTC[0];
    const nextFundingDate = new Date(now);
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
    if(now.getUTCHours() >= fundingHoursUTC[fundingHoursUTC.length - 1]) {
        nextFundingDate.setUTCDate(now.getUTCDate() + 1);
    }
    return nextFundingDate.getTime();
}


function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));
    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;
            if (!exchange1Rates || !exchange2Rates) continue;
            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);
            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol], rate2Data = exchange2Rates[symbol];
                if (typeof rate1Data.maxLeverage !== 'number' || rate1Data.maxLeverage <= 0 ||
                    typeof rate2Data.maxLeverage !== 'number' || rate2Data.maxLeverage <= 0) {
                    continue; 
                }
                
                if (!rate1Data.fundingTimestamp || !rate2Data.fundingTimestamp) continue;

                let longExchange, shortExchange, longRate, shortRate;
                if (rate1Data.fundingRate > rate2Data.fundingRate) {
                    shortExchange = exchange1Id; shortRate = rate1Data; longExchange = exchange2Id; longRate = rate2Data;
                } else {
                    shortExchange = exchange2Id; shortRate = rate2Data; longExchange = exchange1Id; longRate = rate1Data;
                }
                const fundingDiff = shortRate.fundingRate - longRate.fundingRate;
                const commonLeverage = Math.min(longRate.maxLeverage, shortRate.maxLeverage);
                const estimatedPnl = fundingDiff * commonLeverage * 100;
                if (estimatedPnl >= MINIMUM_PNL_THRESHOLD) {
                    const finalFundingTime = Math.max(rate1Data.fundingTimestamp, rate2Data.fundingTimestamp);

                    const minutesUntilFunding = (finalFundingTime - Date.now()) / (1000 * 60);
                    const isImminent = minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES;
                    allFoundOpportunities.push({
                        coin: symbol, exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                        fundingDiff: parseFloat(fundingDiff.toFixed(6)), nextFundingTime: finalFundingTime,
                        commonLeverage: commonLeverage, estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                        isImminent: isImminent,
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
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData; 
    
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    scheduleNextLoop();
}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId);
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    let delay = (60 - seconds) * 1000;
    
    // Schedule more frequent updates around the top of the hour for criticality
    if (minutes === 59 && seconds < 30) {
        delay = (30 - seconds) * 1000; // Run at XX:59:30
    }
    else if (minutes >= 55 && minutes < 59) {
        delay = ((58 - minutes) * 60 + (60 - seconds)) * 1000; // Run at XX:59:00
    }
    loopTimeoutId = setTimeout(masterLoop, delay);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); res.end('Lỗi index.html'); return; }
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

server.listen(PORT, () => {
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi số 200) đang chạy tại http://localhost:${PORT}`);
    // Khởi tạo và chạy vòng lặp cập nhật dữ liệu mà không chặn quá trình khởi động server
    (async () => {
        await initializeLeverageCache();
        await masterLoop(); // Lần chạy đầu tiên sẽ tự động lên lịch cho các lần sau
    })();
    // Lên lịch làm mới bộ nhớ đệm đòn bẩy định kỳ
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
