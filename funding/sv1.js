// sv1.js (BẢN SỬA LỖI SỐ 21 - SỬ DỤNG REST API TRỰC TIẾP CHO BINGX LEVERAGE)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// Đảm bảo có node-fetch nếu bạn đang chạy Node.js < 18
// const fetch = require('node-fetch'); // Uncomment nếu cần

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
const binanceApiKey = '2rgsf5oYto2HaBS05DS7u4QVtDHf5uxQjEpZiP6eSMUlQRYb194XdE82zZy0Yujw';
const binanceApiSecret = 'jnCGekaD5XWm8i48LIAfQZpq5pFtBmZ3ZyYR4sK3UW4PoZlgPVCMrljk8DCFa9Xk';
const bingxApiKey = 'vvmD6sdV12c382zUvGMWUnD1yWi1ti8TCFsGaiEIlH6kFTHzkmPdeJQCuUQivXKAPrsEcfOvgwge9aAQ';
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

const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '');

// === LOGIC LẤY ĐÒN BẨY BẰNG CCXT (BINANCE) ===
async function getBinanceLeverage(exchange) {
    try {
        const tiers = await exchange.fetchLeverageTiers();
        const leverages = {};
        for (const symbol in tiers) {
            const symbolTiers = tiers[symbol];
            if (Array.isArray(symbolTiers) && symbolTiers.length > 0) {
                const validLeverages = symbolTiers.map(t => t.leverage).filter(l => typeof l === 'number' && !isNaN(l));
                if (validLeverages.length > 0) {
                    leverages[cleanSymbol(symbol)] = Math.max(...validLeverages);
                } else {
                    console.warn(`[CACHE] ⚠️ Binance: Không tìm thấy đòn bẩy hợp lệ cho ${cleanSymbol(symbol)}. Dữ liệu tiers:`, symbolTiers);
                    leverages[cleanSymbol(symbol)] = null;
                }
            } else {
                console.warn(`[CACHE] ⚠️ Binance: Dữ liệu tiers không hợp lệ hoặc trống cho ${cleanSymbol(symbol)}. Dữ liệu tiers:`, symbolTiers);
                leverages[cleanSymbol(symbol)] = null;
            }
        }
        return leverages;
    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi khi lấy đòn bẩy cho BINANCEUSDM: ${e.message}. Vui lòng kiểm tra API Key và quyền.`);
        return {};
    }
}

// === LOGIC LẤY ĐÒN BẨY BẰNG REST API TRỰC TIẾP (BINGX) ===
async function getBingXLeverageDirectAPI() {
    console.log('[DEBUG] BINGX: Đang cố gắng lấy đòn bẩy bằng REST API trực tiếp...');
    const leverages = {};
    try {
        const response = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/contracts');
        const data = await response.json();

        if (data.code === 0 && Array.isArray(data.data)) {
            for (const contract of data.data) {
                if (contract.symbol.endsWith('-USDT') && contract.detail && typeof contract.detail.maxLeverage === 'number') {
                    const symbol = cleanSymbol(contract.symbol);
                    leverages[symbol] = contract.detail.maxLeverage;
                    // console.log(`[DEBUG] BINGX - ${symbol}: Đòn bẩy tìm thấy qua REST API: ${contract.detail.maxLeverage}`);
                } else {
                    // console.warn(`[DEBUG] BINGX - Bỏ qua hợp đồng ${contract.symbol} (không phải USDT hoặc thiếu maxLeverage). Chi tiết:`, contract);
                }
            }
            console.log(`[DEBUG] BINGX: Đã lấy thành công ${Object.keys(leverages).length} đòn bẩy qua REST API.`);
        } else {
            console.error('[CACHE] ❌ BINGX: Lỗi hoặc dữ liệu không hợp lệ từ REST API contracts:', data);
        }
    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho BINGX bằng REST API: ${e.message}`);
    }
    return leverages;
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

                // Cố gắng tìm maxLeverage ở các vị trí phổ biến
                if (typeof market?.info?.maxLeverage === 'number') {
                    maxLeverageFound = market.info.maxLeverage;
                } else if (typeof market?.limits?.leverage?.max === 'number') {
                    maxLeverageFound = market.limits.leverage.max;
                } else {
                    console.warn(`[CACHE] ⚠️ ${exchange.id.toUpperCase()}: Không tìm thấy maxLeverage là số cho ${symbol}.`);
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
    console.log('[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...');
    const newCache = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        const exchange = privateExchanges[id];
        try {
            let leverages = {};
            if (id === 'binanceusdm') {
                leverages = await getBinanceLeverage(exchange);
                const count = Object.values(leverages).filter(v => v !== null).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'fetchLeverageTiers'.`);
            } else if (id === 'bingx') {
                leverages = await getBingXLeverageDirectAPI(); // Dùng REST API trực tiếp cho BingX
                const count = Object.values(leverages).filter(v => v !== null).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy qua REST API trực tiếp.`);
            }
            else { // OKX, Bitget dùng generic CCXT
                leverages = await getGenericLeverage(exchange);
                const count = Object.values(leverages).filter(v => v !== null).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'loadMarkets' (dự phòng).`);
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
            const exchange = publicExchanges[id];
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
                if (!rate1Data.maxLeverage || !rate2Data.maxLeverage) continue;
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
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi số 21) đang chạy tại http://localhost:${PORT}`);
    await initializeLeverageCache();
    await masterLoop();
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
