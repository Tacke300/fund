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

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1$", minVol: 6.5, posTP: 0.5, posSL: 1.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
    return response.data;
}

async function syncTPSL(symbol, side, entry, info, qty, tpP, slP) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - tpP / 100) : (1 + tpP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slP / 100) : (1 - slP / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    try {
        // Hủy lệnh cũ
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        // Đặt lệnh mới
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, Math.abs(qty).toFixed(info.quantityPrecision), undefined, { positionSide: side, stopPrice: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, Math.abs(qty).toFixed(info.quantityPrecision), undefined, { positionSide: side, stopPrice: slPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

async function openPosition(symbol, dcaIteration = 0, isReverse = false, baseMargin = 1) {
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const candle = status.candidatesList.find(c => c.symbol === symbol) || { c1: 0, c5: 0, c15: 0 };
        
        let marginToUse = isReverse ? baseMargin * 50 : baseMargin * (dcaIteration === 0 ? 1 : (dcaIteration + 1) * 1.1);
        let side = isReverse ? 'LONG' : 'SHORT';
        let label = isReverse ? "REVERSE" : (dcaIteration === 0 ? "ENTRY" : `DCA ${dcaIteration}`);

        let qtyNum = (marginToUse * 20) / parseFloat(ticker.data.price);
        qtyNum = Math.ceil(qtyNum / info.stepSize) * info.stepSize;

        await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        await new Promise(r => setTimeout(r, 1500));
        const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (realP) {
            const entry = parseFloat(realP.entryPrice);
            const sync = await syncTPSL(symbol, side, entry, info, Math.abs(realP.positionAmt), botSettings.posTP, botSettings.posSL);
            addBotLog(`✅ [${label}] ${symbol} | Entry: ${entry} | Var: ${candle.c1}/${candle.c5}%`, "success");
            botActivePositions.set(`${symbol}_${side}`, { 
                symbol, side, entryPrice: entry, leverage: 20, tp: sync.tp,
                qty: Math.abs(realP.positionAmt), dcaCount: dcaIteration, isReverse, firstMargin: baseMargin 
            });
        }
    } catch (e) { addBotLog(`🚨 Lỗi Mở: ${e.message}`); }
    finally { openingSymbols.delete(symbol); }
}

async function monitorLoop() {
    if (!status.isReady) return setTimeout(monitorLoop, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeKeys = new Set(posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => `${p.symbol}_${p.positionSide}`));

        for (let [key, botPos] of botActivePositions) {
            const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
            if (!activeKeys.has(key)) {
                botActivePositions.delete(key);
                const hitSL = botPos.side === 'SHORT' ? parseFloat(p.markPrice) > botPos.entryPrice : parseFloat(p.markPrice) < botPos.entryPrice;
                if (hitSL && !botPos.isReverse) {
                    if (botPos.dcaCount + 1 < botSettings.maxDCA) await openPosition(botPos.symbol, botPos.dcaCount + 1, false, botPos.firstMargin);
                    else await openPosition(botPos.symbol, 0, true, botPos.firstMargin);
                } else {
                    status.blackList[botPos.symbol] = Date.now() + 900000;
                    status.botClosedCount++;
                }
            } else {
                botPos.pnl = parseFloat(p.unRealizedProfit);
                botPos.priceDev = ((parseFloat(p.markPrice) - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(monitorLoop, 1000);
}

// Logic Scanner
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        status.exchangeInfo = Object.fromEntries(infoRes.data.symbols.map(s => [s.symbol, { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize) }]));
        status.isReady = true; monitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account');
    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: { ...status, blackList: Object.fromEntries(Object.entries(status.blackList).map(([s, t]) => [s, Math.max(0, Math.floor((t - Date.now())/1000))])) },
        wallet: { 
            totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2),
            availableBalance: parseFloat(acc.availableBalance).toFixed(2),
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2)
        }
    });
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001); init();

setInterval(() => {
    if (status.isReady && botSettings.isRunning && botActivePositions.size < botSettings.maxPositions) {
        const entry = status.candidatesList.find(c => Math.abs(c.c1) >= botSettings.minVol && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
        if (entry) openPosition(entry.symbol, 0, false, parseFloat(botSettings.invValue.replace('$','')));
    }
}, 4000);
