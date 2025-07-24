// sv1.js (BẢN SỬA LỖI SỐ 26 - FUNDING HISTORY CACHING & BINANCE LEVERAGE DEBUG)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto'); // Cần cho hàm sign của BingX direct API

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30; // Tần suất làm mới cache đòn bẩy
const FUNDING_HISTORY_FULL_REFRESH_INTERVAL_MINUTES = 10; // Tần suất làm mới đầy đủ lịch sử funding (cho tất cả symbols)
const FUNDING_HISTORY_CACHE_TTL_MINUTES = 60; // TTL cho từng entry trong lịch sử funding cache (để tránh suy luận lại quá sớm)


// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
const binanceApiKey = '2rgsf5oYto2HaBS05DS7u4QVtDHf5uxQjEpZiP6eSMUlQRYb194XdE82zZy0Yujw';
const binanceApiSecret = 'jnCGekaD5XWm8i48LIAfQZpq5pFtBmZ3ZyYR4sK3UW4PoZlgPVCMrljk8DCFa9Xk';
const bingxApiKey = 'vvmD6sdV12c382zUvGMWUnD1yWi1ti8TCFsGaiEIlH6kGTHzkmPdeJQCuUQivXKAPrsEcfOvgwge9aAQ'; // Đảm bảo API key và secret đúng và có quyền
const bingxApiSecret = '1o30hXOVTsZ6o40JixrGPfTCvHaqFTutSEpGAyjqbmGt7p9RsVqGUKXHHItsOz174ncfQ9YWStvGIs3Oeb3Pg';
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let fundingHistoryCache = {}; // Cache cho lịch sử funding: { 'exchange_symbol': { timestamp: ..., nextFundingTime: ... } }
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let lastFullFundingHistoryRefreshTime = 0; // Thời điểm cuối cùng làm mới toàn bộ lịch sử funding

// === LOGIC MỚI: TÁCH RIÊNG KẾT NỐI PUBLIC VÀ PRIVATE ===
const publicExchanges = {}; // Dùng để lấy funding, không bao giờ lỗi do key
const privateExchanges = {}; // Dùng để lấy đòn bẩy, cần key

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
        privateExchanges[id] = publicExchanges[id];
    }
});

// cleanSymbol: Chuẩn hóa symbol để dùng làm key trong cache và hiển thị
const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

// Hàm hỗ trợ ký cho BingX direct API (nếu cần dùng các endpoint private)
function signBingX(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// === LOGIC LẤY ĐÒN BẨY CHO BINANCE (Chỉ dùng fetchLeverageBracket từng symbol) ===
async function getBinanceLeverage(exchange) {
    let leverages = {};
    try {
        await exchange.loadMarkets(true); // Đảm bảo markets được tải để có danh sách symbol
        const markets = Object.values(exchange.markets).filter(m => m.swap && m.quote === 'USDT');

        for (const market of markets) {
            const originalSymbol = market.symbol; // Ví dụ: BTCUSDT
            const cleanS = cleanSymbol(originalSymbol); // Ví dụ: BTC
            try {
                // Sử dụng fetchLeverageBracket cho từng symbol như trong code ví dụ của bạn
                const bracketInfo = await exchange.fetchLeverageBracket(originalSymbol);
                // In ra chi tiết bracketInfo cho vài symbol chính để debug
                if (cleanS === 'BTC' || cleanS === 'ETH' || cleanS === 'XRP') { 
                    console.log(`[DEBUG] BINANCEUSDM: Raw leverageBracket for ${originalSymbol}:`, JSON.stringify(bracketInfo, null, 2));
                }
                
                const initialLeverage = bracketInfo?.[0]?.brackets?.[0]?.initialLeverage;

                if (typeof initialLeverage === 'number' && initialLeverage > 0) {
                    leverages[cleanS] = initialLeverage;
                } else {
                    console.warn(`[CACHE] ⚠️ Binance: Không tìm thấy đòn bẩy hợp lệ (> 0) cho ${originalSymbol} từ fetchLeverageBracket. Info:`, JSON.stringify(bracketInfo));
                    leverages[cleanS] = null;
                }
            } catch (e) {
                console.error(`[CACHE] ❌ Binance: Lỗi khi lấy đòn bẩy cho ${originalSymbol} bằng fetchLeverageBracket: ${e.message}. Vui lòng kiểm tra API Key và quyền.`);
                leverages[cleanS] = null;
            }
        }
        return leverages;
    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINANCEUSDM: ${e.message}.`);
        return {};
    }
}

// === LOGIC LẤY ĐÒN BẨY CHO BINGX (GỌI DIRECT API TỪNG SYMBOL VỚI KÝ TÊN) ===
async function getBingXLeverageFromTradeAPI(exchange) {
    console.log('[DEBUG] BINGX: Đang cố gắng lấy đòn bẩy bằng REST API trực tiếp /swap/v2/trade/leverage (từng symbol)...');
    const leverages = {};
    if (!bingxApiKey || !bingxApiSecret) {
        console.error('[CACHE] ❌ BINGX: Thiếu API Key hoặc Secret để lấy đòn bẩy qua API /trade/leverage.');
        return {};
    }

    try {
        await exchange.loadMarkets(true); // Tải markets để có danh sách symbol BingX
        const markets = Object.values(exchange.markets).filter(m => m.swap && m.quote === 'USDT');

        const BINGX_REQUEST_DELAY_MS = 100; // Delay giữa mỗi request để tránh rate limit
        for (const market of markets) {
            const originalSymbol = market.symbol; // Ví dụ: BTC-USDT (định dạng của BingX)
            const cleanS = cleanSymbol(originalSymbol);

            try {
                const timestamp = Date.now().toString();
                const recvWindow = "5000";
                const queryString = `recvWindow=${recvWindow}×tamp=${timestamp}&symbol=${originalSymbol}`;
                const signature = signBingX(queryString, bingxApiSecret);

                const url = `https://open-api.bingx.com/openApi/swap/v2/trade/leverage?${queryString}&signature=${signature}`;
                
                // In ra URL và phản hồi thô cho một vài symbol chính để debug
                if (cleanS === 'BTC' || cleanS === 'ETH' || cleanS === 'XRP') {
                    console.log(`[DEBUG] BINGX API Call URL: ${url}`);
                    const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });
                    const json = await res.json();
                    console.log(`[DEBUG] BINGX Raw response for ${originalSymbol} from /trade/leverage:`, JSON.stringify(json, null, 2));

                    if (json && json.code === 0 && json.data && typeof json.data.longLeverage === 'number' && typeof json.data.shortLeverage === 'number') {
                        leverages[cleanS] = Math.max(parseFloat(json.data.longLeverage), parseFloat(json.data.shortLeverage));
                    } else {
                        console.warn(`[CACHE] ⚠️ BINGX: Không tìm thấy đòn bẩy hợp lệ cho ${originalSymbol} từ /trade/leverage. Code: ${json.code}, Msg: ${json.msg}`);
                        leverages[cleanS] = null;
                    }
                } else { // Cho các symbol khác, không in debug quá chi tiết để tránh tràn log
                    const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });
                    const json = await res.json();
                    if (json && json.code === 0 && json.data && typeof json.data.longLeverage === 'number' && typeof json.data.shortLeverage === 'number') {
                        leverages[cleanS] = Math.max(parseFloat(json.data.longLeverage), parseFloat(json.data.shortLeverage));
                    } else {
                        leverages[cleanS] = null;
                    }
                }
            } catch (e) {
                console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy đòn bẩy cho ${originalSymbol} từ /trade/leverage: ${e.message}`);
                leverages[cleanS] = null;
            }
            await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS)); // Delay giữa các request
        }
        console.log(`[DEBUG] BINGX: Đã lấy thành công ${Object.values(leverages).filter(v => v !== null && v > 0).length} đòn bẩy qua REST API /trade/leverage.`);
        return leverages;

    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINGX: ${e.message}`);
        return {};
    }
}


// === LOGIC LẤY ĐÒN BẨY CHUNG BẰNG CCXT (OKX, BITGET) ===
async function getGenericLeverage(exchange) {
    try {
        await exchange.loadMarkets(true);
        const leverages = {};

        for (const market of Object.values(exchange.markets)) {
            if (market.swap && market.quote === 'USDT') {
                const symbol = cleanSymbol(market.symbol);
                let maxLeverageFound = null;

                if (typeof market?.info?.maxLeverage === 'number' && market.info.maxLeverage > 0) {
                    maxLeverageFound = market.info.maxLeverage;
                } else if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) {
                    maxLeverageFound = market.limits.leverage.max;
                } else {
                    console.warn(`[CACHE] ⚠️ ${exchange.id.toUpperCase()}: Không tìm thấy maxLeverage là số (> 0) cho ${symbol}. Market info:`, JSON.stringify(market.info), "Limits:", JSON.stringify(market.limits));
                }
                
                leverages[symbol] = maxLeverageFound;
            }
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
                leverages = await getBingXLeverageFromTradeAPI(exchange); // Dùng REST API trực tiếp /trade/leverage cho BingX
                const count = Object.values(leverages).filter(v => v !== null && v > 0).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy.`);
            }
            else { // OKX, Bitget dùng generic CCXT
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

// Hàm mới: Tính toán thời gian funding tiếp theo dựa trên lịch sử
async function calculateNextFundingTimeFromHistory(exchange, symbol) {
    const cacheKey = `${exchange.id}_${symbol}`;
    const cachedEntry = fundingHistoryCache[cacheKey];

    // Nếu có trong cache và chưa hết hạn, sử dụng data từ cache
    if (cachedEntry && Date.now() < cachedEntry.timestamp + FUNDING_HISTORY_CACHE_TTL_MINUTES * 60 * 1000) {
        return cachedEntry.nextFundingTime;
    }

    try {
        // Lấy lịch sử funding rates. Giới hạn 20 bản ghi để không quá nặng.
        // Bitget và BingX cần originalSymbol, không phải cleanS.
        const originalSymbolForExchange = Object.values(exchange.markets).find(m => cleanSymbol(m.symbol) === symbol)?.symbol || symbol;

        const history = await exchange.fetchFundingRateHistory(originalSymbolForExchange, undefined, undefined, 20);
        if (!history || history.length < 2) {
            // console.warn(`[FUNDING_HISTORY] Không đủ lịch sử funding cho ${exchange.id.toUpperCase()} ${symbol}.`);
            return null; // Không đủ dữ liệu để suy luận
        }

        // Sắp xếp theo thời gian tăng dần
        history.sort((a, b) => a.timestamp - b.timestamp);

        // Cố gắng suy luận interval (lấy sự khác biệt giữa 2 timestamp gần nhất)
        let inferredInterval = null;
        for (let i = history.length - 1; i >= 1; i--) {
            const diff = history[i].timestamp - history[i-1].timestamp;
            // Chỉ lấy khoảng thời gian hợp lý (ví dụ: > 1h và < 24h)
            if (diff > 3600000 && diff < 86400000) { 
                inferredInterval = diff;
                break;
            }
        }

        if (!inferredInterval) {
            // console.warn(`[FUNDING_HISTORY] Không suy luận được khoảng thời gian funding hợp lý cho ${exchange.id.toUpperCase()} ${symbol}.`);
            return null;
        }

        const lastFundingTime = history[history.length - 1].timestamp;
        let nextPredictedFundingTime = lastFundingTime + inferredInterval;

        // Nếu thời gian dự đoán đã qua, tìm thời gian tiếp theo trong tương lai
        while (nextPredictedFundingTime < Date.now()) {
            nextPredictedFundingTime += inferredInterval;
        }
        
        // Cập nhật cache
        fundingHistoryCache[cacheKey] = {
            timestamp: Date.now(),
            nextFundingTime: nextPredictedFundingTime
        };
        // console.log(`[FUNDING_HISTORY] ${exchange.id.toUpperCase()} ${symbol}: Suy luận nextFundingTime ${new Date(nextPredictedFundingTime).toISOString()} (interval ${inferredInterval / (1000 * 60 * 60)}h).`);
        return nextPredictedFundingTime;

    } catch (e) {
        // console.error(`[FUNDING_HISTORY] Lỗi khi lấy hoặc xử lý lịch sử funding cho ${exchange.id.toUpperCase()} ${symbol}: ${e.message}`);
        return null;
    }
}


// calculateNextStandardFundingTime: Hàm dự phòng cũ nếu không lấy được từ API/Lịch sử
function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16]; // Các giờ funding chuẩn (UTC)
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h) ?? fundingHoursUTC[0];
    const nextFundingDate = new Date(now);
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
    
    // Nếu giờ hiện tại đã vượt qua tất cả các giờ funding trong ngày, đặt ngày tiếp theo
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
            const fundingRatesRaw = await exchange.fetchFundingRates(); // Lấy tất cả funding rates
            const processedRates = {};
            
            for (const rate of Object.values(fundingRatesRaw)) {
                const originalSymbol = rate.symbol;
                const cleanS = cleanSymbol(originalSymbol);
                const maxLeverage = leverageCache[id]?.[cleanS] || null;

                let fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime;

                // Nếu là BingX hoặc Bitget VÀ (không có fundingTimestamp/nextFundingTime TỪ API HOẶC CẦN LÀM MỚI LỊCH SỬ)
                if ((id === 'bingx' || id === 'bitget') && (!fundingTimestamp || fundingTimestamp === 0 || isFullHistoryRefreshDue)) {
                    const historicalFundingTime = await calculateNextFundingTimeFromHistory(exchange, cleanS); // Truyền cleanS
                    if (historicalFundingTime) {
                        fundingTimestamp = historicalFundingTime;
                    } else {
                        // Nếu cả lịch sử cũng không suy luận được, dùng standard (dự phòng cuối cùng)
                        fundingTimestamp = calculateNextStandardFundingTime();
                    }
                } else if (!fundingTimestamp || fundingTimestamp === 0) {
                    // Với các sàn khác nếu không có fundingTimestamp/nextFundingTime, dùng standard
                    fundingTimestamp = calculateNextStandardFundingTime();
                }

                processedRates[cleanS] = {
                    symbol: cleanS, // Lưu symbol đã được chuẩn hóa
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
                // Chỉ tiếp tục nếu cả hai sàn đều có maxLeverage là số (không phải null hoặc 0)
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
    // Leverage cache chỉ được refresh định kỳ, không phải mỗi loop để tiết kiệm API
    // Nó được gọi lần đầu trong server.listen và sau đó qua setInterval
    // await initializeLeverageCache(); 
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
    let delay = (60 - seconds) * 1000; // Mặc định chạy đầu phút tiếp theo
    let nextRunReason = "Lịch trình mặc định (đầu phút tiếp theo)";

    // Các lịch trình cập nhật cường độ cao theo yêu cầu cũ
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
        // === DEBUG: Dòng này sẽ in ra dữ liệu JSON được gửi đến frontend
        console.log("[DEBUG] Dữ liệu API gửi đến frontend (rawRates):", JSON.stringify(responseData.rawRates, null, 2));
        // === KẾT THÚC DEBUG ===

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi số 26) đang chạy tại http://localhost:${PORT}`);
    await initializeLeverageCache(); // Gọi lần đầu khi khởi động
    await masterLoop(); // Bắt đầu vòng lặp chính
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000); // Lên lịch làm mới cache đòn bẩy
});
