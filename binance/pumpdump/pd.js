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

function addBotLog(msg) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg });
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
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: slPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: false };
    }
}

async function openPosition(symbol, dcaIteration = 0, isReverse = false, baseMargin = 1) {
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        
        // 1. ĐẶT ĐÒN BẨY TỐI ĐA TRƯỚC KHI VÀO LỆNH (Ví dụ x125 hoặc x75 tùy coin)
        let targetLev = 50; // Bạn có thể sửa số này thành đòn bẩy mong muốn
        try { await exchange.setLeverage(targetLev, symbol); } catch(e) {}

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = isReverse ? baseMargin * 50 : baseMargin * (dcaIteration === 0 ? 1 : (dcaIteration + 1) * 1.1);
        let side = isReverse ? 'LONG' : 'SHORT';

        // 2. TÍNH QTY DỰA TRÊN ĐÒN BẨY THỰC TẾ
        let qtyNum = (marginToUse * targetLev) / currentPrice;
        qtyNum = Math.floor(qtyNum / info.stepSize) * info.stepSize;

        await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        await new Promise(r => setTimeout(r, 2000));

        const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (realP) {
            const entry = parseFloat(realP.entryPrice);
            const actualLev = parseInt(realP.leverage); // LẤY LEVERAGE THẬT TỪ SÀN
            const sync = await syncTPSL(symbol, side, entry, info, Math.abs(realP.positionAmt), botSettings.posTP, botSettings.posSL);
            
            botActivePositions.set(`${symbol}_${side}`, { 
                symbol, side, entryPrice: entry, 
                leverage: actualLev, // GỬI LEVERAGE THẬT XUỐNG HTML
                tp: sync.tp, sl: sync.sl, qty: Math.abs(realP.positionAmt), 
                dcaCount: dcaIteration, isReverse, firstMargin: baseMargin,
                tpslOk: sync.success
            });
            addBotLog(`✅ ${symbol} x${actualLev} Entry: ${entry}`);
        }
    } catch (e) { addBotLog(`🚨 Lỗi Open ${symbol}: ${e.message}`); }
    finally { openingSymbols.delete(symbol); }
}

async function monitorLoop() {
    if (!status.isReady) return setTimeout(monitorLoop, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeOnExchange = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        for (let [key, botPos] of botActivePositions) {
            const p = activeOnExchange.find(x => `${x.symbol}_${x.positionSide}` === key);
            
            if (!p) {
                botActivePositions.delete(key);
                continue;
            }

            // Cập nhật lại Leverage nếu bạn lỡ tay chỉnh trên App khi đang treo bot
            botPos.leverage = p.leverage;

            // Kiểm tra và đặt lại TP/SL nếu thiếu
            if (!botPos.tpslOk) {
                const info = status.exchangeInfo[botPos.symbol];
                const retry = await syncTPSL(botPos.symbol, botPos.side, botPos.entryPrice, info, botPos.qty, botSettings.posTP, botSettings.posSL);
                if (retry.success) botPos.tpslOk = true;
            }

            botPos.pnl = parseFloat(p.unRealizedProfit);
            botPos.priceDev = ((parseFloat(p.markPrice) - botPos.entryPrice) / botPos.entryPrice) * 100;

            // Force Close khẩn cấp
            const markPrice = parseFloat(p.markPrice);
            const isShort = botPos.side === 'SHORT';
            const hitTP = isShort ? markPrice <= botPos.tp : markPrice >= botPos.tp;
            const hitSL = isShort ? markPrice >= botPos.sl : markPrice <= botPos.sl;

            if (hitTP || hitSL) {
                try {
                    await exchange.createOrder(botPos.symbol, 'MARKET', isShort ? 'BUY' : 'SELL', botPos.qty, undefined, { positionSide: botPos.side });
                    botActivePositions.delete(key);
                    addBotLog(`⚡ Force Closed ${botPos.symbol}`);
                } catch (err) {}
            }
        }
    } catch (e) {}
    setTimeout(monitorLoop, 1000); 
}

// --- Các phần giữ nguyên ---
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
        status.exchangeInfo = Object.fromEntries(infoRes.data.symbols.map(s => [s.symbol, { 
            quantityPrecision: s.quantityPrecision, 
            pricePrecision: s.pricePrecision, 
            stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize) 
        }]));
        status.isReady = true; monitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
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
    } catch (e) { res.json({ botSettings, activePositions: [], status }); }
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
