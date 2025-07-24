// sv1.js (BẢN SỬA LỖI LOGIC THỜI GIAN TRIỆT ĐỂ)

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

// ----- BIẾN TOÀN CỤC -----
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;

const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    exchanges[id] = new exchangeClass({ 'options': { 'defaultType': 'swap' } });
});

const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '');

function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = -1;
    for (const hour of fundingHoursUTC) {
        if (now.getUTCHours() < hour) {
            nextHourUTC = hour;
            break;
        }
    }
    const nextFundingDate = new Date(now.getTime());
    nextFundingDate.setUTCHours(nextFundingDate.getUTCHours(), 0, 0, 0);
    if (nextHourUTC !== -1) {
        nextFundingDate.setUTCHours(nextHourUTC);
    } else {
        nextFundingDate.setUTCDate(now.getUTCDate() + 1);
        nextFundingDate.setUTCHours(0);
    }
    return nextFundingDate.getTime();
}

async function fetchAllExchangeData() {
    const results = await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            await exchange.loadMarkets();
            const fundingRatesRaw = await exchange.fetchFundingRates();
            const processedRates = {};
            for (const rate of Object.values(fundingRatesRaw)) {
                const symbol = cleanSymbol(rate.symbol);
                const marketInfo = exchange.markets[rate.symbol];
                if (rate && typeof rate.fundingRate === 'number' && marketInfo) {
                    let timestamp = rate.fundingTimestamp || rate.nextFundingTime || null;
                    if (id === 'bitget' && !timestamp) {
                        timestamp = calculateNextStandardFundingTime();
                    }
                    processedRates[symbol] = {
                        symbol: symbol,
                        fundingRate: rate.fundingRate,
                        fundingTimestamp: timestamp,
                        maxLeverage: marketInfo.limits?.leverage?.max || marketInfo.info?.maxLeverage || 75
                    };
                }
            }
            return { id, status: 'success', rates: processedRates };
        } catch (e) {
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) {
                console.warn(`- Lỗi khi lấy dữ liệu từ ${id.toUpperCase()}: ${e.constructor.name} - ${e.message}`);
            }
            return { id, status: 'error', rates: {} };
        }
    }));

    const freshData = {};
    results.forEach(result => {
        if (result.status === 'success') {
            freshData[result.id] = { rates: result.rates };
        }
    });
    return freshData;
}


// === HÀM CHUẨN HÓA THỜI GIAN (LOGIC SỬA LỖI CỐT LÕI) ===
function standardizeFundingTimes(data) {
    const allSymbols = new Set();
    Object.values(data).forEach(ex => {
        if (ex.rates) Object.keys(ex.rates).forEach(symbol => allSymbols.add(symbol));
    });

    const authoritativeTimes = {};
    // Bước 1: Tạo bản đồ thời gian chuẩn cho từng coin
    allSymbols.forEach(symbol => {
        const binanceTime = data.binanceusdm?.rates[symbol]?.fundingTimestamp;
        const okxTime = data.okx?.rates[symbol]?.fundingTimestamp;

        if (binanceTime && okxTime) authoritativeTimes[symbol] = Math.max(binanceTime, okxTime);
        else if (binanceTime) authoritativeTimes[symbol] = binanceTime;
        else if (okxTime) authoritativeTimes[symbol] = okxTime;
        else authoritativeTimes[symbol] = calculateNextStandardFundingTime(); // Phương án cuối
    });

    // Bước 2: Ghi đè thời gian trên tất cả các sàn bằng thời gian chuẩn
    Object.values(data).forEach(ex => {
        if (ex.rates) {
            Object.keys(ex.rates).forEach(symbol => {
                if (authoritativeTimes[symbol]) {
                    ex.rates[symbol].fundingTimestamp = authoritativeTimes[symbol];
                }
            });
        }
    });

    return data;
}


function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    
    // Tạo bản sao dữ liệu đã được chuẩn hóa để tính toán
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));

    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;
            if (!exchange1Rates || !exchange2Rates) continue;

            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);
            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol], rate2Data = exchange2Rates[symbol];

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
                    // Thời gian bây giờ đã được chuẩn hóa, chỉ cần lấy từ bất kỳ sàn nào
                    const finalFundingTime = rate1Data.fundingTimestamp; 

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

// ----- Vòng lặp chính đã được cập nhật -----
async function masterLoop() {
    console.log(`[${new Date().toISOString()}] Vòng lặp chính bắt đầu...`);
    
    // 1. Lấy dữ liệu mới
    const freshData = await fetchAllExchangeData();
    
    // 2. Chuẩn hóa thời gian TRƯỚC KHI LÀM BẤT CỨ ĐIỀU GÌ KHÁC
    exchangeData = standardizeFundingTimes(freshData);
    
    // 3. Tính toán arbitrage với dữ liệu đã được chuẩn hóa
    calculateArbitrageOpportunities();
    
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`   => Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
}

// ----- CÁC HÀM KHỞI ĐỘNG VÀ MÁY CHỦ -----
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
            // Gửi đi dữ liệu đã được chuẩn hóa
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
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi triệt để) đang chạy tại http://localhost:${PORT}`);
    await masterLoop(); // Chạy lần đầu
    setInterval(masterLoop, 60 * 1000); // Lặp lại mỗi phút
});
