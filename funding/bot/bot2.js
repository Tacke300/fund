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

// const { usdtDepositAddressesByNetwork } = require('./balance.js'); // <<-- ĐÃ LOẠI BỎ

const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';

const MIN_PNL_PERCENTAGE = 1;
const MAX_MINUTES_UNTIL_FUNDING = 30;
const MIN_MINUTES_FOR_EXECUTION = 15;

// Cập nhật số tiền chuyển tối thiểu theo yêu cầu (KHÔNG CÒN ĐƯỢC DÙNG)
// const FUND_TRANSFER_MIN_AMOUNT_BINANCE = 10; // <<-- ĐÃ LOẠI BỎ
// const FUND_TRANSFER_MIN_AMOUNT_BINGX = 5; // <<-- ĐÃ LOẠI BỎ
// const FUND_TRANSFER_MIN_AMOUNT_OKX = 1; // <<-- ĐÃ LOẠI BỎ

const DATA_FETCH_INTERVAL_SECONDS = 5;
const HOURLY_FETCH_TIME_MINUTE = 45;

const SL_PERCENT_OF_COLLATERAL = 700;
const TP_PERCENT_OF_COLLATERAL = 8386;

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

let currentSelectedOpportunityForExecution = null;
let bestPotentialOpportunityForDisplay = null; // Đây là cơ hội tốt nhất được server tính toán và hiển thị
let allCurrentOpportunities = []; // Tất cả cơ hội từ server

const LAST_ACTION_TIMESTAMP = {
    dataFetch: 0,
    selectionTime: 0,
    tradeExecution: 0,
    closeTrade: 0,
};

let currentTradeDetails = null;

let currentPercentageToUse = 50;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        safeLog('debug', '[SERVER_DATA_FETCHED]', data); // Log data returned from server
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
        const longExIdNormalized = op.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.longExchange.toLowerCase();

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

            // Select the best opportunity for display (e.g., highest PnL, closest funding time)
            if (!bestForDisplay ||
                op.estimatedPnl > bestForDisplay.estimatedPnl || // Prefer higher PnL
                (op.estimatedPnl === bestForDisplay.estimatedPnl && minutesUntilFunding < bestForDisplay.details.minutesUntilFunding) // Then closer funding
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
        const longExId = bestForDisplay.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : bestForDisplay.details.longExchange.toLowerCase();
        const minAvailableBalance = Math.min(balances[shortExId]?.available || 0, balances[longExId]?.available || 0);
        bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (minAvailableBalance * (currentPercentageToUse / 100)).toFixed(2);
    } else {
        bestPotentialOpportunityForDisplay = null;
    }
}


async function executeTrades(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        safeLog('warn', '[BOT_TRADE] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    if (!opportunity.details || !opportunity.details.shortExchange || !opportunity.details.longExchange ||
        !opportunity.details.shortOriginalSymbol || !opportunity.details.longOriginalSymbol) {
        safeLog('error', '[BOT_TRADE] Thông tin chi tiết cơ hội thiếu trường cần thiết (exchange ID hoặc original symbol). Hủy bỏ lệnh.');
        return false;
    }

    const shortExchangeId = opportunity.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : opportunity.details.shortExchange.toLowerCase();
    const longExchangeId = opportunity.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : opportunity.details.longExchange.toLowerCase();

    if (DISABLED_EXCHANGES.includes(shortExchangeId) || DISABLED_EXCHANGES.includes(longExchangeId) ||
        !exchanges[shortExchangeId] || !exchanges[longExchangeId]) {
        safeLog('error', `[BOT_TRADE] Bỏ qua thực hiện lệnh vì sàn ${shortExchangeId} hoặc ${longExchangeId} bị tắt hoặc chưa được khởi tạo.`);
        return false;
    }

    const cleanedCoin = opportunity.coin;
    const shortOriginalSymbol = opportunity.details.shortOriginalSymbol;
    const longOriginalSymbol = opportunity.details.longOriginalSymbol;

    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    const minAvailableBalanceInPair = Math.min(balances[shortExchangeId]?.available || 0, balances[longExchangeId]?.available || 0);
    const baseCollateralPerSide = minAvailableBalanceInPair * (percentageToUse / 100);

    const shortCollateral = baseCollateralPerSide;
    const longCollateral = baseCollateralPerSide;

    if (shortCollateral <= 0 || longCollateral <= 0) {
        safeLog('error', '[BOT_TRADE] Số tiền mở lệnh (collateral) không hợp lệ (cần dương). Hủy bỏ lệnh.');
        return false;
    }
    if (balances[shortExchangeId]?.available < shortCollateral || balances[longExchangeId]?.available < longCollateral) {
        safeLog('error', `[BOT_TRADE] Số dư khả dụng không đủ để mở lệnh với vốn ${baseCollateralPerSide.toFixed(2)} USDT mỗi bên. ${shortExchangeId}: ${balances[shortExchangeId]?.available.toFixed(2)}, ${longExchangeId}: ${balances[longExchangeId]?.available.toFixed(2)}. Hủy bỏ lệnh.`);
        return false;
    }

    safeLog('log', `[BOT_TRADE] Chuẩn bị mở lệnh cho ${cleanedCoin}:`);
    safeLog('log', `  SHORT ${shortExchangeId} (${shortOriginalSymbol}): ${shortCollateral.toFixed(2)} USDT collateral`);
    safeLog('log', `  LONG ${longExchangeId} (${longOriginalSymbol}): ${longCollateral.toFixed(2)} USDT collateral`);

    let tradeSuccess = true;
    let shortOrder = null, longOrder = null;

    try {
        await shortExchange.loadMarkets(true); // Load markets to ensure proper symbol handling
        await longExchange.loadMarkets(true);

        const tickerShort = await shortExchange.fetchTicker(shortOriginalSymbol);
        const tickerLong = await longExchange.fetchTicker(longOriginalSymbol);

        const shortEntryPrice = tickerShort.last;
        const longEntryPrice = tickerLong.last;

        if (!shortEntryPrice || !longEntryPrice) {
            safeLog('error', `[BOT_TRADE] Không lấy được giá thị trường hiện tại cho ${cleanedCoin}.`);
            return false;
        }

        const commonLeverage = opportunity.commonLeverage || 1;

        // Set leverage first for the symbols
        try {
            await shortExchange.setLeverage(commonLeverage, shortOriginalSymbol);
            safeLog('log', `[BOT_TRADE] ✅ Đặt đòn bẩy x${commonLeverage} cho SHORT ${shortOriginalSymbol} trên ${shortExchangeId}.`);
        } catch (levErr) {
            safeLog('warn', `[BOT_TRADE] ⚠️ Lỗi đặt đòn bẩy cho SHORT ${shortOriginalSymbol} trên ${shortExchangeId}: ${levErr.message}. Tiếp tục mà không đảm bảo đòn bẩy.`, levErr);
        }
        try {
            await longExchange.setLeverage(commonLeverage, longOriginalSymbol);
            safeLog('log', `[BOT_TRADE] ✅ Đặt đòn bẩy x${commonLeverage} cho LONG ${longOriginalSymbol} trên ${longExchangeId}.`);
        } catch (levErr) {
            safeLog('warn', `[BOT_TRADE] ⚠️ Lỗi đặt đòn bẩy cho LONG ${longOriginalSymbol} trên ${longExchangeId}: ${levErr.message}. Tiếp tục mà không đảm bảo đòn bẩy.`, levErr);
        }

        const shortAmount = (shortCollateral * commonLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * commonLeverage) / longEntryPrice;

        if (shortAmount <= 0 || longAmount <= 0) {
            safeLog('error', '[BOT_TRADE] Lượng hợp đồng tính toán không hợp lệ (cần dương). Hủy bỏ lệnh.');
            return false;
        }
        
        // Use amountToLots to get precise amount for market order based on exchange's rules
        const shortAmountToOrder = shortExchange.amountToLots(shortOriginalSymbol, shortAmount);
        const longAmountToOrder = longExchange.amountToLots(longOriginalSymbol, longAmount);


        safeLog('log', `[BOT_TRADE] Mở SHORT ${shortAmountToOrder} ${shortOriginalSymbol} trên ${shortExchangeId} với giá ${shortEntryPrice.toFixed(4)}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, shortAmountToOrder);
        safeLog('log', `[BOT_TRADE] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}, Amount ${shortOrder.amount}, Price ${shortOrder.price}`);

        safeLog('log', `[BOT_TRADE] Mở LONG ${longAmountToOrder} ${longOriginalSymbol} trên ${longExchangeId} với giá ${longEntryPrice.toFixed(4)}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, longAmountToOrder);
        safeLog('log', `[BOT_TRADE] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}, Amount ${longOrder.amount}, Price ${longOrder.price}`);

        safeLog('log', `[BOT_TRADE] Setting currentTradeDetails for ${cleanedCoin} on ${shortExchangeId}/${longExchangeId}`);
        currentTradeDetails = {
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
            openTime: Date.now()
        };
        safeLog('log', `[BOT_TRADE] currentTradeDetails set successfully.`);

        safeLog('log', '[BOT_TRADE] Đợi 2 giây để gửi lệnh TP/SL...');
        await sleep(2000);

        const shortTpPrice = shortEntryPrice * (1 - (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const shortSlPrice = shortEntryPrice * (1 + (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));

        const longTpPrice = longEntryPrice * (1 + (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const longSlPrice = longEntryPrice * (1 - (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));

        safeLog('log', `[BOT_TRADE] Tính toán TP/SL cho ${cleanedCoin}:`);
        safeLog('log', `  Short Entry: ${shortEntryPrice.toFixed(4)}, SL: ${shortSlPrice.toFixed(4)}, TP: ${shortTpPrice.toFixed(4)}`);
        safeLog('log', `  Long Entry: ${longEntryPrice.toFixed(4)}, SL: ${longSlPrice.toFixed(4)}, TP: ${longTpPrice.toFixed(4)}`);

        currentTradeDetails.shortSlPrice = shortSlPrice;
        currentTradeDetails.shortTpPrice = shortTpPrice;
        currentTradeDetails.longSlPrice = longSlPrice;
        currentTradeDetails.longTpPrice = longTpPrice;

        // Đặt TP/SL cho vị thế SHORT
        try {
            await shortExchange.createOrder(
                shortOriginalSymbol,
                'STOP_MARKET',
                'buy',
                shortOrder.amount,
                undefined,
                { 'stopPrice': shortSlPrice, 'reduceOnly': true } // reduceOnly để đảm bảo đây là lệnh đóng vị thế
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho SHORT ${shortExchangeId} thành công.`);
        } catch (slShortError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho SHORT ${shortExchangeId}: ${slShortError.message}`, slShortError);
        }

        try {
            await shortExchange.createOrder(
                shortOriginalSymbol,
                'TAKE_PROFIT_MARKET',
                'buy',
                shortOrder.amount,
                undefined,
                { 'stopPrice': shortTpPrice, 'reduceOnly': true } // reduceOnly để đảm bảo đây là lệnh đóng vị thế
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho SHORT ${shortExchangeId} thành công.`);
        } catch (tpShortError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho SHORT ${shortExchangeId}: ${tpShortError.message}`, tpShortError);
        }

        // Đặt TP/SL cho vị thế LONG
        try {
            await longExchange.createOrder(
                longOriginalSymbol,
                'STOP_MARKET',
                'sell',
                longOrder.amount,
                undefined,
                { 'stopPrice': longSlPrice, 'reduceOnly': true } // reduceOnly để đảm bảo đây là lệnh đóng vị thế
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho LONG ${longExchangeId} thành công.`);
        } catch (slLongError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho LONG ${longExchangeId}: ${slLongError.message}`, slLongError);
        }

        try {
            await longExchange.createOrder(
                longOriginalSymbol,
                'TAKE_PROFIT_MARKET',
                'sell',
                longOrder.amount,
                undefined,
                { 'stopPrice': longTpPrice, 'reduceOnly': true } // reduceOnly để đảm bảo đây là lệnh đóng vị thế
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho LONG ${longExchangeId} thành công.`);
        } catch (tpLongError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho LONG ${longExchangeId}: ${tpLongError.message}`, tpLongError);
        }

    } catch (e) {
        safeLog('error', `[BOT_TRADE] ❌ Lỗi khi thực hiện giao dịch (hoặc đặt TP/SL): ${e.message}`, e);
        tradeSuccess = false;
        // Attempt to cancel orders if one side failed
        if (shortOrder?.id) {
            try { await exchanges[shortExchangeId].cancelOrder(shortOrder.id, shortOriginalSymbol); safeLog('log', `[BOT_TRADE] Đã hủy lệnh SHORT ${shortExchangeId}: ${shortOrder.id}`); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh SHORT: ${ce.message}`, ce); }
        }
        if (longOrder?.id) {
            try { await exchanges[longExchangeId].cancelOrder(longOrder.id, longOriginalSymbol); safeLog('log', `[BOT_TRADE] Đã hủy lệnh LONG ${longExchangeId}: ${longOrder.id}`); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh LONG: ${ce.message}`, ce); }
        }
        safeLog('log', `[BOT] currentTradeDetails being reset to null due to trade failure.`);
        currentTradeDetails = null; // Clear details if trade setup failed
    }
    return tradeSuccess;
}

async function closeTradesAndCalculatePnL() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('log', '[BOT_PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }

    safeLog('log', '[BOT_PNL] 🔄 Đang đóng các vị thế và tính toán PnL...');
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount, shortCollateral, longCollateral } = currentTradeDetails;

    try {
        safeLog('log', '[BOT_PNL] Hủy các lệnh TP/SL còn chờ (nếu có)...');
        // Fetch and cancel specific symbol orders for SHORT side
        try {
            const shortOpenOrders = await exchanges[shortExchange].fetchOpenOrders(shortOriginalSymbol);
            for (const order of shortOpenOrders) {
                // Ensure we only cancel TP/SL orders that are still open
                if ((order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') && order.status === 'open') {
                    await exchanges[shortExchange].cancelOrder(order.id, shortOriginalSymbol);
                    safeLog('log', `[BOT_PNL] Đã hủy lệnh chờ ${order.type} ${order.id} cho ${shortOriginalSymbol} trên ${shortExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ cho ${shortOriginalSymbol} trên ${shortExchange}: ${e.message}`, e); }
        
        // Fetch and cancel specific symbol orders for LONG side
        try {
            const longOpenOrders = await exchanges[longExchange].fetchOpenOrders(longOriginalSymbol);
            for (const order of longOpenOrders) {
                // Ensure we only cancel TP/SL orders that are still open
                if ((order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') && order.status === 'open') {
                    await exchanges[longExchange].cancelOrder(order.id, longOriginalSymbol);
                    safeLog('log', `[BOT_PNL] Đã hủy lệnh chờ ${order.type} ${order.id} cho ${longOriginalSymbol} trên ${longExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ cho ${longOriginalSymbol} trên ${longExchange}: ${e.message}`, e); }

        safeLog('log', `[BOT_PNL] Đóng vị thế SHORT ${coin} trên ${shortExchange} (amount: ${shortOrderAmount})...`);
        const closeShortOrder = await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế SHORT trên ${shortExchange} đã đóng. Order ID: ${closeShortOrder.id}`);

        safeLog('log', `[BOT_PNL] Đóng vị thế LONG ${coin} trên ${longExchange} (amount: ${longOrderAmount})...`);
        const closeLongOrder = await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế LONG trên ${longExchange} đã đóng. Order ID: ${closeLongOrder.id}`);

        await sleep(15000); // Wait a bit for balances to settle on exchanges

        await updateBalances();

        // Calculate PnL based on collateral used and current available balance
        // This assumes that the entire initial collateral is what we are measuring against.
        // And the "available" balance correctly reflects the realized PnL from closing.
        const currentShortAvailable = balances[shortExchange]?.available;
        const currentLongAvailable = balances[longExchange]?.available;
        const cyclePnl = (currentShortAvailable - currentTradeDetails.shortCollateral) + (currentLongAvailable - currentTradeDetails.longCollateral);

        cumulativePnl += cyclePnl;

        tradeHistory.unshift({
            id: Date.now(),
            coin: coin,
            exchanges: `${shortExchange}/${longExchange}`,
            fundingDiff: currentSelectedOpportunityForExecution?.fundingDiff, // Use the last selected opportunity for metadata
            estimatedPnl: currentSelectedOpportunityForExecution?.estimatedPnl, // Use the last selected opportunity for metadata
            actualPnl: parseFloat(cyclePnl.toFixed(2)),
            timestamp: new Date().toISOString()
        });

        if (tradeHistory.length > 50) {
            tradeHistory.pop();
        }

        safeLog('log', `[BOT_PNL] ✅ Chu kỳ giao dịch cho ${coin} hoàn tất. PnL chu kỳ: ${cyclePnl.toFixed(2)} USDT. Tổng PnL: ${cumulativePnl.toFixed(2)} USDT.`);

    } catch (e) {
        safeLog('error', `[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`, e);
    } finally {
        currentSelectedOpportunityForExecution = null; // Clear selected opportunity for next cycle
        safeLog('log', `[BOT] currentTradeDetails being reset to null.`);
        currentTradeDetails = null; // Clear current trade details
        safeLog('log', '[BOT_PNL] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).');
    }
}

let serverDataGlobal = null;

// HÀM CHÍNH CỦA VÒNG LẶP BOT - Vẫn là async vì có các await khác
async function mainBotLoop() {
    safeLog('debug', '[MAIN_BOT_LOOP] Running LAST RESORT DEBUGGED VERSION (2024-07-31 V5 - Promise Chain).'); // Log để xác nhận phiên bản này đang chạy
    
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);

    // Đã loại bỏ các trạng thái TRANSFERRING_FUNDS khỏi điều kiện dừng chung
    if (botState !== 'RUNNING') {
        safeLog('log', '[BOT_LOOP] Bot không ở trạng thái RUNNING. Dừng vòng lặp.');
        return;
    }

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    const minuteAligned = Math.floor(now.getTime() / (60 * 1000));

    if (currentSecond % DATA_FETCH_INTERVAL_SECONDS === 0 && LAST_ACTION_TIMESTAMP.dataFetch !== currentSecond) {
        LAST_ACTION_TIMESTAMP.dataFetch = currentSecond;

        const fetchedData = await fetchDataFromServer();
        if (fetchedData) {
            serverDataGlobal = fetchedData;
            await processServerData(serverDataGlobal);
        }
    }

    if (currentMinute === 50 && currentSecond >= 0 && currentSecond < 5 && botState === 'RUNNING' && !currentTradeDetails && !currentSelectedOpportunityForExecution) {
        if (LAST_ACTION_TIMESTAMP.selectionTime !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.selectionTime = minuteAligned;

            safeLog('log', `[BOT_LOOP] 🌟 Kích hoạt lựa chọn cơ hội để THỰC HIỆN tại phút ${currentMinute}:${currentSecond} giây.`);

            let bestOpportunityFoundForExecution = null;
            for (const op of allCurrentOpportunities) {
                const minutesUntilFunding = op.details.minutesUntilFunding;

                if (op.estimatedPnl >= MIN_PNL_PERCENTAGE &&
                    minutesUntilFunding > 0 &&
                    minutesUntilFunding < MIN_MINUTES_FOR_EXECUTION &&
                    minutesUntilFunding <= MAX_MINUTES_UNTIL_FUNDING) {

                    if (!bestOpportunityFoundForExecution ||
                        minutesUntilFunding < bestOpportunityFoundForExecution.details.minutesUntilFunding ||
                        (minutesUntilFunding === bestOpportunityFoundForExecution.details.minutesUntilFunding && op.estimatedPnl > bestOpportunityFoundForExecution.estimatedPnl)
                    ) {
                        bestOpportunityFoundForExecution = op;
                    }
                }
            }

            if (bestOpportunityFoundForExecution) {
                currentSelectedOpportunityForExecution = bestOpportunityFoundForExecution;
                safeLog('log', `[BOT_LOOP] ✅ Bot đã chọn cơ hội: ${currentSelectedOpportunityForExecution.coin} trên ${currentSelectedOpportunityForExecution.exchanges} để THỰC HIỆN.`);
                safeLog('log', `  Thông tin chi tiết: PnL ước tính: ${currentSelectedOpportunityForExecution.estimatedPnl.toFixed(2)}%, Funding trong: ${currentSelectedOpportunityForExecution.details.minutesUntilFunding.toFixed(1)} phút.`);
                safeLog('log', `  Sàn Short: ${currentSelectedOpportunityForExecution.details.shortExchange} (${currentSelectedOpportunityForExecution.details.shortOriginalSymbol}), Sàn Long: ${currentSelectedOpportunityForExecution.details.longExchange} (${currentSelectedOpportunityForExecution.details.longOriginalSymbol})`);
                
                // Cập nhật hiển thị vốn dự kiến theo cách tính mới
                const shortExId = currentSelectedOpportunityForExecution.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : currentSelectedOpportunityForExecution.details.shortExchange.toLowerCase();
                const longExId = currentSelectedOpportunityForExecution.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : currentSelectedOpportunityForExecution.details.longExchange.toLowerCase();
                const minAvailableBalanceForDisplay = Math.min(balances[shortExId]?.available || 0, balances[longExId]?.available || 0);
                bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (minAvailableBalanceForDisplay * (currentPercentageToUse / 100)).toFixed(2);
                safeLog('log', `  Vốn dự kiến: ${bestPotentialOpportunityForDisplay.estimatedTradeCollateral} USDT`);

                // <<-- ĐÃ LOẠI BỎ LOGIC VÀ TRẠNG THÁI CHUYỂN TIỀN Ở ĐÂY -->>
                safeLog('log', '[BOT_LOOP] Bỏ qua bước chuyển tiền. Tiền phải có sẵn trên các sàn.');
                // Kế tiếp là sẽ chờ đến thời điểm mở lệnh (phút 59)

            } else {
                safeLog('log', `[BOT_LOOP] 🔍 Không tìm thấy cơ hội nào đủ điều kiện để THỰC HIỆN tại phút ${currentMinute}.`);
                currentSelectedOpportunityForExecution = null;
            }
        }
    }

    if (currentMinute === 59 && currentSecond >= 55 && currentSecond < 59 && botState === 'RUNNING' && currentSelectedOpportunityForExecution && !currentTradeDetails) {
        if (LAST_ACTION_TIMESTAMP.tradeExecution !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.tradeExecution = minuteAligned;

            safeLog('log', `[BOT_LOOP] ⚡ Kích hoạt mở lệnh cho cơ hội ${currentSelectedOpportunityForExecution.coin} vào phút 59:55.`);
            botState = 'EXECUTING_TRADES'; // Vẫn giữ trạng thái này để UI cập nhật và theo dõi
            const tradeSuccess = await executeTrades(currentSelectedOpportunityForExecution, currentPercentageToUse);
            if (tradeSuccess) {
                safeLog('log', '[BOT_LOOP] ✅ Mở lệnh hoàn tất.');
            } else {
                safeLog('error', '[BOT_LOOP] ❌ Lỗi mở lệnh. Hủy chu kỳ này.');
                currentSelectedOpportunityForExecution = null;
                currentTradeDetails = null;
            }
            botState = 'RUNNING'; // Trả về RUNNING sau khi thực hiện xong
        }
    }

    // THIS IS THE MODIFIED BLOCK: Now uses Promise chain directly.
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && botState === 'RUNNING' && currentTradeDetails?.status === 'OPEN') {
        if (LAST_ACTION_TIMESTAMP.closeTrade !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.closeTrade = minuteAligned;

            safeLog('log', '[BOT_LOOP] 🛑 Kích hoạt đóng lệnh và tính PnL vào phút 00:05.');
            botState = 'CLOSING_TRADES'; // Vẫn giữ trạng thái này để UI cập nhật và theo dõi
            
            // Calling closeTradesAndCalculatePnL and handling its Promise directly
            closeTradesAndCalculatePnL()
                .then(() => {
                    safeLog('log', '[BOT_LOOP] ✅ Đóng lệnh và tính PnL hoàn tất (qua Promise.then).');
                })
                .catch(errorInClose => {
                    safeLog('error', `[BOT_LOOP] ❌ Lỗi khi đóng lệnh và tính PnL (qua Promise.catch): ${errorInClose.message}`, errorInClose);
                })
                .finally(() => {
                    botState = 'RUNNING'; // Trả về RUNNING sau khi thực hiện xong, bất kể thành công hay thất bại
                });
        }
    }

    // Lặp lại vòng lặp sau 1 giây
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
    // Điều chỉnh trạng thái có thể dừng để phù hợp với việc loại bỏ các bước chuyển tiền
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
        let displayCurrentTradeDetails = null;
        try {
            if (currentTradeDetails && typeof currentTradeDetails === 'object' && currentTradeDetails.status === 'OPEN') {
                displayCurrentTradeDetails = currentTradeDetails;
            } else {
                displayCurrentTradeDetails = null;
            }
        } catch (e) {
            safeLog('error', `[BOT_SERVER] CRITICAL EXCEPTION accessing currentTradeDetails for status API: ${e.message}. Setting to null.`, e);
            displayCurrentTradeDetails = null;
        }

        const statusData = {
            botState: botState,
            balances: Object.fromEntries(Object.entries(balances).filter(([id]) => activeExchangeIds.includes(id) || id === 'totalOverall')),
            initialTotalBalance: initialTotalBalance,
            cumulativePnl: cumulativePnl,
            tradeHistory: tradeHistory,
            currentSelectedOpportunity: bestPotentialOpportunityForDisplay,
            currentTradeDetails: displayCurrentTradeDetails
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

                // 1. Kiểm tra xem có cơ hội nào đang được hiển thị trên UI không
                if (!bestPotentialOpportunityForDisplay) {
                    safeLog('warn', '[BOT_SERVER] Không tìm thấy cơ hội nào đang được hiển thị trên UI. Không thể thực hiện lệnh test.');
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Không tìm thấy cơ hội arbitrage nào để test. Vui lòng đảm bảo có cơ hội được hiển thị trên UI.' }));
                    return;
                }

                // 2. NGĂN CHẶN LỆNH TEST NẾU ĐÃ CÓ LỆNH ĐANG MỞ
                if (currentTradeDetails && currentTradeDetails.status === 'OPEN') {
                    safeLog('warn', '[BOT_SERVER] Đã có lệnh đang mở. Không thể thực hiện lệnh test khi có lệnh đang được theo dõi.');
                    res.writeHead(409, { 'Content-Type': 'application/json' }); // 409 Conflict
                    res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở. Vui lòng đóng lệnh hiện tại trước khi thực hiện lệnh test.' }));
                    return;
                }
                
                // 3. Sử dụng trực tiếp cơ hội đang hiển thị tốt nhất làm cơ hội test
                const testOpportunity = bestPotentialOpportunityForDisplay;

                safeLog('log', `[BOT_SERVER] ⚡ Yêu cầu TEST MỞ LỆNH: ${testOpportunity.coin} trên ${testOpportunity.exchanges} với ${testPercentageToUse}% vốn.`);
                safeLog('log', '[BOT_SERVER] Thông tin cơ hội Test:', testOpportunity);

                // Lưu trữ tạm thời currentSelectedOpportunityForExecution để closeTradesAndCalculatePnL có thể truy cập metadata
                const originalCurrentSelectedOpportunityForExecution = currentSelectedOpportunityForExecution;
                currentSelectedOpportunityForExecution = testOpportunity; 

                const tradeSuccess = await executeTrades(testOpportunity, testPercentageToUse);

                // Khôi phục lại currentSelectedOpportunityForExecution ban đầu sau khi test hoàn tất
                currentSelectedOpportunityForExecution = originalCurrentSelectedOpportunityForExecution;

                if (tradeSuccess) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Lệnh TEST đã được gửi thành công!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Có lỗi xảy ra khi gửi lệnh TEST. Vui lòng kiểm tra log bot.' }));
                }

            } catch (error) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/test-trade:', error.message, error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện lệnh test.' }));
            }
        });
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') { // NEW: STOP TEST TRADE ENDPOINT
        try {
            if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
                safeLog('log', '[BOT_SERVER] Yêu cầu dừng lệnh nhưng không có lệnh nào đang mở để dừng.');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Không có lệnh nào đang mở để dừng.' }));
                return;
            }

            safeLog('log', '[BOT_SERVER] 🛑 Yêu cầu DỪNG LỆNH ĐANG MỞ (có thể là lệnh test hoặc lệnh tự động).');
            closeTradesAndCalculatePnL()
                .then(() => {
                    safeLog('log', '[BOT_SERVER] ✅ Đóng lệnh và tính PnL hoàn tất (qua Promise.then trong API stop-test-trade).');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng vị thế thành công.' }));
                })
                .catch(errorInClose => {
                    safeLog('error', `[BOT_SERVER] ❌ Lỗi khi đóng lệnh và tính PnL (qua Promise.catch trong API stop-test-trade): ${errorInClose.message}`, errorInClose);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Lỗi server khi dừng lệnh.' }));
                });

        } catch (error) {
            safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/stop-test-trade:', error.message, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Lỗi server khi dừng lệnh.' }));
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
