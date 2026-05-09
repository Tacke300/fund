import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();

const positionLocks = new Map();
const dcaCleanupLocks = new Map();
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const BLACKLIST_DURATION = 15 * 60 * 1000;

// ============ LOGGING ============
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

async function retryWithBackoff(fn, functionName = 'API Call', maxRetries = MAX_RETRIES) {
    for (let i = 0; i < maxRetries; i++) {
        try { return await fn(); } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(r => setTimeout(r, Math.pow(2, i) * RETRY_BASE_DELAY));
        }
    }
}

async function acquirePositionLock(symbol) {
    const posKey = `${symbol}_SHORT`;
    while (positionLocks.has(posKey)) { await new Promise(r => setTimeout(r, 200)); }
    positionLocks.set(posKey, true);
}
function releasePositionLock(symbol) { positionLocks.delete(`${symbol}_SHORT`); }

async function acquireDCACleanupLock(symbol) {
    const dcaKey = `DCA_CLEANUP_${symbol}_SHORT`;
    while (dcaCleanupLocks.has(dcaKey)) { await new Promise(r => setTimeout(r, 100)); }
    dcaCleanupLocks.set(dcaKey, true);
}
function releaseDCACleanupLock(symbol) { dcaCleanupLocks.delete(`DCA_CLEANUP_${symbol}_SHORT`); }

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    return retryWithBackoff(async () => {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    }, `binancePrivate(${endpoint})`);
}

async function forceClearAllOrders(symbol) {
    try {
        const openOrders = await exchange.fetchOpenOrders(symbol);
        for (const order of openOrders) {
            await exchange.cancelOrder(order['id'], symbol, { positionSide: order['info']?.positionSide || 'SHORT' });
        }
        return true;
    } catch (e) { return false; }
}

// ============ VERIFY TPSL + LOG ID ============
async function verifyTPSLOrders(symbol, side) {
    try {
        await new Promise(r => setTimeout(r, 2000)); 
        const openOrders = await exchange.fetchOpenOrders(symbol);
        const tpslOrders = openOrders.filter(o => {
            const type = (o.info?.type || o.type || '').toUpperCase();
            const posSide = o.info?.positionSide;
            return ['TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(type) && posSide === side;
        });

        tpslOrders.forEach(o => {
            addBotLog(`📌 [${symbol}] Lệnh chờ xác nhận: ${o.info.type} | ID: ${o.id} | Price: ${o.info.stopPrice}`);
        });

        const hasTP = tpslOrders.some(o => (o.info?.type || o.type || '').toUpperCase() === 'TAKE_PROFIT_MARKET');
        const hasSL = tpslOrders.some(o => (o.info?.type || o.type || '').toUpperCase() === 'STOP_MARKET');
        return hasTP && hasSL;
    } catch (e) { return false; }
}

// ============ SYNC TP/SL + LOG ID ============
async function syncTPSL(symbol, side, entry, info, isDCA = false) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    if (isDCA) await acquireDCACleanupLock(symbol);
    try {
        await forceClearAllOrders(symbol);
        await new Promise(r => setTimeout(r, 1000));

        const orderTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        addBotLog(`🎯 [${symbol}] Đặt lệnh TP thành công: ID ${orderTP.id} @ ${tpPrice}`);

        const orderSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        addBotLog(`🛑 [${symbol}] Đặt lệnh SL thành công: ID ${orderSL.id} @ ${slPrice}`);

        await verifyTPSLOrders(symbol, side);
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi đặt TPSL: ${e.message}`, "error");
        return { success: false };
    } finally {
        if (isDCA) releaseDCACleanupLock(symbol);
    }
}

// ============ OPEN / DCA ============
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    try {
        await acquirePositionLock(symbol);
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const hasPos = posRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!isDCA && hasPos) {
            addBotLog(`⚠️ [${symbol}] Đã có vị thế, bỏ qua mở mới.`);
            return;
        }

        let cp = isDCA ? botActivePositions.get(posKey) : null;
        if (isDCA && (!cp || cp.isProcessing)) return;
        if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;

        if (isDCA) cp.isProcessing = true; else openingSymbols.add(symbol);

        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = 0;
        if (isDCA) {
            marginToUse = cp.firstMargin;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        addBotLog(`🚀 [${symbol}] Đang ${isDCA ? 'DCA' : 'Mở'} | Price: ${currentPrice} | Qty: ${qtyNum}`);
        
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await retryWithBackoff(() => exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' }));

        if (order) {
            addBotLog(`✅ [${symbol}] Lệnh Market khớp | ID: ${order.id}`);
            await new Promise(r => setTimeout(r, 3000)); 
            const pUpdate = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pUpdate.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const finalEntry = parseFloat(realP.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, isDCA);
                if (sync.success) {
                    botActivePositions.set(posKey, { 
                        symbol, side: 'SHORT', entryPrice: finalEntry, originalEntry: isDCA ? cp.originalEntry : finalEntry, 
                        qty: Math.abs(parseFloat(realP.positionAmt)), tp: sync.tp, sl: sync.sl, 
                        firstMargin: isDCA ? cp.firstMargin : marginToUse, dcaCount: isDCA ? cp.dcaCount + 1 : 0, 
                        leverage: info.maxLeverage, isProcessing: false, pnl: 0, priceDev: 0
                    });
                }
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi Open/DCA: ${e.message}`, "error");
        if(isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    } finally { 
        openingSymbols.delete(symbol);
        releasePositionLock(symbol);
    }
}

// ============ MONITOR + BLACKLIST SAU KHI ĐÓNG ============
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const closedPositions = [];

        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // Nếu vị thế không còn trên sàn => Đã đóng
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                closedPositions.push({ key, symbol: botPos.symbol, pos: botPos });
                continue;
            }

            const markPrice = parseFloat(realPos.markPrice);
            botPos.markPrice = markPrice;
            botPos.pnl = parseFloat(realPos.unRealizedProfit);
            botPos.priceDev = ((markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;

            // Fail-safe Market Close
            const hitTP = markPrice <= botPos.tp;
            const hitSL = markPrice >= botPos.sl;
            if (hitTP || hitSL) {
                addBotLog(`🚨 [${botPos.symbol}] Fail-safe: Giá chạm ngưỡng (${markPrice}). Đóng Market ngay!`, "warning");
                try {
                    await forceClearAllOrders(botPos.symbol);
                    const info = status.exchangeInfo[botPos.symbol];
                    await exchange.createOrder(botPos.symbol, 'MARKET', 'BUY', botPos.qty.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
                } catch (err) { addBotLog(`❌ [${botPos.symbol}] Lỗi đóng Fail-safe: ${err.message}`, "error"); }
            }
        }

        for (const closed of closedPositions) {
            addBotLog(`📉 [${closed.symbol}] Vị thế đã đóng. Bắt đầu Blacklist 15p.`);
            // ĐÓNG XONG MỚI BLACKLIST
            status.blackList[closed.symbol] = Date.now() + BLACKLIST_DURATION;
            botActivePositions.delete(closed.key);
            await trackClosedPnL(closed.symbol, closed.pos);
        }
    } catch (e) { }
    setTimeout(priceMonitorLoop, 1000);
}

async function trackClosedPnL(symbol, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
        const finalPnL = trades.filter(t => (Date.now() - t.time) < 60000).reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        status.botClosedCount++; 
        status.botPnLClosed += finalPnL;
        addBotLog(`💰 [${symbol}] Chốt PnL: ${finalPnL.toFixed(2)}$ | Tổng PnL: ${status.botPnLClosed.toFixed(2)}$`);
    } catch (e) { }
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const now = Date.now();
        Object.keys(status.blackList).forEach(s => { if(status.blackList[s] < now) delete status.blackList[s]; });

        for (let [key, botPos] of botActivePositions) {
            if (!botPos.isProcessing && botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) {
                await openPosition(botPos.symbol, true);
            }
        }

        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol || Math.abs(parseFloat(c.c5)) >= botSettings.minVol;
                return info && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && volOK;
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) { }
}

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY V20.9 - MONITOR & LOG ID READY", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); 
setInterval(mainLoop, 5000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, 
            wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2) } 
        });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
