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

// Cấu hình Axios cho Native API
const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

// Cấu hình CCXT
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

// LOCKS
let openingSymbols = new Set();
let clearingSymbols = new Set(); 

const BLACKLIST_DURATION = 15 * 60 * 1000;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        throw new Error(e.response?.data?.msg || e.message);
    }
}

// ============ HÀM XÓA LỆNH 2 TẦNG (MODE 5) ============
async function forceClearAllOrders(symbol) {
    if (clearingSymbols.has(symbol)) return;
    clearingSymbols.add(symbol);
    try {
        addBotLog(`💣 [${symbol}] Force Clear 2 tầng...`);
        // Tầng 1 — Xóa bulk
        try {
            await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        } catch (e) {}

        await new Promise(r => setTimeout(r, 1000));

        // Tầng 2 — Nếu còn sót thì xóa từng ID
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        if (openOrders.length > 0) {
            for (const order of openOrders) {
                try {
                    await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: order.orderId });
                } catch (err) {}
            }
        }
        addBotLog(`✅ [${symbol}] Đã dọn sạch lệnh.`);
    } finally {
        clearingSymbols.delete(symbol);
    }
}

// ============ 4 CÁCH ĐẶT TP/SL (MODE 1 -> 4) ============
async function syncTPSL(symbol, side, entry, info, qty, mode = 4, customTP = null, customSL = null) {
    if (clearingSymbols.has(symbol)) return { tp: 0, sl: 0 };
    const isShort = side === 'SHORT';
    const tpP = customTP || botSettings.posTP;
    const slP = customSL || botSettings.posSL;
    const tpPrice = (entry * (isShort ? (1 - tpP / 100) : (1 + tpP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slP / 100) : (1 - slP / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    const finalQty = Math.abs(qty).toFixed(info.quantityPrecision);

    try {
        if (mode === 1) {
            // M1: LIMIT TP + STOP_MARKET SL (TP nhảy vào Lệnh cơ bản)
            await exchange.createOrder(symbol, 'LIMIT', sideClose, finalQty, tpPrice, { positionSide: side, reduceOnly: true });
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: slPrice, reduceOnly: true });
        } 
        else if (mode === 2) {
            // M2: TAKE_PROFIT (Limit) + STOP (Limit) (Nhảy vào Lệnh cơ bản)
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT', quantity: finalQty, stopPrice: tpPrice, price: tpPrice, workingType: 'MARK_PRICE' });
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'STOP', quantity: finalQty, stopPrice: slPrice, price: slPrice, workingType: 'MARK_PRICE' });
        }
        else if (mode === 3) {
            // M3: Native API STOP_MARKET/TP_MARKET
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: 'true' });
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true' });
        }
        else {
            // M4: CCXT Standard (Lệnh điều kiện)
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: slPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        }
        addBotLog(`🎯 [${symbol}] Đã đặt TPSL Mode ${mode}`, "success");
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi đặt TPSL: ${e.message}`, "error");
        return { tp: 0, sl: 0 };
    }
}

// ============ QUẢN LÝ VỊ THẾ ============
async function openPosition(symbol, isDCA = false, manualData = null) {
    if (openingSymbols.has(symbol) || clearingSymbols.has(symbol)) return;
    const posKey = `${symbol}_SHORT`;
    openingSymbols.add(symbol);

    try {
        // XÓA LỆNH CHỜ 2 TẦNG TRƯỚC KHI MỞ
        await forceClearAllOrders(symbol);
        await new Promise(r => setTimeout(r, 500));

        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let cp = botActivePositions.get(posKey);
        let marginToUse = manualData ? manualData.margin : 0;

        if (!manualData) {
            if (isDCA) {
                if (!cp || cp.isProcessing) return;
                cp.isProcessing = true;
                marginToUse = cp.firstMargin;
            } else {
                const acc = await binancePrivate('/fapi/v2/account');
                marginToUse = botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) : parseFloat(botSettings.invValue);
            }
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 5.5) qtyNum = Math.ceil(6.0 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const finalEntry = parseFloat(realP.entryPrice);
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                // Lúc mở vị thế mặc định dùng cách đặt Mode 4
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, currentQty, 4, manualData?.tp, manualData?.sl);
                
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, qty: currentQty, 
                    tp: sync.tp, sl: sync.sl, margin: (currentQty * finalEntry) / info.maxLeverage,
                    leverage: info.maxLeverage, firstMargin: isDCA ? cp.firstMargin : marginToUse,
                    dcaCount: isDCA ? cp.dcaCount + 1 : 0, isProcessing: false, pnl: 0, markPrice: currentPrice, tpslStep: 10 
                });
            }
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] Lỗi mở: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const exchangeKeys = new Set();
        posRisk.forEach(p => { if (Math.abs(parseFloat(p.positionAmt)) > 0) exchangeKeys.add(`${p.symbol}_${p.positionSide}`); });

        for (let [key, botPos] of botActivePositions) {
            if (!exchangeKeys.has(key)) {
                addBotLog(`📉 [${botPos.symbol}] Vị thế đã đóng. Force Clear 2 tầng...`);
                await forceClearAllOrders(botPos.symbol); 
                status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                botActivePositions.delete(key);
                status.botClosedCount++;
            } else {
                const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
                botPos.markPrice = parseFloat(p.markPrice);
                botPos.pnl = parseFloat(p.unRealizedProfit) - ((botPos.qty * botPos.markPrice) * 0.001);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        for (let [key, botPos] of botActivePositions) {
            if (!botPos.isProcessing && botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) await openPosition(botPos.symbol, true);
        }
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const entry = status.candidatesList.find(c => {
                const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol || Math.abs(parseFloat(c.c5)) >= botSettings.minVol;
                return volOK && !status.blackList[c.symbol] && !clearingSymbols.has(c.symbol) && !botActivePositions.has(`${c.symbol}_SHORT`);
            });
            if (entry) await openPosition(entry.symbol, false);
        }
    } catch (e) {}
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
            const brk = brkRes.find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👹 LUFFY V10 ONLINE - 2-STAGE CLEAR", "success");
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

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const blSecs = {}; const now = Date.now();
        Object.keys(status.blackList).forEach(s => { const rem = Math.floor((status.blackList[s] - now) / 1000); if (rem > 0) blSecs[s] = rem; else delete status.blackList[s]; });
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status: { ...status, blackList: blSecs }, wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) } });
    } catch (e) { res.json({ status }); }
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

APP.post('/api/test', async (req, res) => {
    const { action, symbol, mode } = req.body;
    const posKey = `${symbol}_SHORT`;
    const pos = botActivePositions.get(posKey);
    const info = status.exchangeInfo[symbol];
    const m = parseInt(mode);

    try {
        if (action === 'open') await openPosition(symbol, false, { margin: 0.5, tp: 10, sl: 50 });
        
        if (action === 'clear') {
            if (m === 5) await forceClearAllOrders(symbol); // Nút 5 xóa 2 tầng
            else await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        }

        if (action === 'set_only' && pos) {
            await forceClearAllOrders(symbol); 
            await syncTPSL(symbol, 'SHORT', pos.entryPrice, info, pos.qty, m); // Set theo Mode (1-4)
        }

        if (action === 'reset_cycle' && pos) {
            await forceClearAllOrders(symbol); 
            pos.tpslStep = (pos.tpslStep === 10) ? 15 : 10;
            const newSync = await syncTPSL(symbol, 'SHORT', pos.entryPrice, info, pos.qty, m, pos.tpslStep, botSettings.posSL);
            pos.tp = newSync.tp; pos.sl = newSync.sl;
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
