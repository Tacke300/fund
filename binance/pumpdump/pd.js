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

// --- BIẾN TOÀN CỤC ---
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
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
    } catch (e) { throw new Error(e.response?.data?.msg || e.message); }
}

// --- 4 PHƯƠNG THỨC KỸ THUẬT ĐẶT TP/SL ---
async function syncTPSL(symbol, side, entry, info, qty, mode = 1) {
    if (clearingSymbols.has(symbol)) return { tp: 0, sl: 0 };
    const isShort = side === 'SHORT';
    const sideClose = isShort ? 'BUY' : 'SELL';
    const finalQty = Math.abs(qty).toFixed(info.quantityPrecision);
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);

    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 600));

        if (mode === 1) { // CCXT FIX
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: tpPrice, workingType: 'MARK_PRICE', reduceOnly: undefined });
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: slPrice, workingType: 'MARK_PRICE', reduceOnly: undefined });
        } 
        else if (mode === 2) { // AXIOS LẺ
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity: finalQty, workingType: 'MARK_PRICE' });
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, quantity: finalQty, workingType: 'MARK_PRICE' });
        }
        else if (mode === 3) { // CCXT PRIVATE POST
            await exchange.privatePostOrder({ symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity: finalQty, workingType: 'MARK_PRICE' });
            await exchange.privatePostOrder({ symbol, side: sideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, quantity: finalQty, workingType: 'MARK_PRICE' });
        }
        else { // M4: BATCH ORDERS
            const batch = [
                { symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity: finalQty, workingType: 'MARK_PRICE' },
                { symbol, side: sideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, quantity: finalQty, workingType: 'MARK_PRICE' }
            ];
            await binancePrivate('/fapi/v1/batchOrders', 'POST', { batchOrders: JSON.stringify(batch) });
        }

        addBotLog(`🎯 [${symbol}] M${mode} OK: TP ${tpPrice}, SL ${slPrice}`, "success");
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) { addBotLog(`🚨 Lỗi M${mode}: ${e.message}`, "error"); return { tp: 0, sl: 0 }; }
}

// --- M5: GIỮ NGUYÊN HÀM XÓA LỆNH ---
async function forceClearAllOrders(symbol) {
    if (clearingSymbols.has(symbol)) return;
    clearingSymbols.add(symbol);
    try {
        addBotLog(`🧨 [${symbol}] M5: Clear All Orders...`, "warning");
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        addBotLog(`✅ [${symbol}] M5: OK.`, "success");
    } catch (e) { addBotLog(`🚨 Lỗi M5: ${e.message}`, "error"); }
    finally { clearingSymbols.delete(symbol); }
}

// --- LOGIC MỞ LỆNH & DCA ---
async function openPosition(symbol, isDCA = false, manualMode = null) {
    if (openingSymbols.has(symbol) || clearingSymbols.has(symbol)) return;
    const posKey = `${symbol}_SHORT`;
    openingSymbols.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let cp = botActivePositions.get(posKey);
        
        let marginToUse = 0;
        if (manualMode) marginToUse = 6.0; 
        else if (isDCA) { if (!cp || cp.isProcessing) return; cp.isProcessing = true; marginToUse = cp.firstMargin; }
        else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) : parseFloat(botSettings.invValue);
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 5.5) qtyNum = Math.ceil(6.0 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
        
        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const sync = await syncTPSL(symbol, 'SHORT', currentPrice, info, qtyNum, manualMode || 1);
            botActivePositions.set(posKey, { symbol, entryPrice: currentPrice, qty: qtyNum, tp: sync.tp, sl: sync.sl, firstMargin: isDCA ? cp.firstMargin : marginToUse, dcaCount: isDCA ? cp.dcaCount + 1 : 0, isProcessing: false, pnl: 0 });
        }
    } catch (e) { addBotLog(`🚨 Lỗi mở: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
}

// --- VÒNG LẶP QUẢN LÝ ---
async function priceMonitorLoop() {
    if (!status.isReady) return setTimeout(priceMonitorLoop, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const exchangeKeys = new Set();
        posRisk.forEach(p => { if (Math.abs(parseFloat(p.positionAmt)) > 0) exchangeKeys.add(`${p.symbol}_${p.positionSide}`); });
        
        for (let [key, botPos] of botActivePositions) {
            if (!exchangeKeys.has(key)) {
                await forceClearAllOrders(botPos.symbol);
                status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                botActivePositions.delete(key);
                status.botClosedCount++;
            } else {
                const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
                botPos.pnl = parseFloat(p.unRealizedProfit);
                botPos.priceDev = ((parseFloat(p.markPrice) - botPos.entryPrice) / botPos.entryPrice) * 100;
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
            const entry = status.candidatesList.find(c => !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
            if (entry) await openPosition(entry.symbol);
        }
    } catch (e) {}
}

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: 20 };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👹 LUFFY V5 FULL - READY", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); setInterval(mainLoop, 5000);
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
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2) } });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/test', async (req, res) => {
    const { action, symbol, mode } = req.body;
    if (action === 'open') openPosition(symbol, false, parseInt(mode));
    else if (action === 'clear') forceClearAllOrders(symbol);
    res.json({ success: true });
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
