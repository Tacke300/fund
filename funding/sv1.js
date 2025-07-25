// sv1.js (BẢN SỬA LỖI SỐ 101 - Sửa endpoint BingX Funding Rate, Bỏ comment debug BingX Leverage, Log chi tiết lỗi parse JSON Binance)

const http = require('http'); // Giữ lại cho server HTTP
const https = require('https'); // Thêm cho các yêu cầu HTTPS ra ngoài
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto'); // Cần cho hàm sign của Direct API
const Binance = require('node-binance-api'); // Thư viện node-binance-api

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;
const FUNDING_HISTORY_FULL_REFRESH_INTERVAL_MINUTES = 10; 
const FUNDING_HISTORY_CACHE_TTL_MINUTES = 60; 

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
// API Key/Secret của Binance (đã cập nhật theo yêu cầu của bạn)
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT20WZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc';
// API Key/Secret của BingX (vui lòng kiểm tra lại thật kỹ trên sàn)
const bingxApiKey = 'hlt2pwTdbgfEk9rL54igHBBKLnkpsbMV4EJLVFxwx0Pm86VKbmQuT6JBR6W20ha7jKD4RkswCooFgmMF1ag';
const bingxApiSecret = 'YcrFgTWcCaRLJ40TMv6J4sUQl1cUPbOTZPAlXBosDWWLri103E8XC1LasXa2YDKz1VqYhw11xWCibTRHkXiA';
// API Key/Secret/Passphrase của OKX (vui lòng kiểm tra lại thật kỹ trên sàn)
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
// API Key/Secret của Bitget (vui lòng kiểm tra lại thật kỹ trên sàn)
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';


// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let fundingHistoryCache = {}; 
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let lastFullFundingHistoryRefreshTime = 0; 

// Khởi tạo client Binance riêng bằng node-binance-api
const binanceClient = new Binance().options({
    APIKEY: binanceApiKey,
    APISECRET: binanceApiSecret
});

// Khởi tạo các sàn giao dịch bằng CCXT
const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = { 'options': { 'defaultType': 'swap' } }; 

    if (id === 'binanceusdm' && binanceApiKey && binanceApiSecret) { 
        config.apiKey = binanceApiKey; config.secret = binanceApiSecret; 
        console.log(`[AUTH] Đã cấu hình CCXT cho Binance (dùng cho public calls và loadMarkets).`);
    } else if (id === 'bingx' && bingxApiKey && bingxApiSecret) { 
        config.apiKey = bingxApiKey; config.secret = bingxApiSecret; 
        console.log(`[AUTH] Đã cấu hình HMAC cho BingX.`); 
    } else if (id === 'okx' && okxApiKey && okxApiSecret) { 
        config.apiKey = okxApiKey; config.secret = okxApiSecret; 
        if(okxPassword) config.password = okxPassword; 
        console.log(`[AUTH] Đã cấu hình HMAC cho OKX.`); 
    } else if (id === 'bitget' && bitgetApiKey && bitgetApiSecret) { 
        config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; 
        if(bitgetApiPassword) config.password = bitgetApiPassword; 
        console.log(`[AUTH] Đã cấu hình HMAC cho Bitget.`); 
    } else {
        exchanges[id] = new exchangeClass(config);
        console.warn(`[AUTH] ⚠️ Không có API Key/Secret hoặc thiếu cho ${id.toUpperCase()}. Sẽ chỉ dùng public API nếu có thể.`);
    }
    
    if (!exchanges[id]) { // Đảm bảo exchange được gán nếu chưa được gán bởi các điều kiện trên
        exchanges[id] = new exchangeClass(config);
    }
});


const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

// Hàm hỗ trợ ký cho BingX direct API
function signBingX(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// === LOGIC LẤY ĐÒN BẨY CHO BINANCE (Bằng node-binance-api) ===
async function getBinanceLeverageDirectAPI() {
    let leverages = {};
    try {
        console.log('[DEBUG] BINANCEUSDM: Đang lấy đòn bẩy bằng node-binance-api (futuresLeverageBracket)...');
        
        const leverageInfo = await binanceClient.futuresLeverageBracket(); 

        if (!leverageInfo || !Array.isArray(leverageInfo)) {
            console.warn(`[CACHE] ⚠️ BINANCEUSDM: futuresLeverageBracket không trả về dữ liệu hợp lệ (không phải mảng). Dữ liệu thô: ${JSON.stringify(leverageInfo)}`);
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

        console.log(`[CACHE] ✅ BINANCEUSDM: Lấy thành công ${Object.values(leverages).filter(v => v !== null && v > 0).length} đòn bẩy bằng node-binance-api.`);
        return leverages;

    } catch (e) {
        console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy đòn bẩy bằng node-binance-api: ${e.message}.`);
        return {};
    }
}

// === LOGIC LẤY ĐÒN BẨY CHO BINGX (GỌI DIRECT API TỪNG SYMBOL VỚI KÝ TÊN) ===
async function getBingXLeverageDirectAPI() {
    console.log('[DEBUG] BINGX: Đang cố gắng lấy đòn bẩy bằng REST API trực tiếp /swap/v2/trade/leverage (từng symbol)...');
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

                console.log(`[DEBUG] BINGX API Call URL: ${url}`); // Bỏ comment để debug chi tiết từng symbol
                console.log(`[DEBUG] BINGX Raw response for ${originalSymbol} from /trade/leverage:`, JSON.stringify(json, null, 2)); // Bỏ comment để debug chi tiết từng symbol

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

// Hàm này giờ chỉ dùng cho OKX và Bitget (dùng qua CCXT loadMarkets)
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
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id]; 
        newCache[id] = {};
        let count = 0; 
        try {
            if (id === 'binanceusdm') {
                const leverages = await getBinanceLeverageDirectAPI();
                newCache[id] = leverages;
                count = Object.values(leverages).filter(v => v !== null && v > 0).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số ${count} đòn bẩy đã lấy.`);
            } else if (id === 'bingx') {
                const leverages = await getBingXLeverageDirectAPI();
                newCache[id] = leverages;
                count = Object.values(leverages).filter(v => v !== null && v > 0).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số ${count} đòn bẩy đã lấy.`);
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
                            count++;
                        }
                    }
                }
                if (count > 0) { console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'fetchLeverageTiers'.`); }
                else { console.log(`[CACHE] ⚠️ ${id.toUpperCase()}: 'fetchLeverageTiers' không trả về dữ liệu hợp lệ.`); }
            } else { 
                await exchange.loadMarkets(true);
                for (const market of Object.values(exchange.markets)) {
                    if (market.swap && market.quote === 'USDT') {
                        const symbol = cleanSymbol(market.symbol);
                        const maxLeverage = getMaxLeverageFromMarketInfo(market, id);
                        newCache[id][symbol] = maxLeverage;
                        if (maxLeverage !== null && maxLeverage > 0) count++;
                    }
                }
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'loadMarkets' (dự phòng).`);
            }
        } catch (e) { 
            console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}`); 
            newCache[id] = {}; 
        }
    }));
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
}

// Hàm lấy funding rates trực tiếp từ Binance Premium Index (đã chuyển sang HTTPS)
function getBinanceFundingRatesDirectAPI() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'fapi.binance.com',
            path: '/fapi/v1/premiumIndex',
            method: 'GET',
        };

        const req = https.request(options, (res) => { 
            let data = '';
            res.on('data', chunk => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const filteredData = parsed.filter(item => 
                        item.symbol.endsWith('USDT') && 
                        typeof item.lastFundingRate === 'string' && 
                        typeof item.nextFundingTime === 'number'
                    );
                    resolve(filteredData);
                } catch (err) {
                    console.error(`[ERROR_PARSE] Dữ liệu nhận được từ Binance premiumIndex (dài ${data.length} ký tự): '${data.substring(0, Math.min(data.length, 200))}'...`); 
                    reject(new Error('Lỗi parse JSON từ Binance premiumIndex: ' + err.message));
                }
            });
        });
        req.on('error', err => {
            reject(new Error('Lỗi khi gọi API Binance premiumIndex: ' + err.message));
        });
        req.end();
    });
}

// Hàm lấy funding rates trực tiếp từ BingX (đã sửa endpoint)
function getBingXFundingRatesDirectAPI() {
    return new Promise(async (resolve, reject) => {
        // Funding rate endpoint công khai không cần API Secret nhưng một số vẫn cần API Key
        if (!bingxApiKey) { 
            console.error('[CACHE] ❌ BINGX: Thiếu API Key để lấy funding rate qua API.');
            return reject(new Error('Thiếu API Key cho BingX.'));
        }

        try {
            const timestamp = Date.now().toString();
            // Đã sửa endpoint theo tài liệu BingX chính thức: /openApi/swap/v2/market/fundingRate
            const url = `https://open-api.bingx.com/openApi/swap/v2/market/fundingRate?timestamp=${timestamp}`; 
            
            const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });
            const json = await res.json();

            // console.log(`[DEBUG] BINGX Funding API Call URL: ${url}`); 
            // console.log(`[DEBUG] BINGX Raw response for Funding Rate:`, JSON.stringify(json, null, 2)); 

            if (json && json.code === 0 && Array.isArray(json.data)) {
                const processedData = json.data.map(item => ({
                    symbol: cleanSymbol(item.symbol),
                    fundingRate: parseFloat(item.fundingRate),
                    fundingTimestamp: parseInt(item.fundingTimestamp, 10)
                })).filter(item => 
                    !isNaN(item.fundingRate) && 
                    !isNaN(item.fundingTimestamp) && 
                    item.fundingTimestamp > 0
                );
                resolve(processedData);
            } else {
                reject(new Error(`BingX Funding API trả về lỗi hoặc dữ liệu không hợp lệ. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`));
            }
        } catch (e) {
            reject(new Error(`Lỗi khi gọi API BingX Funding Rate: ${e.message}`));
        }
    });
}


async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const results = await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id]; 
            let fundingRatesRaw;
            let processedRates = {};

            if (id === 'binanceusdm') {
                fundingRatesRaw = await getBinanceFundingRatesDirectAPI();
                for (const item of fundingRatesRaw) {
                    processedRates[cleanSymbol(item.symbol)] = {
                        symbol: cleanSymbol(item.symbol),
                        fundingRate: parseFloat(item.lastFundingRate), 
                        fundingTimestamp: item.nextFundingTime,
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
    }));
    results.forEach(result => { if (result.status === 'success') { freshData[result.id] = { rates: result.rates }; }});
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
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi số 101) đang chạy tại http://localhost:${PORT}`);
    await initializeLeverageCache();
    await masterLoop();
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
