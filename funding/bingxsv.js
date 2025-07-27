const http = require('http');
const https = require('https'); // Giữ lại vì có thể cần cho fetch nội bộ khác trong tương lai, nhưng không dùng trực tiếp cho API sàn nữa
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt'); // Thư viện chính
// const crypto = require('crypto'); // Không còn cần cho signing riêng
// const Binance = require('node-binance-api'); // Không còn cần node-binance-api

const PORT = 5001;

// ----- CẤU HÌNH -----
// Đảm bảo ID của các sàn khớp với tên module trong CCXT
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.00001;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
// API Key/Secret của Binance (Binance Futures)
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88TzvmC3SpT9nEf4fcDf0pEnFzoTc';
// API Key/Secret của BingX
const bingxApiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const bingxApiSecret = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';
// API Key/Secret/Passphrase của OKX
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
// API Key/Secret của Bitget
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';


// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;

// Không còn cần client Binance riêng, CCXT sẽ xử lý tất cả
// const binanceClient = new Binance().options({ APIKEY: binanceApiKey, APISECRET: binanceApiSecret });

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = { 'options': { 'defaultType': 'swap' } }; // Luôn sử dụng swap/futures

    // Cấu hình API Key/Secret/Passphrase cho CCXT
    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }
    else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
    exchanges[id].enableRateLimit = true; // Bật giới hạn tỷ lệ mặc định của CCXT
});


const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

// Hàm này không còn cần thiết vì BingX sẽ dùng CCXT
// const formatBingXApiSymbol = (ccxtSymbol) => {
//     let base = ccxtSymbol.replace(/\/USDT/g, '').replace(/:USDT/g, '').replace(/\/USDC/g, '').replace(/:USDC/g, '').replace(/-USDT$/g, '').replace(/-USDC$/g, '');
//     return `${base.toUpperCase()}-USDT`;
// };

// Hàm signBingX không còn cần thiết
// function signBingX(queryString, secret) {
//     return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
// }

// === HÀM LẤY ĐÒN BẨY TỐI ĐA CHUNG (Dùng cho mọi sàn qua CCXT) ===
function getMaxLeverageFromMarketInfo(market, exchangeId) {
    // Ưu tiên market.limits.leverage.max (cách chuẩn của CCXT)
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) {
        return market.limits.leverage.max;
    }
    // Nếu không có, tìm trong market.info (tùy thuộc vào sàn, CCXT sẽ parse vào đây)
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

// === KHỞI TẠO VÀ LÀM MỚI BỘ NHỚ ĐỆM ĐÒN BẨY (Tất cả dùng CCXT) ===
async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id];
        newCache[id] = {};
        try {
            // Ưu tiên fetchLeverageTiers nếu sàn hỗ trợ (thường đáng tin cậy hơn)
            if (exchange.has['fetchLeverageTiers']) {
                const leverageTiers = await exchange.fetchLeverageTiers();
                for (const symbol in leverageTiers) {
                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        const parsedMaxLeverage = parseInt(Math.max(...tiers.map(t => t.leverage)), 10);
                        if (!isNaN(parsedMaxLeverage) && parsedMaxLeverage > 0) {
                            newCache[id][cleanSymbol(symbol)] = parsedMaxLeverage;
                        } else console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ cho ${symbol} từ fetchLeverageTiers.`);
                    }
                }
            } else { // Dự phòng: dùng loadMarkets và getMaxLeverageFromMarketInfo
                await exchange.loadMarkets(true); // Luôn tải lại để có dữ liệu thị trường mới nhất
                for (const market of Object.values(exchange.markets)) {
                    // Lọc các thị trường swap USDT
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
            console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy.`);
            return { id, status: 'fulfilled' };
        } catch (e) {
            console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}.`);
            newCache[id] = {}; 
            return { id, status: 'rejected', reason: e.message };
        }
    });
    await Promise.allSettled(promises); // Chờ tất cả các promise hoàn thành
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
}

// === HÀM LẤY FUNDING RATES CHO TẤT CẢ CÁC SÀN (Tất cả dùng CCXT) ===
async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    const promises = EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            let processedRates = {};
            
            // fetchFundingRates của CCXT sẽ lấy cả funding rate và next funding time
            const fundingRatesRaw = await exchange.fetchFundingRates();
            for (const rate of Object.values(fundingRatesRaw)) {
                const symbolCleaned = cleanSymbol(rate.symbol);
                const maxLeverage = leverageCache[id]?.[symbolCleaned] || null; // Lấy từ cache đòn bẩy đã có
                
                // CCXT cung cấp fundingTimestamp hoặc nextFundingTime, dùng fallback nếu cần
                const fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();

                // Kiểm tra lại dữ liệu trước khi lưu
                if (typeof rate.fundingRate === 'number' && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                     processedRates[symbolCleaned] = {
                        symbol: symbolCleaned,
                        fundingRate: rate.fundingRate,
                        fundingTimestamp: fundingTimestamp,
                        maxLeverage: maxLeverage
                    };
                } else {
                    console.warn(`[DATA] ⚠️ ${id.toUpperCase()}: Dữ liệu funding rate hoặc timestamp không hợp lệ cho ${rate.symbol}. Rate: ${rate.fundingRate}, Time: ${fundingTimestamp}.`);
                }
            }
            console.log(`[DATA] ✅ ${id.toUpperCase()}: Đã lấy thành công ${Object.keys(processedRates).length} funding rates.`);
            return { id, status: 'fulfilled', rates: processedRates };
        } catch (e) {
            console.error(`[DATA] ❌ Lỗi khi lấy funding từ ${id.toUpperCase()}: ${e.message}.`);
            return { id, status: 'rejected', reason: e.message };
        }
    });
    const results = await Promise.allSettled(promises);

    results.forEach(result => {
        if (result.status === 'fulfilled') {
            freshData[result.value.id] = { rates: result.value.rates };
        } else {
            console.warn(`[DATA] ⚠️ ${result.value?.id?.toUpperCase() || 'UNKNOWN'}: Không thể cập nhật funding rates. Nguyên nhân: ${result.reason}.`);
            if (!exchangeData[result.value?.id]) { 
                exchangeData[result.value.id] = { rates: {} }; // Khởi tạo rỗng nếu chưa có dữ liệu cũ
            }
        }
    });
    return freshData;
}

// Hàm tính toán thời gian funding tiêu chuẩn nếu không có từ API (fallback)
function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);
    const nextFundingDate = new Date(now);
    if (nextHourUTC === undefined) { // Nếu đã qua 16:00 UTC, thì là 00:00 UTC của ngày hôm sau
        nextHourUTC = fundingHoursUTC[0];
        nextFundingDate.setUTCDate(now.getUTCDate() + 1);
    }
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0); // Đặt giờ, phút, giây, mili giây về 0
    return nextFundingDate.getTime();
}

// === LOGIC TÍNH TOÁN CƠ HỘI ARBITRAGE ===
function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData)); // Deep copy để đảm bảo tính bất biến

    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;

            // Bỏ qua nếu thiếu dữ liệu rates cho một trong hai sàn
            if (!exchange1Rates || !exchange2Rates || Object.keys(exchange1Rates).length === 0 || Object.keys(exchange2Rates).length === 0) {
                continue;
            }

            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);

            // Bỏ qua nếu không có symbol chung
            if (commonSymbols.length === 0) {
                continue;
            }

            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol];
                const rate2Data = exchange2Rates[symbol];

                // Kiểm tra đòn bẩy hợp lệ: phải là số và > 0
                if (typeof rate1Data.maxLeverage !== 'number' || rate1Data.maxLeverage <= 0 ||
                    typeof rate2Data.maxLeverage !== 'number' || rate2Data.maxLeverage <= 0) {
                    continue; 
                }

                // Kiểm tra Funding Rate và Timestamp có tồn tại và hợp lệ không
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

                // Chỉ xem xét nếu có sự khác biệt dương đáng kể
                if (fundingDiff <= FUNDING_DIFFERENCE_THRESHOLD) {
                    continue;
                }

                const commonLeverage = Math.min(longRate.maxLeverage, shortRate.maxLeverage);
                const estimatedPnl = fundingDiff * commonLeverage * 100; // PnL ước tính cho $100 vốn

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

// === VÒNG LẶP CHÍNH CẬP NHẬT DỮ LIỆU ===
async function masterLoop() {
    console.log(`\n[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})...`);
    
    // 1. Cập nhật cache đòn bẩy (tất cả dùng CCXT)
    await initializeLeverageCache(); 

    // 2. Lấy dữ liệu funding rate từ tất cả các sàn (tất cả dùng CCXT)
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData; // Cập nhật dữ liệu vào biến toàn cục

    // 3. Tính toán cơ hội arbitrage
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP]   => Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
    scheduleNextLoop();
}

// === HÀM LÊN LỊCH CHO VÒNG LẶP TIẾP THEO ===
function scheduleNextLoop() {
    clearTimeout(loopTimeoutId);
    const now = new Date();
    // Lên lịch để chạy 5 giây sau đầu phút tiếp theo (ví dụ: 00:00:05, 00:01:05)
    const delaySeconds = (60 - now.getSeconds() + 5) % 60; 
    const delayMs = (delaySeconds === 0 ? 60 : delaySeconds) * 1000;
    console.log(`[SCHEDULER] Vòng lặp kế tiếp sau ${delaySeconds.toFixed(1)} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delayMs);
}

// === KHỞI TẠO SERVER HTTP ===
const server = http.createServer((req, res) => {
    // Phục vụ file index.html
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); res.end('Lỗi khi đọc index.html'); return; }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } 
    // Endpoint API để client fetch dữ liệu
    else if (req.url === '/api/data' && req.method === 'GET') {
        const responseData = {
            lastUpdated: lastFullUpdateTimestamp,
            arbitrageData: arbitrageOpportunities,
            rawRates: {
                // Dữ liệu raw rates từ tất cả các sàn
                binance: Object.values(exchangeData.binanceusdm?.rates || {}),
                bingx: Object.values(exchangeData.bingx?.rates || {}), 
                okx: Object.values(exchangeData.okx?.rates || {}),
                bitget: Object.values(exchangeData.bitget?.rates || {}),
            }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } 
    // Xử lý các request không khớp
    else {
        res.writeHead(404); res.end('Not Found');
    }
});

// === KHỞI ĐỘNG SERVER ===
server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu (SỬ DỤNG HOÀN TOÀN CCXT) đang chạy tại http://localhost:${PORT}`);
    // Bắt đầu vòng lặp chính ngay khi server khởi động
    await masterLoop(); 
    // Đặt lịch làm mới cache đòn bẩy định kỳ (nếu initializeLeverageCache không được gọi trong masterLoop đủ thường xuyên)
    // Hiện tại masterLoop đã gọi initializeLeverageCache() ở mỗi vòng lặp, nên dòng này có thể thừa.
    // Giữ lại nếu bạn muốn có một lịch trình refresh leverage riêng biệt, ít thường xuyên hơn.
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
