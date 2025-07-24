const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');

const PORT = 5001;

const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;
const FUNDING_HISTORY_FULL_REFRESH_INTERVAL_MINUTES = 10;
const FUNDING_HISTORY_CACHE_TTL_MINUTES = 60;

const binanceApiKey = '2rgsf5oYto2HaBS05DS7u4QVtDHf5uxQjEpZiP6eSMUlQRYb194XdE82zZy0Yujq'; // ĐẢM BẢO ĐÂY LÀ KEY THẬT CỦA BẠN
const binanceApiSecret = 'jnCGekaD5XWm8i48LIAQZpq5pFtBmZ3ZyYR4sK3UW4PoZlgPVCMrljk8DCFa9Xk'; // ĐẢM BẢO ĐÂY LÀ SECRET THẬT CỦA BẠN
const bingxApiKey = 'vvmD6sdV12c382zUvGMWUnD1yWi1ti8TCFsGaiEIlH6kGTHzkmPdeJQCuUQivXKAPrsEcfOvgwge9aAQ'; // ĐẢM BẢO ĐÂY LÀ KEY THẬT CỦA BẠN
const bingxApiSecret = '1o30hXOVTsZ6o40JixrGPfTCvHaqFTutSEpGAyjqbmGt7p9RsVqGUKXHHItsOz174ncfQ9YWStvGIs3Oeb3Pg'; // ĐẢM BẢO ĐÂY LÀ SECRET THẬT CỦA BẠN
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';

let leverageCache = {};
let fundingHistoryCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let lastFullFundingHistoryRefreshTime = 0;

const publicExchanges = {};
const privateExchanges = {};

EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    publicExchanges[id] = new exchangeClass({ 'options': { 'defaultType': 'swap' } });

    const config = { 'options': { 'defaultType': 'swap' } };
    let hasKey = false;
    if (id === 'binanceusdm' && binanceApiKey) { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; hasKey = true; }
    else if (id === 'bingx' && bingxApiKey) { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; hasKey = true; }
    else if (id === 'okx' && okxApiKey) { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; hasKey = true; }
    else if (id === 'bitget' && bitgetApiKey) { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; hasKey = true; }

    if (hasKey) {
        privateExchanges[id] = new exchangeClass(config);
        console.log(`[AUTH] Đã cấu hình HMAC cho ${id.toUpperCase()}.`);
    } else {
        // Nếu không có key, vẫn khởi tạo để tránh lỗi, nhưng nó sẽ chỉ dùng public API nếu có thể
        privateExchanges[id] = publicExchanges[id]; 
        console.warn(`[AUTH] ⚠️ Không có API Key/Secret cho ${id.toUpperCase()}. Không thể lấy đòn bẩy bằng private API.`);
    }
});

const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

function signBingX(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function getBinanceLeverage(exchange) {
    let leverages = {};
    try {
        let markets = [];
        try {
            await exchange.loadMarkets(true);
            markets = Object.values(exchange.markets).filter(m => m.swap && m.quote === 'USDT');
            if (markets.length === 0) {
                console.warn(`[CACHE] ⚠️ BINANCEUSDM: loadMarkets đã trả về 0 thị trường USDT Swap. Vui lòng kiểm tra kết nối hoặc API Key/quyền.`);
                return {};
            } else {
                console.log(`[CACHE] BINANCEUSDM: Đã tải ${markets.length} thị trường USDT Swap.`);
            }
        } catch (e) {
            console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi tải thị trường (loadMarkets): ${e.message}. Vui lòng kiểm tra API Key và quyền.`);
            return {};
        }

        for (const market of markets) {
            const originalSymbol = market.symbol;
            const cleanS = cleanSymbol(originalSymbol);
            try {
                const bracketInfo = await exchange.fetchLeverageBracket(originalSymbol);
                
                // Bật debug cho tất cả các symbol để thấy lý do null/invalid
                console.log(`[DEBUG] BINANCEUSDM: Raw leverageBracket for ${originalSymbol}:`, JSON.stringify(bracketInfo, null, 2));
                
                let initialLeverageValue = null;
                if (bracketInfo && Array.isArray(bracketInfo) && bracketInfo.length > 0 && 
                    bracketInfo[0].brackets && Array.isArray(bracketInfo[0].brackets) && bracketInfo[0].brackets.length > 0) {
                    
                    const rawLeverage = bracketInfo[0].brackets[0].initialLeverage;
                    const parsedLeverage = parseFloat(rawLeverage);

                    if (!isNaN(parsedLeverage) && parsedLeverage > 0) {
                        initialLeverageValue = parsedLeverage;
                    } else {
                        console.warn(`[CACHE] ⚠️ Binance: initialLeverage cho ${originalSymbol} là '${rawLeverage}' (đã parse: ${parsedLeverage}), không phải số hợp lệ (> 0).`);
                    }
                } else {
                    console.warn(`[CACHE] ⚠️ Binance: Cấu trúc phản hồi fetchLeverageBracket cho ${originalSymbol} không như mong đợi hoặc không có bracket đầu tiên.`);
                }
                
                leverages[cleanS] = initialLeverageValue;

            } catch (e) {
                console.error(`[CACHE] ❌ Binance: Lỗi khi lấy đòn bẩy cho ${originalSymbol} bằng fetchLeverageBracket: ${e.message}.`);
                leverages[cleanS] = null;
            }
        }
        return leverages;
    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINANCEUSDM: ${e.message}.`);
        return {};
    }
}

async function getBingXLeverageFromTradeAPI(exchange) {
    console.log('[DEBUG] BINGX: Đang cố gắng lấy đòn bẩy bằng REST API trực tiếp /swap/v2/trade/leverage (từng symbol)...');
    const leverages = {};
    if (!bingxApiKey || !bingxApiSecret) {
        console.error('[CACHE] ❌ BINGX: Thiếu API Key hoặc Secret để lấy đòn bẩy qua API /trade/leverage.');
        return {};
    }

    try {
        let markets = [];
        try {
            await exchange.loadMarkets(true);
            markets = Object.values(exchange.markets).filter(m => m.swap && m.quote === 'USDT');
            if (markets.length === 0) {
                console.warn(`[CACHE] ⚠️ BINGX: loadMarkets đã trả về 0 thị trường USDT Swap. Vui lòng kiểm tra kết nối hoặc API Key/quyền.`);
                return {};
            } else {
                console.log(`[CACHE] BINGX: Đã tải ${markets.length} thị trường USDT Swap.`);
            }
        } catch (e) {
            console.error(`[CACHE] ❌ BINGX: Lỗi khi tải thị trường (loadMarkets): ${e.message}. Vui lòng kiểm tra API Key và quyền.`);
            return {};
        }

        const BINGX_REQUEST_DELAY_MS = 100;
        for (const market of markets) {
            const originalSymbol = market.symbol;
            const cleanS = cleanSymbol(originalSymbol);

            try {
                const timestamp = Date.now().toString();
                const recvWindow = "5000";
                const queryString = `recvWindow=${recvWindow}×tamp=${timestamp}&symbol=${originalSymbol}`;
                const signature = signBingX(queryString, bingxApiSecret);

                const url = `https://open-api.bingx.com/openApi/swap/v2/trade/leverage?${queryString}&signature=${signature}`;
                
                const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });
                const json = await res.json();

                // Bật debug cho tất cả các symbol
                console.log(`[DEBUG] BINGX API Call URL: ${url}`);
                console.log(`[DEBUG] BINGX Raw response for ${originalSymbol} from /trade/leverage:`, JSON.stringify(json, null, 2));

                let maxLeverageFound = null;
                if (json && json.code === 0 && json.data) {
                    const longLev = parseFloat(json.data.longLeverage);
                    const shortLev = parseFloat(json.data.shortLeverage);

                    if (!isNaN(longLev) && !isNaN(shortLev) && (longLev > 0 || shortLev > 0)) {
                        maxLeverageFound = Math.max(longLev, shortLev);
                    } else {
                        console.warn(`[CACHE] ⚠️ BINGX: Dữ liệu đòn bẩy (longLeverage: '${json.data.longLeverage}', shortLeverage: '${json.data.shortLeverage}') cho ${originalSymbol} không phải số hoặc bằng 0.`);
                    }
                } else {
                    console.warn(`[CACHE] ⚠️ BINGX: Phản hồi API không thành công hoặc không có trường 'data' cho ${originalSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                }
                leverages[cleanS] = maxLeverageFound;

            } catch (e) {
                console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy đòn bẩy cho ${originalSymbol} từ /trade/leverage: ${e.message}`);
                leverages[cleanS] = null;
            }
            await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
        }
        console.log(`[DEBUG] BINGX: Đã lấy thành công ${Object.values(leverages).filter(v => v !== null && v > 0).length} đòn bẩy qua REST API /trade/leverage.`);
        return leverages;

    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINGX: ${e.message}`);
        return {};
    }
}

async function getGenericLeverage(exchange) {
    try {
        let markets = [];
        try {
            await exchange.loadMarkets(true);
            markets = Object.values(exchange.markets).filter(m => m.swap && m.quote === 'USDT');
            if (markets.length === 0) {
                console.warn(`[CACHE] ⚠️ ${exchange.id.toUpperCase()}: loadMarkets đã trả về 0 thị trường USDT Swap. Vui lòng kiểm tra kết nối hoặc API Key/quyền.`);
                return {};
            } else {
                console.log(`[CACHE] ${exchange.id.toUpperCase()}: Đã tải ${markets.length} thị trường USDT Swap.`);
            }
        } catch (e) {
            console.error(`[CACHE] ❌ ${exchange.id.toUpperCase()}: Lỗi khi tải thị trường (loadMarkets): ${e.message}. Vui lòng kiểm tra API Key và quyền.`);
            return {};
        }

        const leverages = {};
        for (const market of markets) {
            const symbol = cleanSymbol(market.symbol);
            let maxLeverageFound = null;

            let rawMaxLevInfo = market?.info?.maxLeverage;
            let parsedMaxLevInfo = !isNaN(parseFloat(rawMaxLevInfo)) ? parseFloat(rawMaxLevInfo) : null;

            let rawMaxLevLimits = market?.limits?.leverage?.max;
            let parsedMaxLevLimits = !isNaN(parseFloat(rawMaxLevLimits)) ? parseFloat(rawMaxLevLimits) : null;
            
            if (parsedMaxLevInfo !== null && parsedMaxLevInfo > 0) {
                maxLeverageFound = parsedMaxLevInfo;
            } else if (parsedMaxLevLimits !== null && parsedMaxLevLimits > 0) {
                maxLeverageFound = parsedMaxLevLimits;
            } else {
                console.warn(`[CACHE] ⚠️ ${exchange.id.toUpperCase()}: Không tìm thấy maxLeverage là số (> 0) cho ${symbol}.`);
                console.warn(`  - market.info.maxLeverage: '${rawMaxLevInfo}' (parsed: ${parsedMaxLevInfo})`);
                console.warn(`  - market.limits.leverage.max: '${rawMaxLevLimits}' (parsed: ${parsedMaxLevLimits})`);
            }
            
            leverages[symbol] = maxLeverageFound;
        }
        return leverages;
    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi khi lấy đòn bẩy chung cho ${exchange.id.toUpperCase()}: ${e.message}. Vui lòng kiểm tra API Key và quyền.`);
        return {};
    }
}

async function initializeLeverageCache() {
    console.log('[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy... (Bản sửa lỗi số 26)');
    const newCache = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        const exchange = privateExchanges[id];
        try {
            let leverages = {};
            if (id === 'binanceusdm') {
                leverages = await getBinanceLeverage(exchange);
                const count = Object.values(leverages).filter(v => v !== null && v > 0).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy.`);
            } else if (id === 'bingx') {
                leverages = await getBingXLeverageFromTradeAPI(exchange);
                const count = Object.values(leverages).filter(v => v !== null && v > 0).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy.`);
            }
            else {
                leverages = await getGenericLeverage(exchange);
                const count = Object.values(leverages).filter(v => v !== null && v > 0).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy.`);
            }
            newCache[id] = leverages;
        } catch (e) {
            console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}`);
            newCache[id] = {};
        }
    }));
    leverageCache = newCache;
    console.log('[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.');
}

async function calculateNextFundingTimeFromHistory(exchange, symbol) {
    const cacheKey = `${exchange.id}_${symbol}`;
    const cachedEntry = fundingHistoryCache[cacheKey];

    if (cachedEntry && Date.now() < cachedEntry.timestamp + FUNDING_HISTORY_CACHE_TTL_MINUTES * 60 * 1000) {
        return cachedEntry.nextFundingTime;
    }

    try {
        // Đảm bảo markets đã được tải trước khi gọi fetchFundingRateHistory nếu cần
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            await exchange.loadMarkets(true);
        }
        const originalSymbolForExchange = Object.values(exchange.markets).find(m => cleanSymbol(m.symbol) === symbol)?.symbol || symbol;
        if (!originalSymbolForExchange) {
            // console.warn(`[FUNDING_HISTORY] Không tìm thấy originalSymbol cho ${exchange.id.toUpperCase()} ${symbol}.`);
            return null;
        }

        const history = await exchange.fetchFundingRateHistory(originalSymbolForExchange, undefined, undefined, 20);
        if (!history || history.length < 2) {
            return null;
        }

        history.sort((a, b) => a.timestamp - b.timestamp);

        let inferredInterval = null;
        for (let i = history.length - 1; i >= 1; i--) {
            const diff = history[i].timestamp - history[i-1].timestamp;
            if (diff > 3600000 && diff < 86400000) { 
                inferredInterval = diff;
                break;
            }
        }

        if (!inferredInterval) {
            return null;
        }

        const lastFundingTime = history[history.length - 1].timestamp;
        let nextPredictedFundingTime = lastFundingTime + inferredInterval;

        while (nextPredictedFundingTime < Date.now()) {
            nextPredictedFundingTime += inferredInterval;
        }
        
        fundingHistoryCache[cacheKey] = {
            timestamp: Date.now(),
            nextFundingTime: nextPredictedFundingTime
        };
        return nextPredictedFundingTime;

    } catch (e) {
        return null;
    }
}

function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h) ?? fundingHoursUTC[0];
    const nextFundingDate = new Date(now);
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
    
    if(now.getUTCHours() >= fundingHoursUTC[fundingHoursUTC.length - 1] && now.getUTCHours() >= nextHourUTC) {
        nextFundingDate.setUTCDate(now.getUTCDate() + 1);
    }
    return nextFundingDate.getTime();
}

async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const now = Date.now();
    const isFullHistoryRefreshDue = (now - lastFullFundingHistoryRefreshTime) > FUNDING_HISTORY_FULL_REFRESH_INTERVAL_MINUTES * 60 * 1000;
    
    if (isFullHistoryRefreshDue) {
        console.log(`[FUNDING_HISTORY] Bắt đầu làm mới đầy đủ lịch sử funding (tất cả symbols)...`);
        lastFullFundingHistoryRefreshTime = now;
    }

    const results = await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = publicExchanges[id];
            const fundingRatesRaw = await exchange.fetchFundingRates();
            const processedRates = {};
            
            for (const rate of Object.values(fundingRatesRaw)) {
                const originalSymbol = rate.symbol;
                const cleanS = cleanSymbol(originalSymbol);
                const maxLeverage = leverageCache[id]?.[cleanS] || null;

                let fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime;

                if ((id === 'bingx' || id === 'bitget') && (!fundingTimestamp || fundingTimestamp === 0 || isFullHistoryRefreshDue)) {
                    const historicalFundingTime = await calculateNextFundingTimeFromHistory(exchange, cleanS);
                    if (historicalFundingTime) {
                        fundingTimestamp = historicalFundingTime;
                    } else {
                        fundingTimestamp = calculateNextStandardFundingTime();
                    }
                } else if (!fundingTimestamp || fundingTimestamp === 0) {
                    fundingTimestamp = calculateNextStandardFundingTime();
                }

                processedRates[cleanS] = {
                    symbol: cleanS,
                    fundingRate: rate.fundingRate,
                    fundingTimestamp: fundingTimestamp,
                    maxLeverage: maxLeverage
                };
            }
            return { id, status: 'success', rates: processedRates };
        } catch (e) {
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) {
                console.error(`- Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}`);
            }
            return { id, status: 'error', rates: {} };
        }
    }));
    results.forEach(result => { if (result.status === 'success') { freshData[result.id] = { rates: result.rates }; }});
    return freshData;
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
                    shortExchange = exchange1Id; shortRate = rate1Data;
                    longExchange = exchange2Id; longRate = rate2Data;
                } else {
                    shortExchange = exchange2Id; shortRate = rate2Data;
                    longExchange = exchange1Id; longRate = rate1Data;
                }

                const fundingDiff = shortRate.fundingRate - longRate.fundingRate;
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
                        commonLeverage: commonLeverage,
                        estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
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
    console.log(`[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()}...`);
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData;
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP]   => Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
    scheduleNextLoop();
}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId);
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    let delay = (60 - seconds) * 1000;
    let nextRunReason = "Lịch trình mặc định (đầu phút tiếp theo)";

    if (minutes === 59 && seconds < 30) {
        delay = (30 - seconds) * 1000;
        nextRunReason = `Cập nhật cường độ cao lúc ${minutes}:30`;
    }
    else if (minutes >= 55 && minutes < 59) {
        delay = ((58 - minutes) * 60 + (60 - seconds)) * 1000;
        nextRunReason = `Chuẩn bị cho cập nhật lúc 59:00`;
    }
    console.log(`[SCHEDULER] ${nextRunReason}. Vòng lặp kế tiếp sau ${(delay / 1000).toFixed(1)} giây.`);
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
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi số 26) đang chạy tại http://localhost:${PORT}`);
    await initializeLeverageCache();
    await masterLoop();
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
