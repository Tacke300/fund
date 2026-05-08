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

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) { 
        throw new Error(error.response?.data?.msg || error.message); 
    }
}

// 1. DỌN LỆNH CHỜ (CỰC KỲ QUAN TRỌNG)
async function forceClearAllOrders(symbol) {
    try {
        addBotLog(`🧹 [${symbol}] Dọn dẹp lệnh chờ...`);
        // Xóa mọi lệnh đang treo (cả TP/SL cũ)
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        return true;
    } catch (e) { return false; }
}

// 2. ĐỒNG BỘ TP/SL - CHIẾN THUẬT "BACK TO BASIC" (FIX TRIỆT ĐỂ)
async function syncTPSL(symbol, side, entry, info) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    await forceClearAllOrders(symbol);
    await new Promise(r => setTimeout(r, 1000));

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realPos = posRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (!realPos) return { success: false };
        const qtyToClose = Math.abs(parseFloat(realPos.positionAmt)).toFixed(info.quantityPrecision);

        // Dùng API thường, truyền đúng Quantity và Side. Tuyệt đối KHÔNG dùng closePosition/reduceOnly.
        // Cách này ép Binance phải chấp nhận lệnh vì nó là một lệnh điều kiện cơ bản.
        
        // Đặt Take Profit
        await binancePrivate('/fapi/v1/order', 'POST', {
            symbol,
            side: sideClose,
            positionSide: side,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice,
            quantity: qtyToClose,
            workingType: 'MARK_PRICE'
        });

        await new Promise(r => setTimeout(r, 800));

        // Đặt Stop Loss
        await binancePrivate('/fapi/v1/order', 'POST', {
            symbol,
            side: sideClose,
            positionSide: side,
            type: 'STOP_MARKET',
            stopPrice: slPrice,
            quantity: qtyToClose,
            workingType: 'MARK_PRICE'
        });

        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        addBotLog(`❌ [${symbol}] LỖI ĐẶT TP/SL: ${e.message}`, "error");
        return { success: false };
    }
}

// 3. MỞ VỊ THẾ & DCA
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const hasPosOnExchange = posRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!isDCA && hasPosOnExchange) return;

        let cp = null;
        if (isDCA) {
            cp = botActivePositions.get(posKey);
            if (!cp || cp.isProcessing) return; 
            cp.isProcessing = true;
        } else {
            if (botActivePositions.has(posKey) || openingSymbols.has(symbol)) return;
            openingSymbols.add(symbol);
        }

        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = 0, currentDCA = 0, firstMargin = 0, originalEntry = 0;
        if (isDCA) {
            firstMargin = cp.firstMargin;
            originalEntry = cp.originalEntry || cp.entryPrice;
            marginToUse = firstMargin * 1.5; 
            currentDCA = cp.dcaCount + 1;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
            originalEntry = currentPrice;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`⏳ [${symbol}] Đang cập nhật vị thế...`);
            await new Promise(r => setTimeout(r, 6000)); 
            
            const posDataUpdate = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realPos = posDataUpdate.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realPos) {
                const finalEntry = parseFloat(realPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                
                addBotLog(`🚀 [${symbol}] ${isDCA ? 'DCA #' + currentDCA : 'OPEN'} OK | Entry: ${finalEntry} | TP: ${sync.tp || 'Err'}`);

                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, originalEntry, qty: Math.abs(parseFloat(realPos.positionAmt)), 
                    tp: sync.tp || 0, sl: sync.sl || 0, firstMargin, dcaCount: currentDCA, 
                    leverage: info.maxLeverage, isProcessing: false, pnl: 0, priceDev: 0
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] LỖI: ${e.message}`, "error");
        if(isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    } finally { openingSymbols.delete(symbol); }
}

// --- PHẦN CÒN LẠI GIỮ NGUYÊN ---
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.blackList[botPos.symbol] = now + (10 * 60 * 1000);
                trackClosedPnL(botPos.symbol, botPos);
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

async function trackClosedPnL(symbol, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
        const finalPnL = trades.filter(t => (Date.now() - t.time) < 60000).reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        status.botClosedCount++; 
        status.botPnLClosed += finalPnL;
        addBotLog(`✅ CHỐT ${symbol} | PnL: ${finalPnL.toFixed(2)}$`, "success");
    } catch (e) {}
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        Object.keys(status.blackList).forEach(s => { if(status.blackList[s] < Date.now()) delete status.blackList[s]; });
        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue; 
            if (botPos.priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) { 
                await openPosition(botPos.symbol, true); 
            }
        }
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = Math.abs(parseFloat(c.c1)) >= parseFloat(botSettings.minVol) || Math.abs(parseFloat(c.c5)) >= parseFloat(botSettings.minVol);
                return info && info.maxLeverage >= 20 && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && hasVol;
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v2/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY V22.0 - STABLE VERSION", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); 
setInterval(mainLoop, 3000);
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
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) } });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
