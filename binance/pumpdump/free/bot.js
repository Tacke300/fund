import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MAX_DCA_LEVEL = 2;
const MARGIN_PROTECT_LIMIT = 60;
const MARGIN_RECOVER_LIMIT = 70;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, 'bot_settings.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };

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

let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let errorReported = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 
let currentBotIP = null; 

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

setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Unban Blacklist: ${symbol}`, "success");
        }
    }
}, 1000);

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            for (let [key, b] of botActivePositions) {
                try {
                    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of orders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch (err) {}
            }
            botActivePositions.clear();
            isProcessingDCA.clear();
        }
        if (!botSettings.isRunning) return setTimeout(priceMonitor, 1000);

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
                if (b.currentQty !== currentQty) { b.currentQty = currentQty; b.hitTime = null; }
                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);
                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;
                await new Promise(r => setTimeout(r, 1000));
                const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 10 });
                const closedById = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED' && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));
                let reasonOfClose = closedById ? (closedById.type === 'STOP_MARKET' ? "SL_MARKET" : "TP_MARKET") : "MANUAL";
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 45000));
                let totalR = 0, totalV = 0;
                if (recent.length > 0) {
                    recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); });
                }
                const netPnl = totalR - (totalV * 0.0005);
                botActivePositions.delete(key);
                status.botClosedCount++;
                status.botPnLClosed += netPnl;
                if (netPnl > 0 || b.isFinalLong) status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                addBotLog(`${netPnl > 0 ? "💰 [CHỐT LỜI]" : "📉 [CẮT LỖ]"} ${b.symbol} | PnL: ${netPnl.toFixed(4)}$`, netPnl > 0 ? "success" : "error");
                if (netPnl < 0 && b.side === 'SHORT' && (b.dcaCount + 1) <= botSettings.maxDCA) {
                    openPosition(b.symbol, { ...b, dcaCount: b.dcaCount + 1, margin: b.firstMargin * Math.pow(2, b.dcaCount + 1), totalLossAccumulated: (b.totalLossAccumulated || 0) + Math.abs(netPnl) });
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    finally { setTimeout(priceMonitor, 1000); }
}

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binancePrivate('/fapi/v2/account');
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        let qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qty.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === 'SHORT' && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', info, entry * 0.98, entry * 1.1);
                botActivePositions.set(`${symbol}_SHORT`, { symbol, side: 'SHORT', entryPrice: entry, tp: sync.tp, sl: sync.sl, dcaCount: dcaData ? dcaData.dcaCount : 0, currentQty: qty, firstMargin: dcaData ? dcaData.firstMargin : margin });
                addBotLog(`📡 [OPEN] ${symbol} | Short | Entry: ${entry}`);
            }
        }
    } catch (e) { addBotLog(e.message, "error"); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        await new Promise(r => setTimeout(r, 600));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.post('/api/panic-close-all', async (req, res) => {
    addBotLog("🚨 [PANIC] Đang đóng tất cả vị thế...", "error", true);
    for (let [key, b] of botActivePositions) {
        try { await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side }); } catch(e){}
    }
    botActivePositions.clear();
    res.json({ success: true });
});

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: acc });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body };
    saveSettings();
    addBotLog("⚙️ Cấu hình đã được lưu.");
    res.json({ success: true }); 
});

async function init() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const temp = {};
        info.data.symbols.forEach(s => {
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: 20 };
        });
        status.exchangeInfo = temp; status.isReady = true; priceMonitor();
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
        if (can) openPosition(can.symbol);
    }
}, 3000);

APP.listen(1111, () => console.log("⚡ Bot Server running at http://localhost:1111"));
