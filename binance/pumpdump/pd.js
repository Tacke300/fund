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
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();
let clearingSymbols = new Set(); 

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

// ============ ENGINE QUÉT LỆNH ĐIỀU KIỆN (GHOST BUSTER) ============
async function getConditionalOrders(symbol) {
    try {
        // Lấy 50 lệnh gần nhất từ allOrders để bao phủ lệnh TP/SL (Conditional)
        const all = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol, limit: 50 });
        const now = Date.now();

        return all.filter(o => {
            const validType = ['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET'].includes(o.type);
            const alive = o.status === 'NEW' || o.status === 'PARTIALLY_FILLED';
            // TRAP FIX: Chỉ lấy lệnh trong 30 phút đổ lại để tránh xóa nhầm lệnh cũ chưa sync status
            const recent = now - o.updateTime < 1000 * 60 * 30;
            return validType && alive && recent;
        });
    } catch (e) { return []; }
}

// ============ XÓA ĐÍCH DANH THEO ID (TARGETED STRIKE) ============
async function clearOrders(symbol) {
    if (clearingSymbols.has(symbol)) return;
    clearingSymbols.add(symbol);
    try {
        const orders = await getConditionalOrders(symbol);
        if (orders.length > 0) {
            addBotLog(`🧹 [${symbol}] Tìm thấy ${orders.length} lệnh điều kiện. Đang xóa theo ID...`, "warning");
            for (const o of orders) {
                try {
                    await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
                    addBotLog(`🗑️ Xóa ID: ${o.orderId} (${o.type})`, "success");
                } catch (err) {}
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    } finally {
        setTimeout(() => { clearingSymbols.delete(symbol); }, 3000);
    }
}

// ============ ĐẶT TPSL: FIX PARAMS + ROLLBACK ============
async function syncTPSL(symbol, side, entry, info, customTP = null, customSL = null) {
    if (clearingSymbols.has(symbol)) return { tp: 0, sl: 0 };
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - (customTP || botSettings.posTP) / 100) : (1 + (customTP || botSettings.posTP) / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + (customSL || botSettings.posSL) / 100) : (1 - (customSL || botSettings.posSL) / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    const params = { positionSide: side, closePosition: true, workingType: 'MARK_PRICE' };

    try {
        const oTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { ...params, stopPrice: tpPrice });
        const oSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { ...params, stopPrice: slPrice });
        addBotLog(`🎯 [${symbol}] TP-ID: ${oTP.id} | SL-ID: ${oSL.id}`, "success");
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi đặt TPSL: ${e.message}. Đang dọn ID mồ côi...`, "error");
        await clearOrders(symbol);
        return { tp: 0, sl: 0 };
    }
}

// ============ ENTRY & DCA LOGIC (WAIT UNLOCK) ============
async function openPosition(symbol, isDCA = false) {
    if (openingSymbols.has(symbol) || clearingSymbols.has(symbol)) return;
    const posKey = `${symbol}_SHORT`;
    openingSymbols.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let cp = botActivePositions.get(posKey);

        if (isDCA && cp) {
            await clearOrders(symbol);
            while (clearingSymbols.has(symbol)) await new Promise(r => setTimeout(r, 500));
        }

        const acc = await binancePrivate('/fapi/v2/account');
        let marginToUse = isDCA ? cp.firstMargin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) : parseFloat(botSettings.invValue));
        
        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 6.0) qtyNum = Math.ceil(6.5 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`🚀 [${symbol}] Entry OK. ID: ${order.id}`);
            await new Promise(r => setTimeout(r, 2500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const finalEntry = parseFloat(realP.entryPrice);
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, qty: currentQty, 
                    tp: sync.tp, sl: sync.sl, margin: (currentQty * finalEntry) / info.maxLeverage,
                    firstMargin: isDCA ? cp.firstMargin : marginToUse,
                    dcaCount: isDCA ? cp.dcaCount + 1 : 0, pnl: 0, markPrice: currentPrice
                });
            }
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] Mở lệnh lỗi: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
}

// ============ LOOP GIÁ & DỌN RÁC ============
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const exchangeKeys = new Set();
        posRisk.forEach(p => { if (Math.abs(parseFloat(p.positionAmt)) > 0) exchangeKeys.add(`${p.symbol}_${p.positionSide}`); });

        for (let [key, botPos] of botActivePositions) {
            if (!exchangeKeys.has(key)) {
                addBotLog(`📉 [${botPos.symbol}] Position đã đóng. Bắt đầu Ghost Strike (ID-Clear)...`, "warning");
                await clearOrders(botPos.symbol);
                status.blackList[botPos.symbol] = Date.now() + (15 * 60 * 1000);
                botActivePositions.delete(key);
                status.botClosedCount++;
            } else {
                const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
                botPos.markPrice = parseFloat(p.markPrice);
                botPos.pnl = parseFloat(p.unRealizedProfit);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

// ============ SERVER & API ============
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
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👹 LUFFY V10 ONLINE - ID GHOST BUSTER ACTIVATED", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); 
setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning) return;
    for (let [key, botPos] of botActivePositions) {
        if (botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) await openPosition(botPos.symbol, true);
    }
    if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
        const entry = status.candidatesList.find(c => {
            const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol;
            return volOK && !status.blackList[c.symbol] && !clearingSymbols.has(c.symbol) && !botActivePositions.has(`${c.symbol}_SHORT`);
        });
        if (entry) await openPosition(entry.symbol, false);
    }
}, 5000);

// Nguồn dữ liệu
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
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.post('/api/test', async (req, res) => {
    const { action, symbol } = req.body;
    try {
        if (action === 'open') await openPosition(symbol, false);
        if (action === 'clear') await clearOrders(symbol);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
