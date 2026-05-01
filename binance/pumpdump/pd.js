import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 20000, headers: { 'X-MBX-APIKEY': API_KEY } });

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

// --- BIẾN TOÀN CỤC ---
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let deletingOrdersCache = new Map(); 
let syncingTPSL = new Set(); 
let creatingTPSL = new Set(); 
let openingSymbols = new Set(); 
let timestampOffset = 0; 
let cachedPosRisk = []; 

// --- UTILS ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) { throw new Error(error.response?.data?.msg || error.message); }
}

async function refreshPosRisk() { 
    try { cachedPosRisk = await binancePrivate('/fapi/v2/positionRisk'); } catch (e) {} 
}

// --- [FIX 1] SAFE DELETE REAL - XÓA BẰNG THỰC LỰC ---
async function safeDelete(symbol, orderId) {
    for (let i = 0; i < 5; i++) {
        try {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId });
            await new Promise(r => setTimeout(r, 250));
            const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
            if (!orders.some(o => o.orderId == orderId)) {
                deletingOrdersCache.set(orderId.toString(), Date.now());
                return true;
            }
        } catch (e) {
            if (e.message.includes("Unknown order") || e.message.includes("does not exist")) {
                deletingOrdersCache.set(orderId.toString(), Date.now());
                return true;
            }
        }
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

async function getCleanOrders(symbol) {
    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
    const now = Date.now();
    for (let [id, time] of deletingOrdersCache) { if (now - time > 5000) deletingOrdersCache.delete(id); }
    return orders.filter(o => !deletingOrdersCache.has(o.orderId.toString()));
}

function isTPSLOrder(o, side, targetPrice, targetQty, sideClose) {
    if (o.positionSide !== side) return false;
    const stop = parseFloat(o.stopPrice || o.activatePrice || 0);
    const qty = Math.abs(parseFloat(o.origQty || 0));
    return (o.type.includes("STOP") || o.type.includes("TAKE_PROFIT")) && 
           o.side.toLowerCase() === sideClose.toLowerCase() && 
           Math.abs(stop - targetPrice) <= targetPrice * 0.001 && 
           Math.abs(qty - targetQty) <= targetQty * 0.05;
}

// --- [FIX 2 & 4] SYNC TPSL ATOMIC & VERIFY LOOP ---
async function syncTPSL(symbol, side, info) {
    const lockKey = `${symbol}_${side}`;
    if (syncingTPSL.has(lockKey) || creatingTPSL.has(lockKey)) return null;
    
    syncingTPSL.add(lockKey);
    creatingTPSL.add(lockKey); // Khóa sớm triệt tiêu race condition

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realPos = posRisk.find(p => p.symbol === symbol && p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (!realPos) return null;

        const currentQty = Math.abs(parseFloat(realPos.positionAmt));
        const finalQtyStr = (Math.floor(currentQty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        const realEntry = parseFloat(realPos.entryPrice);
        const isShort = (side === 'SHORT');
        const tpPrice = parseFloat((realEntry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision));
        const slPrice = parseFloat((realEntry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision));
        const sideClose = isShort ? 'buy' : 'sell';

        let currentOrders = await getCleanOrders(symbol);
        const tpslOrders = currentOrders.filter(o => o.positionSide === side && (o.type.includes("STOP") || o.type.includes("TAKE_PROFIT")));

        if (tpslOrders.find(o => isTPSLOrder(o, side, tpPrice, currentQty, sideClose)) && 
            tpslOrders.find(o => isTPSLOrder(o, side, slPrice, currentQty, sideClose)) && 
            tpslOrders.length === 2) {
            return { symbol, side, tp: tpPrice, sl: slPrice, qty: currentQty, entry: realEntry, lastSync: Date.now() };
        }

        // Bắt đầu dọn dẹp
        for (const o of tpslOrders) await safeDelete(symbol, o.orderId);

        // Verify sạch rác thực tế
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 200));
            const check = await getCleanOrders(symbol);
            if (!check.some(o => o.positionSide === side && (o.type.includes("STOP") || o.type.includes("TAKE_PROFIT")))) break;
        }

        const params = { positionSide: side, reduceOnly: true, workingType: 'MARK_PRICE' };
        let createdTP = null; let createdSL = null;
        try {
            createdTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, finalQtyStr, undefined, { ...params, stopPrice: tpPrice });
            createdSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQtyStr, undefined, { ...params, stopPrice: slPrice });

            await new Promise(r => setTimeout(r, 600));
            const verify = await getCleanOrders(symbol);
            if (!verify.some(o => isTPSLOrder(o, side, tpPrice, currentQty, sideClose)) || 
                !verify.some(o => isTPSLOrder(o, side, slPrice, currentQty, sideClose))) {
                throw new Error("VERIFY_FAIL");
            }
            addBotLog(`🛡️ [${symbol}] V16.6 Sync OK.`);
            return { symbol, side, tp: tpPrice, sl: slPrice, qty: currentQty, entry: realEntry, lastSync: Date.now() };
        } catch (err) {
            if (createdTP) await safeDelete(symbol, createdTP.id);
            if (createdSL) await safeDelete(symbol, createdSL.id);
            return null;
        }
    } finally { 
        syncingTPSL.delete(lockKey); 
        setTimeout(() => creatingTPSL.delete(lockKey), 1000); 
    }
}

// --- MONITOR & MAIN LOOP ---
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        for (let [key, botPos] of botActivePositions) {
            // [FIX 3] Monitor Check Side
            let real = cachedPosRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (!real) {
                const orders = await getCleanOrders(botPos.symbol);
                for (const o of orders.filter(o => o.positionSide === botPos.side)) await safeDelete(botPos.symbol, o.orderId);
                status.blackList[botPos.symbol] = Date.now() + 900000;
                botActivePositions.delete(key);
                addBotLog(`✅ [${botPos.symbol}] Position Cleaned.`);
            } else if (Date.now() - (botPos.lastSync || 0) > 15000) {
                const sync = await syncTPSL(botPos.symbol, botPos.side, status.exchangeInfo[botPos.symbol]);
                if (sync) Object.assign(botPos, sync);
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

// --- [FIX 5] THE SWEEPER - QUÉT RÁC TOÀN SÀN MỖI 3 PHÚT ---
setInterval(async () => {
    if (!status.isReady) return;
    for (const sym of Object.keys(status.exchangeInfo)) {
        try {
            const hasPos = cachedPosRisk.some(p => Math.abs(parseFloat(p.positionAmt)) > 0 && p.symbol === sym);
            if (!hasPos) {
                const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: sym });
                for (const o of orders) {
                    if (o.type.includes("STOP") || o.type.includes("TAKE_PROFIT")) {
                        await safeDelete(sym, o.orderId);
                        addBotLog(`🧹 Sweeper Cleaned: ${sym}`, "info");
                    }
                }
            }
        } catch {}
    }
}, 180000);

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let margin = isDCA ? (botActivePositions.get(posKey).firstMargin * 1.05) : 0;
        if (!isDCA) {
            const acc = await binancePrivate('/fapi/v2/account');
            margin = botSettings.invValue.includes('%') ? (acc.availableBalance * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue);
        }
        let qtyNum = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
        if (order) {
            await new Promise(r => setTimeout(r, 3000));
            const sync = await syncTPSL(symbol, 'SHORT', info);
            if (sync) botActivePositions.set(posKey, { ...sync, firstMargin: isDCA ? botActivePositions.get(posKey).firstMargin : margin, dcaCount: isDCA ? botActivePositions.get(posKey).dcaCount + 1 : 0 });
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] Open Fail: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const activeShorts = cachedPosRisk.filter(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
        for (let pos of activeShorts) {
            const key = `${pos.symbol}_SHORT`;
            const botPos = botActivePositions.get(key);
            if (!botPos || botPos.dcaLock) continue;
            const curDev = ((parseFloat(pos.markPrice) - parseFloat(pos.entryPrice)) / parseFloat(pos.entryPrice)) * 100;
            const dcaThreshold = botSettings.dcaStep * (botPos.dcaCount + 1);
            
            if (curDev >= dcaThreshold && botPos.dcaCount < botSettings.maxDCA && !botPos.latchDCA) {
                botPos.dcaLock = true;
                await openPosition(pos.symbol, true);
                setTimeout(() => { if(botActivePositions.has(key)) botActivePositions.get(key).dcaLock = false; }, 5000);
            } else if (curDev < dcaThreshold - 0.5) { botPos.latchDCA = false; }
        }

        if (activeShorts.length < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                return info && info.maxLeverage >= 20 && (status.blackList[c.symbol] || 0) < Date.now() && 
                       !activeShorts.some(p => p.symbol === c.symbol) && (Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol);
            });
            if (keo) await openPosition(keo.symbol);
        }
    } catch (e) {}
}

async function init() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = res.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = brkRes.find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("💎 V16.6 THE UNSTOPPABLE ACTIVATED", "success");
        setInterval(refreshPosRisk, 1200); 
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); 
setInterval(mainLoop, 3000);
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
