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
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 50000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: {}, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, publicIP: "Đang kiểm tra..." };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function syncTime() { 
    try { 
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); 
        timestampOffset = res.data.serverTime - Date.now(); 
    } catch (e) {} 
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 5000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) { throw new Error(error.response?.data?.msg || error.message); }
}

async function hardClearOrders(symbol) {
    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 3000));
        return true;
    } catch (e) { return true; }
}

async function syncTPSL(symbol, side, entry, info, customTP = null, customSL = null) {
    const isShort = (side === 'SHORT');
    const tp = Number((entry * (isShort ? (1 - (customTP || botSettings.posTP) / 100) : (1 + 10 / 100))).toFixed(info.pricePrecision));
    const sl = Number((entry * (isShort ? (1 + (customSL || botSettings.posSL) / 100) : (1 - 10 / 100))).toFixed(info.pricePrecision));
    const sideClose = isShort ? 'buy' : 'sell';

    try {
        await hardClearOrders(symbol);
        await new Promise(r => setTimeout(r, 3000));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: tp, closePosition: 'true' });
        await new Promise(r => setTimeout(r, 1000));
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: sl, closePosition: 'true' });
        
        addBotLog(`✨ [${symbol}] Cài TP/SL: ${tp} / ${sl}`, "success");
        return { tp, sl };
    } catch (e) { 
        addBotLog(`❌ Lỗi cài TP/SL ${symbol}: ${e.message}`, "error");
        return { tp, sl };
    }
}

async function openHedgeLong(symbol, firstMargin, info) {
    try {
        const price = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).then(res => parseFloat(res.data.price));
        const hedgeMargin = firstMargin * 50;
        const qty = Math.ceil((hedgeMargin * info.maxLeverage / price) / info.stepSize) * info.stepSize;
        
        await exchange.setLeverage(info.maxLeverage, symbol);
        await exchange.createOrder(symbol, 'market', 'buy', qty.toFixed(info.quantityPrecision), undefined, { positionSide: 'LONG' });
        
        addBotLog(`🛡️ [${symbol}] ĐÃ MỞ HEDGE LONG X50 ($${hedgeMargin.toFixed(2)})`, "warning");
        await new Promise(r => setTimeout(r, 3000));
        await syncTPSL(symbol, 'LONG', price, info, 10, 10);
    } catch (e) { addBotLog(`🚨 Lỗi Hedge ${symbol}: ${e.message}`); }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        const info = status.exchangeInfo[symbol];
        const price = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).then(res => parseFloat(res.data.price));
        let currentPos = botActivePositions.get(posKey);
        
        let margin = isDCA ? currentPos.firstMargin : (botSettings.invValue.includes('%') ? (await binancePrivate('/fapi/v2/account')).availableBalance * parseFloat(botSettings.invValue) / 100 : parseFloat(botSettings.invValue));

        let qty = Math.ceil(((margin * info.maxLeverage) / price) / info.stepSize) * info.stepSize;
        if ((qty * price) < 6.5) qty = (6.5 / price);

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qty.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`🚀 [${symbol}] ${isDCA ? `DCA lần ${currentPos.dcaCount + 1}` : 'Mở SHORT'}`);
            await new Promise(r => setTimeout(r, 3000));
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            
            if (upPos && Math.abs(parseFloat(upPos.positionAmt)) > 0) {
                const entry = parseFloat(upPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', entry, info);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: entry, qty: Math.abs(parseFloat(upPos.positionAmt)), 
                    tp: sync.tp, sl: sync.sl, firstMargin: isDCA ? currentPos.firstMargin : margin, 
                    dcaCount: isDCA ? currentPos.dcaCount + 1 : 0, isProcessing: false, hedgeOpened: isDCA ? currentPos.hedgeOpened : false 
                });
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi: ${e.message}`); }
    finally { openingSymbols.delete(symbol); }
}

async function priceMonitorLoop() {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.blackList[botPos.symbol] = Date.now() + 600000;
                botActivePositions.delete(key);
                addBotLog(`✅ [${botPos.symbol}] Vị thế đã đóng.`, "success");
                continue;
            }
            botPos.markPrice = parseFloat(realPos.markPrice);
            botPos.pnl = parseFloat(realPos.unRealizedProfit);

            const hitTP = botPos.side === 'SHORT' ? (botPos.markPrice <= botPos.tp) : (botPos.markPrice >= botPos.tp);
            const hitSL = botPos.side === 'SHORT' ? (botPos.markPrice >= botPos.sl) : (botPos.markPrice <= botPos.sl);
            
            if ((hitTP || hitSL) && botPos.tp > 0) {
                addBotLog(`🚨 [${botPos.symbol}] Chốt Market khẩn cấp (Chạm TP/SL)...`);
                await exchange.createOrder(botPos.symbol, 'market', botPos.side === 'SHORT' ? 'buy' : 'sell', Math.abs(parseFloat(realPos.positionAmt)), undefined, { positionSide: botPos.side });
                await hardClearOrders(botPos.symbol);
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1500);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    for (let [key, botPos] of botActivePositions) {
        if (botPos.isProcessing) continue;
        const dev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
        
        if (dev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
        else if (dev >= (botSettings.dcaStep * 1.5) && botPos.dcaCount >= botSettings.maxDCA && !botPos.hedgeOpened) {
            botPos.hedgeOpened = true; 
            await openHedgeLong(botPos.symbol, botPos.firstMargin, status.exchangeInfo[botPos.symbol]);
        }
    }
    if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
        const keo = status.candidatesList.find(c => {
            const info = status.exchangeInfo[c.symbol];
            return info && (status.blackList[c.symbol] || 0) < Date.now() && !botActivePositions.has(`${c.symbol}_SHORT`) && [c.c1, c.c5].some(v => Math.abs(v) >= botSettings.minVol);
        });
        if (keo) await openPosition(keo.symbol, false);
    }
}

async function init() {
    await syncTime();
    try {
        const [infoRes, brkRes] = await Promise.all([binanceApi.get('/fapi/v1/exchangeInfo'), binancePrivate('/fapi/v1/leverageBracket')]);
        infoRes.data.symbols.forEach(s => {
            const brk = brkRes.find(b => b.symbol === s.symbol);
            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.isReady = true; 
        addBotLog("👿 LUFFY BOT ONLINE", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

// CẤU HÌNH SERVER EXPRESS
const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname)); // Phục vụ các file tĩnh như index.html, css, js

// Route chính để trả về giao diện
APP.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

APP.get('/api/status', (req, res) => {
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status });
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ success: true });
});

// Chạy bot
init(); 
setInterval(mainLoop, 4000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 3000);

APP.listen(9001, () => {
    console.log("✅ Server đang chạy tại http://localhost:9001");
});
