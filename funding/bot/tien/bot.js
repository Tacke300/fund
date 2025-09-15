const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const { usdtDepositAddressesByNetwork } = require('./balance.js');

const safeLog = (type, ...args) => {
    try {
        const timestamp = new Date().toLocaleTimeString('vi-VN');
        const message = args.map(arg => {
            if (arg instanceof Error) { return arg.stack || arg.message; }
            return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg;
        }).join(' ');
        console[type](`[${timestamp} ${type.toUpperCase()}]`, message);
    } catch (e) {
        process.stderr.write(`FATAL LOG ERROR: ${e.message}\n`);
    }
};

const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('./config.js');

const BOT_PORT = 5006;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15;
const DATA_FETCH_INTERVAL_SECONDS = 5;
const MAX_CONSECUTIVE_FAILS = 3;
const MIN_COLLATERAL_FOR_TRADE = 0.1;
const TP_SL_PNL_PERCENTAGE = 150;

const FUND_TRANSFER_MIN_AMOUNT_BINANCE = 10;
const FUND_TRANSFER_MIN_AMOUNT_KUCOIN = 5;
const FUND_TRANSFER_MIN_AMOUNT_BITGET = 5;

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoinfutures'];
const DISABLED_EXCHANGES = [];
const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

let botState = 'STOPPED';
let botLoopIntervalId = null;
let balances = {};
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];
let currentTradeDetails = null;
let tradeAwaitingPnl = null;
let currentPercentageToUse = 50;
let exchangeHealth = {};
let transferStatus = { inProgress: false, message: null };

activeExchangeIds.forEach(id => {
    balances[id] = { available: 0, total: 0 };
    exchangeHealth[id] = { consecutiveFails: 0, isDisabled: false };
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const exchanges = {};
activeExchangeIds.forEach(id => {
    try {
        let exchangeClass;
        let config = { 'enableRateLimit': true, 'verbose': false };
        if (id === 'binanceusdm') { exchangeClass = ccxt.binanceusdm; config.apiKey = binanceApiKey; config.secret = binanceApiSecret; config.options = { 'defaultType': 'swap' }; }
        else if (id === 'okx') { exchangeClass = ccxt.okx; config.apiKey = okxApiKey; config.secret = okxApiSecret; config.password = okxPassword; config.options = { 'defaultType': 'swap' }; }
        else if (id === 'bitget') { exchangeClass = ccxt.bitget; config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; config.password = bitgetApiPassword; config.options = { 'defaultType': 'swap' }; }
        else if (id === 'kucoinfutures') { exchangeClass = ccxt.kucoinfutures; config.apiKey = kucoinApiKey; config.secret = kucoinApiSecret; config.password = kucoinApiPassword; }
        if (config.apiKey && config.secret && (id !== 'kucoinfutures' || config.password)) { exchanges[id] = new exchangeClass(config); safeLog('log', `[INIT] Khởi tạo sàn ${id.toUpperCase()} thành công.`); }
        else { safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret/Password.`); }
    } catch (e) { safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`); }
});

function getMinTransferAmount(fromExchangeId) {
    if (fromExchangeId === 'binanceusdm') return FUND_TRANSFER_MIN_AMOUNT_BINANCE;
    if (fromExchangeId === 'kucoinfutures') return FUND_TRANSFER_MIN_AMOUNT_KUCOIN;
    if (fromExchangeId === 'bitget') return FUND_TRANSFER_MIN_AMOUNT_BITGET;
    return 5;
}

function getTargetDepositInfo(fromExchangeId, toExchangeId) {
    let withdrawalNetwork = 'BEP20';
    let depositNetwork = 'BEP20';
    if (toExchangeId === 'kucoinfutures') {
        withdrawalNetwork = 'BEP20';
        depositNetwork = 'BEP20';
    } else if (fromExchangeId === 'kucoinfutures') {
        withdrawalNetwork = 'APTOS';
        depositNetwork = 'APTOS';
    }
    const depositAddress = usdtDepositAddressesByNetwork[toExchangeId]?.[depositNetwork];
    if (!depositAddress || depositAddress.startsWith('ĐIỀN ĐỊA CHỈ')) {
        safeLog('error', `[HELPER] Lỗi: Địa chỉ nạp tiền cho ${toExchangeId.toUpperCase()} qua mạng ${depositNetwork} chưa được cấu hình.`);
        return null;
    }
    return { network: withdrawalNetwork, address: depositAddress };
}

async function pollForBalance(exchangeId, targetAmount, maxPollAttempts = 90, pollIntervalMs = 10000) {
    const exchange = exchanges[exchangeId];
    const DUST_AMOUNT = 0.001;
    for (let i = 0; i < maxPollAttempts; i++) {
        try {
            const fullBalance = await exchange.fetchBalance();
            if (fullBalance.free?.USDT && fullBalance.free.USDT >= DUST_AMOUNT) {
                return { found: true, type: 'spot', balance: fullBalance.free.USDT };
            }
            for (const [walletType, walletData] of Object.entries(fullBalance)) {
                if (typeof walletData === 'object' && walletData !== null && walletData.free?.USDT && walletData.free.USDT >= DUST_AMOUNT) {
                    return { found: true, type: walletType, balance: walletData.free.USDT };
                }
            }
        } catch (e) {
            safeLog('error', `[POLL] Lỗi khi lấy số dư ${exchangeId.toUpperCase()}: ${e.message}`);
        }
        await sleep(pollIntervalMs);
    }
    return { found: false, type: null, balance: 0 };
}

async function executeFundTransfer(fromExchangeId, toExchangeId, amount) {
    transferStatus = { inProgress: true, message: `Bắt đầu quá trình chuyển ${amount} USDT từ ${fromExchangeId.toUpperCase()} đến ${toExchangeId.toUpperCase()}.` };
    const sourceExchange = exchanges[fromExchangeId];
    const targetExchange = exchanges[toExchangeId];
    try {
        const fromAccount = (fromExchangeId === 'bitget') ? 'swap' : 'future';
        const toAccount = (fromExchangeId === 'kucoinfutures') ? 'main' : 'spot';
        transferStatus.message = `Bước 1/4: Chuyển ${amount} USDT sang ví Spot/Main trên ${fromExchangeId.toUpperCase()}...`;
        await sourceExchange.transfer('USDT', amount, fromAccount, toAccount);
        await sleep(5000);

        const targetDepositInfo = getTargetDepositInfo(fromExchangeId, toExchangeId);
        transferStatus.message = `Bước 2/4: Đang gửi lệnh rút ${amount} USDT đến ${toExchangeId.toUpperCase()}...`;
        const withdrawResult = await sourceExchange.withdraw('USDT', amount, targetDepositInfo.address, undefined, { network: targetDepositInfo.network });
        safeLog('log', `[TRANSFER] Yêu cầu rút tiền được chấp nhận. TxID/Info: ${withdrawResult.id || JSON.stringify(withdrawResult.info)}`);

        transferStatus.message = `Bước 3/4: Đang chờ xác nhận từ blockchain và sàn nhận. Việc này có thể mất vài phút...`;
        const pollResult = await pollForBalance(toExchangeId, amount);

        if (!pollResult.found) {
            throw new Error(`Bot không nhận được tiền trên ${toExchangeId.toUpperCase()} sau khi chờ. Vui lòng kiểm tra thủ công.`);
        }
        
        safeLog('log', `[TRANSFER] Đã nhận ${pollResult.balance.toFixed(4)} USDT vào ví '${pollResult.type}' trên ${toExchangeId.toUpperCase()}.`);
        transferStatus.message = `Bước 4/4: Đã nhận tiền! Đang chuyển vào ví Futures trên ${toExchangeId.toUpperCase()}...`;
        
        try {
            const targetFromAccount = pollResult.type;
            const targetToAccount = (toExchangeId === 'bitget') ? 'swap' : 'future';
            await targetExchange.transfer('USDT', pollResult.balance, targetFromAccount, targetToAccount);
            transferStatus.message = `✅✅✅ Hoàn tất! ${pollResult.balance.toFixed(4)} USDT đã được chuyển thành công vào ví Futures.`;
            setTimeout(updateBalances, 3000);
        } catch (internalError) {
            safeLog('error', `[TRANSFER] Lỗi chuyển nội bộ cuối cùng:`, internalError);
            throw new Error(`Tiền đã về ví '${pollResult.type}' nhưng GẶP LỖI khi tự động chuyển vào ví Futures. Vui lòng chuyển thủ công.`);
        }
    } catch (e) {
        safeLog('error', `[TRANSFER] Lỗi nghiêm trọng:`, e);
        transferStatus.message = `❌ Lỗi: ${e.message}`;
    } finally {
        setTimeout(() => {
            transferStatus = { inProgress: false, message: null };
            updateBalances();
        }, 30000);
    }
}

async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        safeLog('error', `[BOT] Lỗi khi lấy dữ liệu từ server: ${error.message}`);
        return null;
    }
}

async function updateBalances() {
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id] || exchangeHealth[id].isDisabled) return;
        try {
            const balanceData = (id === 'kucoinfutures') ? await exchanges[id].fetchBalance() : await exchanges[id].fetchBalance({ 'type': 'future' });
            balances[id] = { available: balanceData?.free?.USDT || 0, total: balanceData?.total?.USDT || 0 };
            if (exchangeHealth[id].consecutiveFails > 0) {
                safeLog('info', `[HEALTH] Sàn ${id.toUpperCase()} đã hoạt động trở lại.`);
                exchangeHealth[id].consecutiveFails = 0;
                exchangeHealth[id].isDisabled = false;
            }
        } catch (e) {
            balances[id] = { available: 0, total: 0 };
            exchangeHealth[id].consecutiveFails++;
            if (exchangeHealth[id].consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
                if (!exchangeHealth[id].isDisabled) {
                    exchangeHealth[id].isDisabled = true;
                    safeLog('warn', `[HEALTH] Sàn ${id.toUpperCase()} đã bị tạm vô hiệu hóa.`);
                }
            }
        }
    }));
}

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets(true);
    } catch (e) {
        safeLog('error', `[SYMBOL] Lỗi tải markets cho ${exchange.id}: ${e.message}`);
        return null;
    }
    const base = String(rawCoinSymbol).toUpperCase().replace(/USDT$/, '');
    const attempts = [`${base}/USDT:USDT`, `${base}USDT`, `${base}-USDT-SWAP`, `${base}USDTM`, `${base}/USDT`];
    for (const attempt of attempts) {
        const market = exchange.markets[attempt];
        if (market?.active && (market.contract || market.swap || market.future)) {
            return market.id;
        }
    }
    return null;
}

async function setLeverageSafely(exchange, symbol, desiredLeverage) {
    const params = (exchange.id === 'kucoinfutures') ? { 'marginMode': 'cross' } : {};
    try {
        await exchange.setLeverage(desiredLeverage, symbol, params);
        return desiredLeverage;
    } catch (e) {
        safeLog('error', `[LEVERAGE] Không thể đặt đòn bẩy x${desiredLeverage} cho ${symbol} trên ${exchange.id}. Lỗi: ${e.message}`);
        return null;
    }
}

const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase().trim();
    if (lowerId.includes('binance')) return 'binanceusdm';
    if (lowerId.includes('kucoin')) return 'kucoinfutures';
    return lowerId;
};

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        allCurrentOpportunities = [];
        bestPotentialOpportunityForDisplay = null;
        return;
    }
    const opportunities = serverData.arbitrageData
        .filter(op => {
            if (!op?.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) return false;
            const [shortExRaw, longExRaw] = op.exchanges.split(' / ');
            if (!shortExRaw || !longExRaw) return false;
            const shortExchange = normalizeExchangeId(shortExRaw);
            const longExchange = normalizeExchangeId(longExRaw);
            return exchanges[shortExchange] && !exchangeHealth[shortExchange]?.isDisabled &&
                   exchanges[longExchange] && !exchangeHealth[longExchange]?.isDisabled;
        })
        .map(op => {
            const [shortExRaw, longExRaw] = op.exchanges.split(' / ');
            op.details = { shortExchange: normalizeExchangeId(shortExRaw), longExchange: normalizeExchangeId(longExRaw) };
            return op;
        });
    allCurrentOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

async function computeOrderDetails(exchange, symbol, targetNotionalUSDT, leverage, availableBalance) {
    await exchange.loadMarkets();
    const market = exchange.market(symbol);
    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker?.last || ticker?.close;
    if (!price) throw new Error(`Không lấy được giá cho ${symbol} trên ${exchange.id}`);
    const contractSize = market.contractSize ?? 1;
    let amount = parseFloat(exchange.amountToPrecision(symbol, targetNotionalUSDT / (price * contractSize)));
    if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) amount = Math.round(amount);
    if (amount <= (market.limits.amount.min || 0)) {
         throw new Error(`Số lượng tính toán (${amount}) phải lớn hơn mức tối thiểu của sàn (${market.limits.amount.min}).`);
    }
    let currentNotional = amount * price * contractSize;
    if (market.limits?.cost?.min && currentNotional < market.limits.cost.min) {
        throw new Error(`Giá trị lệnh ${currentNotional.toFixed(4)} < mức tối thiểu ${market.limits.cost.min} USDT.`);
    }
    const requiredMargin = currentNotional / leverage;
    const safetyBuffer = 0.98;
    if (requiredMargin > availableBalance * safetyBuffer) {
        const maxNotional = availableBalance * leverage * safetyBuffer;
        let newAmount = parseFloat(exchange.amountToPrecision(symbol, maxNotional / (price * contractSize)));
        if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) newAmount = Math.floor(newAmount);
        if (newAmount <= (market.limits.amount.min || 0)) {
             throw new Error(`Không đủ ký quỹ sau khi điều chỉnh. Yêu cầu ${requiredMargin.toFixed(4)}, có sẵn ${availableBalance.toFixed(4)} USDT.`);
        }
        amount = newAmount;
        currentNotional = amount * price * contractSize;
    }
    return { amount, price, notional: currentNotional, requiredMargin: currentNotional / leverage };
}

async function placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
    if (!entryPrice || typeof entryPrice !== 'number' || entryPrice <= 0) return { tpOrderId: null, slOrderId: null };
    if (!notionalValue || notionalValue <= 0) return { tpOrderId: null, slOrderId: null };
    const pnlAmount = collateral * (TP_SL_PNL_PERCENTAGE / 100);
    const priceChange = (pnlAmount / notionalValue) * entryPrice;
    let tpPrice, slPrice;
    if (side === 'sell') {
        tpPrice = entryPrice - priceChange;
        slPrice = entryPrice + priceChange;
    } else {
        tpPrice = entryPrice + priceChange;
        slPrice = entryPrice - priceChange;
    }
    if (isNaN(tpPrice) || isNaN(slPrice)) return { tpOrderId: null, slOrderId: null };
    const orderSide = (side === 'sell') ? 'buy' : 'sell';
    try {
        let tpResult, slResult;
        if (exchange.id === 'kucoinfutures') {
            const tpParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'down' : 'up', 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType': 'MP' };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
            const slParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'up' : 'down', 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType': 'MP' };
            slResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
        } else if (exchange.id === 'bitget') {
            const holdSide = side === 'buy' ? 'long' : 'short';
            const tpParams = { 'planType': 'normal_plan', 'triggerPrice': exchange.priceToPrecision(symbol, tpPrice), 'holdSide': holdSide };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
            const slParams = { 'planType': 'normal_plan', 'triggerPrice': exchange.priceToPrecision(symbol, slPrice), 'holdSide': holdSide };
            slResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
        } else {
            const params = { 'closePosition': 'true' };
            tpResult = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
            slResult = await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
        }
        return { tpOrderId: tpResult.id, slOrderId: slResult.id };
    } catch (e) {
        safeLog('error', `[TP/SL] Lỗi khi đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}:`, e);
        return { tpOrderId: null, slOrderId: null };
    }
}

async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    await updateBalances();
    const shortEx = exchanges[shortExchange], longEx = exchanges[longExchange];
    const shortBalance = balances[shortExchange]?.available || 0, longBalance = balances[longExchange]?.available || 0;
    const minBalance = Math.min(shortBalance, longBalance);
    const collateral = minBalance * (percentageToUse / 100);
    if (collateral < MIN_COLLATERAL_FOR_TRADE) return false;
    const shortSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longSymbol = await getExchangeSpecificSymbol(longEx, coin);
    if (!shortSymbol || !longSymbol) return false;
    const [actualShortLeverage, actualLongLeverage] = await Promise.all([
        setLeverageSafely(shortEx, shortSymbol, desiredLeverage),
        setLeverageSafely(longEx, longSymbol, desiredLeverage)
    ]);
    if (!actualShortLeverage || !actualLongLeverage) return false;
    const leverageToUse = Math.min(actualShortLeverage, actualLongLeverage);
    let shortOrderDetails, longOrderDetails;
    try {
        const targetNotional = collateral * leverageToUse;
        [shortOrderDetails, longOrderDetails] = await Promise.all([
            computeOrderDetails(shortEx, shortSymbol, targetNotional, leverageToUse, shortBalance),
            computeOrderDetails(longEx, longSymbol, targetNotional, leverageToUse, longBalance)
        ]);
    } catch (e) {
        safeLog('error', `[PREPARE] Lỗi khi chuẩn bị lệnh:`, e.message);
        return false;
    }
    let shortOrder, longOrder;
    try {
        [shortOrder, longOrder] = await Promise.all([
            shortEx.createMarketSellOrder(shortSymbol, shortOrderDetails.amount, (shortEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {})),
            longEx.createMarketBuyOrder(longSymbol, longOrderDetails.amount, (longEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {}))
        ]);
    } catch (e) {
        safeLog('error', `[TRADE] Mở lệnh chính thất bại:`, e);
        return false;
    }
    await sleep(3000);
    const getReliableFillPrice = async (exchange, symbol, orderId) => {
        try {
            const order = await exchange.fetchOrder(orderId, symbol);
            if (order?.average > 0) return order.average;
            const trades = await exchange.fetchMyTrades(symbol, undefined, 1, { 'orderId': orderId });
            if (trades?.[0]?.price > 0) return trades[0].price;
            return null;
        } catch (e) {
            safeLog('error', `Lỗi nghiêm trọng khi lấy giá khớp lệnh cho ${exchange.id}. Lỗi: ${e.message}`);
            return null;
        }
    };
    const [shortEntryPrice, longEntryPrice] = await Promise.all([
        getReliableFillPrice(shortEx, shortSymbol, shortOrder.id),
        getReliableFillPrice(longEx, longSymbol, longOrder.id)
    ]);
    if (!shortEntryPrice || !longEntryPrice) {
        currentTradeDetails = { 
            ...opportunity.details, coin, status: 'MANUAL_CHECK_NO_SL', openTime: Date.now(), 
            shortOrderAmount: shortOrderDetails.amount, longOrderAmount: longOrderDetails.amount, 
            commonLeverageUsed: leverageToUse, shortOriginalSymbol: shortSymbol, longOriginalSymbol: longSymbol 
        };
        return false;
    }
    const [shortTpSlIds, longTpSlIds] = await Promise.all([
        placeTpSlOrders(shortEx, shortSymbol, 'sell', shortOrderDetails.amount, shortEntryPrice, collateral, shortOrderDetails.notional),
        placeTpSlOrders(longEx, longSymbol, 'buy', longOrderDetails.amount, longEntryPrice, collateral, longOrderDetails.notional)
    ]);
    currentTradeDetails = {
        ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(),
        shortOrderAmount: shortOrderDetails.amount, longOrderAmount: longOrderDetails.amount,
        commonLeverageUsed: leverageToUse, shortOriginalSymbol: shortSymbol, longOriginalSymbol: longSymbol,
        shortBalanceBefore: shortBalance, longBalanceBefore: longBalance,
        shortTpOrderId: shortTpSlIds.tpOrderId, shortSlOrderId: shortTpSlIds.slOrderId,
        longTpOrderId: longTpSlIds.tpOrderId, longSlOrderId: longTpSlIds.slOrderId,
    };
    return true;
}

async function cancelPendingOrders(tradeDetails) {
    if (!tradeDetails) return;
    const ordersToCancel = [
        { ex: exchanges[tradeDetails.shortExchange], symbol: tradeDetails.shortOriginalSymbol, id: tradeDetails.shortTpOrderId },
        { ex: exchanges[tradeDetails.shortExchange], symbol: tradeDetails.shortOriginalSymbol, id: tradeDetails.shortSlOrderId },
        { ex: exchanges[tradeDetails.longExchange], symbol: tradeDetails.longOriginalSymbol, id: tradeDetails.longTpOrderId },
        { ex: exchanges[tradeDetails.longExchange], symbol: tradeDetails.longOriginalSymbol, id: tradeDetails.longSlOrderId },
    ];
    await Promise.all(ordersToCancel.map(async (order) => {
        if (order.id && order.ex) {
            try {
                await order.ex.cancelOrder(order.id, order.symbol, (order.ex.id === 'kucoinfutures' || order.ex.id === 'bitget') ? { 'stop': true } : {});
            } catch (e) {
                 if (!e.message.includes('order not found')) {
                    safeLog('warn', `[CLEANUP] Không thể hủy lệnh ${order.id}: ${e.message}`);
                 }
            }
        }
    }));
}

async function closeTradeNow() {
    if (!currentTradeDetails) return false;
    const tradeToClose = { ...currentTradeDetails };
    if (tradeToClose.status === 'OPEN') {
        await cancelPendingOrders(tradeToClose);
        await sleep(1000); 
    }
    try {
        const shortEx = exchanges[tradeToClose.shortExchange];
        const longEx = exchanges[tradeToClose.longExchange];
        const params = { 'reduceOnly': true, ...(shortEx.id === 'kucoinfutures' && {'marginMode': 'cross'}) };
        await Promise.all([
            shortEx.createMarketBuyOrder(tradeToClose.shortOriginalSymbol, tradeToClose.shortOrderAmount, params),
            longEx.createMarketSellOrder(tradeToClose.longOriginalSymbol, tradeToClose.longOrderAmount, params)
        ]);
        tradeAwaitingPnl = { ...currentTradeDetails, status: 'PENDING_PNL_CALC', closeTime: Date.now() };
        currentTradeDetails = null;
        return true;
    } catch (e) {
        safeLog('error', `[PNL] Lỗi khi đóng vị thế cho ${tradeToClose.coin}:`, e);
        return false;
    }
}

async function calculatePnlAfterDelay(closedTrade) {
    await sleep(5000);
    await updateBalances();
    const shortBalanceAfter = balances[closedTrade.shortExchange]?.available || 0;
    const longBalanceAfter = balances[closedTrade.longExchange]?.available || 0;
    const pnlShort = shortBalanceAfter - closedTrade.shortBalanceBefore;
    const pnlLong = longBalanceAfter - closedTrade.longBalanceBefore;
    const totalPnl = pnlShort + pnlLong;
    safeLog('log', `[PNL] KẾT QUẢ PHIÊN (${closedTrade.coin}): PNL Tổng: ${totalPnl.toFixed(4)} USDT`);
    tradeHistory.unshift({ ...closedTrade, status: 'CLOSED', actualPnl: totalPnl, pnlShort, pnlLong });
    if (tradeHistory.length > 50) tradeHistory.pop();
    tradeAwaitingPnl = null;
}

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    try {
        if (tradeAwaitingPnl) {
            await calculatePnlAfterDelay(tradeAwaitingPnl);
        }
        if (!currentTradeDetails && !tradeAwaitingPnl) {
            const serverData = await fetchDataFromServer();
            await processServerData(serverData);
            const now = new Date();
            const currentMinute = now.getUTCMinutes();
            if (currentMinute >= 55) {
                for (const opportunity of allCurrentOpportunities) {
                    const minutesToFunding = (opportunity.nextFundingTime - Date.now()) / 60000;
                    if (minutesToFunding > 0 && minutesToFunding < MIN_MINUTES_FOR_EXECUTION) {
                        if (await executeTrades(opportunity, currentPercentageToUse)) break;
                    }
                }
            }
        }
    } catch (e) {
        safeLog('error', '[LOOP] Lỗi nghiêm trọng trong vòng lặp chính:', e);
    }
    if (botState === 'RUNNING') {
        botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
    }
}

function startBot() {
    if (botState === 'RUNNING') return false;
    botState = 'RUNNING';
    currentTradeDetails = null;
    tradeAwaitingPnl = null;
    updateBalances().then(mainBotLoop).catch(e => {
        safeLog('error', `[BOT] Lỗi cập nhật số dư ban đầu:`, e);
        botState = 'STOPPED';
    });
    return true;
}

function stopBot() {
    if (botState !== 'RUNNING') return false;
    botState = 'STOPPED';
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);
    return true;
}

const botServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = req.url;
    const method = req.method;
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    await new Promise(resolve => req.on('end', resolve));
    try {
        if (url === '/' && method === 'GET') {
            fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
                res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(err ? 'Lỗi đọc file index.html' : content);
            });
        } else if (url === '/bot-api/status' && method === 'GET') {
            const transferExchanges = ['binanceusdm', 'bitget', 'kucoinfutures'];
            const internalTransferExchanges = activeExchangeIds.filter(id => exchanges[id]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ botState, balances, tradeHistory, bestPotentialOpportunityForDisplay, currentTradeDetails, activeExchangeIds, exchangeHealth, transferExchanges, internalTransferExchanges, transferStatus }));
        } else if (url === '/bot-api/start' && method === 'POST') {
            try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch { currentPercentageToUse = 50; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: startBot(), message: 'Đã gửi yêu cầu khởi động bot.' }));
        } else if (url === '/bot-api/stop' && method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: stopBot(), message: 'Đã gửi yêu cầu dừng bot.' }));
        } else if (url === '/bot-api/custom-test-trade' && method === 'POST') {
            if (currentTradeDetails || transferStatus.inProgress) return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Bot đang bận với một giao dịch hoặc đang chuyển tiền.' }));
            if (!bestPotentialOpportunityForDisplay) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Chưa có cơ hội nào.' }));
            const data = JSON.parse(body);
            const testOpportunity = { coin: bestPotentialOpportunityForDisplay?.coin, commonLeverage: parseInt(data.leverage, 10) || 20, details: { shortExchange: data.shortExchange, longExchange: data.longExchange } };
            const tradeSuccess = await executeTrades(testOpportunity, parseFloat(data.percentage));
            res.writeHead(tradeSuccess ? 200 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: tradeSuccess, message: tradeSuccess ? 'Lệnh Test đã được gửi.' : 'Lỗi khi gửi lệnh Test.' }));
        } else if (url === '/bot-api/close-trade-now' && method === 'POST') {
            const success = await closeTradeNow();
            res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success, message: success ? 'Đã gửi yêu cầu đóng lệnh.' : 'Không có lệnh đang mở hoặc có lỗi.' }));
        } else if (url === '/bot-api/transfer-funds' && method === 'POST') {
            if (transferStatus.inProgress) {
                return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Đang có một quá trình chuyển tiền khác diễn ra.' }));
            }
            const { fromExchangeId, toExchangeId, amountStr } = JSON.parse(body);
            const amount = parseFloat(amountStr);
            const allowedExchanges = ['binanceusdm', 'bitget', 'kucoinfutures'];
            if (!allowedExchanges.includes(fromExchangeId) || !allowedExchanges.includes(toExchangeId) || !amount || isNaN(amount) || amount < getMinTransferAmount(fromExchangeId) || fromExchangeId === toExchangeId) {
                return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Dữ liệu không hợp lệ.' }));
            }
            if (!exchanges[fromExchangeId] || !exchanges[toExchangeId]) {
                 return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Sàn chưa được khởi tạo.' }));
            }
            if (!getTargetDepositInfo(fromExchangeId, toExchangeId)) {
                return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Lỗi cấu hình địa chỉ/mạng.' }));
            }
            executeFundTransfer(fromExchangeId, toExchangeId, amount);
            res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, message: 'Đã nhận yêu cầu. Quá trình chuyển tiền đang được xử lý trong nền.' }));
        } else if (url === '/bot-api/internal-transfer' && method === 'POST') {
            const { exchangeId, amountStr, fromAccount: genericFrom, toAccount: genericTo } = JSON.parse(body);
            const amount = parseFloat(amountStr);
            if(!exchangeId || !amount || isNaN(amount) || amount <= 0 || !genericFrom || !genericTo) {
                 return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Dữ liệu không hợp lệ.` }));
            }
            const exchange = exchanges[exchangeId];
            if (!exchange) return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Sàn ${exchangeId} chưa được khởi tạo.` }));
            let from = genericFrom, to = genericTo;
            if (exchangeId === 'bitget') { if (from === 'future') from = 'swap'; if (to === 'future') to = 'swap'; }
            else if (exchangeId === 'kucoinfutures') { if (from === 'spot') from = 'main'; if (to === 'spot') to = 'main'; }
            try {
                await exchange.transfer('USDT', amount, from, to);
                setTimeout(updateBalances, 3000);
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, message: 'Chuyển nội bộ thành công.' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Lỗi: ${e.message}` }));
            }
        } else {
            res.writeHead(404).end('Not Found');
        }
    } catch (error) {
        safeLog('error', `[SERVER] Lỗi xử lý yêu cầu ${method} ${url}:`, error);
        res.writeHead(500).end('Internal Server Error');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
