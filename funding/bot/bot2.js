const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

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
} = require('../config.js');

const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15;
const DATA_FETCH_INTERVAL_SECONDS = 5;
const MAX_CONSECUTIVE_FAILS = 3;
const MIN_COLLATERAL_FOR_TRADE = 0.1;
const TP_SL_PNL_PERCENTAGE = 1.5;

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
    safeLog('log', '[BALANCES] Đang cập nhật số dư...');
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id] || exchangeHealth[id].isDisabled) return;
        try {
            let balanceData = (id === 'kucoinfutures') ? await exchanges[id].fetchBalance() : await exchanges[id].fetchBalance({ 'type': 'future' });
            const usdtAvailable = balanceData?.free?.USDT || 0;
            const usdtTotal = balanceData?.total?.USDT || 0;
            balances[id] = { available: usdtAvailable, total: usdtTotal };
            exchangeHealth[id].consecutiveFails = 0;
            if (exchangeHealth[id].isDisabled) {
                exchangeHealth[id].isDisabled = false;
                safeLog('info', `[HEALTH] Sàn ${id.toUpperCase()} đã hoạt động trở lại.`);
            }
        } catch (e) {
            balances[id] = { available: 0, total: 0 };
            exchangeHealth[id].consecutiveFails++;
            safeLog('error', `[BALANCES] Lỗi lấy số dư ${id.toUpperCase()} (lần ${exchangeHealth[id].consecutiveFails}): ${e.message}`);
            if (exchangeHealth[id].consecutiveFails >= MAX_CONSECUTIVE_FAILS && !exchangeHealth[id].isDisabled) {
                exchangeHealth[id].isDisabled = true;
                safeLog('warn', `[HEALTH] Sàn ${id.toUpperCase()} đã bị tạm vô hiệu hóa.`);
            }
        }
    }));
    safeLog('log', '[BALANCES] Hoàn tất cập nhật số dư.');
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
    safeLog('warn', `[SYMBOL] ❌ KHÔNG tìm thấy symbol hợp lệ cho ${rawCoinSymbol} trên ${exchange.id}.`);
    return null;
}

async function setLeverageSafely(exchange, symbol, desiredLeverage) {
    const params = {};
    if (exchange.id === 'kucoinfutures') {
        params['marginMode'] = 'cross';
    }
    try {
        await exchange.setLeverage(desiredLeverage, symbol, params);
        safeLog('log', `[LEVERAGE] ✅ Đặt đòn bẩy x${desiredLeverage} cho ${symbol} trên ${exchange.id} thành công.`);
        return desiredLeverage;
    } catch (e) {
        safeLog('error', `[LEVERAGE] ❌ Không thể đặt đòn bẩy x${desiredLeverage} cho ${symbol} trên ${exchange.id}. Lỗi: ${e.message}`);
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
    const opportunities = [];
    for (const op of serverData.arbitrageData) {
        if (!op?.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) continue;
        const [shortExRaw, longExRaw] = op.exchanges.split(' / ');
        if (!shortExRaw || !longExRaw) continue;
        const shortExchange = normalizeExchangeId(shortExRaw);
        const longExchange = normalizeExchangeId(longExRaw);
        if (!exchanges[shortExchange] || exchangeHealth[shortExchange]?.isDisabled || !exchanges[longExchange] || exchangeHealth[longExchange]?.isDisabled) continue;
        op.details = { shortExchange, longExchange };
        opportunities.push(op);
    }
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
    const rawAmount = targetNotionalUSDT / (price * contractSize);
    let amount = parseFloat(exchange.amountToPrecision(symbol, rawAmount));

    const currentNotional = amount * price * contractSize;
    const requiredMargin = currentNotional / leverage;
    
    const minCost = market.limits?.cost?.min ?? 0;
    if (minCost > 0 && currentNotional < minCost) {
        throw new Error(`Giá trị lệnh ${currentNotional.toFixed(4)} < mức tối thiểu ${minCost} USDT.`);
    }

    const safetyBuffer = 0.98;
    if (requiredMargin > availableBalance * safetyBuffer) {
        safeLog('warn', `[ADJUST] Ký quỹ yêu cầu (${requiredMargin.toFixed(4)}) > mức an toàn (${(availableBalance * safetyBuffer).toFixed(4)}). Đang điều chỉnh lại số lượng...`);
        const maxNotional = availableBalance * leverage * safetyBuffer;
        const maxRawAmount = maxNotional / (price * contractSize);
        let newAmount = parseFloat(exchange.amountToPrecision(symbol, maxRawAmount));
        
        if (newAmount <= (market.limits?.amount?.min ?? 0)) {
            throw new Error(`Không đủ ký quỹ. Yêu cầu ${requiredMargin.toFixed(4)}, có sẵn ${availableBalance.toFixed(4)} USDT.`);
        }

        const newNotional = newAmount * price * contractSize;
        safeLog('log', `[ADJUST] Đã điều chỉnh: Số lượng ${amount} -> ${newAmount}, Giá trị ${currentNotional.toFixed(2)} -> ${newNotional.toFixed(2)} USDT.`);
        amount = newAmount;
    }
    
    return {
        amount,
        price,
        notional: amount * price * contractSize,
        requiredMargin: (amount * price * contractSize) / leverage,
    };
}

async function placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
    if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
        safeLog('error', `[TP/SL] ❌ Giá vào lệnh không hợp lệ (${entryPrice}), bỏ qua đặt TP/SL cho ${symbol}`);
        return { tpOrderId: null, slOrderId: null };
    }
    if (!notionalValue || notionalValue <= 0) {
        safeLog('error', `[TP/SL] ❌ Giá trị vị thế (notional) không hợp lệ (${notionalValue}), bỏ qua đặt TP/SL.`);
        return { tpOrderId: null, slOrderId: null };
    }

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
    
    if (isNaN(tpPrice) || isNaN(slPrice) || tpPrice <= 0 || slPrice <= 0) {
        safeLog('error', `[TP/SL] ❌ Giá TP/SL tính ra không hợp lệ (TP: ${tpPrice}, SL: ${slPrice}) cho ${symbol}`);
        return { tpOrderId: null, slOrderId: null };
    }

    const orderSide = (side === 'sell') ? 'buy' : 'sell';
    safeLog('log', `[TP/SL] Đang đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}... (TP: ${tpPrice.toFixed(5)}, SL: ${slPrice.toFixed(5)})`);

    try {
        let tpResult, slResult;

        if (exchange.id === 'kucoinfutures') {
            const tpParams = {
                'reduceOnly': true, 'stop': side === 'sell' ? 'down' : 'up',
                'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType': 'MP',
                'size': amount, 'marginMode': 'cross'
            };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, undefined, undefined, tpParams);
            safeLog('log', `[TP/SL] ✅ [KuCoin] Đặt lệnh TP cho ${symbol} thành công. ID: ${tpResult.id}`);

            const slParams = {
                'reduceOnly': true, 'stop': side === 'sell' ? 'up' : 'down',
                'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType': 'MP',
                'size': amount, 'marginMode': 'cross'
            };
            slResult = await exchange.createOrder(symbol, 'market', orderSide, undefined, undefined, slParams);
            safeLog('log', `[TP/SL] ✅ [KuCoin] Đặt lệnh SL cho ${symbol} thành công. ID: ${slResult.id}`);

        } else if (exchange.id === 'bitget') {
            const tpParams = {
                'reduceOnly': true,
                'takeProfitPrice': exchange.priceToPrecision(symbol, tpPrice)
            };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
            safeLog('log', `[TP/SL] ✅ [Bitget] Đặt lệnh TP cho ${symbol} thành công. ID: ${tpResult.id}`);

            const slParams = {
                'reduceOnly': true,
                'stopLossPrice': exchange.priceToPrecision(symbol, slPrice)
            };
            slResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
            safeLog('log', `[TP/SL] ✅ [Bitget] Đặt lệnh SL cho ${symbol} thành công. ID: ${slResult.id}`);

        } else { // Logic chuẩn cho Binance, OKX...
            const params = { 'reduceOnly': true };
            tpResult = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
            safeLog('log', `[TP/SL] ✅ Đặt lệnh TP cho ${symbol} thành công. ID: ${tpResult.id}`);

            slResult = await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
            safeLog('log', `[TP/SL] ✅ Đặt lệnh SL cho ${symbol} thành công. ID: ${slResult.id}`);
        }

        return { tpOrderId: tpResult.id, slOrderId: slResult.id };
    } catch (e) {
        safeLog('error', `[TP/SL] ❌ Lỗi khi đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}:`, e);
        return { tpOrderId: null, slOrderId: null };
    }
}


async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;

    safeLog('log', `[TRADE] Chuẩn bị giao dịch ${coin} (Short: ${shortExchange.toUpperCase()}, Long: ${longExchange.toUpperCase()})...`);
    await updateBalances();
    
    const shortEx = exchanges[shortExchange];
    const longEx = exchanges[longExchange];

    const shortBalance = balances[shortExchange]?.available || 0;
    const longBalance = balances[longExchange]?.available || 0;
    const minBalance = Math.min(shortBalance, longBalance);
    safeLog('log', `[TRADE] Số dư nhỏ nhất được chọn làm cơ sở: ${minBalance.toFixed(4)} USDT`);

    const collateral = minBalance * (percentageToUse / 100);
    if (collateral < MIN_COLLATERAL_FOR_TRADE) {
        safeLog('error', `[TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) < mức sàn của bot (${MIN_COLLATERAL_FOR_TRADE} USDT).`);
        return false;
    }
    
    const shortOriginalSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longOriginalSymbol = await getExchangeSpecificSymbol(longEx, coin);
    if (!shortOriginalSymbol || !longOriginalSymbol) return false;
    
    const actualShortLeverage = await setLeverageSafely(shortEx, shortOriginalSymbol, desiredLeverage);
    const actualLongLeverage = await setLeverageSafely(longEx, longOriginalSymbol, desiredLeverage);
    if (!actualShortLeverage || !actualLongLeverage) return false;
    
    const leverageToUse = Math.min(actualShortLeverage, actualLongLeverage);

    let shortOrderDetails, longOrderDetails;
    try {
        const targetNotional = collateral * leverageToUse;
        safeLog('log', `[DEBUG] Giá trị lệnh mục tiêu (Target Notional): ${targetNotional.toFixed(4)} USDT`);
        shortOrderDetails = await computeOrderDetails(shortEx, shortOriginalSymbol, targetNotional, leverageToUse, shortBalance);
        longOrderDetails = await computeOrderDetails(longEx, longOriginalSymbol, targetNotional, leverageToUse, longBalance);
        safeLog('log', '[DEBUG] SHORT ORDER PREPARE:', shortOrderDetails);
        safeLog('log', '[DEBUG] LONG ORDER PREPARE:', longOrderDetails);
    } catch (e) {
        safeLog('error', `[PREPARE] ❌ Lỗi khi chuẩn bị lệnh:`, e.message);
        return false;
    }

    let shortOrder, longOrder;
    try {
        const shortParams = {}; if (shortEx.id === 'kucoinfutures') shortParams['marginMode'] = 'cross';
        const longParams = {}; if (longEx.id === 'kucoinfutures') longParams['marginMode'] = 'cross';
        
        shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortOrderDetails.amount, shortParams);
        longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longOrderDetails.amount, longParams);
        safeLog('log', `[TRADE] ✅ Mở lệnh chính thành công.`);
    } catch (e) {
        safeLog('error', `[TRADE] ❌ Mở lệnh chính thất bại:`, e);
        return false;
    }
    
    safeLog('log', '[TRADE] Đang chờ 3 giây để tất cả sàn cập nhật trạng thái lệnh...');
    await sleep(3000);

    const getReliableFillPrice = async (exchange, symbol, orderId) => {
        try {
            const trades = await exchange.fetchMyTrades(symbol, undefined, 1, { 'orderId': orderId });
            if (trades && trades.length > 0) {
                safeLog('log', `[PRICE] Lấy giá khớp lệnh từ fetchMyTrades cho ${exchange.id}: ${trades[0].price}`);
                return trades[0].price;
            }
            const order = await exchange.fetchOrder(orderId, symbol);
            if (order && order.average) {
                safeLog('log', `[PRICE] Lấy giá khớp lệnh từ fetchOrder cho ${exchange.id}: ${order.average}`);
                return order.average;
            }
            throw new Error("Không tìm thấy trade hoặc giá average trong order.");
        } catch (e) {
            safeLog('warn', `[PRICE] Không thể lấy giá khớp lệnh chính xác cho ${exchange.id} (Lỗi: ${e.message}). Dùng giá ticker làm phương án dự phòng.`);
            const ticker = await exchange.fetchTicker(symbol);
            return ticker.last;
        }
    };

    let shortEntryPrice = await getReliableFillPrice(shortEx, shortOriginalSymbol, shortOrder.id);
    let longEntryPrice = await getReliableFillPrice(longEx, longOriginalSymbol, longOrder.id);

    if (!shortEntryPrice || !longEntryPrice || isNaN(shortEntryPrice) || isNaN(longEntryPrice)) {
        safeLog('error', `[TRADE] ❌ KHÔNG THỂ XÁC ĐỊNH GIÁ VÀO LỆNH SAU KHI CHỜ. Sẽ không đặt TP/SL. Vui lòng kiểm tra thủ công!`);
        return false;
    }
    
    const shortTpSlIds = await placeTpSlOrders(shortEx, shortOriginalSymbol, 'sell', shortOrderDetails.amount, shortEntryPrice, collateral, shortOrderDetails.notional);
    const longTpSlIds = await placeTpSlOrders(longEx, longOriginalSymbol, 'buy', longOrderDetails.amount, longEntryPrice, collateral, longOrderDetails.notional);

    currentTradeDetails = {
        ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(),
        shortOrderAmount: shortOrderDetails.amount, longOrderAmount: longOrderDetails.amount,
        commonLeverageUsed: leverageToUse, shortOriginalSymbol, longOriginalSymbol,
        shortBalanceBefore: shortBalance, longBalanceBefore: longBalance,
        shortTpOrderId: shortTpSlIds.tpOrderId, shortSlOrderId: shortTpSlIds.slOrderId,
        longTpOrderId: longTpSlIds.tpOrderId, longSlOrderId: longTpSlIds.slOrderId,
    };
    return true;
}

async function cancelPendingOrders(tradeDetails) {
    if (!tradeDetails) return;
    safeLog('log', '[CLEANUP] Dọn dẹp các lệnh TP/SL đang chờ...');
    const { shortExchange, shortOriginalSymbol, shortTpOrderId, shortSlOrderId, longExchange, longOriginalSymbol, longTpOrderId, longSlOrderId } = tradeDetails;
    const shortEx = exchanges[shortExchange];
    const longEx = exchanges[longExchange];
    const ordersToCancel = [
        { ex: shortEx, symbol: shortOriginalSymbol, id: shortTpOrderId },
        { ex: shortEx, symbol: shortOriginalSymbol, id: shortSlOrderId },
        { ex: longEx, symbol: longOriginalSymbol, id: longTpOrderId },
        { ex: longEx, symbol: longOriginalSymbol, id: longSlOrderId },
    ];
    for (const order of ordersToCancel) {
        if (order.id) {
            try {
                if (order.ex.id === 'kucoinfutures') {
                    await order.ex.cancelOrder(order.id, order.symbol, { 'stop': true });
                } else {
                    await order.ex.cancelOrder(order.id, order.symbol);
                }
                safeLog('log', `[CLEANUP] ✅ Hủy lệnh ${order.id} thành công.`);
            } catch (e) {
                if (e.message.includes('order not found')) {
                     safeLog('warn', `[CLEANUP] ⚠️ Lệnh ${order.id} không tìm thấy (có thể đã khớp hoặc bị hủy).`);
                } else {
                    safeLog('warn', `[CLEANUP] ⚠️ Không thể hủy lệnh ${order.id}: ${e.message}`);
                }
            }
        }
    }
}

async function closeTradeNow() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('warn', '[API] Không có giao dịch nào đang mở để đóng.');
        return false;
    }
    const tradeToClose = { ...currentTradeDetails };
    safeLog('log', `[API] Nhận yêu cầu đóng lệnh cho ${tradeToClose.coin}...`);
    
    await cancelPendingOrders(tradeToClose);
    await sleep(1000); 

    try {
        const shortEx = exchanges[tradeToClose.shortExchange];
        const longEx = exchanges[tradeToClose.longExchange];
        
        const shortParams = { 'reduceOnly': true }; 
        if (shortEx.id === 'kucoinfutures') shortParams['marginMode'] = 'cross';
        
        const longParams = { 'reduceOnly': true };
        if (longEx.id === 'kucoinfutures') longParams['marginMode'] = 'cross';

        await shortEx.createMarketBuyOrder(tradeToClose.shortOriginalSymbol, tradeToClose.shortOrderAmount, shortParams);
        await longEx.createMarketSellOrder(tradeToClose.longOriginalSymbol, tradeToClose.longOrderAmount, longParams);
        
        currentTradeDetails.status = 'PENDING_PNL_CALC';
        currentTradeDetails.closeTime = Date.now();
        tradeAwaitingPnl = { ...currentTradeDetails };
        
        safeLog('log', `[PNL] ✅ Đã gửi lệnh đóng cho ${tradeToClose.coin}. Chờ tính PNL...`);
        currentTradeDetails = null;
        return true;
    } catch (e) {
        safeLog('error', `[PNL] ❌ Lỗi khi đóng vị thế cho ${tradeToClose.coin}:`, e);
        return false;
    }
}

async function calculatePnlAfterDelay(closedTrade) {
    safeLog('log', `[PNL] Chờ 5 giây để số dư cập nhật trước khi tính PNL...`);
    await sleep(5000);
    safeLog('log', `[PNL] Đang tính PNL cho giao dịch đã đóng (${closedTrade.coin})...`);
    await updateBalances();
    const shortBalanceAfter = balances[closedTrade.shortExchange]?.available || 0;
    const longBalanceAfter = balances[closedTrade.longExchange]?.available || 0;
    const pnlShort = shortBalanceAfter - closedTrade.shortBalanceBefore;
    const pnlLong = longBalanceAfter - closedTrade.longBalanceBefore;
    const totalPnl = pnlShort + pnlLong;
    safeLog('log', `[PNL] KẾT QUẢ PHIÊN (${closedTrade.coin}):`);
    safeLog('log', `  > ${closedTrade.shortExchange.toUpperCase()} PNL: ${pnlShort.toFixed(4)} USDT`);
    safeLog('log', `  > ${closedTrade.longExchange.toUpperCase()} PNL: ${pnlLong.toFixed(4)} USDT`);
    safeLog('log', `  > TỔNG PNL: ${totalPnl.toFixed(4)} USDT`);
    tradeHistory.unshift({ ...closedTrade, status: 'CLOSED', actualPnl: totalPnl });
    if (tradeHistory.length > 50) tradeHistory.pop();
    tradeAwaitingPnl = null;
}

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    try {
        if (tradeAwaitingPnl && (Date.now() - tradeAwaitingPnl.closeTime >= 15000)) {
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
                        safeLog('log', `[LOOP] Phát hiện cơ hội đủ điều kiện để mở: ${opportunity.coin}.`);
                        if (await executeTrades(opportunity, currentPercentageToUse)) break;
                    }
                }
            }
        }
    } catch (e) {
        safeLog('error', '[LOOP] Gặp lỗi nghiêm trọng trong vòng lặp chính:', e);
    }
    botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

function startBot() {
    if (botState === 'RUNNING') return false;
    botState = 'RUNNING';
    safeLog('log', '[BOT] Khởi động Bot...');
    currentTradeDetails = null;
    tradeAwaitingPnl = null;
    updateBalances().then(() => mainBotLoop()).catch(e => {
        safeLog('error', `[BOT] Lỗi cập nhật số dư ban đầu:`, e);
        botState = 'STOPPED';
    });
    return true;
}

function stopBot() {
    if (botState !== 'RUNNING') return false;
    botState = 'STOPPED';
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);
    safeLog('log', '[BOT] Dừng Bot...');
    return true;
}

const botServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(err ? 'Lỗi đọc file index.html' : content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        const statusData = { botState, balances, tradeHistory, bestPotentialOpportunityForDisplay, currentTradeDetails, activeExchangeIds, exchangeHealth };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch { currentPercentageToUse = 50; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: startBot(), message: 'Đã gửi yêu cầu khởi động bot.' }));
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopBot(), message: 'Đã gửi yêu cầu dừng bot.' }));
    } else if (req.url === '/bot-api/custom-test-trade' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { shortExchange, longExchange, leverage, percentage } = data;
                if (!bestPotentialOpportunityForDisplay) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Hiện không có cơ hội nào để lấy coin test.' }));
                }
                if (currentTradeDetails) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở.' }));
                }
                const testOpportunity = {
                    coin: bestPotentialOpportunityForDisplay.coin,
                    commonLeverage: parseInt(leverage, 10) || 20,
                    details: { shortExchange, longExchange }
                };
                const tradeSuccess = await executeTrades(testOpportunity, parseFloat(percentage));
                if (tradeSuccess) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Lệnh Test đã được gửi thành công!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Lỗi khi gửi lệnh Test. Kiểm tra log bot.' }));
                }
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện lệnh test.' }));
            }
        });
    } else if (req.url === '/bot-api/close-trade-now' && req.method === 'POST') {
        const success = await closeTradeNow();
        if (success) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Đã gửi yêu cầu đóng lệnh. PNL sẽ được tính sau giây lát.' }));
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Không có lệnh nào đang mở để đóng hoặc đã có lỗi xảy ra.' }));
        }
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
