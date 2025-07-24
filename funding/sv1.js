// sv1.js (BẢN SỬA LỖI SỐ 6 - SỬA LỖI `null` ĐÒN BẨY VỚI PHƯƠNG PHÁP MỚI)

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
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;

// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;

const exchanges = {};

// Tạo instance cho từng sàn, bạn nhập API Key, Secret cho BingX nếu cần
EXCHANGE_IDS.forEach(id => {
    if (id === 'bingx') {
        exchanges[id] = new ccxt.bingx({
            apiKey: 'WhRrdudEgBMTiFnTiqrZe2LlNGeK68lcMAZhOyn0AY00amysW5ep2LJ45smFxONwoIE0l72b4zc5muDGw',        // <-- Nhập API Key BingX của bạn tại đây
            secret: 'IDNVPQkBYo2WaxdgzbJlkGQvmvJmPXET5JTyqcZxThb16a2kZNU7M5LKLJicA2hLtckejMtyFzPA ',        // <-- Nhập Secret BingX của bạn tại đây
            options: { defaultType: 'swap' },
        });
        // Nếu cần custom thêm HMAC hoặc headers, có thể bổ sung ở đây (ccxt bingx chuẩn hỗ trợ HMAC)
    } else {
        const exchangeClass = ccxt[id];
        exchanges[id] = new exchangeClass({ options: { defaultType: 'swap' } });
    }
});

const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '');

// === HÀM LẤY ĐÒN BẨY ĐÃ VIẾT LẠI HOÀN TOÀN ===
function getMaxLeverageFromMarket(market, exchangeId) {
    // Tầng 1: Logic đặc biệt cho Binance (quan trọng nhất)
    if (exchangeId === 'binanceusdm') {
        if (Array.isArray(market?.info?.brackets) && market.info.brackets.length > 0) {
            const initialLeverage = parseInt(market.info.brackets[0].initialLeverage, 10);
            if (!isNaN(initialLeverage) && initialLeverage > 0) {
                return initialLeverage;
            }
        }
    }

    // Tầng 1.5: Logic riêng cho BingX (do ccxt bingx chưa chuẩn hoặc thiếu)
    if (exchangeId === 'bingx') {
        // BingX thường có maxLeverage trong market.info.maxLeverage hoặc tương tự
        if (typeof market?.info?.maxLeverage === 'string' || typeof market?.info?.maxLeverage === 'number') {
            const leverage = parseInt(market.info.maxLeverage, 10);
            if (!isNaN(leverage) && leverage > 0) {
                return leverage;
            }
        }
        // Thử thêm tìm các key chứa "leverage" nếu trên không có
        if (typeof market?.info === 'object' && market.info !== null) {
            for (const key in market.info) {
                if (key.toLowerCase().includes('leverage')) {
                    const value = market.info[key];
                    const leverage = parseInt(value, 10);
                    if (!isNaN(leverage) && leverage > 0) {
                        return leverage;
                    }
                }
            }
        }
    }

    // Tầng 2: Logic chuẩn của CCXT
    if (typeof market?.limits?.leverage?.max === 'number') {
        return market.limits.leverage.max;
    }

    // Tầng 3: "Săn lùng" thông minh trong object 'info' (dành cho sàn khác)
    if (typeof market?.info === 'object' && market.info !== null) {
        for (const key in market.info) {
            if (key.toLowerCase().includes('leverage')) {
                const value = market.info[key];
                const leverage = parseInt(value, 10);
                if (!isNaN(leverage) && leverage > 0) {
                    return leverage;
                }
            }
        }
    }

    // Nếu tất cả đều thất bại, trả về null
    return null;
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
                    const maxLeverage = getMaxLeverageFromMarket(market, id);
                    newCache[id][symbol] = maxLeverage;
                }
            }
            // Log ra một vài ví dụ để kiểm tra
            const sampleSymbols = ['BTC', 'ETH', '1000PEPE'];
            let logSample = '';
            for(const s of sampleSymbols) {
                if(newCache[id][s] !== undefined) {
                    logSample += ` ${s}: ${newCache[id][s] || 'null'} |`;
                }
            }
            console.log(`[CACHE] ✅ ${id.toUpperCase()} (Ví dụ: |${logSample})`);
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
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) { 
                console.warn(`- Lỗi funding từ ${id.toUpperCase()}: ${e.message}`);
            }
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
        if (a.nextFundingTime < b.nextFunding
