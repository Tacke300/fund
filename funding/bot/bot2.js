const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// --- CÁC HÀM TIỆN ÍCH VÀ KHAI BÁO BIẾN ---
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
const TP_SL_PNL_PERCENTAGE = 150;

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

// --- KHỞI TẠO SÀN GIAO DỊCH ---
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

// --- CÁC HÀM LOGIC CỐT LÕI CỦA BOT ---

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
            safeLog('error', `[BALANCES] Lỗi lấy số dư ${id.toUpperCase()} (lần ${exchangeHealth[id].consecutiveFails}): ${e.message}`);
            if (exchangeHealth[id].consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
                if (!exchangeHealth[id].isDisabled) {
                    exchangeHealth[id].isDisabled = true;
                    safeLog('warn', `[HEALTH] Sàn ${id.toUpperCase()} đã bị tạm vô hiệu hóa do ${MAX_CONSECUTIVE_FAILS} lỗi liên tiếp.`);
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
    safeLog('warn', `[SYMBOL] ❌ KHÔNG tìm thấy symbol hợp lệ cho ${rawCoinSymbol} trên ${exchange.id}.`);
    return null;
}

async function setLeverageSafely(exchange, symbol, desiredLeverage) {
    const params = (exchange.id === 'kucoinfutures') ? { 'marginMode': 'cross' } : {};
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
        safeLog('warn', `[ADJUST] Ký quỹ yêu cầu (${requiredMargin.toFixed(4)}) > mức an toàn (${(availableBalance * safetyBuffer).toFixed(4)}). Đang điều chỉnh...`);
        const maxNotional = availableBalance * leverage * safetyBuffer;
        let newAmount = parseFloat(exchange.amountToPrecision(symbol, maxNotional / (price * contractSize)));
        if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) newAmount = Math.floor(newAmount);
        
        if (newAmount <= (market.limits.amount.min || 0)) {
             throw new Error(`Không đủ ký quỹ sau khi điều chỉnh. Yêu cầu ${requiredMargin.toFixed(4)}, có sẵn ${availableBalance.toFixed(4)} USDT.`);
        }
        amount = newAmount;
        currentNotional = amount * price * contractSize;
        safeLog('log', `[ADJUST] Đã điều chỉnh: Số lượng -> ${amount}, Giá trị -> ${currentNotional.toFixed(2)} USDT.`);
    }
    
    return { amount, price, notional: currentNotional, requiredMargin: currentNotional / leverage };
}

async function placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
    // Lớp phòng vệ đầu tiên: Kiểm tra dữ liệu đầu vào
    if (!entryPrice || typeof entryPrice !== 'number' || entryPrice <= 0) {
        safeLog('error', `[TP/SL] ❌ DỮ LIỆU ĐẦU VÀO KHÔNG HỢP LỆ: entryPrice là '${entryPrice}'. Hủy đặt lệnh.`);
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
        safeLog('error', `[TP/SL] ❌ Giá TP/SL cơ bản tính ra không hợp lệ/âm (TP: ${tpPrice}, SL: ${slPrice}). Hủy đặt lệnh.`);
        return { tpOrderId: null, slOrderId: null };
    }

    const orderSide = (side === 'sell') ? 'buy' : 'sell';
    safeLog('log', `[TP/SL] Chuẩn bị đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}... (Giá gốc TP ~${tpPrice.toFixed(6)}, SL ~${slPrice.toFixed(6)})`);

    try {
        let tpResult, slResult;
        if (exchange.id === 'kucoinfutures') {
            const tpParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'down' : 'up', 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType': 'MP' };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
            const slParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'up' : 'down', 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType': 'MP' };
            slResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
            safeLog('log', `[TP/SL] ✅ [KuCoin] Đặt TP/SL thành công.`);
        } else if (exchange.id === 'bitget') {
            const holdSide = side === 'buy' ? 'long' : 'short';
            const tpParams = { 'planType': 'normal_plan', 'triggerPrice': exchange.priceToPrecision(symbol, tpPrice), 'holdSide': holdSide };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
            const slParams = { 'planType': 'normal_plan', 'triggerPrice': exchange.priceToPrecision(symbol, slPrice), 'holdSide': holdSide };
            slResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
            safeLog('log', `[TP/SL] ✅ [Bitget] Đặt TP/SL thành công.`);
        } else {
            const market = exchange.market(symbol);
            const tickSize = market.precision.price ? Math.pow(10, -market.precision.price) : 0.000001;
            const offset = 2 * tickSize;
            let finalTpPrice, finalSlPrice;

            if (side === 'buy') {
                finalTpPrice = tpPrice + offset;
                finalSlPrice = slPrice - offset;
            } else {
                finalTpPrice = tpPrice - offset;
                finalSlPrice = slPrice + offset;
            }

            if (finalTpPrice <= 0 || finalSlPrice <= 0) {
                 safeLog('error', `[TP/SL] ❌ Giá sau khi điều chỉnh offset bị âm (TP: ${finalTpPrice}, SL: ${finalSlPrice}). Hủy đặt lệnh.`);
                 return { tpOrderId: null, slOrderId: null };
            }
            safeLog('log', `[TP/SL] [${exchange.id.toUpperCase()}] Giá đã điều chỉnh - TP: ${finalTpPrice.toFixed(6)}, SL: ${finalSlPrice.toFixed(6)}`);

            const params = { 'reduceOnly': true };
            tpResult = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, finalTpPrice) });
            slResult = await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, finalSlPrice) });
            safeLog('log', `[TP/SL] ✅ [${exchange.id.toUpperCase()}] Đặt TP/SL thành công.`);
        }
        return { tpOrderId: tpResult.id, slOrderId: slResult.id };
    } catch (e) {
        safeLog('error', `[TP/SL] ❌ Lỗi khi đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}:`, e);
        return { tpOrderId: null, slOrderId: null };
    }
}

// ===================================================================================
// ================= HÀM executeTrades ĐÃ ĐƯỢC THÊM CHỐT CHẶN AN TOÀN =================
// ===================================================================================
async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    safeLog('log', `[TRADE] Bắt đầu giao dịch ${coin} (Short: ${shortExchange.toUpperCase()}, Long: ${longExchange.toUpperCase()})...`);
    
    await updateBalances();
    const shortEx = exchanges[shortExchange], longEx = exchanges[longExchange];
    const shortBalance = balances[shortExchange]?.available || 0, longBalance = balances[longExchange]?.available || 0;
    const minBalance = Math.min(shortBalance, longBalance);
    safeLog('log', `[TRADE] Số dư nhỏ nhất được chọn: ${minBalance.toFixed(4)} USDT`);

    const collateral = minBalance * (percentageToUse / 100);
    if (collateral < MIN_COLLATERAL_FOR_TRADE) {
        safeLog('error', `[TRADE] Vốn thế chấp (${collateral.toFixed(2)}) < mức tối thiểu (${MIN_COLLATERAL_FOR_TRADE} USDT). Hủy.`);
        return false;
    }
    
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
        safeLog('log', `[DEBUG] Giá trị lệnh mục tiêu (Notional): ${targetNotional.toFixed(4)} USDT`);
        [shortOrderDetails, longOrderDetails] = await Promise.all([
            computeOrderDetails(shortEx, shortSymbol, targetNotional, leverageToUse, shortBalance),
            computeOrderDetails(longEx, longSymbol, targetNotional, leverageToUse, longBalance)
        ]);
        safeLog('log', '[DEBUG] SHORT PREPARE:', shortOrderDetails);
        safeLog('log', '[DEBUG] LONG PREPARE:', longOrderDetails);
    } catch (e) {
        safeLog('error', `[PREPARE] ❌ Lỗi khi chuẩn bị lệnh:`, e.message);
        return false;
    }

    let shortOrder, longOrder;
    try {
        [shortOrder, longOrder] = await Promise.all([
            shortEx.createMarketSellOrder(shortSymbol, shortOrderDetails.amount, (shortEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {})),
            longEx.createMarketBuyOrder(longSymbol, longOrderDetails.amount, (longEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {}))
        ]);
        safeLog('log', `[TRADE] ✅ Mở lệnh chính thành công.`);
    } catch (e) {
        safeLog('error', `[TRADE] ❌ Mở lệnh chính thất bại:`, e);
        return false;
    }
    
    safeLog('log', '[TRADE] Chờ 3 giây để lệnh được khớp và cập nhật...');
    await sleep(3000);

    const getReliableFillPrice = async (exchange, symbol, orderId) => {
        try {
            safeLog('log', `[PRICE] Đang lấy giá khớp lệnh cho order ${orderId} trên ${exchange.id}...`);
            const order = await exchange.fetchOrder(orderId, symbol);
            if (order?.average && typeof order.average === 'number' && order.average > 0) {
                safeLog('log', `[PRICE] ✅ Lấy giá từ fetchOrder: ${order.average}`);
                return order.average;
            }
            const trades = await exchange.fetchMyTrades(symbol, undefined, 1, { 'orderId': orderId });
            if (trades?.[0]?.price && typeof trades[0].price === 'number' && trades[0].price > 0) {
                safeLog('log', `[PRICE] ✅ Lấy giá từ fetchMyTrades: ${trades[0].price}`);
                return trades[0].price;
            }
            throw new Error("Không tìm thấy giá khớp lệnh hợp lệ.");
        } catch (e) {
            safeLog('error', `[PRICE] ❌ Lỗi nghiêm trọng khi lấy giá khớp lệnh cho ${exchange.id}. Lỗi: ${e.message}`);
            return null; // Trả về null khi có lỗi
        }
    };

    const [shortEntryPrice, longEntryPrice] = await Promise.all([
        getReliableFillPrice(shortEx, shortSymbol, shortOrder.id),
        getReliableFillPrice(longEx, longSymbol, longOrder.id)
    ]);

    // =========================================================================
    // ====================== CHỐT CHẶN AN TOÀN MỚI ============================
    // =========================================================================
    if (!shortEntryPrice || !longEntryPrice || typeof shortEntryPrice !== 'number' || typeof longEntryPrice !== 'number') {
        safeLog('error', `[TRADE] ❌ KHÔNG THỂ XÁC ĐỊNH GIÁ VÀO LỆNH HỢP LỆ. Sẽ không đặt TP/SL. VUI LÒNG KIỂM TRA VÀ ĐÓNG LỆNH THỦ CÔNG!`);
        currentTradeDetails = { 
            ...opportunity.details, coin, status: 'MANUAL_CHECK_NO_SL', openTime: Date.now(), 
            shortOrderAmount: shortOrderDetails.amount, longOrderAmount: longOrderDetails.amount, 
            commonLeverageUsed: leverageToUse, shortOriginalSymbol: shortSymbol, longOriginalSymbol: longSymbol 
        };
        return false; // Dừng lại tại đây
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


// --- CÁC HÀM QUẢN LÝ GIAO DỊCH VÀ VÒNG LẶP ---
async function cancelPendingOrders(tradeDetails) {
    if (!tradeDetails) return;
    safeLog('log', '[CLEANUP] Dọn dẹp các lệnh TP/SL đang chờ...');
    const ordersToCancel = [
        { ex: exchanges[tradeDetails.shortExchange], symbol: tradeDetails.shortOriginalSymbol, id: tradeDetails.shortTpOrderId },
        { ex: exchanges[tradeDetails.shortExchange], symbol: tradeDetails.shortOriginalSymbol, id: tradeDetails.shortSlOrderId },
        { ex: exchanges[tradeDetails.longExchange], symbol: tradeDetails.longOriginalSymbol, id: tradeDetails.longTpOrderId },
        { ex: exchanges[tradeDetails.longExchange], symbol: tradeDetails.longOriginalSymbol, id: tradeDetails.longSlOrderId },
    ];
    await Promise.all(ordersToCancel.map(async (order) => {
        if (order.id && order.ex) {
            try {
                const params = (order.ex.id === 'kucoinfutures' || order.ex.id === 'bitget') ? { 'stop': true } : {};
                await order.ex.cancelOrder(order.id, order.symbol, params);
                safeLog('log', `[CLEANUP] ✅ Hủy lệnh ${order.id} thành công.`);
            } catch (e) {
                if (e.message.includes('order not found')) {
                     safeLog('warn', `[CLEANUP] ⚠️ Lệnh ${order.id} không tìm thấy (có thể đã khớp).`);
                } else {
                    safeLog('warn', `[CLEANUP] ⚠️ Không thể hủy lệnh ${order.id}: ${e.message}`);
                }
            }
        }
    }));
}

async function closeTradeNow() {
    if (!currentTradeDetails) {
        safeLog('warn', '[API] Không có giao dịch nào đang mở để đóng.');
        return false;
    }
    const tradeToClose = { ...currentTradeDetails };
    safeLog('log', `[API] Nhận yêu cầu đóng lệnh cho ${tradeToClose.coin}...`);
    
    // Nếu giao dịch đang ở trạng thái cần kiểm tra thủ công, không hủy lệnh TP/SL vì chúng không tồn tại
    if (tradeToClose.status === 'OPEN') {
        await cancelPendingOrders(tradeToClose);
        await sleep(1000); 
    }

    try {
        const shortEx = exchanges[tradeToClose.shortExchange];
        const longEx = exchanges[tradeToClose.longExchange];
        const shortParams = { 'reduceOnly': true, ...(shortEx.id === 'kucoinfutures' && {'marginMode': 'cross'}) };
        const longParams = { 'reduceOnly': true, ...(longEx.id === 'kucoinfutures' && {'marginMode': 'cross'}) };

        await Promise.all([
            shortEx.createMarketBuyOrder(tradeToClose.shortOriginalSymbol, tradeToClose.shortOrderAmount, shortParams),
            longEx.createMarketSellOrder(tradeToClose.longOriginalSymbol, tradeToClose.longOrderAmount, longParams)
        ]);
        
        tradeAwaitingPnl = { ...currentTradeDetails, status: 'PENDING_PNL_CALC', closeTime: Date.now() };
        safeLog('log', `[PNL] ✅ Đã gửi lệnh đóng cho ${tradeToClose.coin}. Chờ tính PNL...`);
        currentTradeDetails = null;
        return true;
    } catch (e) {
        safeLog('error', `[PNL] ❌ Lỗi khi đóng vị thế cho ${tradeToClose.coin}:`, e);
        return false;
    }
}

async function calculatePnlAfterDelay(closedTrade) {
    safeLog('log', `[PNL] Chờ 5 giây để số dư cập nhật...`);
    await sleep(5000);
    safeLog('log', `[PNL] Đang tính PNL cho giao dịch ${closedTrade.coin}...`);
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
                        safeLog('log', `[LOOP] Phát hiện cơ hội đủ điều kiện: ${opportunity.coin} với PNL ${opportunity.estimatedPnl.toFixed(3)}%`);
                        if (await executeTrades(opportunity, currentPercentageToUse)) break;
                    }
                }
            }
        }
    } catch (e) {
        safeLog('error', '[LOOP] Gặp lỗi nghiêm trọng trong vòng lặp chính:', e);
    }
    if (botState === 'RUNNING') {
        botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
    }
}

function startBot() {
    if (botState === 'RUNNING') return false;
    botState = 'RUNNING';
    safeLog('log', '[BOT] Khởi động Bot...');
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
    safeLog('log', '[BOT] Dừng Bot...');
    return true;
}

// --- KHỞI TẠO MÁY CHỦ GIAO DIỆN ---
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ botState, balances, tradeHistory, bestPotentialOpportunityForDisplay, currentTradeDetails, activeExchangeIds, exchangeHealth }));
        } else if (url === '/bot-api/start' && method === 'POST') {
            try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch { currentPercentageToUse = 50; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: startBot(), message: 'Đã gửi yêu cầu khởi động bot.' }));
        } else if (url === '/bot-api/stop' && method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: stopBot(), message: 'Đã gửi yêu cầu dừng bot.' }));
        } else if (url === '/bot-api/custom-test-trade' && method === 'POST') {
            if (currentTradeDetails) return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở.' }));
            if (!bestPotentialOpportunityForDisplay) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Chưa có cơ hội nào.' }));
            const data = JSON.parse(body);
            const testOpportunity = {
                coin: bestPotentialOpportunityForDisplay?.coin,
                commonLeverage: parseInt(data.leverage, 10) || 20,
                details: { shortExchange: data.shortExchange, longExchange: data.longExchange }
            };
            const tradeSuccess = await executeTrades(testOpportunity, parseFloat(data.percentage));
            res.writeHead(tradeSuccess ? 200 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: tradeSuccess, message: tradeSuccess ? 'Lệnh Test đã được gửi.' : 'Lỗi khi gửi lệnh Test.' }));
        } else if (url === '/bot-api/close-trade-now' && method === 'POST') {
            const success = await closeTradeNow();
            res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success, message: success ? 'Đã gửi yêu cầu đóng lệnh.' : 'Không có lệnh đang mở hoặc có lỗi.' }));
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
