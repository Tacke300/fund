// sv1.js (BẢN SỬA LỖI SỐ 13 - LOGIC THỜI GIAN THẬT, ĐÃ CẬP NHẬT API KEY BINANCE VÀ SỬ DỤNG DIRECT REST API CHO BINANCE LEVERAGE)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto'); // Cần cho hàm sign của Binance direct API

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
// Đã thay thế API Key và Secret của Binance bằng cặp bạn cung cấp.
// Vui lòng kiểm tra lại API Key và Secret của BingX nếu nó vẫn báo lỗi.
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc';
const bingxApiKey = 'vvmD6sdV12c382zUvGMWUnD1yWi1ti8TCFsGaiEIlH6kGTHzkmPdeJQCuUQivXKAPrsEcfOvgwge9aAQ';
const bingxApiSecret = '1o30hXOVTsZ6o40JixrGPfTCvHaqFTutSEpGAyjqbmGt7p9RsVqGUKXHHItsOz174ncfQ9YWStvGIs3Oeb3Pg';
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

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = { 'options': { 'defaultType': 'swap' } };
    if (id === 'binanceusdm' && binanceApiKey && binanceApiSecret) { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; console.log(`[AUTH] Đã cấu hình HMAC cho Binance.`); }
    else if (id === 'bingx' && bingxApiKey && bingxApiSecret) { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; console.log(`[AUTH] Đã cấu hình HMAC cho BingX.`); }
    else if (id === 'okx' && okxApiKey && okxApiSecret) { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; console.log(`[AUTH] Đã cấu hình HMAC cho OKX.`); }
    else if (id === 'bitget' && bitgetApiKey && bitgetApiSecret) { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; console.log(`[AUTH] Đã cấu hình HMAC cho Bitget.`); }
    exchanges[id] = new exchangeClass(config);
});


const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

// Hàm hỗ trợ ký cho Binance direct API
function signBinance(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// === LOGIC LẤY ĐÒN BẨY CHO BINANCE (GỌI DIRECT REST API) ===
async function getBinanceLeverageDirectAPI(exchange) {
    console.log('[DEBUG] BINANCEUSDM: Đang cố gắng lấy đòn bẩy bằng REST API trực tiếp /fapi/v1/leverageBracket...');
    const leverages = {};
    if (!binanceApiKey || !binanceApiSecret) {
        console.error('[CACHE] ❌ BINANCEUSDM: Thiếu API Key hoặc Secret để lấy đòn bẩy qua API /fapi/v1/leverageBracket.');
        return {};
    }

    try {
        await exchange.loadMarkets(true); // Tải markets để có danh sách symbol Binance
        const markets = Object.values(exchange.markets).filter(m => m.swap && m.quote === 'USDT');

        const BINANCE_REQUEST_DELAY_MS = 50; // Delay giữa mỗi request để tránh rate limit
        for (const market of markets) {
            const originalSymbol = market.symbol; // Ví dụ: BTCUSDT
            const cleanS = cleanSymbol(originalSymbol);

            try {
                const timestamp = Date.now().toString();
                const recvWindow = "5000"; // Thời gian cho phép lệch giờ
                const queryString = `symbol=${originalSymbol}×tamp=${timestamp}&recvWindow=${recvWindow}`;
                const signature = signBinance(queryString, binanceApiSecret);

                const url = `https://fapi.binance.com/fapi/v1/leverageBracket?${queryString}&signature=${signature}`;
                
                const res = await fetch(url, { method: "GET", headers: { "X-MBX-APIKEY": binanceApiKey } });
                const json = await res.json();

                console.log(`[DEBUG] BINANCEUSDM API Call URL: ${url}`);
                console.log(`[DEBUG] BINANCEUSDM Raw response for ${originalSymbol} from /fapi/v1/leverageBracket:`, JSON.stringify(json, null, 2));

                let maxLeverageFound = null;
                if (Array.isArray(json) && json.length > 0 && json[0].brackets && Array.isArray(json[0].brackets) && json[0].brackets.length > 0) {
                    const rawLeverage = json[0].brackets[0].initialLeverage;
                    const parsedLeverage = parseFloat(rawLeverage);

                    if (!isNaN(parsedLeverage) && parsedLeverage > 0) {
                        maxLeverageFound = parsedLeverage;
                    } else {
                        console.warn(`[CACHE] ⚠️ BINANCEUSDM: Dữ liệu đòn bẩy 'initialLeverage' cho ${originalSymbol} là '${rawLeverage}' (đã parse: ${parsedLeverage}), không phải số hợp lệ (> 0).`);
                    }
                } else if (json.code && json.msg) { // Bắt các lỗi từ API của Binance
                    console.warn(`[CACHE] ⚠️ BINANCEUSDM: Phản hồi API lỗi cho ${originalSymbol}. Code: ${json.code}, Msg: ${json.msg}`);
                } else {
                    console.warn(`[CACHE] ⚠️ BINANCEUSDM: Cấu trúc phản hồi API không như mong đợi cho ${originalSymbol}.`);
                }
                leverages[cleanS] = maxLeverageFound;

            } catch (e) {
                console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy đòn bẩy cho ${originalSymbol} từ /fapi/v1/leverageBracket: ${e.message}`);
                leverages[cleanS] = null;
            }
            await new Promise(resolve => setTimeout(resolve, BINANCE_REQUEST_DELAY_MS)); // Delay giữa các request
        }
        console.log(`[DEBUG] BINANCEUSDM: Đã lấy thành công ${Object.values(leverages).filter(v => v !== null && v > 0).length} đòn bẩy qua REST API /fapi/v1/leverageBracket.`);
        return leverages;

    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINANCEUSDM: ${e.message}`);
        return {};
    }
}


// getMaxLeverageFromMarketInfo: Hàm này chỉ được dùng cho OKX và Bitget trong phiên bản này.
function getMaxLeverageFromMarketInfo(market, exchangeId) {
    // Logic của Binance (fetchLeverageTiers / fetchLeverageBracket) sẽ được thay thế bằng Direct API, nên phần này sẽ ít được dùng cho Binance.
    // Tuy nhiên, vẫn giữ lại phòng trường hợp CCXT cập nhật và cần thiết.
    if (exchangeId === 'binanceusdm') { 
        try { 
            if (Array.isArray(market?.info?.brackets)) { 
                const max = Math.max(...market.info.brackets.map(b => parseInt(b.initialLeverage))); 
                if (!isNaN(max) && max > 0) return max; 
            } 
        } catch (e) { } 
    }
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) return market.limits.leverage.max;
    if (exchangeId === 'bingx') { 
        try { 
            const keys = ['leverage', 'maxLeverage', 'longLeverage', 'max_long_leverage']; 
            for (const k of keys) { 
                if (market.info[k]) { 
                    const lv = parseInt(market.info[k]); 
                    if (!isNaN(lv) && lv > 1) return lv; 
                } 
            } 
        } catch (e) { } 
    }
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
        let success = false;
        try {
            if (id === 'binanceusdm') { // Sử dụng Direct API cho Binance
                const leverages = await getBinanceLeverageDirectAPI(exchange);
                const count = Object.values(leverages).filter(v => v !== null && v > 0).length;
                newCache[id] = leverages;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'Direct REST API'.`);
                success = true;
            } else if (exchange.has['fetchLeverageTiers']) {
                const leverageTiers = await exchange.fetchLeverageTiers();
                let count = 0;
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
                if (count > 0) { console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'fetchLeverageTiers'.`); success = true; }
                else { console.log(`[CACHE] ⚠️ ${id.toUpperCase()}: 'fetchLeverageTiers' không trả về dữ liệu hợp lệ.`); }
            }
        } catch (e) { 
            console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Lỗi 'fetchLeverageTiers' (${e.constructor.name}). Chuyển sang dự phòng: ${e.message}`); 
        }
        if (!success) {
            try {
                await exchange.loadMarkets(true);
                let count = 0;
                for (const market of Object.values(exchange.markets)) {
                    if (market.swap && market.quote === 'USDT') {
                        const symbol = cleanSymbol(market.symbol);
                        const maxLeverage = getMaxLeverageFromMarketInfo(market, id);
                        newCache[id][symbol] = maxLeverage;
                        if (maxLeverage !== null && maxLeverage > 0) count++;
                    }
                }
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'loadMarkets' (dự phòng).`);
            } catch (e) { console.error(`[CACHE] ❌ ${id.toUpperCase()}: Thất bại ở cả 2 phương pháp. Lỗi cuối: ${e.message}`); }
        }
    }));
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
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

async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const results = await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            const fundingRatesRaw = await exchange.fetchFundingRates();
            const processedRates = {};
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
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi số 13, Cập nhật API Key Binance và Direct API) đang chạy tại http://localhost:${PORT}`);
    await initializeLeverageCache();
    await masterLoop();
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
