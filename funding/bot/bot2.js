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

// --- CONFIG & GLOBAL STATE (Không đổi) ---
const { binanceApiKey, binanceApiSecret, okxApiKey, okxApiSecret, okxPassword, bitgetApiKey, bitgetApiSecret, bitgetApiPassword, kucoinApiKey, kucoinApiSecret, kucoinApiPassword } = require('../config.js');
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
activeExchangeIds.forEach(id => { balances[id] = { available: 0, total: 0 }; exchangeHealth[id] = { consecutiveFails: 0, isDisabled: false }; });
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
const exchanges = {};
activeExchangeIds.forEach(id => { try { let exchangeClass; let config = { 'enableRateLimit': true, 'verbose': false }; if (id === 'binanceusdm') { exchangeClass = ccxt.binanceusdm; config.apiKey = binanceApiKey; config.secret = binanceApiSecret; config.options = { 'defaultType': 'swap' }; } else if (id === 'okx') { exchangeClass = ccxt.okx; config.apiKey = okxApiKey; config.secret = okxApiSecret; config.password = okxPassword; config.options = { 'defaultType': 'swap' }; } else if (id === 'bitget') { exchangeClass = ccxt.bitget; config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; config.password = bitgetApiPassword; config.options = { 'defaultType': 'swap' }; } else if (id === 'kucoinfutures') { exchangeClass = ccxt.kucoinfutures; config.apiKey = kucoinApiKey; config.secret = kucoinApiSecret; config.password = kucoinApiPassword; } if (config.apiKey && config.secret && (id !== 'kucoinfutures' || config.password)) { exchanges[id] = new exchangeClass(config); safeLog('log', `[INIT] Khởi tạo sàn ${id.toUpperCase()} thành công.`); } else { safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret/Password.`); } } catch (e) { safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`); } });

// --- CORE BOT LOGIC ---
async function fetchDataFromServer() { try { const response = await fetch(SERVER_DATA_URL); if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`); return await response.json(); } catch (error) { safeLog('error', `[BOT] Lỗi khi lấy dữ liệu từ server: ${error.message}`); return null; } }
async function updateBalances() { /* ... (hàm này không cần thay đổi) ... */ }
async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) { /* ... (hàm này không cần thay đổi) ... */ }
async function setLeverageSafely(exchange, symbol, desiredLeverage) { /* ... (hàm này không cần thay đổi) ... */ }
const normalizeExchangeId = (id) => { /* ... (hàm này không cần thay đổi) ... */ };
async function processServerData(serverData) { /* ... (hàm này không cần thay đổi) ... */ }

// =================================================================================
// ================== HÀM placeTpSlOrders ĐÃ ĐƯỢC VIẾT LẠI ========================
// =================================================================================
async function placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral) {
    if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
        safeLog('error', `[TP/SL] ❌ Giá vào lệnh không hợp lệ (${entryPrice}), bỏ qua đặt TP/SL cho ${symbol}`);
        return { tpOrderId: null, slOrderId: null };
    }

    const pnlAmount = collateral * TP_SL_PNL_PERCENTAGE;
    const pnlPerUnit = pnlAmount / amount;
    
    let tpPrice, slPrice;
    if (side === 'sell') { // Vị thế Short
        tpPrice = entryPrice - pnlPerUnit;
        slPrice = entryPrice + pnlPerUnit;
    } else { // Vị thế Long
        tpPrice = entryPrice + pnlPerUnit;
        slPrice = entryPrice - pnlPerUnit;
    }
    
    if (isNaN(tpPrice) || isNaN(slPrice) || tpPrice <= 0 || slPrice <= 0) {
        safeLog('error', `[TP/SL] ❌ Giá TP/SL tính ra không hợp lệ (TP: ${tpPrice}, SL: ${slPrice}) cho ${symbol}`);
        return { tpOrderId: null, slOrderId: null };
    }

    const orderSide = (side === 'sell') ? 'buy' : 'sell';
    safeLog('log', `[TP/SL] Đang đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}...`);

    try {
        const params = { 'reduceOnly': true };
        const tpResult = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
        safeLog('log', `[TP/SL] ✅ Đặt lệnh TP cho ${symbol} thành công. ID: ${tpResult.id}`);
        const slResult = await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
        safeLog('log', `[TP/SL] ✅ Đặt lệnh SL cho ${symbol} thành công. ID: ${slResult.id}`);
        return { tpOrderId: tpResult.id, slOrderId: slResult.id };
    } catch (e) {
        safeLog('error', `[TP/SL] ❌ Lỗi khi đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}:`, e);
        return { tpOrderId: null, slOrderId: null };
    }
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
    
    return { amount, price, notional: amount * price * contractSize, requiredMargin: (amount * price * contractSize) / leverage };
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

    // Lấy giá khớp lệnh trung bình, nếu không có thì fallback
    const shortEntryPrice = shortOrder.average || (await shortEx.fetchTicker(shortOriginalSymbol)).last;
    const longEntryPrice = longOrder.average || (await longEx.fetchTicker(longOriginalSymbol)).last;
    
    const shortTpSlIds = await placeTpSlOrders(shortEx, shortOriginalSymbol, 'sell', shortOrder.amount, shortEntryPrice, collateral);
    const longTpSlIds = await placeTpSlOrders(longEx, longOriginalSymbol, 'buy', longOrder.amount, longEntryPrice, collateral);

    currentTradeDetails = {
        ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(),
        shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount,
        commonLeverageUsed: leverageToUse, shortOriginalSymbol, longOriginalSymbol,
        shortBalanceBefore: shortBalance, longBalanceBefore: longBalance,
        shortTpOrderId: shortTpSlIds.tpOrderId, shortSlOrderId: shortTpSlIds.slOrderId,
        longTpOrderId: longTpSlIds.tpOrderId, longSlOrderId: longTpSlIds.slOrderId,
    };
    return true;
}

async function cancelPendingOrders(tradeDetails) { /* ... (không đổi) ... */ }
async function closeTradeNow() { /* ... (không đổi) ... */ }
async function calculatePnlAfterDelay(closedTrade) { /* ... (không đổi) ... */ }
async function mainBotLoop() { /* ... (không đổi) ... */ }
function startBot() { /* ... (không đổi) ... */ }
function stopBot() { /* ... (không đổi) ... */ }
const botServer = http.createServer(async (req, res) => { /* ... (không đổi) ... */ });
botServer.listen(BOT_PORT, () => { safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`); });
