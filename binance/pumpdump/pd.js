import https from 'https';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    timeout: 30000, 
    options: { defaultType: 'future', dualSidePosition: true }
});

let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', 
    minVol: 6.5, posTP: 0.5, posSL: 5.0, dcaStep: 10.0, maxDCA: 9,
    botSLValue: 0, botSLType: 'fixed'
};

let status = { 
    initialBalance: 0, currentBalance: 0, availableBalance: 0, 
    botLogs: [], exchangeInfo: {}, candidatesList: [], history: [] 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let blackListPool = new Map();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatSmart(num) {
    if (!num || isNaN(num)) return "0.00";
    return parseFloat(num).toFixed(num < 1 ? 6 : 4);
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 500) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function callBinance(endpoint, method = 'GET', params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const timestamp = Date.now() + serverTimeOffset;
            const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
            const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
            const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;
            const res = await new Promise((resolve, reject) => {
                const req = https.request(url, { method, timeout: 4000, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
                });
                req.on('error', reject);
                req.end();
            });
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(500); }
    }
}

// HÀM CHỐT PNL THỰC TẾ SAU 30 GIÂY
async function finalizePnL(symbol, side, entryPrice) {
    await sleep(30000); 
    try {
        const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
        const relevantTrades = trades.filter(t => t.symbol === symbol && t.positionSide === side).slice(0, 5);
        let totalRealized = relevantTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        
        status.history.unshift({ 
            time: new Date().toLocaleTimeString('vi-VN'), 
            symbol, side, pnl: totalRealized.toFixed(4), entry: entryPrice 
        });
        if (status.history.length > 200) status.history.pop();
        addBotLog(`💰 Đã chốt ${symbol}: ${totalRealized.toFixed(4)}$ (PnL thật từ sàn)`, "info");
    } catch (e) { console.log("Lỗi PnL:", e.message); }
}

async function updateSànGiáp(symbol, side, posSide, tp, sl) {
    try {
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        const closeSide = posSide === 'LONG' ? 'sell' : 'buy';
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', closeSide, 0, undefined, { positionSide: posSide, stopPrice: tp, closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', closeSide, 0, undefined, { positionSide: posSide, stopPrice: sl, closePosition: true, workingType: 'MARK_PRICE' });
    } catch (e) {}
}

async function openPosition(symbol, side, info) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    try {
        const acc = await callBinance('/fapi/v2/account');
        const availableBal = parseFloat(acc.availableBalance);
        
        // Log biến động 3 khung từ candidatesList
        const coinData = status.candidatesList.find(c => c.symbol === symbol);
        const snapshot = coinData ? `${coinData.c1}/${coinData.c5}/${coinData.c15}%` : "0/0/0%";

        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const price = parseFloat(ticker.price);
        const lev = info.maxLeverage || 20;
        
        let marginReq = botSettings.invType === 'percent' ? (availableBal * botSettings.invValue) / 100 : botSettings.invValue;
        if (marginReq > availableBal) marginReq = availableBal * 0.95;

        let qty = (Math.floor(((marginReq * lev) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: lev });
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });

        if (order.orderId) {
            await sleep(1000);
            const posRisk = await callBinance('/fapi/v2/positionRisk');
            const myPos = posRisk.find(p => p.symbol === symbol && p.positionSide === posSide && parseFloat(p.positionAmt) !== 0);
            if (!myPos) return;

            const entry = parseFloat(myPos.entryPrice);
            const tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entryPrice: formatSmart(entry), initialEntry: entry, 
                margin: formatSmart(parseFloat(myPos.isolatedMargin)), 
                qty: Math.abs(parseFloat(myPos.positionAmt)), 
                tpPrice: formatSmart(tp), slPrice: formatSmart(sl), 
                tpRaw: parseFloat(tp), slRaw: parseFloat(sl), 
                dcaCount: 0, isClosing: false, lev, snap: snapshot
            });

            await updateSànGiáp(symbol, side, posSide, tp, sl);
            addBotLog(`🚀 Mở ${symbol} [${snapshot}] | Margin: ${activeOrdersTracker.get(symbol).margin}$`, "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi mở: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);
        status.availableBalance = parseFloat(acc.availableBalance);
        const posRisk = await callBinance('/fapi/v2/positionRisk');

        for (let [symbol, data] of activeOrdersTracker) {
            const floorPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side && parseFloat(p.positionAmt) !== 0);

            // XÓA VỊ THẾ ẢO: Nếu sàn không còn, xóa khỏi danh sách ngay
            if (!floorPos && !data.isClosing) {
                data.isClosing = true;
                blackListPool.set(symbol, Date.now() + 5 * 60 * 1000);
                activeOrdersTracker.delete(symbol);
                finalizePnL(symbol, data.side, data.entryPrice);
                continue;
            }

            if (data.isClosing) continue;
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            data.markPrice = formatSmart(ticker.price);
        }

        if (activeOrdersTracker.size < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (!activeOrdersTracker.has(coin.symbol) && !pendingSymbols.has(coin.symbol) && !blackListPool.has(coin.symbol) && coin.maxV >= botSettings.minVol) {
                    pendingSymbols.add(coin.symbol);
                    await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol]);
                    setTimeout(() => pendingSymbols.delete(coin.symbol), 5000);
                    break;
                }
            }
        }
    } catch (e) {}
}

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({ 
                    symbol: c.symbol, c1: c.c1, c5: c.c5, c15: c.c15 || 0,
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5)) 
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);
        status.availableBalance = parseFloat(acc.availableBalance);
        const info = await callBinance('/fapi/v1/exchangeInfo');
        const brackets = await callBinance('/fapi/v1/leverageBracket');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const bracket = brackets.find(b => b.symbol === s.symbol);
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: bracket ? bracket.brackets[0].initialLeverage : 20 };
        });
        await exchange.loadMarkets(); 
        addBotLog("👿 LUFFY v16.5 - REAL PNL & NO GHOST POSITIONS", "success");
    } catch (e) {}
}

init(); 
setInterval(mainLoop, 3500);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
