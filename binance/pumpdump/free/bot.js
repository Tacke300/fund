import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MAX_DCA_LEVEL = 2;
const MARGIN_PROTECT_LIMIT = 60;
const MARGIN_RECOVER_LIMIT = 70;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
});

let botSettings = { isRunning: false, capital: "1%", volVolatility: 6.5, maxPos: 3, maxDca: MAX_DCA_LEVEL, tp: 1.2, sl: 10.0, longTp: 1.2, longSl: 10.0 };
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 
let currentBotIP = null; 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
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
        if (now > status.blackList[symbol]) delete status.blackList[symbol];
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
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 45000));
                try {
                    const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of openOrders.filter(o => o.positionSide === b.side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                } catch(e){}
                let totalR = 0, totalV = 0;
                if (recent.length > 0) {
                    recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); });
                }
                const netPnl = totalR - (totalV * 0.0005);
                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += netPnl;
                if (netPnl > 0 || b.isFinalLong) status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                if (netPnl < 0 && b.side === 'SHORT') {
                    const jump = b.dcaCount + 1;
                    if (jump <= botSettings.maxDca) {
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * Math.pow(2, jump), totalLossAccumulated: (b.totalLossAccumulated || 0) + Math.abs(netPnl) });
                    } else {
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 10 });
                    }
                }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitor, 1000);
}

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol); 
    const isDCAorLong = dcaData !== null;
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    try {
        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 1000));
        const acc = await binancePrivate('/fapi/v2/account');
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let qty = 0, margin = 0;
        if (isDCAorLong) {
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            margin = botSettings.capital.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.capital) / 100) : parseFloat(botSettings.capital);
            qty = Math.ceil(Math.max((margin * info.maxLeverage) / currentPrice, 5.05 / currentPrice) / info.stepSize) * info.stepSize;
        }
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) {
                const entry = parseFloat(p.entryPrice);
                let tp = 0, sl = 0;
                if (side === 'LONG') { tp = entry * (1 + botSettings.longTp/100); sl = entry * (1 - botSettings.longSl/100); }
                else {
                    const totalTargetGrossProfit = (dcaData?.totalLossAccumulated || 0) + ((dcaData?.dcaCount + 1 || 1) * (qty * entry * (botSettings.tp / 100)));
                    tp = entry - (totalTargetGrossProfit / qty);
                    sl = entry * (1 + (botSettings.sl * (dcaData?.dcaCount + 1 || 1)) / 100);
                }
                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, { symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, dcaCount: dcaData?.dcaCount || 0, leverage: info.maxLeverage, firstMargin: dcaData?.firstMargin || (qty * currentPrice) / info.maxLeverage, currentQty: qty, dcaHistory: dcaData?.dcaHistory || [entry], isFinalLong: dcaData?.isFinalLong || false, pnl: 0, priceDev: 0, firstQty: dcaData?.firstQty || qty, totalLossAccumulated: dcaData?.totalLossAccumulated || 0 });
            }
        }
    } catch (e) {} finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
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

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status: { ...status }, wallet: acc ? { totalWalletBalance: parseFloat(acc.totalMarginBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) } : { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" } });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

APP.post('/api/panic-close-all', async (req, res) => {
    try {
        for (let [key, b] of botActivePositions) await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        botActivePositions.clear();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

async function init() {
    try {
        const ipRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 8000 }).catch(() => ({ data: { ip: "127.0.0.1" } }));
        currentBotIP = ipRes.data.ip;
        addBotLog(`🌍 IP START: ${currentBotIP}`);
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) return;
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp; status.isReady = true; priceMonitor();
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning || isMarginProtected) return;
    if (botActivePositions.size < botSettings.maxPos && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => (Math.abs(c.c1) >= botSettings.volVolatility || Math.abs(c.c5) >= botSettings.volVolatility) && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && !botActivePositions.has(`${c.symbol}_LONG`));
        if (can) openPosition(can.symbol);
    }
}, 3000);

APP.listen(1112);
