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
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88TzvmC3SpT9nEf4fcDf0pEnFzoTc';
const bingxApiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const bingxApiSecret = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';
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
    else { console.warn(`[AUTH] ⚠️ Không có API Key/Secret hoặc thiếu cho ${id.toUpperCase()}. Sẽ chỉ dùng public API nếu có thể.`); }

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
async function getBinanceLeverageDirectAPI() {
    let leverages = {};
    try {
        const leverageInfo = await binanceClient.futuresLeverageBracket();
        if (!Array.isArray(leverageInfo)) { console.warn(`[CACHE] ⚠️ BINANCEUSDM: futuresLeverageBracket không trả về dữ liệu hợp lệ (không phải mảng).`); return {}; }
        leverageInfo.forEach(info => {
            const cleanS = cleanSymbol(info.symbol);
            if (info.brackets && info.brackets.length > 0) {
                const parsedLeverage = parseFloat(info.brackets[0].initialLeverage);
                if (!isNaN(parsedLeverage) && parsedLeverage > 0) leverages[cleanS] = parsedLeverage;
                else console.warn(`[CACHE] ⚠️ BINANCEUSDM: Đòn bẩy không hợp lệ cho ${info.symbol}: '${info.brackets[0].initialLeverage}' (parse: ${parsedLeverage})`);
            } else console.warn(`[CACHE] ⚠️ BINANCEUSDM: Không có thông tin bracket cho ${info.symbol}.`);
        });
        console.log(`[CACHE] ✅ BINANCEUSDM: Lấy thành công ${Object.values(leverages).filter(v => typeof v === 'number' && v > 0).length} đòn bẩy (Direct API).`);
        return leverages;
    } catch (e) {
        console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy đòn bẩy (Direct API): ${e.message}. VUI LÒNG KIỂM TRA QUYỀN HẠN API (ENABLE FUTURES) VÀ IP WHITELIST CỦA BẠN TRÊN BINANCE.`);
        return {};
    }
}

// === BINGX: LẤY ĐÒN BẨY BẰNG DIRECT API (fetch) ===
async function getBingXLeverageDirectAPI() {
    console.log('[DEBUG] BINGX: Đang cố gắng lấy đòn bẩy bằng REST API trực tiếp /swap/v2/trade/leverage...');
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
                // !!! LƯU Ý QUAN TRỌNG: DÒNG NÀY ĐÃ ĐƯỢC SỬA ĐÚNG CÚ PHÁP '×tamp=' TRONG CÁC BẢN TRƯỚC !!!
                // Nếu bạn vẫn thấy 'xtamp' trong log URL, vui lòng kiểm tra lại file code trên server của bạn.
                // Đảm bảo bạn đã dán/thay thế hoàn toàn bản code mới nhất.
                const queryString = `recvWindow=${recvWindow}&symbol=${bingxApiSymbol}×tamp=${timestamp}`; 
                const signature = signBingX(queryString, bingxApiSecret);
                const url = `https://open-api.bingx.com/openApi/swap/v2/trade/leverage?${queryString}&signature=${signature}`;

                console.log(`[DEBUG] BINGX API Call URL (Leverage): ${url}`);
                const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });

                if (!res.ok) {
                    const errorText = await res.text();
                    console.error(`[CACHE] ❌ BINGX: Phản hồi API không OK cho ${bingxApiSymbol} (Leverage). Status: ${res.status}, Raw: ${errorText}. VUI LÒNG KIỂM TRA API KEY, SECRET, QUYỀN HẠN (PERPETUAL FUTURES) VÀ ĐỒNG BỘ THỜI GIAN MÁY CHỦ.`);
                    leverages[cleanS] = null; continue;
                }
                const json = await res.json();
                console.log(`[DEBUG] BINGX Raw response for ${bingxApiSymbol} from /trade/leverage:`, JSON.stringify(json, null, 2));

                let maxLeverageFound = null;
                if (json && json.code === 0 && json.data) {
                    const longLev = parseFloat(json.data.maxLongLeverage);
                    const shortLev = parseFloat(json.data.maxShortLeverage);
                    if (!isNaN(longLev) && !isNaN(shortLev) && (longLev > 0 || shortLev > 0)) {
                        maxLeverageFound = Math.max(longLev, shortLev);
                    } else console.warn(`[CACHE] ⚠️ BINGX: Dữ liệu đòn bẩy không hợp lệ cho ${bingxApiSymbol}. Data: ${JSON.stringify(json.data)}`);
                } else console.warn(`[CACHE] ⚠️ BINGX: Phản hồi API không thành công hoặc không có 'data' cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                
                console.log(`[DEBUG] BINGX: Đã gán đòn bẩy cho ${cleanS}: Type: ${typeof maxLeverageFound}, Value: ${maxLeverageFound}.`);
                leverages[cleanS] = maxLeverageFound;
            } catch (e) {
                console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy đòn bẩy cho ${bingxApiSymbol} (Direct API): ${e.message}. Stack: ${e.stack}.`);
                leverages[cleanS] = null;
            }
            await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
        }
        console.log(`[CACHE] ✅ BINGX: Hoàn tất lấy đòn bẩy. Đã lấy thành công ${Object.values(leverages).filter(v => typeof v === 'number' && v > 0).length} đòn bẩy (Direct API).`);
        return leverages;
    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINGX (Direct API): ${e.message}. Stack: ${e.stack}.`);
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
                newCache[id] = await getBinanceLeverageDirectAPI(); // Binance: Direct API
            } else if (id === 'bingx') {
                newCache[id] = await getBingXLeverageDirectAPI(); // BingX: Direct API
            } else if (exchange.has['fetchLeverageTiers']) { // OKX & Bitget: Ưu tiên CCXT fetchLeverageTiers
                const leverageTiers = await exchange.fetchLeverageTiers();
                for (const symbol in leverageTiers) {
                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        const parsedMaxLeverage = parseInt(Math.max(...tiers.map(t => t.leverage)), 10);
                        if (!isNaN(parsedMaxLeverage) && parsedMaxLeverage > 0) {
                            newCache[id][cleanSymbol(symbol)] = parsedMaxLeverage;
                        } else console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ cho ${symbol} từ fetchLeverageTiers.`);
                    } else console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: 'fetchLeverageTiers' không có thông tin bậc đòn bẩy hợp lệ cho ${symbol}.`);
                }
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${Object.values(newCache[id]).filter(v => typeof v === 'number' && v > 0).length} đòn bẩy (CCXT fetchLeverageTiers).`);
            } else { // OKX & Bitget: Dự phòng CCXT loadMarkets
                await exchange.loadMarkets(true);
                for (const market of Object.values(exchange.markets)) {
                    if (market.swap && market.quote === 'USDT') {
                        const symbolCleaned = cleanSymbol(market.symbol);
                        const maxLeverage = getMaxLeverageFromMarketInfo(market, id);
                        newCache[id][symbolCleaned] = maxLeverage; 
                        if (maxLeverage !== null && maxLeverage > 0) {
                            // count++; 
                        } else {
                            console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} (Clean: ${symbolCleaned}). Dữ liệu Market (limits.leverage or info): ${JSON.stringify({ limits: market.limits?.leverage, info: market.info })}`);
                        }
                    }
                }
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${Object.values(newCache[id]).filter(v => typeof v === 'number' && v > 0).length} đòn bẩy (CCXT loadMarkets dự phòng).`);
            }
            return { id, status: 'fulfilled' };
        } catch (e) {
            console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}. Stack: ${e.stack}.`);
            newCache[id] = {}; 
            return { id, status: 'rejected', reason: e.message };
        }
    });
    // Sử dụng Promise.allSettled để tất cả các promise đều chạy xong, kể cả khi có lỗi
    await Promise.allSettled(promises);
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
}

// === BINANCE: LẤY FUNDING RATES VÀ NEXT FUNDING BẰNG DIRECT API (node-binance-api) ===
async function getBinanceFundingRatesDirectAPI() {
    try {
        const fundingRatesRaw = await binanceClient.futuresFundingRate();
        if (!Array.isArray(fundingRatesRaw)) { console.warn(`[CACHE] ⚠️ BINANCEUSDM: futuresFundingRate không trả về mảng.`); return []; }
        const filteredData = fundingRatesRaw.map(item => ({
            symbol: item.symbol, fundingRate: parseFloat(item.fundingRate), fundingTimestamp: item.fundingTime 
        })).filter(item => item.symbol.endsWith('USDT') && !isNaN(item.fundingRate) && typeof item.fundingTimestamp === 'number' && item.fundingTimestamp > 0);
        console.log(`[DATA] ✅ BINANCEUSDM: Đã lấy thành công ${filteredData.length} funding rates (Direct API).`);
        return filteredData;
    } catch (e) {
        console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy funding rates (Direct API): ${e.message}. Stack: ${e.stack}.`);
        return [];
    }
}

// === BINGX: LẤY FUNDING RATES VÀ NEXT FUNDING BẰNG DIRECT API (fetch) ===
async function getBingXFundingRatesDirectAPI() {
    return new Promise(async (resolve, reject) => {
        if (!bingxApiKey) { console.error('[CACHE] ❌ BINGX: Thiếu API Key để lấy funding rate.'); return resolve([]); }
        try {
            const bingxCCXT = exchanges['bingx'];
            await bingxCCXT.loadMarkets(true);
            const markets = Object.values(bingxCCXT.markets).filter(m => m.swap && m.quote === 'USDT');
            if (markets.length === 0) { console.warn(`[CACHE] ⚠️ BINGX: loadMarkets trả về 0 thị trường USDT Swap.`); return resolve([]); }

            const BINGX_REQUEST_DELAY_MS = 100;
            const processedDataMap = new Map(); // Dùng Map để lưu trữ entry mới nhất cho mỗi symbol

            for (const market of markets) {
                const cleanS = cleanSymbol(market.symbol);
                const bingxApiSymbol = formatBingXApiSymbol(market.symbol);
                const url = `https://open-api.bingx.com/openApi/swap/v2/quote/fundingRate?symbol=${bingxApiSymbol}`; 

                try {
                    const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });
                    if (!res.ok) {
                        const errorText = await res.text();
                        console.error(`[CACHE] ❌ BINGX: Phản hồi API không OK cho ${bingxApiSymbol} (Funding Rate). Status: ${res.status}, Raw: ${errorText}.`);
                        await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS)); continue;
                    }
                    const json = await res.json();
                    console.log(`[DEBUG] BINGX Raw response for Funding Rate ${bingxApiSymbol}:`, JSON.stringify(json, null, 2));

                    if (json && json.code === 0 && Array.isArray(json.data) && json.data.length > 0) { // ĐÃ SỬA: Kiểm tra json.data là mảng
                        // Sắp xếp theo fundingTime giảm dần để lấy entry mới nhất
                        json.data.sort((a, b) => b.fundingTime - a.fundingTime);
                        const latestData = json.data[0]; // Lấy entry mới nhất (có timestamp cao nhất)

                        const fundingRate = parseFloat(latestData.fundingRate);
                        const fundingTimestamp = parseInt(latestData.fundingTime, 10); // Lấy fundingTime từ entry mới nhất

                        console.log(`[DEBUG] BINGX: Đã parse Funding Rate cho ${bingxApiSymbol}: Rate Type: ${typeof fundingRate}, Value: ${fundingRate}. Timestamp Type: ${typeof fundingTimestamp}, Value: ${fundingTimestamp}.`);

                        if (!isNaN(fundingRate) && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                            processedDataMap.set(cleanS, { symbol: cleanS, fundingRate: fundingRate, fundingTimestamp: fundingTimestamp });
                        } else console.warn(`[CACHE] ⚠️ BINGX: Funding rate ('${latestData.fundingRate}' -> ${fundingRate}) hoặc timestamp ('${latestData.fundingTime}' -> ${fundingTimestamp}) không hợp lệ cho ${bingxApiSymbol}.`);
                    } else if (json && json.code === 0 && json.data === null) {
                        console.warn(`[CACHE] ⚠️ BINGX: Không có dữ liệu funding rate cho ${bingxApiSymbol} (json.data là null hoặc rỗng).`);
                    }
                    else console.warn(`[CACHE] ⚠️ BINGX: Lỗi hoặc dữ liệu không hợp lệ từ /quote/fundingRate cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                } catch (e) {
                    console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy funding rate cho ${bingxApiSymbol} (Direct API): ${e.message}. Stack: ${e.stack}`);
                }
                await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
            }
            console.log(`[DATA] ✅ BINGX: Đã lấy thành công ${processedDataMap.size} funding rates (Direct API).`);
            resolve(Array.from(processedDataMap.values())); // Chuyển Map thành Array
        } catch (e) {
            reject(new Error(`Lỗi tổng quát khi lấy API BingX Funding Rate (Direct API): ${e.message}. Stack: ${e.stack}.`));
        }
    });
}

// Hàm tổng hợp để lấy Funding Rates cho tất cả các sàn
async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            let processedRates = {};
            if (id === 'binanceusdm') {
                processedRates = (await getBinanceFundingRatesDirectAPI()).reduce((acc, item) => {
                    acc[cleanSymbol(item.symbol)] = { ...item, maxLeverage: leverageCache[id]?.[cleanSymbol(item.symbol)] || null };
                    return acc;
                }, {});
            } else if (id === 'bingx') {
                processedRates = (await getBingXFundingRatesDirectAPI()).reduce((acc, item) => {
                    acc[item.symbol] = { ...item, maxLeverage: leverageCache[id]?.[item.symbol] || null };
                    return acc;
                }, {});
            } else { // === OKX & BITGET: LẤY FUNDING RATES VÀ NEXT FUNDING BẰNG CCXT ===
                const fundingRatesRaw = await exchange.fetchFundingRates();
                for (const rate of Object.values(fundingRatesRaw)) {
                    const symbolCleaned = cleanSymbol(rate.symbol);
                    const maxLeverage = leverageCache[id]?.[symbolCleaned] || null;
                    const fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();
                    processedRates[symbolCleaned] = { symbol: symbolCleaned, fundingRate: rate.fundingRate, fundingTimestamp: fundingTimestamp, maxLeverage: maxLeverage };
                }
                console.log(`[DATA] ✅ ${id.toUpperCase()}: Đã lấy thành công ${Object.keys(processedRates).length} funding rates (CCXT).`);
            }
            return { id, status: 'fulfilled', rates: processedRates };
        } catch (e) {
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) {
                console.error(`- Lỗi nghiêm trọng khi lấy funding từ ${id.toUpperCase()}: ${e.message}. Stack: ${e.stack}.`);
            } else {
                console.warn(`- Lỗi tạm thời (timeout/network) khi lấy funding từ ${id.toUpperCase()}: ${e.message}. Sẽ thử lại.`);
            }
            return { id, status: 'rejected', reason: e.message };
        }
    });
    // Sử dụng Promise.allSettled để tất cả các promise đều chạy xong, không chặn nhau
    const results = await Promise.allSettled(promises);

    results.forEach(result => {
        if (result.status === 'fulfilled') {
            freshData[result.value.id] = { rates: result.value.rates };
        } else {
            console.warn(`[DATA] ⚠️ ${result.reason ? result.reason.split(':')[0].trim() : 'UNKNOWN'}: Không thể cập nhật funding rates. Sử dụng dữ liệu cũ nếu có.`);
            if (!exchangeData[result.value.id]) { // Đảm bảo key tồn tại dù bị lỗi
                exchangeData[result.value.id] = { rates: {} };
            }
        }
    });
    return freshData;
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
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData)); // Deep copy để đảm bảo tính bất biến

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
    
    // Luôn cố gắng cập nhật leverage cache trước, sử dụng Promise.allSettled
    await initializeLeverageCache(); 

    // Sử dụng Promise.allSettled để lấy dữ liệu funding rate từ tất cả các sàn
    // Nếu một sàn lỗi, các sàn khác vẫn tiếp tục và dữ liệu của chúng vẫn được đưa vào `exchangeData`
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData; // Cập nhật dữ liệu từ các sàn đã thành công

    // Sau khi dữ liệu được fetch (có thể thiếu từ một số sàn lỗi), tiến hành tính toán
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP]   => Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
    scheduleNextLoop();
}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId);
    const now = new Date();
    const delaySeconds = (60 - now.getSeconds() + 5) % 60; // Chạy 5 giây sau đầu phút tiếp theo
    const delayMs = (delaySeconds === 0 ? 60 : delaySeconds) * 1000;
    console.log(`[SCHEDULER] Vòng lặp kế tiếp sau ${delaySeconds.toFixed(1)} giây (chạy vào giây thứ ${(now.getSeconds() + delaySeconds) % 60} của phút tiếp theo).`);
    loopTimeoutId = setTimeout(masterLoop, delayMs);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); res.end('Lỗi khi đọc index.html'); return; }
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
    console.log(`✅ Máy chủ dữ liệu (ĐÃ FIX PARSING FUNDING BINGX & CẢI THIỆN XỬ LÝ LỖI CHUNG) đang chạy tại http://localhost:${PORT}`);
    // Bắt đầu vòng lặp chính
    await masterLoop(); 
    // initializeLeverageCache đã được gọi bên trong masterLoop.
    // Dòng dưới đây để đảm bảo leverage cache được refresh định kỳ, độc lập với vòng lặp chính nếu cần.
    // Có thể cân nhắc bỏ nếu masterLoop đã đủ thường xuyên và initializeLeverageCache không quá nặng.
    // Hiện tại masterLoop đã gọi initializeLeverageCache() ở mỗi vòng lặp.
    // Nếu bạn muốn refresh leverage cache ít thường xuyên hơn funding rates, thì giữ lại dòng này.
    // Nếu không, bạn có thể comment/xóa dòng này.
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
