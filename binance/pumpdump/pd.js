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

// ============ LOGIC XÓA LỆNH VÀ KIỂM TRA (SỬA THEO YÊU CẦU DIỆT LỆNH ẨN) ============
async function clearOrders(symbol, mode = 4) {
    if (clearingSymbols.has(symbol)) return;
    clearingSymbols.add(symbol);

    try {
        // 1. Quét lệnh: Dùng allOrders để thấy cả lệnh "ẩn" của Hedge Mode
        const all = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol, limit: 100 });
        const now = Date.now();
        // Lọc lệnh TP/SL còn sống (NEW/PARTIALLY_FILLED) và mới cập nhật gần đây
        const targets = all.filter(o => 
            ['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT'].includes(o.type) &&
            ['NEW', 'PARTIALLY_FILLED'].includes(o.status) &&
            (now - o.updateTime < 1000 * 60 * 60) // Trong 1 tiếng qua
        );

        addBotLog(`📌 [${symbol}] Tìm thấy ${targets.length} lệnh chờ thực tế (Mode ${mode})`, "warning");

        // 2. Thực hiện xóa đích danh theo OrderId (Cách duy nhất trị lệnh ẩn)
        if (targets.length > 0) {
            for (const o of targets) {
                try {
                    await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
                    addBotLog(`🗑️ Đã dọn ID: ${o.orderId} (${o.type})`, "success");
                } catch(e) {
                    // Nếu lỗi do lệnh đã bị xóa trước đó thì bỏ qua
                }
            }
        }

        // 3. Fallback: Nếu vẫn muốn dùng các mode gốc của m
        if (mode === 1) await exchange.cancelAllOrders(symbol, { positionSide: 'SHORT' });
        if (mode === 5) await exchange.cancelAllOrders(symbol);

        // 4. Đợi cập nhật và kiểm tra lại
        await new Promise(r => setTimeout(r, 2000));
        const after = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        
        if (after.length === 0) {
            addBotLog(`✅ [${symbol}] Sạch lệnh chờ.`, "success");
        } else {
            addBotLog(`❌ [${symbol}] Còn ${after.length} lệnh chưa diệt được.`, "error");
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi trong clearOrders: ${e.message}`, "error");
    } finally {
        clearingSymbols.delete(symbol);
    }
}

// ============ LOGIC TPSL (GIỮ NGUYÊN CẤU TRÚC GỐC CỦA M) ============
async function syncTPSL(symbol, side, entry, info, qty, customTP = null, customSL = null) {
    if (clearingSymbols.has(symbol)) return { tp: 0, sl: 0 };

    const isShort = side === 'SHORT';
    const tpP = customTP || botSettings.posTP;
    const slP = customSL || botSettings.posSL;
    const tpPrice = (entry * (isShort ? (1 - tpP / 100) : (1 + tpP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slP / 100) : (1 - slP / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    const finalQty = Math.abs(qty).toFixed(info.quantityPrecision);

    try {
        // Tạo lệnh TP - Log ID rõ ràng
        const orderTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, finalQty, undefined, {
            positionSide: side, stopPrice: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE'
        });
        // Tạo lệnh SL - Log ID rõ ràng
        const orderSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, {
            positionSide: side, stopPrice: slPrice, reduceOnly: true, workingType: 'MARK_PRICE'
        });

        addBotLog(`🎯 TPSL OK: TP ID ${orderTP.id}, SL ID ${orderSL.id}`, "success");
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi đặt TPSL: ${e.message}`, "error");
        // Nếu lỗi, thử dọn dẹp ngay để tránh treo lệnh
        await clearOrders(symbol, 4);
        return { tp: 0, sl: 0 };
    }
}

// ============ QUẢN LÝ VỊ THẾ (GIỮ NGUYÊN CODE GỐC CỦA M) ============
async function openPosition(symbol, isDCA = false, manualData = null) {
    if (openingSymbols.has(symbol) || clearingSymbols.has(symbol)) return;
    const posKey = `${symbol}_SHORT`;
    openingSymbols.add(symbol);

    try {
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
                // Trước khi DCA, dọn sạch lệnh cũ để lấy chỗ set TPSL mới
                await clearOrders(symbol, 4);
                while(clearingSymbols.has(symbol)) await new Promise(r => setTimeout(r, 500));
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
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, currentQty, manualData?.tp, manualData?.sl);
                
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
                addBotLog(`📉 [${botPos.symbol}] Vị thế đã đóng. Đang dọn ID mồ côi...`);
                await clearOrders(botPos.symbol, 4); 
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
        addBotLog("👹 LUFFY V5 ONLINE - FULL FIX CLEAR", "success");
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

    if (clearingSymbols.has(symbol) && action !== 'clear') {
        return res.status(400).json({ error: 'Đang clear orders...' });
    }

    try {
        if (action === 'open') await openPosition(symbol, false, { margin: 0.5, tp: 10, sl: 50 });
        if (action === 'clear') await clearOrders(symbol, parseInt(mode) || 4);
        if (action === 'set_only' && pos) {
            await clearOrders(symbol, 4); 
            await syncTPSL(symbol, 'SHORT', pos.entryPrice, info, pos.qty);
        }
        if (action === 'reset_cycle' && pos) {
            await clearOrders(symbol, 4); 
            pos.tpslStep = (pos.tpslStep === 10) ? 15 : 10;
            const newSync = await syncTPSL(symbol, 'SHORT', pos.entryPrice, info, pos.qty, pos.tpslStep, botSettings.posSL);
            pos.tp = newSync.tp; pos.sl = newSync.sl;
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
