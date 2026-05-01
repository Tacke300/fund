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
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 20000, headers: { 'X-MBX-APIKEY': API_KEY } });

// CCXT chỉ dùng cho các thao tác bổ trợ và lệnh Market ban đầu
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

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function syncTime() { try { const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); timestampOffset = res.data.serverTime - Date.now(); } catch (e) {} }

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) await syncTime();
        throw new Error(error.response?.data?.msg || error.message);
    }
}

/**
 * PROTOCOL 1: WAIT POSITION STABLE
 */
async function waitPositionStable(symbol, side) {
    let lastSize = 0, stableCount = 0;
    for (let i = 0; i < 15; i++) {
        try {
            const pos = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pos.find(x => x.positionSide === side);
            const size = p ? Math.abs(parseFloat(p.positionAmt)) : 0;
            if (size > 0 && size === lastSize) stableCount++;
            else stableCount = 0;
            if (stableCount >= 2) return size;
            lastSize = size;
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
    }
    return lastSize;
}

/**
 * PROTOCOL 2: RAW API TPSL (LOẠI BỎ CCXT - FIX TRIỆT ĐỂ -1106 & -4130)
 */
async function syncTPSL(symbol, side, entry, info, actualQty) {
    const isShort = (side === 'SHORT');
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    const qtyStr = parseFloat(actualQty).toFixed(info.quantityPrecision);

    for (let i = 0; i < 3; i++) {
        try {
            // Bước 1: Xóa toàn bộ lệnh chờ cũ của Symbol
            await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
            await new Promise(r => setTimeout(r, 2000));

            // Bước 2: Đặt TP LIMIT + reduceOnly (Raw API)
            await binancePrivate('/fapi/v1/order', 'POST', {
                symbol, side: sideClose, type: 'LIMIT', quantity: qtyStr, price: tpPrice,
                timeInForce: 'GTC', reduceOnly: 'true', positionSide: side
            });
            
            await new Promise(r => setTimeout(r, 1000));

            // Bước 3: Đặt SL STOP_MARKET + closePosition (Raw API)
            await binancePrivate('/fapi/v1/order', 'POST', {
                symbol, side: sideClose, type: 'STOP_MARKET', stopPrice: slPrice,
                closePosition: 'true', positionSide: side, workingType: 'MARK_PRICE'
            });

            addBotLog(`✨ [${symbol}] RAW-SYNC: TP Limit ${tpPrice} | SL Market ${slPrice}`, "success");
            return { tp: Number(tpPrice), sl: Number(slPrice) };
        } catch (e) {
            addBotLog(`⚠️ [${symbol}] Lỗi đặt TPSL lần ${i+1}: ${e.message}`, "warning");
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    throw new Error("CRITICAL_TPSL_ERROR");
}

/**
 * PROTOCOL 3: MỞ LỆNH VÀ DCA
 */
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        const info = status.exchangeInfo[symbol];
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(priceRes.data.price);
        
        let currentPos = botActivePositions.get(posKey);
        if (isDCA && currentPos) currentPos.isProcessing = true; 

        let marginToUse = isDCA ? currentPos.firstMargin * 1.03 : (botSettings.invValue.toString().includes('%') ? (parseFloat((await binancePrivate('/fapi/v2/account')).availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) : parseFloat(botSettings.invValue));
        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            const stableQty = await waitPositionStable(symbol, 'SHORT');
            await new Promise(r => setTimeout(r, 2000)); 
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            
            if (upPos && stableQty > 0) {
                const finalEntry = parseFloat(upPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, stableQty);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, qty: stableQty, tp: sync.tp, sl: sync.sl, 
                    firstMargin: isDCA ? currentPos.firstMargin : marginToUse, 
                    dcaCount: isDCA ? currentPos.dcaCount + 1 : 0, 
                    isProcessing: false
                });
            }
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] Order Fail: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
}

/**
 * MONITOR & UI STATUS (FIX SỐ DƯ TỔNG CHUẨN APP)
 */
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        
        // totalMarginBalance = Ví + PnL chưa ghi nhận (Con số khớp 100% app)
        const totalEquity = parseFloat(acc.totalMarginBalance).toFixed(2);
        const walletBalance = parseFloat(acc.totalWalletBalance).toFixed(2);
        const unrealizedPnL = parseFloat(acc.totalUnrealizedProfit).toFixed(2);
        const available = parseFloat(acc.availableBalance).toFixed(2);

        const bl = {}; 
        Object.entries(status.blackList).forEach(([s, t]) => { if(t > Date.now()) bl[s] = Math.ceil((t-Date.now())/1000); });

        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status: { ...status, blackList: bl }, 
            wallet: { 
                totalWalletBalance: walletBalance,
                totalUnrealizedProfit: unrealizedPnL,
                equity: totalEquity, // <--- SỐ DƯ TỔNG TRÊN DASHBOARD
                availableBalance: available
            } 
        });
    } catch (e) { res.json({ status }); }
});

// ... (Các phần monitor giá, track PnL chốt, init giữ nguyên như cũ) ...

async function trackClosedPnL(symbol, closedTime, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
        const relevantTrades = trades.filter(t => Math.abs(t.time - closedTime) < 40000 && t.positionSide === lastBotPos.side);
        const rawPnL = relevantTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        const fee = (lastBotPos.qty * lastBotPos.entryPrice) * 0.0008; 
        status.botClosedCount++; status.botPnLClosed += (rawPnL - fee);
        addBotLog(`✅ CHỐT ${symbol} | Net: ${(rawPnL - fee).toFixed(2)}$`, "success");
    } catch (e) {}
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.blackList[botPos.symbol] = now + (10 * 60 * 1000);
                trackClosedPnL(botPos.symbol, now, botPos);
                botActivePositions.delete(key);
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice); 
                botPos.pnl = parseFloat(realPos.unRealizedProfit);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeShorts = posRisk.filter(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue;
            const realPos = activeShorts.find(p => p.symbol === botPos.symbol);
            if (realPos) {
                const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
                if (priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
            }
        }
        if (activeShorts.length < botSettings.maxPositions && openingSymbols.size === 0) {
            const candidate = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = Math.abs(parseFloat(c.c1)) >= botSettings.minVol || Math.abs(parseFloat(c.c5)) >= botSettings.minVol;
                return info && info.maxLeverage >= 20 && (status.blackList[c.symbol] || 0) < Date.now() && !activeShorts.some(p => p.symbol === c.symbol) && hasVol;
            });
            if (candidate) await openPosition(candidate.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    try {
        await syncTime(); await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY FINAL-CORE ONLINE", "success"); priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); setInterval(mainLoop, 3000);
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);
