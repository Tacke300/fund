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
    } catch (e) { throw new Error(e.response?.data?.msg || e.message); }
}

// ============ HÀM DIỆT LỆNH 2 TẦNG (M5) ============
async function forceClearAllOrders(symbol) {
    if (clearingSymbols.has(symbol)) return;
    clearingSymbols.add(symbol);
    try {
        addBotLog(`💣 [${symbol}] M5: Quét 2 tầng...`);
        // Tầng 1: Xóa toàn bộ lệnh đang treo
        try { await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }); } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
        // Tầng 2: Check và diệt ID thủ công
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const order of openOrders) {
            try { await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: order.orderId }); } catch (err) {}
        }
        addBotLog(`✅ [${symbol}] Đã dọn sạch bách.`);
    } finally { clearingSymbols.delete(symbol); }
}

// ============ 4 CÁCH ĐẶT TP/SL ĐỂ NHẢY VÀO LỆNH CƠ BẢN ============
async function setTPSLByMode(mode, symbol, side, entry, info, qty, customTP = null) {
    const isShort = side === 'SHORT';
    const tpP = customTP || botSettings.posTP;
    const slP = botSettings.posSL;
    const tpPrice = (entry * (isShort ? (1 - tpP / 100) : (1 + tpP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slP / 100) : (1 - slP / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    const finalQty = Math.abs(qty).toFixed(info.quantityPrecision);

    addBotLog(`⚙️ Đang đặt TP/SL theo Mode ${mode}...`);
    
    try {
        if (mode === 1) {
            // CÁCH 1: Lệnh STOP/TAKE_PROFIT (Thường nhảy vào cơ bản hơn MARKET)
            await binancePrivate('/fapi/v1/order', 'POST', {
                symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT', 
                quantity: finalQty, stopPrice: tpPrice, price: tpPrice, workingType: 'MARK_PRICE'
            });
            await binancePrivate('/fapi/v1/order', 'POST', {
                symbol, side: sideClose, positionSide: side, type: 'STOP', 
                quantity: finalQty, stopPrice: slPrice, price: slPrice, workingType: 'MARK_PRICE'
            });
        } else if (mode === 2) {
            // CÁCH 2: Lệnh LIMIT kèm ClosePosition (Chỉ dùng cho TP)
            await exchange.createOrder(symbol, 'LIMIT', sideClose, finalQty, tpPrice, { positionSide: side, reduceOnly: true });
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: slPrice, reduceOnly: true });
        } else if (mode === 3) {
            // CÁCH 3: Native API STOP_MARKET/TAKE_PROFIT_MARKET
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: 'true' });
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true' });
        } else {
            // CÁCH 4 (Mặc định): CCXT Standard
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: tpPrice, reduceOnly: true });
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: slPrice, reduceOnly: true });
        }
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        addBotLog(`❌ Lỗi đặt TPSL Mode ${mode}: ${e.message}`, 'error');
        return { tp: 0, sl: 0 };
    }
}

// ============ MỞ VỊ THẾ ============
async function openPosition(symbol, isDCA = false) {
    if (openingSymbols.has(symbol) || clearingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);
    try {
        await forceClearAllOrders(symbol); // Luôn dọn rác trước khi mở
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let margin = botSettings.invValue.includes('%') ? 
            (parseFloat((await binancePrivate('/fapi/v2/account')).availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue);

        let qtyNum = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        await exchange.setLeverage(info.maxLeverage, symbol);
        
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = (await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol })).find(p => p.positionSide === 'SHORT');
            const entry = parseFloat(pRisk.entryPrice);
            const qty = Math.abs(parseFloat(pRisk.positionAmt));
            
            // Mặc định lúc mở dùng Mode 4 (Hoặc m có thể chỉnh tùy ý)
            const sync = await setTPSLByMode(4, symbol, 'SHORT', entry, info, qty);
            botActivePositions.set(`${symbol}_SHORT`, { symbol, entryPrice: entry, qty, tp: sync.tp, sl: sync.sl, dcaCount: isDCA ? 1 : 0 });
        }
    } finally { openingSymbols.delete(symbol); }
}

async function priceMonitorLoop() {
    if (!status.isReady) return setTimeout(priceMonitorLoop, 1000);
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        status.unlPnL = parseFloat(acc.totalUnrealizedProfit).toFixed(2); // TRẢ LẠI PNL CHO M

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, botPos] of botActivePositions) {
            const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
            if (!p || Math.abs(parseFloat(p.positionAmt)) === 0) {
                addBotLog(`📉 [${botPos.symbol}] Đóng vị thế. M5 kích hoạt...`);
                await forceClearAllOrders(botPos.symbol);
                botActivePositions.delete(key);
                status.botClosedCount++;
            } else {
                botPos.markPrice = parseFloat(p.markPrice);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1500);
}

// ... (init và các loop candidates giữ nguyên) ...

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account');
    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status, 
        wallet: { 
            totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance).toFixed(2),
            totalUnrealizedProfit: status.unlPnL // TRẢ LẠI Ở ĐÂY
        } 
    });
});

APP.post('/api/test', async (req, res) => {
    const { action, symbol, mode } = req.body;
    const pos = botActivePositions.get(`${symbol}_SHORT`);
    const info = status.exchangeInfo[symbol];
    try {
        if (action === 'clear' && parseInt(mode) === 5) {
            await forceClearAllOrders(symbol);
        } else if (action === 'reset_cycle' && pos) {
            // Khi nhấn nút Reset/Đặt lại, dùng Mode m chọn (1-4)
            await forceClearAllOrders(symbol);
            const m = parseInt(mode) || 4;
            const sync = await setTPSLByMode(m, symbol, 'SHORT', pos.entryPrice, info, pos.qty);
            pos.tp = sync.tp; pos.sl = sync.sl;
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Khởi chạy
async function start() {
    const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
    timestampOffset = timeRes.data.serverTime - Date.now();
    await exchange.loadMarkets();
    const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
    const tempInfo = {};
    infoRes.data.symbols.forEach(s => {
        const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
        tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: 20 };
    });
    status.exchangeInfo = tempInfo; status.isReady = true;
    priceMonitorLoop();
    setInterval(() => { if(botSettings.isRunning) mainLoop(); }, 5000);
}
start();
APP.listen(9001);
