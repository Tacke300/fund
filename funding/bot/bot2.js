const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { URLSearchParams } = require('url');

const safeLog = (type, ...args) => {
    try {
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const timestamp = `${hours}:${minutes}`;
        if (typeof console === 'object' && typeof console[type] === 'function') {
            console[type](`[${timestamp} ${type.toUpperCase()}]`, ...args);
        } else {
            const message = `[${timestamp} ${type.toUpperCase()}] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`;
            if (type === 'error' || type === 'warn') {
                process.stderr.write(message);
            } else {
                process.stdout.write(message);
            }
        }
    } catch (e) {
        process.stderr.write(`FATAL LOG ERROR (safeLog itself failed): ${e.message} - Original log: [${type.toUpperCase()}] ${args.join(' ')}\n`);
    }
};

const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('../config.js');

const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';

const MIN_PNL_PERCENTAGE = 1;
const MAX_MINUTES_UNTIL_FUNDING = 30;

const DATA_FETCH_INTERVAL_SECONDS = 5;
const HOURLY_FETCH_TIME_MINUTE = 45; // Hằng số này không được sử dụng trực tiếp trong logic vòng lặp chính.

const SL_PERCENT_OF_COLLATERAL = 700;
const TP_PERCENT_OF_COLLATERAL = 700;

const DISABLED_EXCHANGES = ['bitget'];

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

let botState = 'STOPPED';
let botLoopIntervalId = null;

const exchanges = {};
activeExchangeIds.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = {
        'options': { 'defaultType': 'swap' },
        'enableRateLimit': true,
        'headers': {
            'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)',
        }
    };

    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }

    if ((config.apiKey && config.secret) || (id === 'okx' && config.password) || (id === 'bitget' && config.password && config.apiKey && config.secret)) {
        exchanges[id] = new exchangeClass(config);
    } else {
        safeLog('warn', `[INIT] Bỏ qua khởi tạo ${id.toUpperCase()} vì thiếu API Key/Secret/Password hoặc không hợp lệ.`);
    }
});

let balances = {};
activeExchangeIds.forEach(id => {
    balances[id] = { total: 0, available: 0, originalSymbol: {} };
});
balances.totalOverall = 0;

let initialTotalBalance = 0;
let cumulativePnl = 0;
let tradeHistory = [];

let currentSelectedOpportunityForExecution = null; // Cơ hội được bot tự động chọn để thực thi
let bestPotentialOpportunityForDisplay = null; // Đây là cơ hội tốt nhất được server tính toán và hiển thị (cho UI)
let allCurrentOpportunities = []; // Tất cả cơ hội từ server

const LAST_ACTION_TIMESTAMP = {
    dataFetch: 0,
    selectionTime: 0,
    tradeExecution: 0,
    closeTrade: 0,
};

let currentTradeDetails = null; // Chi tiết về lệnh tự động đang mở
let testTradeDetails = null; // Chi tiết về lệnh test đang mở

let currentPercentageToUse = 50;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        safeLog('error', `[BOT] ❌ Lỗi khi lấy dữ liệu từ server: ${error.message}`, error);
        return null;
    }
}

async function updateBalances() {
    safeLog('log', '[BOT] 🔄 Cập nhật số dư từ các sàn...');
    let currentTotalOverall = 0;
    for (const id of activeExchangeIds) {
        if (!exchanges[id]) {
            safeLog('warn', `[BOT] ${id.toUpperCase()} không được khởi tạo (có thể do thiếu API Key/Secret). Bỏ qua cập nhật số dư.`);
            continue;
        }
        try {
            const exchange = exchanges[id];
            await exchange.loadMarkets(true);

            // Fetch futures balance for trading
            const accountBalance = await exchange.fetchBalance({ 'type': 'future' });
            const usdtFreeBalance = accountBalance.free?.USDT || 0;
            const usdtTotalBalance = accountBalance.total?.USDT || 0;

            balances[id].available = usdtFreeBalance;
            balances[id].total = usdtTotalBalance;

            balances[id].originalSymbol = {};

            currentTotalOverall += balances[id].available;

            safeLog('log', `[BOT] ✅ ${id.toUpperCase()} Balance: Total ${usdtTotalBalance.toFixed(2)} USDT, Available ${balances[id].available.toFixed(2)} USDT.`);
        } catch (e) {
            safeLog('error', `[BOT] ❌ Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`, e);
        }
    }
    balances.totalOverall = currentTotalOverall;
    safeLog('log', `[BOT] Tổng số dư khả dụng trên tất cả các sàn (có thể bao gồm âm): ${currentTotalOverall.toFixed(2)} USDT.`);
    if (initialTotalBalance === 0) {
        initialTotalBalance = currentTotalOverall;
    }
}

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        safeLog('warn', '[BOT] Dữ liệu từ server không hợp lệ hoặc thiếu arbitrageData.');
        bestPotentialOpportunityForDisplay = null;
        allCurrentOpportunities = [];
        return;
    }

    const now = Date.now();
    let bestForDisplay = null;
    const tempAllOpportunities = [];

    serverData.arbitrageData.forEach(op => {
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);

        // Normalize exchange IDs to match ccxt and local names ('binance' -> 'binanceusdm')
        const shortExIdNormalized = op.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.shortExchange.toLowerCase();
        const longExIdNormalized = op.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.longExchange.toLowerCase(); // SỬA LỖI Ở ĐÂY

        if (DISABLED_EXCHANGES.includes(shortExIdNormalized) || DISABLED_EXCHANGES.includes(longExIdNormalized) ||
            !exchanges[shortExIdNormalized] || !exchanges[longExIdNormalized]) {
            return; // Skip if exchange is disabled or not initialized
        }

        if (op.estimatedPnl > 0 && minutesUntilFunding > 0) {
            op.details.minutesUntilFunding = minutesUntilFunding;

            // Ensure these properties exist, or set to N/A
            op.details.shortFundingRate = op.details.shortRate !== undefined ? op.details.shortRate : 'N/A';
            op.details.longFundingRate = op.details.longRate !== undefined ? op.details.longRate : 'N/A';
            op.fundingDiff = op.fundingDiff !== undefined ? op.fundingDiff : 'N/A';
            op.commonLeverage = op.commonLeverage !== undefined ? op.commonLeverage : 'N/A';

            // Re-assign short/long exchange IDs based on rates if they were swapped by server
            let shortExId = op.details.shortExchange;
            let longExId = op.details.longExchange;

            if (typeof op.details.shortFundingRate === 'number' && typeof op.details.longFundingRate === 'number') {
                if (op.details.shortFundingRate < op.details.longFundingRate) {
                    // This means original short was actually long and vice versa
                    shortExId = op.details.longExchange;
                    longExId = op.details.shortExchange;
                }
            }
            op.details.shortExchange = shortExId;
            op.details.longExchange = longExId;

            tempAllOpportunities.push(op);

            // Cập nhật: Chọn cơ hội tốt nhất để hiển thị (ưu tiên thời gian funding gần nhất, sau đó PnL cao nhất)
            if (!bestForDisplay ||
                op.details.minutesUntilFunding < bestForDisplay.details.minutesUntilFunding || // Ưu tiên funding gần hơn
                (op.details.minutesUntilFunding === bestForDisplay.details.minutesUntilFunding && op.estimatedPnl > bestForDisplay.estimatedPnl) // Nếu funding như nhau, ưu tiên PnL cao hơn
            ) {
                bestForDisplay = op;
            }
        }
    });

    allCurrentOpportunities = tempAllOpportunities;

    if (bestForDisplay) {
        bestPotentialOpportunityForDisplay = bestForDisplay;
        // Update estimated trade collateral for display
        const shortExId = bestForDisplay.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : bestForDisplay.details.shortExchange.toLowerCase();
        const longExId = bestForDisplay.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : bestForDisplay.details.longExchange.toLowerCase(); // SỬA LỖI Ở ĐÂY
        const minAvailableBalance = Math.min(balances[shortExId]?.available || 0, balances[longExId]?.available || 0);
        bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (minAvailableBalance * (currentPercentageToUse / 100)).toFixed(2);
    } else {
        bestPotentialOpportunityForDisplay = null;
    }
}


// Modified executeTrades to handle both auto and test trades
async function executeTrades(opportunity, percentageToUse, isTest = false) {
    const tradeType = isTest ? 'TEST_TRADE' : 'AUTO_TRADE';

    if (!opportunity || percentageToUse <= 0) {
        safeLog('warn', `[BOT_${tradeType}] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.`);
        return false;
    }

    if (!opportunity.details || !opportunity.details.shortExchange || !opportunity.details.longExchange ||
        !opportunity.details.shortOriginalSymbol || !opportunity.details.longOriginalSymbol) {
        safeLog('error', `[BOT_${tradeType}] Thông tin chi tiết cơ hội thiếu trường cần thiết (exchange ID hoặc original symbol). Hủy bỏ lệnh.`);
        return false;
    }

    // Check if an existing trade of the same type is already open
    if (isTest && testTradeDetails && testTradeDetails.status === 'OPEN') {
        safeLog('warn', `[BOT_${tradeType}] Đã có lệnh TEST đang mở. Không thể mở thêm lệnh TEST mới.`);
        return false;
    }
    if (!isTest && currentTradeDetails && currentTradeDetails.status === 'OPEN') {
        safeLog('warn', `[BOT_${tradeType}] Đã có lệnh AUTO đang mở. Không thể mở thêm lệnh AUTO mới.`);
        return false;
    }

    const shortExchangeId = opportunity.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : opportunity.details.shortExchange.toLowerCase();
    const longExchangeId = opportunity.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : opportunity.details.longExchange.toLowerCase();

    if (DISABLED_EXCHANGES.includes(shortExchangeId) || DISABLED_EXCHANGES.includes(longExchangeId) ||
        !exchanges[shortExchangeId] || !exchanges[longExchangeId]) {
        safeLog('error', `[BOT_${tradeType}] Bỏ qua thực hiện lệnh vì sàn ${shortExchangeId} hoặc ${longExchangeId} bị tắt hoặc chưa được khởi tạo.`);
        return false;
    }

    const cleanedCoin = opportunity.coin;
    const shortOriginalSymbol = opportunity.details.shortOriginalSymbol;
    const longOriginalSymbol = opportunity.details.longOriginalSymbol;

    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    const minAvailableBalance = Math.min(balances[shortExchangeId]?.available || 0, balances[longExchangeId]?.available || 0);
    const baseCollateralPerSide = minAvailableBalance * (percentageToUse / 100);

    const shortCollateral = baseCollateralPerSide;
    const longCollateral = baseCollateralPerSide; // Assume same collateral for both sides

    if (shortCollateral <= 0 || longCollateral <= 0) {
        safeLog('error', `[BOT_${tradeType}] Số tiền mở lệnh (collateral) không hợp lệ (cần dương). Hủy bỏ lệnh.`);
        return false;
    }
    if (balances[shortExchangeId]?.available < shortCollateral || balances[longExchangeId]?.available < longCollateral) {
        safeLog('error', `[BOT_${tradeType}] Số dư khả dụng không đủ để mở lệnh với vốn ${baseCollateralPerSide.toFixed(2)} USDT mỗi bên. ${shortExchangeId}: ${balances[shortExchangeId]?.available.toFixed(2)}, ${longExchangeId}: ${balances[longExchangeId]?.available.toFixed(2)}. Hủy bỏ lệnh.`);
        return false;
    }

    safeLog('log', `[BOT_${tradeType}] Chuẩn bị mở lệnh cho ${cleanedCoin}:`);
    safeLog('log', `  SHORT ${shortExchangeId} (${shortOriginalSymbol}): ${shortCollateral.toFixed(2)} USDT collateral`);
    safeLog('log', `  LONG ${longExchangeId} (${longOriginalSymbol}): ${longCollateral.toFixed(2)} USDT collateral`);

    let tradeSuccess = true;
    let shortOrder = null, longOrder = null;

    let shortMarket = null;
    let longMarket = null;

    try {
        await shortExchange.loadMarkets(true);
        await longExchange.loadMarkets(true);

        shortMarket = shortExchange.market(shortOriginalSymbol);
        longMarket = longExchange.market(longOriginalSymbol);

        const tickerShort = await shortExchange.fetchTicker(shortOriginalSymbol);
        const tickerLong = await longExchange.fetchTicker(longOriginalSymbol);

        const shortEntryPrice = tickerShort.last;
        const longEntryPrice = tickerLong.last;

        if (!shortEntryPrice || !longEntryPrice) {
            safeLog('error', `[BOT_${tradeType}] Không lấy được giá thị trường hiện tại cho ${cleanedCoin}.`);
            return false;
        }

        const commonLeverage = opportunity.commonLeverage || 1;

        try {
            if (!shortMarket) {
                safeLog('warn', `⚠️ Market cho symbol ${shortOriginalSymbol} không tìm thấy trên ${shortExchangeId}. Bỏ qua đặt đòn bẩy cho bên SHORT.`);
            } else if (shortExchange.has['setLeverage']) {
                const leverageParams = (shortExchangeId === 'bingx') ? { 'side': 'SHORT' } : {};
                await shortExchange.setLeverage(commonLeverage, shortMarket.symbol, leverageParams);
                safeLog('log', `[BOT_${tradeType}] ✅ Đặt đòn bẩy x${commonLeverage} cho SHORT ${shortOriginalSymbol} trên ${shortExchangeId}.`);
            } else {
                safeLog('warn', `[BOT_${tradeType}] ⚠️ Sàn ${shortExchangeId} không hỗ trợ chức năng setLeverage.`);
            }
        } catch (levErr) {
            safeLog('error', `[BOT_${tradeType}] ❌ Lỗi đặt đòn bẩy cho SHORT ${shortOriginalSymbol} trên ${shortExchangeId}: ${levErr.message}. Tiếp tục mà không đảm bảo đòn bẩy.`, levErr);
        }

        try {
            if (!longMarket) {
                safeLog('warn', `⚠️ Market cho symbol ${longOriginalSymbol} không tìm thấy trên ${longExchangeId}. Bỏ qua đặt đòn bẩy cho bên LONG.`);
            } else if (longExchange.has['setLeverage']) {
                const leverageParams = (longExchangeId === 'bingx') ? { 'side': 'LONG' } : {};
                await longExchange.setLeverage(commonLeverage, longMarket.symbol, leverageParams);
                safeLog('log', `[BOT_${tradeType}] ✅ Đặt đòn bẩy x${commonLeverage} cho LONG ${longOriginalSymbol} trên ${longExchangeId}.`);
            } else {
                safeLog('warn', `[BOT_${tradeType}] ⚠️ Sàn ${longExchangeId} không hỗ trợ chức năng setLeverage.`);
            }
        } catch (levErr) {
            safeLog('error', `[BOT_${tradeType}] ❌ Lỗi đặt đòn bẩy cho LONG ${longOriginalSymbol} trên ${longExchangeId}: ${levErr.message}. Tiếp tục mà không đảm bảo đòn bẩy.`, levErr);
        }

        const shortAmount = (shortCollateral * commonLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * commonLeverage) / longEntryPrice;

        if (shortAmount <= 0 || longAmount <= 0) {
            safeLog('error', `[BOT_${tradeType}] Lượng hợp đồng tính toán không hợp lệ (cần dương). Hủy bỏ lệnh.`);
            return false;
        }

        if (!shortMarket || !longMarket) {
            safeLog('error', `[BOT_${tradeType}] Không tìm thấy thông tin thị trường cho ${shortOriginalSymbol} hoặc ${longOriginalSymbol} sau khi loadMarkets.`);
            return false;
        }

        const shortAmountToOrder = shortExchange.amountToPrecision(shortOriginalSymbol, shortAmount);
        const longAmountToOrder = longExchange.amountToPrecision(longOriginalSymbol, longAmount);

        const shortParams = {};
        if (shortExchangeId === 'bingx') {
            shortParams.positionSide = 'SHORT';
        } else if (shortExchangeId === 'binanceusdm') {
            shortParams.positionSide = 'SHORT';
        }

        const longParams = {};
        if (longExchangeId === 'bingx') {
            longParams.positionSide = 'LONG';
        } else if (longExchangeId === 'binanceusdm') {
            longParams.positionSide = 'LONG';
        }

        safeLog('log', `[BOT_${tradeType}] Mở SHORT ${shortAmountToOrder} ${shortOriginalSymbol} trên ${shortExchangeId} với giá ${shortEntryPrice.toFixed(4)}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, parseFloat(shortAmountToOrder), shortParams);
        safeLog('log', `[BOT_${tradeType}] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}, Amount ${shortOrder.amount}, Price ${shortOrder.price}`);

        safeLog('log', `[BOT_${tradeType}] Mở LONG ${longAmountToOrder} ${longOriginalSymbol} trên ${longExchangeId} với giá ${longEntryPrice.toFixed(4)}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, parseFloat(longAmountToOrder), longParams);
        safeLog('log', `[BOT_${tradeType}] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}, Amount ${longOrder.amount}, Price ${longOrder.price}`);

        const tradeInfo = {
            coin: cleanedCoin,
            shortExchange: shortExchangeId,
            longExchange: longExchangeId,
            shortOriginalSymbol: shortOriginalSymbol,
            longOriginalSymbol: longOriginalSymbol,
            shortOrderId: shortOrder.id,
            longOrderId: longOrder.id,
            shortOrderAmount: shortOrder.amount,
            longOrderAmount: longOrder.amount,
            shortEntryPrice: shortEntryPrice,
            longEntryPrice: longEntryPrice,
            shortCollateral: shortCollateral,
            longCollateral: longCollateral,
            commonLeverage: commonLeverage,
            status: 'OPEN',
            openTime: Date.now(),
            type: isTest ? 'test' : 'auto' // Added type field
        };

        if (isTest) {
            safeLog('log', `[BOT_${tradeType}] Setting testTradeDetails for ${cleanedCoin} on ${shortExchangeId}/${longExchangeId}`);
            testTradeDetails = tradeInfo;
        } else {
            safeLog('log', `[BOT_${tradeType}] Setting currentTradeDetails for ${cleanedCoin} on ${shortExchangeId}/${longExchangeId}`);
            currentTradeDetails = tradeInfo;
        }
        safeLog('log', `[BOT_${tradeType}] Trade details set successfully.`);

        safeLog('log', `[BOT_${tradeType}] Đợi 2 giây để gửi lệnh TP/SL...`);
        await sleep(2000);

        const shortTpPrice = shortEntryPrice * (1 - (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const shortSlPrice = shortEntryPrice * (1 + (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));

        const longTpPrice = longEntryPrice * (1 + (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const longSlPrice = longEntryPrice * (1 - (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));

        const shortTpPriceToOrder = shortExchange.priceToPrecision(shortOriginalSymbol, shortTpPrice);
        const shortSlPriceToOrder = shortExchange.priceToPrecision(shortOriginalSymbol, shortSlPrice);
        const longTpPriceToOrder = longExchange.priceToPrecision(longOriginalSymbol, longTpPrice);
        const longSlPriceToOrder = longExchange.priceToPrecision(longOriginalSymbol, longSlPrice);

        if (isTest) {
            testTradeDetails.shortSlPrice = parseFloat(shortSlPriceToOrder);
            testTradeDetails.shortTpPrice = parseFloat(shortTpPriceToOrder);
            testTradeDetails.longSlPrice = parseFloat(longSlPriceToOrder);
            testTradeDetails.longTpPrice = parseFloat(longTpPriceToOrder);
        } else {
            currentTradeDetails.shortSlPrice = parseFloat(shortSlPriceToOrder);
            currentTradeDetails.shortTpPrice = parseFloat(shortTpPriceToOrder);
            currentTradeDetails.longSlPrice = parseFloat(longSlPriceToOrder);
            currentTradeDetails.longTpPrice = parseFloat(longTpPriceToOrder);
        }


        safeLog('log', `[BOT_${tradeType}] Tính toán TP/SL cho ${cleanedCoin}:`);
        safeLog('log', `  Short Entry: ${shortEntryPrice.toFixed(4)}, SL: ${shortSlPriceToOrder}, TP: ${shortTpPriceToOrder}`);
        safeLog('log', `  Long Entry: ${longEntryPrice.toFixed(4)}, SL: ${longSlPriceToOrder}, TP: ${longTpPriceToOrder}`);

        // Đặt TP/SL cho vị thế SHORT
        try {
            const shortTpSlParams = {};
            if (shortExchangeId === 'bingx') {
                shortTpSlParams.positionSide = 'SHORT';
            } else if (shortExchangeId === 'binanceusdm') {
                shortTpSlParams.positionSide = 'SHORT';
            }

            if (parseFloat(shortSlPriceToOrder) > 0) {
                await shortExchange.createOrder(
                    shortOriginalSymbol,
                    'STOP_MARKET',
                    'buy',
                    shortOrder.amount,
                    undefined,
                    { 'stopPrice': parseFloat(shortSlPriceToOrder), ...shortTpSlParams }
                );
                safeLog('log', `[BOT_${tradeType}] ✅ Đặt SL cho SHORT ${shortExchangeId} thành công.`);
            } else {
                safeLog('warn', `[BOT_${tradeType}] ⚠️ Không đặt SL cho SHORT ${shortExchangeId} vì stopPrice <= 0 (${shortSlPriceToOrder}).`);
            }
        } catch (slShortError) {
            safeLog('error', `[BOT_${tradeType}] ❌ Lỗi đặt SL cho SHORT ${shortExchangeId}: ${slShortError.message}. Tiếp tục.`, slShortError);
        }

        try {
            const shortTpSlParams = {};
            if (shortExchangeId === 'bingx') {
                shortTpSlParams.positionSide = 'SHORT';
            } else if (shortExchangeId === 'binanceusdm') {
                shortTpSlParams.positionSide = 'SHORT';
            }

            if (parseFloat(shortTpPriceToOrder) > 0) {
                await shortExchange.createOrder(
                    shortOriginalSymbol,
                    'TAKE_PROFIT_MARKET',
                    'buy',
                    shortOrder.amount,
                    undefined,
                    { 'stopPrice': parseFloat(shortTpPriceToOrder), ...shortTpSlParams }
                );
                safeLog('log', `[BOT_${tradeType}] ✅ Đặt TP cho SHORT ${shortExchangeId} thành công.`);
            } else {
                safeLog('warn', `[BOT_${tradeType}] ⚠️ Không đặt TP cho SHORT ${shortExchangeId} vì stopPrice <= 0 (${shortTpPriceToOrder}).`);
            }
        } catch (tpShortError) {
            safeLog('error', `[BOT_${tradeType}] ❌ Lỗi đặt TP cho SHORT ${shortExchangeId}: ${tpShortError.message}. Tiếp tục.`, tpShortError);
        }

        // Đặt TP/SL cho vị thế LONG
        try {
            const longTpSlParams = {};
            if (longExchangeId === 'bingx') {
                longTpSlParams.positionSide = 'LONG';
            } else if (longExchangeId === 'binanceusdm') {
                longTpSlParams.positionSide = 'LONG';
            }

            if (parseFloat(longSlPriceToOrder) > 0) {
                await longExchange.createOrder(
                    longOriginalSymbol,
                    'STOP_MARKET',
                    'sell',
                    longOrder.amount,
                    undefined,
                    { 'stopPrice': parseFloat(longSlPriceToOrder), ...longTpSlParams }
                );
                safeLog('log', `[BOT_${tradeType}] ✅ Đặt SL cho LONG ${longExchangeId} thành công.`);
            } else {
                safeLog('warn', `[BOT_${tradeType}] ⚠️ Không đặt SL cho LONG ${longExchangeId} vì stopPrice <= 0 (${longSlPriceToOrder}).`);
            }
        } catch (slLongError) {
            safeLog('error', `[BOT_${tradeType}] ❌ Lỗi đặt SL cho LONG ${longExchangeId}: ${slLongError.message}. Tiếp tục.`, slLongError);
        }

        try {
            const longTpSlParams = {};
            if (longExchangeId === 'bingx') {
                longTpSlParams.positionSide = 'LONG';
            } else if (longExchangeId === 'binanceusdm') {
                longTpSlParams.positionSide = 'LONG';
            }

            if (parseFloat(longTpPriceToOrder) > 0) {
                await longExchange.createOrder(
                    longOriginalSymbol,
                    'TAKE_PROFIT_MARKET',
                    'sell',
                    longOrder.amount,
                    undefined,
                    { 'stopPrice': parseFloat(longTpPriceToOrder), ...longTpSlParams }
                );
                safeLog('log', `[BOT_${tradeType}] ✅ Đặt TP cho LONG ${longExchangeId} thành công.`);
            } else {
                safeLog('warn', `[BOT_${tradeType}] ⚠️ Không đặt TP cho LONG ${longExchangeId} vì stopPrice <= 0 (${longTpPriceToOrder}).`);
            }
        } catch (tpLongError) {
            safeLog('error', `[BOT_${tradeType}] ❌ Lỗi đặt TP cho LONG ${longExchangeId}: ${tpLongError.message}. Tiếp tục.`, tpLongError);
        }

    } catch (e) {
        safeLog('error', `[BOT_${tradeType}] ❌ Lỗi khi thực hiện giao dịch (hoặc đặt TP/SL): ${e.message}`, e);
        tradeSuccess = false;
        // Attempt to cancel orders if one side failed
        if (shortOrder?.id) {
            try { await exchanges[shortExchangeId].cancelOrder(shortOrder.id, shortOriginalSymbol); safeLog('log', `[BOT_${tradeType}] Đã hủy lệnh SHORT ${shortExchangeId}: ${shortOrder.id}`); } catch (ce) { safeLog('error', `[BOT_${tradeType}] Lỗi hủy lệnh SHORT: ${ce.message}`, ce); }
        }
        if (longOrder?.id) {
            try { await exchanges[longExchangeId].cancelOrder(longOrder.id, longOriginalSymbol); safeLog('log', `[BOT_${tradeType}] Đã hủy lệnh LONG ${longExchangeId}: ${longOrder.id}`); } catch (ce) { safeLog('error', `[BOT_${tradeType}] Lỗi hủy lệnh LONG: ${ce.message}`, ce); }
        }
        if (isTest) {
            safeLog('log', `[BOT_${tradeType}] testTradeDetails being reset to null due to trade failure.`);
            testTradeDetails = null; // Clear details if trade setup failed
        } else {
            safeLog('log', `[BOT_${tradeType}] currentTradeDetails being reset to null due to trade failure.`);
            currentTradeDetails = null; // Clear details if trade setup failed
        }
    }
    return tradeSuccess;
}

// Modified closeTradesAndCalculatePnL to handle both auto and test trades
async function closeTradesAndCalculatePnL(isTestTrade = false) {
    const tradeType = isTestTrade ? 'TEST_TRADE' : 'AUTO_TRADE';
    let tradeDetailsToClose = isTestTrade ? testTradeDetails : currentTradeDetails;

    if (!tradeDetailsToClose || tradeDetailsToClose.status !== 'OPEN') {
        safeLog('log', `[BOT_PNL_${tradeType}] Không có giao dịch ${tradeType} nào đang mở để đóng.`);
        return;
    }

    safeLog('log', `[BOT_PNL_${tradeType}] 🔄 Đang đóng các vị thế ${tradeType} và tính toán PnL...`);
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount, shortCollateral, longCollateral } = tradeDetailsToClose;

    try {
        safeLog('log', `[BOT_PNL_${tradeType}] Hủy các lệnh TP/SL còn chờ (nếu có)...`);
        // Fetch and cancel specific symbol orders for SHORT side
        try {
            const shortOpenOrders = await exchanges[shortExchange].fetchOpenOrders(shortOriginalSymbol);
            for (const order of shortOpenOrders) {
                if ((order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') && order.status === 'open') {
                    await exchanges[shortExchange].cancelOrder(order.id, shortOriginalSymbol);
                    safeLog('log', `[BOT_PNL_${tradeType}] Đã hủy lệnh chờ ${order.type} ${order.id} cho ${shortOriginalSymbol} trên ${shortExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL_${tradeType}] Lỗi khi hủy lệnh chờ cho ${shortOriginalSymbol} trên ${shortExchange}: ${e.message}`, e); }

        // Fetch and cancel specific symbol orders for LONG side
        try {
            const longOpenOrders = await exchanges[longExchange].fetchOpenOrders(longOriginalSymbol);
            for (const order of longOpenOrders) {
                if ((order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') && order.status === 'open') {
                    await exchanges[longExchange].cancelOrder(order.id, longOriginalSymbol);
                    safeLog('log', `[BOT_PNL_${tradeType}] Đã hủy lệnh chờ ${order.type} ${order.id} cho ${longOriginalSymbol} trên ${longExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL_${tradeType}] Lỗi khi hủy lệnh chờ cho ${longOriginalSymbol} trên ${longExchange}: ${e.message}`, e); }

        const closeShortParams = {};
        if (shortExchange === 'bingx') {
            closeShortParams.positionSide = 'SHORT';
        } else if (shortExchange === 'binanceusdm') {
            closeShortParams.positionSide = 'SHORT';
        }

        const closeLongParams = {};
        if (longExchange === 'bingx') {
            closeLongParams.positionSide = 'LONG';
        } else if (longExchange === 'binanceusdm') {
            closeLongParams.positionSide = 'LONG';
        }

        safeLog('log', `[BOT_PNL_${tradeType}] Đóng vị thế SHORT ${coin} trên ${shortExchange} (amount: ${shortOrderAmount})...`);
        const closeShortOrder = await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount, closeShortParams);
        safeLog('log', `[BOT_PNL_${tradeType}] ✅ Vị thế SHORT trên ${shortExchange} đã đóng. Order ID: ${closeShortOrder.id}`);

        safeLog('log', `[BOT_PNL_${tradeType}] Đóng vị thế LONG ${coin} trên ${longExchange} (amount: ${longOrderAmount})...`);
        const closeLongOrder = await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount, closeLongParams);
        safeLog('log', `[BOT_PNL_${tradeType}] ✅ Vị thế LONG trên ${longExchange} đã đóng. Order ID: ${closeLongOrder.id}`);

        safeLog('log', `[BOT_PNL_${tradeType}] Đợi 30 giây để sàn xử lý dữ liệu PnL...`);
        await sleep(30000);

        let shortSidePnl = 0;
        let longSidePnl = 0;

        try {
            let pnlFound = false;
            const shortTrades = await exchanges[shortExchange].fetchMyTrades(shortOriginalSymbol, undefined, undefined, { orderId: closeShortOrder.id, limit: 10 });
            for (const trade of shortTrades) {
                if (trade.order === closeShortOrder.id && trade.info?.realizedPnl !== undefined) {
                    shortSidePnl = parseFloat(trade.info.realizedPnl);
                    safeLog('log', `[BOT_PNL_${tradeType}] PnL SHORT từ trade ${trade.id} (order ${closeShortOrder.id}): ${shortSidePnl.toFixed(2)} USDT.`);
                    pnlFound = true;
                    break;
                }
            }
            if (!pnlFound) {
                safeLog('warn', `[BOT_PNL_${tradeType}] Không tìm thấy PnL thực tế cho lệnh SHORT ${closeShortOrder.id} trên ${shortExchange} từ trade history. Cập nhật số dư và tính từ đó.`);
                await updateBalances();
                shortSidePnl = (balances[shortExchange]?.available || 0) - tradeDetailsToClose.shortCollateral;
                safeLog('log', `[BOT_PNL_${tradeType}] PnL SHORT tính từ số dư ${shortExchange}: ${shortSidePnl.toFixed(2)} USDT.`);
            }
        } catch (e) {
            safeLog('error', `[BOT_PNL_${tradeType}] ❌ Lỗi khi lấy PnL thực tế cho SHORT ${shortExchange}: ${e.message}`, e);
            await updateBalances();
            shortSidePnl = (balances[shortExchange]?.available || 0) - tradeDetailsToClose.shortCollateral;
            safeLog('log', `[BOT_PNL_${tradeType}] PnL SHORT tính từ số dư (do lỗi): ${shortSidePnl.toFixed(2)} USDT.`);
        }

        try {
            let pnlFound = false;
            if (longExchange === 'bingx') {
                safeLog('log', `[BOT_PNL_${tradeType}] Đợi thêm 5s vì BingX có thể delay trả về realizedPnl...`);
                await sleep(5000);
            }

            const longTrades = await exchanges[longExchange].fetchMyTrades(longOriginalSymbol, undefined, undefined, { orderId: closeLongOrder.id, limit: 10 });
            for (const trade of longTrades) {
                safeLog('debug', `[BOT_PNL_${tradeType}] DEBUG trade.info for ${longExchange} (order ${trade.order}): ${JSON.stringify(trade.info)}`);

                if (trade.order === closeLongOrder.id && trade.info?.realizedPnl !== undefined) {
                    longSidePnl = parseFloat(trade.info.realizedPnl);
                    safeLog('log', `[BOT_PNL_${tradeType}] PnL LONG từ trade ${trade.id} (order ${closeLongOrder.id}): ${longSidePnl.toFixed(2)} USDT.`);
                    pnlFound = true;
                    break;
                }
                else if (trade.order === closeLongOrder.id && trade.info?.pnl !== undefined) {
                    longSidePnl = parseFloat(trade.info.pnl);
                    safeLog('log', `[BOT_PNL_${tradeType}] PnL LONG từ trade ${trade.id} (order ${closeLongOrder.id}, using trade.info.pnl): ${longSidePnl.toFixed(2)} USDT.`);
                    pnlFound = true;
                    break;
                }
            }
            if (!pnlFound) {
                safeLog('warn', `[BOT_PNL_${tradeType}] Không tìm thấy PnL thực tế cho lệnh LONG ${closeLongOrder.id} trên ${longExchange} từ trade history. Cập nhật số dư và tính từ đó. (Phương pháp fallback này đáng tin cậy)`);
                await updateBalances();
                longSidePnl = (balances[longExchange]?.available || 0) - tradeDetailsToClose.longCollateral;
                safeLog('log', `[BOT_PNL_${tradeType}] PnL LONG tính từ số dư ${longExchange}: ${longSidePnl.toFixed(2)} USDT.`);
            }
        } catch (e) {
            safeLog('error', `[BOT_PNL_${tradeType}] ❌ Lỗi khi lấy PnL thực tế cho LONG ${longExchange}: ${e.message}`, e);
            await updateBalances();
            longSidePnl = (balances[longExchange]?.available || 0) - tradeDetailsToClose.longCollateral;
            safeLog('log', `[BOT_PNL_${tradeType}] PnL LONG tính từ số dư (do lỗi): ${longSidePnl.toFixed(2)} USDT.`);
        }

        const cyclePnl = shortSidePnl + longSidePnl;
        
        // Only update cumulative PnL for auto trades
        if (!isTestTrade) {
            cumulativePnl += cyclePnl;
        }

        tradeHistory.unshift({
            id: Date.now(),
            coin: coin,
            exchanges: `${shortExchange}/${longExchange}`,
            fundingDiff: isTestTrade ? 'TEST' : (currentSelectedOpportunityForExecution?.fundingDiff || 'N/A'), // Use specific source for test
            estimatedPnl: isTestTrade ? 'TEST' : (currentSelectedOpportunityForExecution?.estimatedPnl || 'N/A'), // Use specific source for test
            actualPnl: parseFloat(cyclePnl.toFixed(2)),
            timestamp: new Date().toISOString(),
            type: tradeDetailsToClose.type // Include type in history
        });

        if (tradeHistory.length > 50) {
            tradeHistory.pop();
        }

        safeLog('log', `[BOT_PNL_${tradeType}] ✅ Chu kỳ giao dịch ${tradeType} cho ${coin} hoàn tất. PnL chu kỳ: ${cyclePnl.toFixed(2)} USDT. Tổng PnL (chỉ AUTO): ${cumulativePnl.toFixed(2)} USDT.`);

    } catch (e) {
        safeLog('error', `[BOT_PNL_${tradeType}] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`, e);
    } finally {
        if (isTestTrade) {
            safeLog('log', `[BOT_PNL_${tradeType}] testTradeDetails being reset to null.`);
            testTradeDetails = null; // Clear test trade details
        } else {
            safeLog('log', `[BOT_PNL_${tradeType}] currentSelectedOpportunityForExecution being reset to null.`);
            currentSelectedOpportunityForExecution = null; // Clear selected opportunity for next cycle
            safeLog('log', `[BOT_PNL_${tradeType}] currentTradeDetails being reset to null.`);
            currentTradeDetails = null; // Clear auto trade details
        }
        safeLog('log', `[BOT_PNL_${tradeType}] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).`);
    }
}

let serverDataGlobal = null;

async function mainBotLoop() {
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);

    if (botState !== 'RUNNING') {
        safeLog('log', '[BOT_LOOP_AUTO] Bot không ở trạng thái RUNNING. Dừng vòng lặp.');
        return;
    }

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    const minuteAligned = Math.floor(now.getTime() / (60 * 1000));

    // Cập nhật dữ liệu từ server mỗi DATA_FETCH_INTERVAL_SECONDS
    if (currentSecond % DATA_FETCH_INTERVAL_SECONDS === 0 && LAST_ACTION_TIMESTAMP.dataFetch !== currentSecond) {
        LAST_ACTION_TIMESTAMP.dataFetch = currentSecond;

        const fetchedData = await fetchDataFromServer();
        if (fetchedData) {
            serverDataGlobal = fetchedData;
            await processServerData(serverDataGlobal);
        }
    }

    // Bot sẽ CHỌN cơ hội tốt nhất (gần funding nhất, PnL cao nhất) để "đặt chỗ"
    if (currentMinute === 58 && currentSecond >= 0 && currentSecond < 5 && botState === 'RUNNING') {
        // Đảm bảo bot không đang quản lý một lệnh tự động nào khác
        if (currentTradeDetails && currentTradeDetails.status === 'OPEN') {
             safeLog('log', '[BOT_LOOP_AUTO] ⚠️ Đang có lệnh tự động mở. Bỏ qua việc chọn cơ hội mới.');
             currentSelectedOpportunityForExecution = null; // Clear any pre-selected opportunity
             return; // Skip selection if an auto trade is active
        }

        if (LAST_ACTION_TIMESTAMP.selectionTime !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.selectionTime = minuteAligned;

            safeLog('log', `[BOT_LOOP_AUTO] 🌟 Kích hoạt lựa chọn cơ hội để THỰC HIỆN tại phút ${currentMinute}:${currentSecond} giây.`);

            let bestOpportunityFoundForExecution = null;
            let debugOpportunityCandidates = [];

            for (const op of allCurrentOpportunities) {
                const minutesUntilFunding = (op.nextFundingTime - now.getTime()) / (1000 * 60);
                op.details.minutesUntilFunding = minutesUntilFunding;

                if (op.estimatedPnl >= MIN_PNL_PERCENTAGE && minutesUntilFunding > 0) {
                    debugOpportunityCandidates.push({
                        coin: op.coin,
                        exchanges: op.exchanges,
                        estimatedPnl: op.estimatedPnl.toFixed(2),
                        minutesUntilFunding: minutesUntilFunding.toFixed(1)
                    });

                    if (!bestOpportunityFoundForExecution ||
                        minutesUntilFunding < bestOpportunityFoundForExecution.details.minutesUntilFunding ||
                        (minutesUntilFunding === bestOpportunityFoundForExecution.details.minutesUntilFunding && op.estimatedPnl > bestOpportunityFoundForExecution.estimatedPnl)
                    ) {
                        bestOpportunityFoundForExecution = op;
                    }
                }
            }

            if (debugOpportunityCandidates.length > 0) {
                safeLog('debug', `[BOT_LOOP_AUTO] Các cơ hội đủ điều kiện (PnL >= ${MIN_PNL_PERCENTAGE}%, Funding > 0):`, JSON.stringify(debugOpportunityCandidates, null, 2));
            }

            if (bestOpportunityFoundForExecution) {
                currentSelectedOpportunityForExecution = bestOpportunityFoundForExecution;
                if (bestPotentialOpportunityForDisplay) {
                    bestPotentialOpportunityForDisplay.details.minutesUntilFunding = currentSelectedOpportunityForExecution.details.minutesUntilFunding;
                }

                safeLog('log', `[BOT_LOOP_AUTO] ✅ Bot đã CHỌN cơ hội: ${currentSelectedOpportunityForExecution.coin} trên ${currentSelectedOpportunityForExecution.exchanges} để THỰC HIỆN.`);
                safeLog('log', `  Thông tin chi tiết: PnL ước tính: ${currentSelectedOpportunityForExecution.estimatedPnl.toFixed(2)}%, Funding trong: ${currentSelectedOpportunityForExecution.details.minutesUntilFunding.toFixed(1)} phút.`);
                safeLog('log', `  Sàn Short: ${currentSelectedOpportunityForExecution.details.shortExchange} (${currentSelectedOpportunityForExecution.details.shortOriginalSymbol}), Sàn Long: ${currentSelectedOpportunityForExecution.details.longExchange} (${currentSelectedOpportunityForExecution.details.longOriginalSymbol})`);

                const shortExId = currentSelectedOpportunityForExecution.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : currentSelectedOpportunityForExecution.details.shortExchange.toLowerCase();
                const longExId = currentSelectedOpportunityForExecution.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : currentSelectedOpportunityForExecution.details.longExchange.toLowerCase(); // SỬA LỖI Ở ĐÂY
                const minAvailableBalance = Math.min(balances[shortExId]?.available || 0, balances[longExId]?.available || 0);
                // Ensure bestPotentialOpportunityForDisplay is not null before updating
                if (bestPotentialOpportunityForDisplay) {
                    bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (minAvailableBalance * (currentPercentageToUse / 100)).toFixed(2);
                }
                safeLog('log', `  Vốn dự kiến: ${bestPotentialOpportunityForDisplay?.estimatedTradeCollateral || 'N/A'} USDT`);

                safeLog('log', '[BOT_LOOP_AUTO] Bỏ qua bước chuyển tiền. Tiền phải có sẵn trên các sàn.');

            } else {
                safeLog('log', `[BOT_LOOP_AUTO] 🔍 Không tìm thấy cơ hội nào đủ điều kiện (PnL >= ${MIN_PNL_PERCENTAGE}%) để CHỌN THỰC HIỆN tại phút ${currentMinute}.`);
                currentSelectedOpportunityForExecution = null;
            }
        }
    }

    // Mở lệnh tự động vào phút 59:55 - 59:58
    if (currentMinute === 59 && currentSecond >= 55 && currentSecond < 59 && botState === 'RUNNING' && currentSelectedOpportunityForExecution && !currentTradeDetails) {
        if (LAST_ACTION_TIMESTAMP.tradeExecution !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.tradeExecution = minuteAligned;

            const minutesUntilFundingAtExecution = (currentSelectedOpportunityForExecution.nextFundingTime - now.getTime()) / (1000 * 60);

            if (minutesUntilFundingAtExecution > 0 && minutesUntilFundingAtExecution <= MAX_MINUTES_UNTIL_FUNDING) {
                safeLog('log', `[BOT_LOOP_AUTO] ⚡ Kích hoạt MỞ LỆNH AUTO cho cơ hội ${currentSelectedOpportunityForExecution.coin} vào phút 59:55. (Funding trong ${minutesUntilFundingAtExecution.toFixed(1)} phút)`);
                botState = 'EXECUTING_TRADES';
                const tradeSuccess = await executeTrades(currentSelectedOpportunityForExecution, currentPercentageToUse, false); // isTest = false
                if (tradeSuccess) {
                    safeLog('log', '[BOT_LOOP_AUTO] ✅ Mở lệnh AUTO hoàn tất.');
                } else {
                    safeLog('error', '[BOT_LOOP_AUTO] ❌ Lỗi mở lệnh AUTO. Hủy chu kỳ này.');
                    currentSelectedOpportunityForExecution = null;
                    currentTradeDetails = null;
                }
                botState = 'RUNNING';
            } else {
                safeLog('log', `[BOT_LOOP_AUTO] 🟡 Cơ hội AUTO đã chọn (${currentSelectedOpportunityForExecution.coin}) không còn trong cửa sổ thực hiện lệnh (còn ${minutesUntilFundingAtExecution.toFixed(1)} phút). Bỏ qua.`);
                currentSelectedOpportunityForExecution = null;
            }
        }
    }

    // Đóng lệnh tự động và tính PnL vào phút 00:05
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && botState === 'RUNNING' && currentTradeDetails?.status === 'OPEN') {
        if (LAST_ACTION_TIMESTAMP.closeTrade !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.closeTrade = minuteAligned;

            safeLog('log', '[BOT_LOOP_AUTO] 🛑 Kích hoạt đóng lệnh AUTO và tính PnL vào phút 00:05.');
            botState = 'CLOSING_TRADES';

            closeTradesAndCalculatePnL(false) // isTest = false
                .then(() => {
                    safeLog('log', '[BOT_LOOP_AUTO] ✅ Đóng lệnh AUTO và tính PnL hoàn tất (qua Promise.then).');
                })
                .catch(errorInClose => {
                    safeLog('error', `[BOT_LOOP_AUTO] ❌ Lỗi khi đóng lệnh AUTO và tính PnL (qua Promise.catch): ${errorInClose.message}`, errorInClose);
                })
                .finally(() => {
                    botState = 'RUNNING';
                });
        }
    }

    botLoopIntervalId = setTimeout(() => { mainBotLoop(); }, 1000);
}

function startBot() {
    if (botState === 'STOPPED') {
        safeLog('log', '[BOT] ▶️ Khởi động Bot...');
        botState = 'RUNNING';

        updateBalances().then(() => {
            safeLog('log', '[BOT] Đã cập nhật số dư ban đầu. Bắt đầu vòng lặp bot.');
            mainBotLoop();
        }).catch(err => {
            safeLog('error', `[BOT] Lỗi khi khởi tạo số dư ban đầu: ${err.message}`, err);
            botState = 'STOPPED';
        });
        return true;
    }
    safeLog('warn', '[BOT] Bot đã chạy hoặc đang trong quá trình chuyển trạng thái.');
    return false;
}

function stopBot() {
    if (botState === 'RUNNING' || botState === 'FETCHING_DATA' || botState === 'PROCESSING_DATA' || botState === 'EXECUTING_TRADES' || botState === 'CLOSING_TRADES') {
        safeLog('log', '[BOT] ⏸️ Dừng Bot...');
        if (botLoopIntervalId) {
            clearTimeout(botLoopIntervalId);
            botLoopIntervalId = null;
        }
        botState = 'STOPPED';
        safeLog('log', '[BOT] Bot đã dừng thành công.');
        return true;
    }
    safeLog('warn', '[BOT] Bot không hoạt động hoặc không thể dừng.');
    return false;
}

const botServer = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi khi đọc index.html:', err.message, err);
                res.writeHead(500);
                res.end('Lỗi khi đọc index.html');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        // Display both auto and test trade details
        const statusData = {
            botState: botState,
            balances: Object.fromEntries(Object.entries(balances).filter(([id]) => activeExchangeIds.includes(id) || id === 'totalOverall')),
            initialTotalBalance: initialTotalBalance,
            cumulativePnl: cumulativePnl,
            tradeHistory: tradeHistory,
            currentSelectedOpportunity: bestPotentialOpportunityForDisplay,
            currentTradeDetails: currentTradeDetails, // Auto trade
            testTradeDetails: testTradeDetails // Test trade
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = body ? JSON.parse(body) : {};
                currentPercentageToUse = parseFloat(data.percentageToUse);
                if (isNaN(currentPercentageToUse) || currentPercentageToUse < 1 || currentPercentageToUse > 100) {
                    currentPercentageToUse = 50;
                    safeLog('warn', `Giá trị phần trăm vốn không hợp lệ từ UI, sử dụng mặc định: ${currentPercentageToUse}%`);
                }

                const started = startBot();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: started, message: started ? 'Bot đã khởi động.' : 'Bot đã chạy.' }));
            } catch (error) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/start:', error.message, error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Dữ liệu yêu cầu không hợp lệ hoặc lỗi server.' }));
            }
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? 'Bot đã dừng.' : 'Bot không hoạt động.' }));
    } else if (req.url === '/bot-api/test-trade' && req.method === 'POST') { // TEST TRADE ENDPOINT
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = body ? JSON.parse(body) : {};
                const testPercentageToUse = parseFloat(data.percentageToUse);

                if (isNaN(testPercentageToUse) || testPercentageToUse < 1 || testPercentageToUse > 100) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Phần trăm vốn không hợp lệ (1-100).' }));
                    return;
                }

                if (!bestPotentialOpportunityForDisplay) {
                    safeLog('warn', '[BOT_SERVER_TEST] Không tìm thấy cơ hội nào đang được hiển thị trên UI. Không thể thực hiện lệnh test.');
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Không tìm thấy cơ hội arbitrage nào để test. Vui lòng đảm bảo có cơ hội được hiển thị trên UI.' }));
                    return;
                }

                if (testTradeDetails && testTradeDetails.status === 'OPEN') {
                    safeLog('warn', '[BOT_SERVER_TEST] Đã có lệnh TEST đang mở. Không thể thực hiện lệnh test khi có lệnh TEST đang được theo dõi.');
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Đã có lệnh TEST đang mở. Vui lòng đóng lệnh TEST hiện tại trước khi thực hiện lệnh test mới.' }));
                    return;
                }

                const testOpportunity = bestPotentialOpportunityForDisplay;

                safeLog('log', `[BOT_SERVER_TEST] ⚡ Yêu cầu TEST MỞ LỆNH: ${testOpportunity.coin} trên ${testOpportunity.exchanges} với ${testPercentageToUse}% vốn.`);
                safeLog('log', '[BOT_SERVER_TEST] Thông tin cơ hội Test:', testOpportunity);

                const tradeSuccess = await executeTrades(testOpportunity, testPercentageToUse, true); // isTest = true

                if (tradeSuccess) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Lệnh TEST đã được gửi thành công!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Có lỗi xảy ra khi gửi lệnh TEST. Vui lòng kiểm tra log bot.' }));
                }

            } catch (error) {
                safeLog('error', '[BOT_SERVER_TEST] ❌ Lỗi xử lý POST /bot-api/test-trade:', error.message, error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện lệnh test.' }));
            }
        });
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') { // NEW: STOP TEST TRADE ENDPOINT
        try {
            if (!testTradeDetails || testTradeDetails.status !== 'OPEN') {
                safeLog('log', '[BOT_SERVER_TEST] Yêu cầu dừng lệnh TEST nhưng không có lệnh TEST nào đang mở để dừng.');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Không có lệnh TEST nào đang mở để dừng.' }));
                return;
            }

            safeLog('log', '[BOT_SERVER_TEST] 🛑 Yêu cầu DỪNG LỆNH TEST ĐANG MỞ.');
            closeTradesAndCalculatePnL(true) // isTest = true
                .then(() => {
                    safeLog('log', '[BOT_SERVER_TEST] ✅ Đóng lệnh TEST và tính PnL hoàn tất (qua Promise.then trong API stop-test-trade).');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng vị thế TEST thành công.' }));
                })
                .catch(errorInClose => {
                    safeLog('error', `[BOT_SERVER_TEST] ❌ Lỗi khi đóng lệnh TEST và tính PnL (qua Promise.catch trong API stop-test-trade): ${errorInClose.message}`, errorInClose);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Lỗi server khi dừng lệnh TEST.' }));
                });

        } catch (error) {
            safeLog('error', '[BOT_SERVER_TEST] ❌ Lỗi xử lý POST /bot-api/stop-test-trade:', error.message, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Lỗi server khi dừng lệnh TEST.' }));
        }
    }
    else {
        res.writeHead(404); res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
    safeLog('log', 'Bot đang chờ lệnh "Start" từ giao diện HTML.');
});
