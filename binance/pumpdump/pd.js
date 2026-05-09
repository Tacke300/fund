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

const BLACKLIST_DURATION = 15 * 60 * 1000;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
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

// Dọn lệnh chờ trước khi mở/đóng để tránh rác
async function clearOrders(symbol) {
    if (clearingSymbols.has(symbol)) return;
    clearingSymbols.add(symbol);
    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 1200));
    } catch (e) {
        addBotLog(`⚠️ [${symbol}] Lỗi dọn lệnh: ${e.message}`, "warning");
    } finally {
        clearingSymbols.delete(symbol);
    }
}

// CÁCH ĐẶT TP/SL + GIÁ TRỊ GỐC 100% (FIX LỖI -1106)
async function syncTPSL(symbol, side, entry, info, qty, customTP = null, customSL = null) {
    const isShort = side === 'SHORT';
    const tpP = customTP || botSettings.posTP;
    const slP = customSL || botSettings.posSL;
    const tpPrice = (entry * (isShort ? (1 - tpP / 100) : (1 + tpP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slP / 100) : (1 - slP / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    const finalQty = Math.abs(qty).toFixed(info.quantityPrecision);

    try {
        // Gửi lệnh TP (Bỏ reduceOnly để fix -1106)
        const orderTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, finalQty, undefined, {
            positionSide: side, stopPrice: tpPrice, workingType: 'MARK_PRICE'
        });
        // Gửi lệnh SL
        const orderSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, {
            positionSide: side, stopPrice: slPrice, workingType: 'MARK_PRICE'
        });

        addBotLog(`🎯 [${symbol}] Đã set: TP ${tpPrice} | SL ${slPrice}`, "success");
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi đặt TPSL: ${e.message}`, "error");
        return { tp: 0, sl: 0, success: false };
    }
}

async function openPosition(symbol, isDCA = false, manualData = null) {
    if (openingSymbols.has(symbol) || clearingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        
        // CHẶN COIN MAX LEV < 20
        if (!info || info.maxLeverage < 20) {
            addBotLog(`🚫 [${symbol}] Bỏ qua vì Max Leverage (${info?.maxLeverage}) < 20`, "warning");
            status.blackList[symbol] = Date.now() + (BLACKLIST_DURATION * 2);
            return;
        }

        await clearOrders(symbol);

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        const candle = status.candidatesList.find(c => c.symbol === symbol) || { c1:0, c5:0, c15:0 };
        
        let cp = botActivePositions.get(`${symbol}_SHORT`);
        let marginToUse = manualData ? manualData.margin : 0;

        if (!manualData) {
            if (isDCA) {
                if (!cp || cp.isProcessing) return;
                cp.isProcessing = true;
                marginToUse = cp.firstMargin;
            } else {
                const acc = await binancePrivate('/fapi/v2/account');
                marginToUse = botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) : parseFloat(botSettings.invValue);
            }
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 5.5) qtyNum = Math.ceil(6.0 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        
        // LOG CHI TIẾT VÀO LỆNH/DCA
        const modeText = isDCA ? `[DCA #${cp.dcaCount + 1}]` : `[VÀO LỆNH]`;
        addBotLog(`${modeText} ${symbol} | Giá: ${currentPrice} | Margin: ${marginToUse.toFixed(2)}$ | Vol: [1M:${candle.c1}% 5M:${candle.c5}%]`, "info");

        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const finalEntry = parseFloat(realP.entryPrice);
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, currentQty, manualData?.tp, manualData?.sl);
                
                botActivePositions.set(`${symbol}_SHORT`, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, qty: currentQty, 
                    tp: sync.tp, sl: sync.sl, margin: (currentQty * finalEntry) / info.maxLeverage,
                    leverage: info.maxLeverage, firstMargin: isDCA ? cp.firstMargin : marginToUse,
                    dcaCount: isDCA ? cp.dcaCount + 1 : 0, isProcessing: false, pnl: 0, 
                    markPrice: currentPrice, tpslOk: sync.success, totalVol: currentQty * finalEntry
                });
            }
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] Lỗi: ${e.message}`, "error"); }
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
                // LOG CHI TIẾT KHI CHỐT LỆNH
                const type = botPos.pnl >= 0 ? "SUCCESS" : "ERROR";
                addBotLog(`💰 [CHỐT CỤC] ${botPos.symbol} | PnL: ${botPos.pnl.toFixed(2)}$ | Entry: ${botPos.entryPrice} | DCA: ${botPos.dcaCount}`, type);
                
                await clearOrders(botPos.symbol); 
                status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                botActivePositions.delete(key);
                status.botClosedCount++;
                status.botPnLClosed += botPos.pnl;
            } else {
                const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
                botPos.markPrice = parseFloat(p.markPrice);
                botPos.pnl = parseFloat(p.unRealizedProfit); // Giữ nguyên PnL gốc
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
                const info = status.exchangeInfo[c.symbol];
                return volOK && info && info.maxLeverage >= 20 && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`);
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
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👹 LUFFY V5 ONLINE - FULL LOG & FIXED -1106", "success");
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
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
