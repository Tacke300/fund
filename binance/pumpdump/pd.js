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
    } catch (e) {
        throw new Error(e.response?.data?.msg || e.message);
    }
}

// --- 4 CÁCH CÀI TPSL KHÁC NHAU ---

async function syncTPSL(symbol, side, entry, info, qty, mode = 1) {
    if (clearingSymbols.has(symbol)) return { tp: 0, sl: 0 };
    const isShort = side === 'SHORT';
    const sideClose = isShort ? 'BUY' : 'SELL';
    const finalQty = Math.abs(qty).toFixed(info.quantityPrecision);
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);

    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 500));

        if (mode === 1) {
            // CÁCH 1: DÙNG CCXT (FIXED REDUCEONLY)
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: tpPrice, workingType: 'MARK_PRICE', reduceOnly: undefined });
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, { positionSide: side, stopPrice: slPrice, workingType: 'MARK_PRICE', reduceOnly: undefined });
            addBotLog(`[${symbol}] M1: CCXT OK`, "success");
        } 
        else if (mode === 2) {
            // CÁCH 2: DÙNG REST API (AXIOS) ĐƠN LẺ
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity: finalQty, workingType: 'MARK_PRICE' });
            await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, quantity: finalQty, workingType: 'MARK_PRICE' });
            addBotLog(`[${symbol}] M2: Rest API OK`, "success");
        }
        else if (mode === 3) {
            // CÁCH 3: DÙNG BATCH ORDERS (AXIOS - GỘP LỆNH)
            const batch = [
                { symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity: finalQty, workingType: 'MARK_PRICE', closePosition: "false" },
                { symbol, side: sideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, quantity: finalQty, workingType: 'MARK_PRICE', closePosition: "false" }
            ];
            await binancePrivate('/fapi/v1/batchOrders', 'POST', { batchOrders: JSON.stringify(batch) });
            addBotLog(`[${symbol}] M3: Batch API OK`, "success");
        }
        else if (mode === 4) {
            // CÁCH 4: DÙNG BINANCE PRIVATE CALL (PHƯƠNG THỨC KÝ TÊN THUẦN)
            const common = { symbol, side: sideClose, positionSide: side, quantity: finalQty, workingType: 'MARK_PRICE' };
            await binancePrivate('/fapi/v1/order', 'POST', { ...common, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice });
            await binancePrivate('/fapi/v1/order', 'POST', { ...common, type: 'STOP_MARKET', stopPrice: slPrice });
            addBotLog(`[${symbol}] M4: Private Call OK`, "success");
        }

        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi M${mode}: ${e.message}`, "error");
        return { tp: 0, sl: 0 };
    }
}

// --- CÁC HÀM CÒN LẠI GIỮ NGUYÊN LOGIC ---

async function forceClearAllOrders(symbol) {
    if (clearingSymbols.has(symbol)) return;
    clearingSymbols.add(symbol);
    try {
        addBotLog(`🧨 [${symbol}] Force Clear...`, "warning");
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        addBotLog(`✅ [${symbol}] M5: Sạch.`, "success");
    } catch (e) { addBotLog(`🚨 [${symbol}] Lỗi M5: ${e.message}`, "error"); }
    finally { clearingSymbols.delete(symbol); }
}

async function openPosition(symbol, isDCA = false, manualMode = null) {
    if (openingSymbols.has(symbol) || clearingSymbols.has(symbol)) return;
    const posKey = `${symbol}_SHORT`;
    openingSymbols.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let qtyNum = Math.ceil((6.5 / currentPrice / info.stepSize)) * info.stepSize; 
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
        
        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const modeIdx = manualMode || 1;
                const sync = await syncTPSL(symbol, 'SHORT', parseFloat(realP.entryPrice), info, Math.abs(parseFloat(realP.positionAmt)), modeIdx);
                botActivePositions.set(posKey, { symbol, entryPrice: parseFloat(realP.entryPrice), qty: Math.abs(parseFloat(realP.positionAmt)), tp: sync.tp, sl: sync.sl });
            }
        }
    } catch (e) { addBotLog(`🚨 Lỗi mở: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
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
        addBotLog("👹 LUFFY V5 ONLINE - 4 METHODS READY", "success");
    } catch (e) { setTimeout(init, 5000); }
}

init();

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.post('/api/test', async (req, res) => {
    const { action, symbol, mode } = req.body;
    const m = parseInt(mode);
    try {
        if (action === 'open') await openPosition(symbol, false, m);
        else if (action === 'clear') await forceClearAllOrders(symbol);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }));
APP.listen(9001);
