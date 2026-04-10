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
        process.stderr.write(`FATAL LOG ERROR: ${e.message}\n`);
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
const MIN_MINUTES_FOR_EXECUTION = 15;

const DATA_FETCH_INTERVAL_SECONDS = 5;
const MAX_SERVER_DATA_RETRIES = 10;
const SERVER_DATA_RETRY_DELAY_MS = 5 * 60 * 1000;

const SL_PERCENT_OF_COLLATERAL = 200; 
const TP_PERCENT_OF_COLLATERAL = 200; 

const DISABLED_EXCHANGES = ['bitget', 'okx']; 
const ALLOWED_OPPORTUNITY_EXCHANGES = ['binanceusdm', 'bingx'];
const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

let botState = 'STOPPED';
let botLoopIntervalId = null;
let serverDataRetryCount = 0;

const exchanges = {};
activeExchangeIds.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = {
        'options': { 'defaultType': 'swap' },
        'enableRateLimit': true,
        'headers': { 'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)' }
    };

    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }

    if ((config.apiKey && config.secret) || (id === 'okx' && config.password)) {
        exchanges[id] = new exchangeClass(config);
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
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];
let currentTradeDetails = null;
let currentPercentageToUse = 50;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- GIỮ NGUYÊN LOGIC XỬ LÝ SYMBOL ---
function generateExchangeSpecificSymbols(exchangeId, rawCoinSymbol) {
    if (typeof rawCoinSymbol !== 'string' || !rawCoinSymbol.toUpperCase().endsWith('USDT')) return [rawCoinSymbol];
    const base = rawCoinSymbol.substring(0, rawCoinSymbol.length - 4).toUpperCase();
    const quote = 'USDT';
    const potentialSymbols = new Set();
    potentialSymbols.add(rawCoinSymbol);
    potentialSymbols.add(`${base}/${quote}`);
    if (exchangeId === 'binanceusdm') potentialSymbols.add(`${base}/${quote}:${quote}`);
    else if (exchangeId === 'bingx') {
        if (['SHIB', 'PEPE', 'BONK'].includes(base)) potentialSymbols.add(`1000${base}/${quote}`);
        potentialSymbols.add(`${base}-${quote}`);
    }
    return Array.from(potentialSymbols);
}

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try { await exchange.loadMarkets(); } catch (e) { return null; }
    const symbolsToAttempt = generateExchangeSpecificSymbols(exchange.id, rawCoinSymbol);
    for (const s of symbolsToAttempt) {
        try { if (exchange.market(s)) return exchange.market(s).id; } catch (e) {}
    }
    return null;
}

// --- GIỮ NGUYÊN FETCH DATA & BALANCES ---
async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        serverDataRetryCount = 0;
        return await response.json();
    } catch (error) {
        serverDataRetryCount++;
        if (serverDataRetryCount > MAX_SERVER_DATA_RETRIES) stopBot();
        return null;
    }
}

async function updateBalances() {
    let currentTotalOverall = 0;
    for (const id of activeExchangeIds) {
        if (!exchanges[id]) continue;
        try {
            await exchanges[id].loadMarkets(true);
            const accountBalance = await exchanges[id].fetchBalance({ 'type': 'future' });
            balances[id].available = accountBalance.free?.USDT || 0;
            balances[id].total = accountBalance.total?.USDT || 0;
            currentTotalOverall += balances[id].available;
        } catch (e) { safeLog('error', `Balance ${id} Error: ${e.message}`); }
    }
    balances.totalOverall = currentTotalOverall;
    if (initialTotalBalance === 0) initialTotalBalance = currentTotalOverall;
}

// --- GIỮ NGUYÊN LOGIC LỌC BIẾN ĐỘNG ---
async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) return;
    const now = Date.now();
    let bestForDisplay = null;
    const tempAllOpportunities = [];

    for (const op of serverData.arbitrageData) {
        if (!op || !op.details) continue;
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);
        const shortExIdNormalized = op.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.shortExchange.toLowerCase();
        const longExIdNormalized = op.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.longExchange.toLowerCase();

        if (!ALLOWED_OPPORTUNITY_EXCHANGES.includes(shortExIdNormalized) || !ALLOWED_OPPORTUNITY_EXCHANGES.includes(longExIdNormalized)) continue;
        if (!exchanges[shortExIdNormalized] || !exchanges[longExIdNormalized]) continue;

        const shortOriginalSymbol = await getExchangeSpecificSymbol(exchanges[shortExIdNormalized], op.coin);
        const longOriginalSymbol = await getExchangeSpecificSymbol(exchanges[longExIdNormalized], op.coin);

        if (shortOriginalSymbol && longOriginalSymbol) {
            op.details.shortExchange = shortExIdNormalized;
            op.details.longExchange = longExIdNormalized;
            op.details.shortOriginalSymbol = shortOriginalSymbol;
            op.details.longOriginalSymbol = longOriginalSymbol;
            op.details.minutesUntilFunding = minutesUntilFunding;
            tempAllOpportunities.push(op);
            if (!bestForDisplay || op.estimatedPnl > bestForDisplay.estimatedPnl) bestForDisplay = op;
        }
    }
    allCurrentOpportunities = tempAllOpportunities;
    bestPotentialOpportunityForDisplay = bestForDisplay;
}

// ============================================================================
// 🛡️ PHẦN TP/SL & ĐÓNG LỆNH SMART (ÁP DỤNG CƠ CHẾ VERIFY)
// ============================================================================

async function setSmartGiáp(exchange, symbol, positionSide, amount, tpPrice, slPrice) {
    const side = positionSide.toUpperCase() === 'LONG' ? 'sell' : 'buy';
    try {
        await exchange.cancelAllOrders(symbol, { positionSide }).catch(() => {});
        await Promise.all([
            exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', side, amount, undefined, {
                'stopPrice': exchange.priceToPrecision(symbol, tpPrice),
                'positionSide': positionSide, 'reduceOnly': true, 'workingType': 'MARK_PRICE'
            }),
            exchange.createOrder(symbol, 'STOP_MARKET', side, amount, undefined, {
                'stopPrice': exchange.priceToPrecision(symbol, slPrice),
                'positionSide': positionSide, 'reduceOnly': true, 'workingType': 'MARK_PRICE'
            })
        ]);
        safeLog('success', `✅ [${exchange.id}] Giáp đã cắm: TP @${tpPrice} | SL @${slPrice}`);
    } catch (e) { safeLog('error', `❌ [${exchange.id}] Lỗi giáp: ${e.message}`); }
}

async function smartCloseCCXT(exchange, symbol, positionSide, reason) {
    safeLog('warn', `🚨 [${exchange.id}] Đóng vị thế ${symbol} (${reason})`);
    let isCleared = false;
    for (let i = 1; i <= 5; i++) {
        try {
            const positions = await exchange.fetchPositions([symbol]);
            const pos = positions.find(p => p.symbol === symbol && p.side.toUpperCase() === positionSide.toUpperCase());
            if (!pos || Math.abs(parseFloat(pos.contracts || pos.info.positionAmt || 0)) === 0) {
                isCleared = true; break;
            }
            const amount = Math.abs(parseFloat(pos.contracts || pos.info.positionAmt));
            const side = positionSide.toUpperCase() === 'LONG' ? 'sell' : 'buy';
            await exchange.createOrder(symbol, 'MARKET', side, amount, undefined, { 'positionSide': positionSide, 'reduceOnly': true });
            await sleep(2000);
        } catch (e) { await exchange.cancelAllOrders(symbol, { positionSide }).catch(() => {}); }
    }
    if (isCleared) {
        await exchange.cancelAllOrders(symbol, { positionSide }).catch(() => {});
        safeLog('success', `✅ [${exchange.id}] Verified: Vị thế sạch.`);
    }
    return isCleared;
}

// ============================================================================
// 🚀 THỰC THI GIAO DỊCH (EXECUTE)
// ============================================================================

async function executeTrades(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) return false;
    
    const { shortExchange: sId, longExchange: lId, shortOriginalSymbol: sSym, longOriginalSymbol: lSym } = opportunity.details;
    const shortExchange = exchanges[sId];
    const longExchange = exchanges[lId];

    const minAvail = Math.min(balances[sId]?.available || 0, balances[lId]?.available || 0);
    const collateral = minAvail * (percentageToUse / 100);

    try {
        await Promise.all([shortExchange.loadMarkets(true), longExchange.loadMarkets(true)]);
        const [tickerS, tickerL] = await Promise.all([shortExchange.fetchTicker(sSym), longExchange.fetchTicker(lSym)]);
        
        // Mở vị thế (Giữ nguyên logic leverage của ông)
        const lev = opportunity.commonLeverage || 10;
        await Promise.all([
            shortExchange.setLeverage(lev, sSym).catch(() => {}),
            longExchange.setLeverage(lev, lSym).catch(() => {})
        ]);

        const sAmount = (collateral * lev) / tickerS.last;
        const lAmount = (collateral * lev) / tickerL.last;

        const sOrder = await shortExchange.createMarketSellOrder(sSym, parseFloat(shortExchange.amountToPrecision(sSym, sAmount)), { 'positionSide': 'SHORT' });
        const lOrder = await longExchange.createMarketBuyOrder(lSym, parseFloat(longExchange.amountToPrecision(lSym, lAmount)), { 'positionSide': 'LONG' });

        // Tính TP/SL
        const sTp = tickerS.last * (1 - (TP_PERCENT_OF_COLLATERAL / (lev * 100)));
        const sSl = tickerS.last * (1 + (SL_PERCENT_OF_COLLATERAL / (lev * 100)));
        const lTp = tickerL.last * (1 + (TP_PERCENT_OF_COLLATERAL / (lev * 100)));
        const lSl = tickerL.last * (1 - (SL_PERCENT_OF_COLLATERAL / (lev * 100)));

        currentTradeDetails = {
            coin: opportunity.coin, shortExchange: sId, longExchange: lId,
            shortOriginalSymbol: sSym, longOriginalSymbol: lSym,
            shortTpPrice: sTp, shortSlPrice: sSl, longTpPrice: lTp, longSlPrice: lSl,
            status: 'OPEN', openTime: Date.now()
        };

        // Cắm giáp 5 lớp
        await Promise.all([
            setSmartGiáp(shortExchange, sSym, 'SHORT', sOrder.amount, sTp, sSl),
            setSmartGiáp(longExchange, lSym, 'LONG', lOrder.amount, lTp, lSl)
        ]);
        return true;
    } catch (e) {
        safeLog('error', `FATAL TRADE: ${e.message}`);
        await Promise.all([
            smartCloseCCXT(shortExchange, sSym, 'SHORT', 'FAIL_INIT'),
            smartCloseCCXT(longExchange, lSym, 'LONG', 'FAIL_INIT')
        ]);
        currentTradeDetails = null;
        return false;
    }
}

// --- VÒNG LẶP MONITOR ---
async function monitorFailsafe() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') return;
    const { shortExchange: sId, longExchange: lId, shortOriginalSymbol: sSym, longOriginalSymbol: lSym, 
            shortTpPrice, shortSlPrice, longTpPrice, longSlPrice } = currentTradeDetails;
    try {
        const [tS, tL] = await Promise.all([exchanges[sId].fetchTicker(sSym), exchanges[lId].fetchTicker(lSym)]);
        if (tS.last <= shortTpPrice || tS.last >= shortSlPrice || tL.last >= longTpPrice || tL.last <= longSlPrice) {
            currentTradeDetails.status = 'CLOSING';
            await Promise.all([
                smartCloseCCXT(exchanges[sId], sSym, 'SHORT', 'MONITOR_EXIT'),
                smartCloseCCXT(exchanges[lId], lSym, 'LONG', 'MONITOR_EXIT')
            ]);
            currentTradeDetails = null;
        }
    } catch (e) {}
}

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    if (currentTradeDetails) await monitorFailsafe();
    
    const serverData = await fetchDataFromServer();
    if (serverData) {
        await processServerData(serverData);
        if (!currentTradeDetails && allCurrentOpportunities.length > 0) {
            const op = allCurrentOpportunities[0];
            if (op.estimatedPnl >= MIN_PNL_PERCENTAGE && op.details.minutesUntilFunding <= MAX_MINUTES_UNTIL_FUNDING) {
                await executeTrades(op, currentPercentageToUse);
            }
        }
    }
}

function startBot() { botState = 'RUNNING'; updateBalances(); botLoopIntervalId = setInterval(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000); }
function stopBot() { botState = 'STOPPED'; clearInterval(botLoopIntervalId); }

// Khởi chạy
startBot();
