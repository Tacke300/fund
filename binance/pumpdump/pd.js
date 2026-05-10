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

async function clearOrders(symbol, mode = 1) {
    try {
        if (mode === 1) {
            await exchange.cancelAllOrders(symbol, { positionSide: 'SHORT' });
            addBotLog(`🗑️ [${symbol}] Mode 1: CCXT Cancel All`);
        } else if (mode === 2) {
            const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
            const shorts = orders.filter(o => o.positionSide === 'SHORT');
            for (const o of shorts) {
                await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
            }
            addBotLog(`🗑️ [${symbol}] Mode 2: Native API Delete x${shorts.length}`);
        } else {
            const openOrders = await exchange.fetchOpenOrders(symbol);
            for (const o of openOrders) {
                if (o.info.positionSide === 'SHORT') await exchange.cancelOrder(o.id, symbol);
            }
            addBotLog(`🗑️ [${symbol}] Mode 3: CCXT Fetch & Manual Cancel`);
        }
    } catch (e) { addBotLog(`🚨 Lỗi xóa lệnh: ${e.message}`, "error"); }
}

async function syncTPSL(symbol, side, entry, info, customTP = null, customSL = null) {
    const isShort = side === 'SHORT';
    const tpP = customTP || botSettings.posTP;
    const slP = customSL || botSettings.posSL;
    
    const tpPrice = (entry * (isShort ? (1 - tpP / 100) : (1 + tpP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slP / 100) : (1 - slP / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    try {
        const orderTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
            positionSide: side, 
            stopPrice: tpPrice, 
            workingType: 'MARK_PRICE',
            reduceOnly: false,
            closePosition: true
        });
        const orderSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
            positionSide: side, 
            stopPrice: slPrice, 
            workingType: 'MARK_PRICE',
            reduceOnly: false,
            closePosition: true
        });

        addBotLog(`🎯 [${symbol}] TPSL: TP ${tpPrice} (${tpP}%) | SL ${slPrice}`, "success");
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        if (e.message.includes('reduceonly')) {
            try {
                const orderTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
                    positionSide: side, stopPrice: tpPrice, workingType: 'MARK_PRICE'
                });
                const orderSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
                    positionSide: side, stopPrice: slPrice, workingType: 'MARK_PRICE'
                });
                addBotLog(`🎯 [${symbol}] TPSL (Fallback): TP ${tpPrice} | SL ${slPrice}`, "success");
                return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
            } catch (e2) {
                addBotLog(`❌ [${symbol}] Lỗi TPSL: ${e2.message}`, "error");
            }
        }
        addBotLog(`❌ [${symbol}] Lỗi TPSL: ${e.message}`, "error");
        return { tp: 0, sl: 0 };
    }
}

async function openPosition(symbol, isDCA = false, manualData = null) {
    const posKey = `${symbol}_SHORT`;
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        if (!manualData && info.maxLeverage < 20) {
            addBotLog(`🚫 [${symbol}] Bỏ qua: Max Lev ${info.maxLeverage} < 20`, "warning");
            return;
        }

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
                marginToUse = botSettings.invValue.toString().includes('%') 
                    ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                    : parseFloat(botSettings.invValue);
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
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, manualData?.tp, manualData?.sl);
                
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, 
                    qty: Math.abs(parseFloat(realP.positionAmt)), 
                    tp: sync.tp, sl: sync.sl, 
                    margin: (Math.abs(parseFloat(realP.positionAmt)) * finalEntry) / info.maxLeverage,
                    leverage: info.maxLeverage,
                    firstMargin: isDCA ? cp.firstMargin : marginToUse,
                    dcaCount: isDCA ? cp.dcaCount + 1 : 0, 
                    isProcessing: false, pnl: 0, markPrice: currentPrice,
                    tpslStep: 10 
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi Mở: ${e.message}`, "error");
        if (isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    } finally {
        openingSymbols.delete(symbol);
    }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const exchangeKeys = new Set();
        posRisk.forEach(p => { if (Math.abs(parseFloat(p.positionAmt)) > 0) exchangeKeys.add(`${p.symbol}_${p.positionSide}`); });

        for (let [key, botPos] of botActivePositions) {
            if (!exchangeKeys.has(key)) {
                addBotLog(`📉 [${botPos.symbol}] Vị thế đã đóng. Blacklist 15p.`);
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
    } catch (e) { }
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        for (let [key, botPos] of botActivePositions) {
            if (!botPos.isProcessing && botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) {
                await openPosition(botPos.symbol, true);
            }
        }
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const entry = status.candidatesList.find(c => {
                const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol || Math.abs(parseFloat(c.c5)) >= botSettings.minVol;
                return volOK && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`);
            });
            if (entry) await openPosition(entry.symbol, false);
        }
    } catch (e) { }
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
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY V21.4 - FULL CODE READY", "success");
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
        Object.keys(status.blackList).forEach(s => { 
            const rem = Math.floor((status.blackList[s] - now) / 1000); 
            if (rem > 0) blSecs[s] = rem; else delete status.blackList[s]; 
        });
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status: { ...status, blackList: blSecs }, 
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2),
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2)
            }
        });
    } catch (e) { res.json({ status }); }
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

APP.post('/api/test', async (req, res) => {
    const { action, symbol, mode } = req.body;
    const posKey = `${symbol}_SHORT`;
    const pos = botActivePositions.get(posKey);
    const info = status.exchangeInfo[symbol];

    try {
        if (action === 'open') await openPosition(symbol, false, { margin: 0.5, tp: 10, sl: 50 });
        
        if (action === 'close' && pos) {
            await exchange.createOrder(symbol, 'MARKET', 'BUY', pos.qty.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
        }

        if (action === 'clear') {
            await clearOrders(symbol, mode);
        }

        if (action === 'set_only' && pos) {
            await syncTPSL(symbol, 'SHORT', pos.entryPrice, info);
        }

        if (action === 'reset_cycle' && pos) {
            await clearOrders(symbol, 2);
            await new Promise(r => setTimeout(r, 1000));
            pos.tpslStep = (pos.tpslStep === 10) ? 15 : 10;
            const newSync = await syncTPSL(symbol, 'SHORT', pos.entryPrice, info, pos.tpslStep, botSettings.posSL);
            pos.tp = newSync.tp; pos.sl = newSync.sl;
            addBotLog(`🔄 [${symbol}] Reset TP mới: ${pos.tpslStep}%`);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
