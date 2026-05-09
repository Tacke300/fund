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

// ============ LOCK SYSTEM ============
const positionLocks = new Map();
const dcaCleanupLocks = new Map();
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const BLACKLIST_DURATION = 15 * 60 * 1000;

// ============ UTILITY: RETRY ============
async function retryWithBackoff(fn, functionName = 'API Call', maxRetries = MAX_RETRIES) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) {
                addBotLog(`❌ ${functionName} failed: ${error.message}`, "error");
                throw error;
            }
            const delay = Math.pow(2, i) * RETRY_BASE_DELAY;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ============ POSITION LOCKS ============
async function acquirePositionLock(symbol) {
    const posKey = `${symbol}_SHORT`;
    const startTime = Date.now();
    while (positionLocks.has(posKey)) {
        if (Date.now() - startTime > 120000) { positionLocks.delete(posKey); break; }
        await new Promise(r => setTimeout(r, 200));
    }
    positionLocks.set(posKey, true);
}
function releasePositionLock(symbol) { positionLocks.delete(`${symbol}_SHORT`); }

async function acquireDCACleanupLock(symbol) {
    const dcaKey = `DCA_CLEANUP_${symbol}_SHORT`;
    while (dcaCleanupLocks.has(dcaKey)) { await new Promise(r => setTimeout(r, 100)); }
    dcaCleanupLocks.set(dcaKey, true);
}
function releaseDCACleanupLock(symbol) { dcaCleanupLocks.delete(`DCA_CLEANUP_${symbol}_SHORT`); }

// ============ LOGGING ============
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// ============ BINANCE PRIVATE API ============
async function binancePrivate(endpoint, method = 'GET', data = {}) {
    return retryWithBackoff(async () => {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    }, `binancePrivate(${endpoint})`);
}

// ============ ORDER MANAGEMENT ============
async function waitUntilAllOrdersCleared(symbol, maxWaitTime = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitTime) {
        const openOrders = await exchange.fetchOpenOrders(symbol);
        if (openOrders.length === 0) return true;
        await new Promise(r => setTimeout(r, 800));
    }
    return false;
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

// ============ 2. VERIFY TPSL ORDERS EXIST (FIXED TYPE) ============
async function verifyTPSLOrders(symbol, side, maxAttempts = 3) {
    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            await new Promise(r => setTimeout(r, 2000)); 
            const openOrders = await exchange.fetchOpenOrders(symbol);
            
            const tpslOrders = openOrders.filter(o => {
                const rawType = o.info?.type || o.type || '';
                const type = rawType.toUpperCase();
                const posSide = o.info?.positionSide;
                return ['TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(type) && posSide === side;
            });
            
            const hasTP = tpslOrders.some(o => (o.info?.type || o.type || '').toUpperCase() === 'TAKE_PROFIT_MARKET');
            const hasSL = tpslOrders.some(o => (o.info?.type || o.type || '').toUpperCase() === 'STOP_MARKET');

            if (hasTP && hasSL) return true;
            attempts++;
        } catch (e) { attempts++; }
    }
    return false;
}

// ============ 3. SYNC TP/SL ============
async function syncTPSL(symbol, side, entry, info, isDCA = false) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    if (isDCA) await acquireDCACleanupLock(symbol);

    try {
        await forceClearAllOrders(symbol);
        await waitUntilAllOrdersCleared(symbol, 10000);

        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        await new Promise(r => setTimeout(r, 500));
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE'
        });

        await verifyTPSLOrders(symbol, side, 3);
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi cài TPSL: ${e.message}`, "error");
        return { success: false };
    } finally {
        if (isDCA) releaseDCACleanupLock(symbol);
    }
}

// ============ 4. OPEN & DCA ============
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    try {
        await acquirePositionLock(symbol);
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const hasPos = posRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!isDCA && hasPos) {
            status.blackList[symbol] = Date.now() + BLACKLIST_DURATION;
            return;
        }

        let cp = null;
        if (isDCA) {
            cp = botActivePositions.get(posKey);
            if (!cp || cp.isProcessing) return;
            cp.isProcessing = true;
        } else {
            if (botActivePositions.has(posKey) || openingSymbols.has(symbol)) return;
            openingSymbols.add(symbol);
        }

        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = 0, currentDCA = 0, firstMargin = 0, originalEntry = 0;
        
        if (isDCA) {
            firstMargin = cp.firstMargin;
            originalEntry = cp.originalEntry || cp.entryPrice;
            currentDCA = cp.dcaCount + 1;
            marginToUse = firstMargin;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
            originalEntry = currentPrice;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await retryWithBackoff(() => exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' }));

        if (order) {
            await new Promise(r => setTimeout(r, 3000)); 
            const posDataUpdate = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realPos = posDataUpdate.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realPos) {
                const finalEntry = parseFloat(realPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, isDCA);
                if (sync.success) {
                    botActivePositions.set(posKey, { 
                        symbol, side: 'SHORT', entryPrice: finalEntry, originalEntry, qty: Math.abs(parseFloat(realPos.positionAmt)), 
                        tp: sync.tp, sl: sync.sl, firstMargin, dcaCount: currentDCA, 
                        leverage: info.maxLeverage, isProcessing: false, pnl: 0, priceDev: 0
                    });
                    status.blackList[symbol] = Date.now() + BLACKLIST_DURATION;
                    addBotLog(`✅ [${symbol}] ${isDCA ? 'DCA thành công' : 'Mở vị thế thành công'}`);
                }
            }
        }
    } catch (e) {
        if(isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    } finally { 
        openingSymbols.delete(symbol);
        releasePositionLock(symbol);
    }
}

// ============ PRICE MONITOR & FAIL-SAFE MARKET CLOSE ============
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const closedPositions = [];

        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // 1. Kiểm tra nếu vị thế đã đóng (do khớp TP/SL sàn)
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                closedPositions.push({ key, symbol: botPos.symbol, pos: botPos });
                continue;
            }

            const markPrice = parseFloat(realPos.markPrice);
            botPos.markPrice = markPrice;
            botPos.pnl = parseFloat(realPos.unRealizedProfit);
            botPos.priceDev = ((markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;

            // 2. FAIL-SAFE: Tự đóng Market nếu giá vượt TP/SL mà lệnh chờ không chạy
            const isShort = botPos.side === 'SHORT';
            const hitTP = isShort ? (markPrice <= botPos.tp) : (markPrice >= botPos.tp);
            const hitSL = isShort ? (markPrice >= botPos.sl) : (markPrice <= botPos.sl);

            if (hitTP || hitSL) {
                addBotLog(`🚨 [${botPos.symbol}] FAIL-SAFE: Giá vượt ngưỡng (${markPrice}). Đóng Market khẩn cấp!`, "warning");
                const sideClose = isShort ? 'BUY' : 'SELL';
                const info = status.exchangeInfo[botPos.symbol];
                
                try {
                    await forceClearAllOrders(botPos.symbol);
                    await exchange.createOrder(botPos.symbol, 'MARKET', sideClose, botPos.qty.toFixed(info.quantityPrecision), undefined, { positionSide: botPos.side });
                    addBotLog(`🔥 [${botPos.symbol}] FAIL-SAFE: Đã đóng vị thế Market.`);
                    // Price monitor vòng sau sẽ tự xóa khỏi botActivePositions và cho vào blacklist
                } catch (err) {
                    addBotLog(`❌ [${botPos.symbol}] FAIL-SAFE Lỗi: ${err.message}`, "error");
                }
            }
        }

        for (const closed of closedPositions) {
            await trackClosedPnL(closed.symbol, closed.pos);
            botActivePositions.delete(closed.key);
            // Luôn cho vào blacklist sau khi đóng vị thế
            status.blackList[closed.symbol] = Date.now() + BLACKLIST_DURATION;
        }
    } catch (e) { }
    setTimeout(priceMonitorLoop, 1000);
}

// ============ TRACK PNL ============
async function trackClosedPnL(symbol, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
        const finalPnL = trades.filter(t => (Date.now() - t.time) < 60000).reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        status.botClosedCount++; 
        status.botPnLClosed += finalPnL;
        addBotLog(`💰 [${symbol}] Chốt: ${finalPnL.toFixed(2)}$ | Tổng PnL: ${status.botPnLClosed.toFixed(2)}$`);
    } catch (e) { }
}

// ============ MAIN LOOP ============
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

// ============ INIT ============
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
        addBotLog("👿 LUFFY V20.8 - FAIL-SAFE MONITOR ACTIVE", "success");
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
