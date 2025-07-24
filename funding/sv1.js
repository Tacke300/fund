// sv1.js (BẢN HOÀN THIỆN CUỐI CÙNG - SỬA LỖI ĐÒN BẨY & LỊCH THÔNG MINH)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
// YÊU CẦU 2: LÀM MỚI CACHE ĐÒN BẨY MỖI 30 PHÚT
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null; // ID cho bộ lập lịch

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    exchanges[id] = new exchangeClass({ 'options': { 'defaultType': 'swap' } });
});

const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '');

// === SỬA LỖI CỐT LÕI: HÀM LẤY ĐÒN BẨY VỚI LOGIC RIÊNG CHO BINANCE ===
function getMaxLeverageFromMarket(market, exchangeId) {
    // Ưu tiên logic cho Binance vì cấu trúc đặc biệt
    if (exchangeId === 'binanceusdm') {
        // Đòn bẩy của Binance nằm trong 'brackets'
        if (Array.isArray(market?.info?.brackets) && market.info.brackets.length > 0) {
            const initialLeverage = parseInt(market.info.brackets[0].initialLeverage, 10);
            if (!isNaN(initialLeverage)) return initialLeverage;
        }
    }

    // Logic chung cho các sàn khác
    const potentialValues = [
        market?.limits?.leverage?.max,
        market?.info?.maxLeverage,
        market?.info?.leverage,
        market?.info?.leverage_ratio,
        market?.info?.max_leverage
    ];

    for (const value of potentialValues) {
        if (value !== undefined && value !== null) {
            const leverage = parseInt(value, 10);
            if (!isNaN(leverage) && leverage > 0) return leverage;
        }
    }
    return null; // Trả về null nếu không tìm thấy
}

async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            await exchange.loadMarkets(true);
            newCache[id] = {};
            for (const market of Object.values(exchange.markets)) {
                if (market.swap && market.quote === 'USDT') {
                    const symbol = cleanSymbol(market.symbol);
                    // Truyền `id` vào hàm để có logic riêng
                    const maxLeverage = getMaxLeverageFromMarket(market, id);
                    newCache[id][symbol] = maxLeverage;
                }
            }
            console.log(`[CACHE] ✅ Đã cache thành công đòn bẩy cho ${id.toUpperCase()}`);
        } catch (e) {
            console.warn(`[CACHE] ❌ Lỗi khi cache đòn bẩy cho ${id.toUpperCase()}: ${e.message}`);
        }
    }));
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
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
                const maxLeverage = leverageCache[id]?.[symbol];

                if (maxLeverage !== undefined) {
                     processedRates[symbol] = {
                        symbol: symbol,
                        fundingRate: rate.fundingRate,
                        fundingTimestamp: rate.fundingTimestamp || rate.nextFundingTime,
                        maxLeverage: maxLeverage
                    };
                }
            }
            return { id, status: 'success', rates: processedRates };
        } catch (e) {
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) { console.warn(`- Lỗi funding từ ${id.toUpperCase()}: ${e.message}`); }
            return { id, status: 'error', rates: {} };
        }
    }));

    results.forEach(result => { if (result.status === 'success') { freshData[result.id] = { rates: result.rates }; }});
    return freshData;
}

function standardizeFundingTimes(data) {
    const allSymbols = new Set();
    Object.values(data).forEach(ex => { if (ex.rates) Object.keys(ex.rates).forEach(symbol => allSymbols.add(symbol)); });

    const authoritativeTimes = {};
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];

    allSymbols.forEach(symbol => {
        const binanceTime = data.binanceusdm?.rates[symbol]?.fundingTimestamp;
        const okxTime = data.okx?.rates[symbol]?.fundingTimestamp;

        if (binanceTime && okxTime) authoritativeTimes[symbol] = Math.max(binanceTime, okxTime);
        else if (binanceTime) authoritativeTimes[symbol] = binanceTime;
        else if (okxTime) authoritativeTimes[symbol] = okxTime;
        else {
             let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h) ?? fundingHoursUTC[0];
             const nextFundingDate = new Date(now);
             nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
             if(now.getUTCHours() >= fundingHoursUTC[fundingHoursUTC.length - 1]) { nextFundingDate.setUTCDate(now.getUTCDate() + 1); }
             authoritativeTimes[symbol] = nextFundingDate.getTime();
        }
    });

    Object.values(data).forEach(ex => {
        if (ex.rates) {
            Object.values(ex.rates).forEach(rate => {
                if (authoritativeTimes[rate.symbol]) { rate.fundingTimestamp = authoritativeTimes[rate.symbol]; }
            });
        }
    });
    return data;
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
                    const finalFundingTime = rate1Data.fundingTimestamp;
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

// === LOGIC MỚI: BỘ LẬP LỊCH THÔNG MINH ===
function scheduleNextLoop() {
    clearTimeout(loopTimeoutId); // Xóa lịch cũ đề phòng

    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    let delay = (60 - seconds) * 1000; // Mặc định là chạy vào đầu phút tiếp theo
    let nextRunReason = "Lịch trình mặc định (đầu phút tiếp theo)";

    // Phút 59, và chưa qua giây 30 -> Lên lịch chạy lúc 59:30
    if (minutes === 59 && seconds < 30) {
        delay = (30 - seconds) * 1000;
        nextRunReason = `Cập nhật cường độ cao lúc ${minutes}:30`;
    }
    // Từ phút 55 đến 58 -> Lên lịch chạy lúc 59:00
    else if (minutes >= 55 && minutes < 59) {
        delay = ((58 - minutes) * 60 + (60 - seconds)) * 1000;
        nextRunReason = `Chuẩn bị cho cập nhật lúc 59:00`;
    }

    console.log(`[SCHEDULER] ${nextRunReason}. Vòng lặp kế tiếp sau ${(delay / 1000).toFixed(1)} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delay);
}

async function masterLoop() {
    console.log(`[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()}...`);
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = standardizeFundingTimes(freshFundingData);
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP]   => Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);

    // Lên lịch cho lần chạy tiếp theo
    scheduleNextLoop();
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
    console.log(`✅ Máy chủ dữ liệu (Bản Hoàn Thiện) đang chạy tại http://localhost:${PORT}`);

    // 1. Khởi tạo cache đòn bẩy lần đầu
    await initializeLeverageCache();

    // 2. Chạy vòng lặp chính lần đầu tiên
    await masterLoop();

    // 3. Đặt lịch làm mới cache đòn bẩy (đúng 30 phút)
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
