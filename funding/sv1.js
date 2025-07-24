// sv1.js (BẢN HOÀN CHỈNH - HIỂN THỊ TẤT CẢ CƠ HỘI & SỬA LỖI LOGIC)

const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
// YÊU CẦU 1: CỨ TRÊN 15% LÀ HIỂN THỊ
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15; // Ngưỡng để kích hoạt hiệu ứng nhấp nháy

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

async function fetchAndProcessDataForExchange(exchangeId) {
    const exchange = exchanges[exchangeId];
    try {
        await exchange.loadMarkets();
        const fundingRatesRaw = await exchange.fetchFundingRates();
        const processedRates = {};
        for (const rate of Object.values(fundingRatesRaw)) {
            const symbol = cleanSymbol(rate.symbol);
            const marketInfo = exchange.markets[rate.symbol];
            if (rate && typeof rate.fundingRate === 'number' && marketInfo) {
                let timestamp = rate.fundingTimestamp || rate.nextFundingTime || null;
                if (exchangeId === 'bitget' && !timestamp) {
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
        return { id: exchangeId, status: 'success', rates: processedRates };
    } catch (e) {
        if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) {
            console.warn(`- Lỗi khi lấy dữ liệu từ ${exchangeId.toUpperCase()}: ${e.constructor.name} - ${e.message}`);
        }
        return { id: exchangeId, status: 'error', rates: {} };
    }
}

async function updateAllData() {
    console.log(`[${new Date().toISOString()}] Bắt đầu cập nhật dữ liệu...`);
    const results = await Promise.all(EXCHANGE_IDS.map(id => fetchAndProcessDataForExchange(id)));
    exchangeData = {};
    results.forEach(result => {
        if (result.status === 'success') {
            exchangeData[result.id] = { rates: result.rates };
        }
    });
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log("✅ Cập nhật dữ liệu thành công!");
}

// YÊU CẦU 2: HÀM LOGIC LẤY THỜI GIAN FUNDING ƯU TIÊN
function getAuthoritativeFundingTime(symbol, allExchangeData) {
    const binanceTime = allExchangeData.binanceusdm?.rates[symbol]?.fundingTimestamp;
    const okxTime = allExchangeData.okx?.rates[symbol]?.fundingTimestamp;

    if (binanceTime && okxTime) return Math.max(binanceTime, okxTime);
    if (binanceTime) return binanceTime;
    if (okxTime) return okxTime;
    return calculateNextStandardFundingTime();
}

// === LOGIC TÍNH TOÁN ĐÚNG: HIỂN THỊ TẤT CẢ CÁC CẶP THỎA MÃN ĐIỀU KIỆN ===
function calculateArbitrageOpportunities() {
    // KHỞI TẠO MỘT MẢNG RỖNG ĐỂ CHỨA TẤT CẢ CÁC CƠ HỘI TÌM ĐƯỢC
    const allFoundOpportunities = []; 
    const allSymbols = new Set();
    
    // Tạo bản sao của exchangeData để đảm bảo dữ liệu nhất quán trong một lần chạy
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));

    Object.values(currentExchangeData).forEach(data => {
        if(data.rates) Object.keys(data.rates).forEach(symbol => allSymbols.add(symbol));
    });

    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i];
            const exchange2Id = EXCHANGE_IDS[j];
            
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates;
            const exchange2Rates = currentExchangeData[exchange2Id]?.rates;

            if (!exchange1Rates || !exchange2Rates) continue;

            // Tìm các coin chung giữa 2 sàn
            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);

            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol];
                const rate2Data = exchange2Rates[symbol];

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

                // NẾU THỎA MÃN ĐIỀU KIỆN PNL >= 15, THÊM NGAY VÀO DANH SÁCH
                if (estimatedPnl >= MINIMUM_PNL_THRESHOLD) {
                    // Áp dụng logic thời gian ưu tiên cho coin này
                    const finalFundingTime = getAuthoritativeFundingTime(symbol, currentExchangeData);

                    const minutesUntilFunding = (finalFundingTime - Date.now()) / (1000 * 60);
                    const isImminent = minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES;

                    const opportunity = {
                        coin: symbol,
                        exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                        fundingDiff: parseFloat(fundingDiff.toFixed(6)),
                        nextFundingTime: finalFundingTime,
                        commonLeverage: commonLeverage,
                        estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                        isImminent: isImminent,
                    };
                    
                    // Thêm trực tiếp vào mảng, không cần so sánh "tốt nhất"
                    allFoundOpportunities.push(opportunity);
                }
            }
        }
    }
    
    // YÊU CẦU 3: SẮP XẾP TẤT CẢ CÁC CƠ HỘI TÌM ĐƯỢC THEO 2 CẤP ĐỘ
    arbitrageOpportunities = allFoundOpportunities.sort((a, b) => {
        if (a.nextFundingTime < b.nextFundingTime) return -1;
        if (a.nextFundingTime > b.nextFundingTime) return 1;
        return b.estimatedPnl - a.estimatedPnl;
    });
}


// ----- CÁC HÀM KHỞI ĐỘNG VÀ MÁY CHỦ (Không thay đổi) -----
function masterLoop() {
    setInterval(async () => {
        console.log(`[${new Date().toISOString()}] Đang cập nhật và tính toán...`);
        await updateAllData();
        calculateArbitrageOpportunities();
        console.log(`   => Tìm thấy ${arbitrageOpportunities.length} cơ hội arbitrage thỏa mãn điều kiện.`);
    }, 60 * 1000);
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
    console.log(`✅ Máy chủ dữ liệu (Bản Hoàn Chỉnh) đang chạy tại http://localhost:${PORT}`);
    await updateAllData();
    calculateArbitrageOpportunities();
    masterLoop();
});
