import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; 
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MARGIN_PROTECT_LIMIT = 60;    
const MARGIN_RECOVER_LIMIT = 70;    
const MONITOR_INTERVAL = 250; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, 'bot_settings.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
});

let botSettings = { isRunning: false, capital: "1%", volVolatility: 6.5, maxPos: 3, maxDca: 2, tp: 1.2, sl: 10.0, longTp: 15.0, longSl: 15.0 };
let openingPositions = new Set();
let closingPositions = new Set();
let forceClosingPositions = new Set();
let leverageInitialized = new Set();
let monitorRunning = false;
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let timestampOffset = 0;
let isMarginProtected = false; 
let globalExchangePositions = [];
let errorReported = new Set();

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            botSettings = JSON.stringify(data) !== '{}' ? JSON.parse(data) : botSettings;
        } else { saveSettings(); }
    } catch (e) { console.error("❌ Lỗi đọc file cấu hình:", e.message); }
}

function saveSettings() {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 4), 'utf8'); } catch (e) { console.error("❌ Lỗi ghi file cấu hình:", e.message); }
}
loadSettings();

function addBotLog(msg, type = 'info', force = false) {
    if (errorReported.has(msg) && !force) return;
    if (type === 'error') errorReported.add(msg);
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        await new Promise(r => setTimeout(r, 400));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { addBotLog(`❌ Lỗi đặt TP/SL: ${e.message}`, "error"); return { tp: tpPrice, sl: slPrice }; }
}

async function openPosition(symbol, dcaData = null) {
    if (openingPositions.has(symbol)) return;
    openingPositions.add(symbol); 
    const isFinalLong = dcaData?.isFinalLong || false;
    const side = isFinalLong ? 'LONG' : 'SHORT';
    const dcaCount = dcaData ? dcaData.dcaCount : 0;
    
    try {
        const info = status.exchangeInfo[symbol];
        if (!leverageInitialized.has(symbol)) { await exchange.setLeverage(info.maxLeverage, symbol); leverageInitialized.add(symbol); }
        await new Promise(r => setTimeout(r, 400));
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let qty = Math.ceil(((dcaData ? dcaData.margin : parseFloat(botSettings.capital)) * info.maxLeverage / currentPrice) / info.stepSize) * info.stepSize;
        if ((qty * currentPrice) < 5.5) qty = Math.ceil((5.5 / currentPrice) / info.stepSize) * info.stepSize;

        await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        await new Promise(r => setTimeout(r, 1200));
        const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
        
        if (p) {
            const entry = parseFloat(p.entryPrice);
            const history = dcaData ? [...dcaData.dcaHistory, entry] : [entry];
            const avgEntry = history.reduce((a, b) => a + b, 0) / history.length;
            const tp = side === 'SHORT' ? avgEntry - (avgEntry * (botSettings.tp * (dcaCount + 1) / 100)) : entry * (1 + (botSettings.longTp / 100));
            const sl = side === 'SHORT' ? avgEntry + (avgEntry * (botSettings.sl * (dcaCount + 1) / 100)) : entry * (1 - (botSettings.longSl / 100));
            
            const sync = await syncTPSL(symbol, side, info, tp, sl);
            botActivePositions.set(`${symbol}_${side}`, { symbol, side, dcaCount, dcaHistory: history, firstMargin: dcaData?.firstMargin || parseFloat(botSettings.capital), isFinalLong });
            addBotLog(`📡 [${side}] ${symbol} | DCA: ${dcaCount} | Entry: ${entry}`);
        }
    } catch (e) {
        addBotLog(`❌ Lỗi vị thế ${symbol}: ${e.message}`, "error");
        status.blackList[symbol] = Date.now() + (60 * 60 * 1000);
    } finally { setTimeout(() => openingPositions.delete(symbol), 2000); }
}

async function handlePositionCloseCheck(key, b) {
    if (closingPositions.has(b.symbol)) return;
    closingPositions.add(b.symbol);
    try {
        await new Promise(r => setTimeout(r, 1200));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 1 });
        const netPnl = trades[0] ? parseFloat(trades[0].realizedPnl) : 0;
        addBotLog(`💰 [CLOSE] ${b.symbol} | Lý do: ${netPnl > 0 ? "TP_MARKET" : "SL_MARKET"} | PnL: ${netPnl}`);
        botActivePositions.delete(key);

        if (netPnl < 0 && botSettings.isRunning && !b.isFinalLong) {
            if (b.dcaCount < botSettings.maxDca) openPosition(b.symbol, { ...b, dcaCount: b.dcaCount + 1, margin: b.firstMargin * 2 });
            else openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 10 });
        }
    } catch (err) { console.error(err); } finally { closingPositions.delete(b.symbol); }
}

setInterval(async () => {
    if (!status.isReady) return;
    try {
        const res = await binancePrivate('/fapi/v2/positionRisk');
        if (res && Array.isArray(res)) globalExchangePositions = res;
    } catch (e) {}
}, 5000);

setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) { delete status.blackList[symbol]; addBotLog(`🔄 Unban Blacklist: ${symbol}`); }
    }
}, 1000);

async function priceMonitor() {
    const started = Date.now();
    if (!status.isReady || monitorRunning) return setTimeout(priceMonitor, 100);
    monitorRunning = true;
    try {
        for (let [key, b] of botActivePositions) {
            const realP = globalExchangePositions.find(p => `${p.symbol}_${p.positionSide}` === key);
            if (!realP || parseFloat(realP.positionAmt) === 0) handlePositionCloseCheck(key, b);
        }
    } catch (e) {} finally { monitorRunning = false; setTimeout(priceMonitor, Math.max(50, MONITOR_INTERVAL - (Date.now() - started))); }
}

async function init() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { status.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp; status.isReady = true; priceMonitor();
    } catch (e) { setTimeout(init, 5000); }
}
init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning || isMarginProtected || botActivePositions.size >= botSettings.maxPos || openingPositions.size > 0) return;
    const can = status.candidatesList.find(c => (Math.abs(c.c1) >= botSettings.volVolatility || Math.abs(c.c5) >= botSettings.volVolatility) && !status.blackList[c.symbol] && !status.permanentBlacklist[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && !botActivePositions.has(`${c.symbol}_LONG`));
    if (can) openPosition(can.symbol);
}, 3000);

const APP = express(); APP.use(express.json());
APP.get('/api/status', (req, res) => res.json(status));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; saveSettings(); res.json({ success: true }); });
APP.listen(1111);
