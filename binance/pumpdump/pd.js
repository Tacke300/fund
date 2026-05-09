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
const BLACKLIST_DURATION = 15 * 60 * 1000;

// ============ LOGGING ============
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// ============ BINANCE PRIVATE API ============
async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) { 
        throw new Error(error.response?.data?.msg || error.message); 
    }
}

// ============ FIX: XỬ LÝ LỆNH CHẾ ĐỘ 2 CHIỀU ============
async function forceClearAllOrders(symbol) {
    try {
        const openOrders = await exchange.fetchOpenOrders(symbol);
        const shortOrders = openOrders.filter(o => o.info.positionSide === 'SHORT');
        for (const order of shortOrders) {
            await exchange.cancelOrder(order.id, symbol, { positionSide: 'SHORT' });
        }
        return true;
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi dọn lệnh: ${e.message}`, "error");
        return false;
    }
}

async function verifyTPSLOrders(symbol, side, maxAttempts = 5) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const openOrders = await exchange.fetchOpenOrders(symbol);
            const tpsl = openOrders.filter(o => o.info.positionSide === side && 
                ['TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(o.info.type || o.type));
            if (tpsl.length >= 2) return true;
            addBotLog(`⏳ [${symbol}] Đang verify lệnh chờ (${tpsl.length}/2)...`);
        } catch (e) {}
    }
    return false;
}

async function emergencyClose(symbol, side, info) {
    try {
        addBotLog(`🚨 [${symbol}] Đóng vị thế khẩn cấp...`, "error");
        await forceClearAllOrders(symbol);
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realPos = posRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (realPos) {
            const qty = Math.abs(parseFloat(realPos.positionAmt));
            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            await exchange.createOrder(symbol, 'MARKET', sideClose, qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
            addBotLog(`🔥 [${symbol}] Đã đóng Market Close thành công.`);
        }
    } catch (e) { addBotLog(`❌ Lỗi đóng khẩn cấp: ${e.message}`, "error"); }
}

async function syncTPSL(symbol, side, entry, info) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    try {
        await forceClearAllOrders(symbol);
        await new Promise(r => setTimeout(r, 1000));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE' });
        
        const ok = await verifyTPSLOrders(symbol, side);
        if (!ok) { await emergencyClose(symbol, side, info); return { success: false }; }
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) { await emergencyClose(symbol, side, info); return { success: false }; }
}

// ============ TRADING LOGIC ============
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    try {
        const info = status.exchangeInfo[symbol];
        if (!info) return;
        const posKeyLock = `${symbol}_SHORT`;
        if (positionLocks.has(posKeyLock)) return;
        positionLocks.set(posKeyLock, true);

        let cp = isDCA ? botActivePositions.get(posKey) : null;
        if (isDCA && (!cp || cp.isProcessing)) { positionLocks.delete(posKeyLock); return; }
        if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) { positionLocks.delete(posKeyLock); return; }

        if (isDCA) cp.isProcessing = true; else openingSymbols.add(symbol);

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        const acc = await binancePrivate('/fapi/v2/account');
        
        let marginToUse = isDCA ? cp.firstMargin : (botSettings.invValue.toString().includes('%') 
            ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
            : parseFloat(botSettings.invValue));

        let qtyNum = Math.max((marginToUse * info.maxLeverage) / currentPrice, 6/currentPrice);
        qtyNum = Math.ceil(qtyNum / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 3000));
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realPos = posRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realPos) {
                const finalEntry = parseFloat(realPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                if (sync.success) {
                    botActivePositions.set(posKey, { 
                        symbol, side: 'SHORT', entryPrice: finalEntry, originalEntry: isDCA ? cp.originalEntry : finalEntry,
                        qty: Math.abs(parseFloat(realPos.positionAmt)), tp: sync.tp, sl: sync.sl, 
                        firstMargin: isDCA ? cp.firstMargin : marginToUse, dcaCount: isDCA ? cp.dcaCount + 1 : 0, 
                        isProcessing: false, pnl: 0, priceDev: 0, leverage: info.maxLeverage
                    });
                    status.blackList[symbol] = Date.now() + BLACKLIST_DURATION;
                }
            }
        }
    } catch (e) { addBotLog(`🚨 Lỗi Open: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); positionLocks.delete(`${symbol}_SHORT`); }
}

// ============ LOOPS ============
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const closed = [];
        for (let [key, botPos] of botActivePositions) {
            const real = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!real || Math.abs(parseFloat(real.positionAmt)) === 0) {
                closed.push(key);
            } else {
                botPos.markPrice = parseFloat(real.markPrice);
                botPos.pnl = parseFloat(real.unRealizedProfit);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
        for (const k of closed) {
            const p = botActivePositions.get(k);
            status.botClosedCount++;
            addBotLog(`✅ Chốt ${p.symbol}`, "success");
            botActivePositions.delete(k);
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1500);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    const now = Date.now();
    Object.keys(status.blackList).forEach(s => { if(status.blackList[s] < now) delete status.blackList[s]; });

    for (let [key, botPos] of botActivePositions) {
        if (!botPos.isProcessing && botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) {
            await openPosition(botPos.symbol, true);
        }
    }
    if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
        const keo = status.candidatesList.find(c => !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && (Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol));
        if (keo) await openPosition(keo.symbol, false);
    }
}

// ============ INITIALIZATION ============
async function init() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: 20 };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY V21.1 - FULL DATA SYNC", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 5000);

// ============ EXPRESS: CUNG CẤP DỮ LIỆU CHO HTML ============
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        // Trả về đúng cấu trúc Object mà HTML của bạn yêu cầu
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status, 
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) 
            },
            locks: {
                positionLocksCount: positionLocks.size,
                dcaCleanupLocksCount: dcaCleanupLocks.size,
                openingSymbolsCount: openingSymbols.size
            }
        });
    } catch (e) { res.json({ status }); }
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    res.json({ success: true }); 
});

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);

// Sync candidates list từ bot tín hiệu khác
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);
