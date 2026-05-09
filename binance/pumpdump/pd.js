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

async function clearOrders(symbol) {
    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 800));
    } catch (e) {}
}

async function syncTPSL(symbol, side, entry, info, qty, tpP, slP) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - tpP / 100) : (1 + tpP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slP / 100) : (1 - slP / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    try {
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, Math.abs(qty).toFixed(info.quantityPrecision), undefined, { positionSide: side, stopPrice: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, Math.abs(qty).toFixed(info.quantityPrecision), undefined, { positionSide: side, stopPrice: slPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

async function openPosition(symbol, dcaIteration = 0, isReverse = false, baseMargin = 1) {
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        // Lấy thông tin nến tại thời điểm mở lệnh
        const candle = status.candidatesList.find(c => c.symbol === symbol) || { c1: '?', c5: '?', c15: '?' };
        
        let marginToUse = 0;
        let side = 'SHORT';
        let label = dcaIteration === 0 ? "ENTRY MỚI" : `DCA LẦN ${dcaIteration}`;

        if (isReverse) {
            marginToUse = baseMargin * 50;
            side = 'LONG';
            label = "REVERSE X50";
        } else {
            const factor = dcaIteration === 0 ? 1 : (dcaIteration + 1) * 1.1;
            marginToUse = baseMargin * factor;
        }

        let qtyNum = (marginToUse * info.maxLeverage) / currentPrice;
        qtyNum = Math.ceil(qtyNum / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        await new Promise(r => setTimeout(r, 1200));
        const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (realP) {
            const finalEntry = parseFloat(realP.entryPrice);
            const currentQty = Math.abs(parseFloat(realP.positionAmt));
            const tpVal = isReverse ? 10.0 : botSettings.posTP;
            const slVal = isReverse ? 10.0 : botSettings.posSL;

            const sync = await syncTPSL(symbol, side, finalEntry, info, currentQty, tpVal, slVal);
            
            // LOG CHI TIẾT
            addBotLog(`✅ [${label}] ${symbol} | Margin: ${marginToUse.toFixed(2)}$ | Lev: x${info.maxLeverage} | Entry: ${finalEntry} | TP: ${sync.tp} | SL: ${sync.sl} | Biến động: [1m:${candle.c1}% | 5m:${candle.c5}% | 15m:${candle.c15}%]`, "success");

            botActivePositions.set(`${symbol}_${side}`, {
                symbol, side, entryPrice: finalEntry, qty: currentQty, leverage: info.maxLeverage,
                tp: sync.tp, sl: sync.sl, margin: marginToUse, firstMargin: baseMargin, 
                dcaCount: dcaIteration, isReverse, pnl: 0, priceDev: 0
            });
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] Lỗi Open: ${e.message}`, "error");
    } finally { openingSymbols.delete(symbol); }
}

async function monitorLoop() {
    if (!status.isReady) return setTimeout(monitorLoop, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeKeys = new Set(posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => `${p.symbol}_${p.positionSide}`));

        for (let [key, botPos] of botActivePositions) {
            if (!activeKeys.has(key)) {
                // Vị thế đã đóng
                await clearOrders(botPos.symbol);
                botActivePositions.delete(key);

                // Kiểm tra xem là TP hay SL
                const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${botPos.symbol}`);
                const currentPrice = parseFloat(ticker.data.price);
                const hitSL = botPos.side === 'SHORT' ? currentPrice > botPos.entryPrice : currentPrice < botPos.entryPrice;

                if (hitSL && !botPos.isReverse) {
                    addBotLog(`⚠️ [${botPos.symbol}] Chạm SL. Kích hoạt DCA tiếp theo...`, "warning");
                    if (botPos.dcaCount + 1 < botSettings.maxDCA) {
                        await openPosition(botPos.symbol, botPos.dcaCount + 1, false, botPos.firstMargin);
                    } else {
                        await openPosition(botPos.symbol, 0, true, botPos.firstMargin);
                    }
                } else {
                    // Đóng do TP hoặc Reverse xong hoặc đóng thủ công -> Blacklist
                    addBotLog(`💰 [${botPos.symbol}] Đã chốt lãi/Kết thúc chu kỳ. Đưa vào Blacklist.`, "success");
                    status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                    status.botClosedCount++;
                }
            } else {
                const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
                botPos.pnl = parseFloat(p.unRealizedProfit);
                botPos.priceDev = ((parseFloat(p.markPrice) - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(monitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
        const entry = status.candidatesList.find(c => {
            return Math.abs(parseFloat(c.c1)) >= botSettings.minVol && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`);
        });
        if (entry) {
            const baseMargin = parseFloat(botSettings.invValue.replace('$', '')) || 1;
            await openPosition(entry.symbol, 0, false, baseMargin);
        }
    }
}

// Khởi tạo (CCXT & Binance Info)
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
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👹 LUFFY V7 - FULL LOGS & SMART BLACKLIST ONLINE", "success");
        monitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); setInterval(mainLoop, 4000);
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
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status: { ...status, blackList: blSecs }, wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2) } });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.post('/api/test', async (req, res) => {
    const { action, symbol } = req.body;
    try {
        if (action === 'open') await openPosition(symbol, 0, false, parseFloat(botSettings.invValue.replace('$','')));
        if (action === 'close') await clearOrders(symbol); 
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
