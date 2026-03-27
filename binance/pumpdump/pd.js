import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- HỆ THỐNG QUẢN TRỊ RỦI RO (HEDGE FUND LAYER) ---
let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: 1.5, invType: 'percent', 
    minVol: 2.2, posTP: 1.2, posSL: 3.0,
    maxDrawdown: 10.0,
    enableBE: true, // ✅ Break-Even
    beTrigger: 0.8, // Lãi 0.8% thì dời SL về Entry
    emergencyRetry: 3 // Số lần thử lại TP/SL trước khi panic close
};

let status = { initialBalance: 0, currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [], globalCooldown: 0 };
let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    const color = type === 'success' ? '\x1b[32m' : (type === 'error' ? '\x1b[31m' : '\x1b[36m');
    console.log(`${color}[${time}] ${msg}\x1b[0m`);
}

// 🛡️ API CORE (Fixed 100% Logic)
async function callBinance(endpoint, method = 'GET', params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const timestamp = Date.now() + serverTimeOffset;
            const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
            const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
            const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

            const res = await new Promise((resolve, reject) => {
                const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
                });
                req.on('error', reject);
                req.end();
            });

            if (res.code === -1021) { 
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now(); // FIX: t là object, không parse lại
                continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(300); }
    }
}

// 🚀 HÀM MỞ VỊ THẾ v11.0 "QUỸ PHÒNG HỘ"
async function openPosition(symbol, side, info, scan) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    
    pendingSymbols.add(symbol);
    const lockTimer = setTimeout(() => pendingSymbols.delete(symbol), 15 * 60 * 1000);

    try {
        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const entryPrice = parseFloat(ticker.price);
        
        // 1. CHECK MARGIN & DRAWDOWN
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);
        const availableBalance = parseFloat(acc.availableBalance);
        
        const drawdown = ((status.initialBalance - status.currentBalance) / status.initialBalance) * 100;
        if (drawdown > botSettings.maxDrawdown) {
            botSettings.isRunning = false;
            addBotLog(`🚨 [SHUTDOWN] Drawdown ${drawdown.toFixed(2)}%`, "error");
            return;
        }

        let marginNeeded = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        if (marginNeeded > availableBalance) {
            addBotLog(`❌ Thiếu vốn cho ${symbol} (Cần: ${marginNeeded}$, Có: ${availableBalance.toFixed(2)}$)`, "error");
            return;
        }
        
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const lev = brackets[0]?.brackets[0]?.initialLeverage || 20;
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: lev });

        let minQty = (info.minNotional * 1.1) / entryPrice; 
        let qtyStr = (Math.floor(Math.max((marginNeeded * lev) / entryPrice, minQty) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        // 2. ENTRY (Bỏ priceProtect để khớp nhanh nhất)
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qtyStr });

        if (order.orderId) {
            status.globalCooldown = Date.now() + 30000; // Chỉ cooldown khi khớp lệnh
            addBotLog(`🚀 ENTRY OK: ${symbol} | Qty:${qtyStr}`, "info");
            activeOrdersTracker.set(symbol, { symbol, side: posSide, qty: qtyStr, entry: entryPrice, isBE: false, tpId: null, slId: null });

            // 3. ĐẶT TP/SL VỚI CƠ CHẾ RETRY
            setTimeout(async () => {
                const tp = (side === 'BUY' ? entryPrice * (1 + botSettings.posTP/100) : entryPrice * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
                const sl = (side === 'BUY' ? entryPrice * (1 - botSettings.posSL/100) : entryPrice * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

                let tpId = null, slId = null;

                for (let attempt = 1; attempt <= botSettings.emergencyRetry; attempt++) {
                    if (!tpId) {
                        const r = await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'true' });
                        if (r.orderId) tpId = r.orderId;
                    }
                    if (!slId) {
                        const r = await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'true' });
                        if (r.orderId) slId = r.orderId;
                    }
                    if (tpId && slId) break;
                    await sleep(500 * attempt);
                }

                if (!tpId || !slId) {
                    addBotLog(`🛡️ [EMERGENCY] ${symbol} Fail TP/SL sau ${botSettings.emergencyRetry} lần. Đóng lệnh!`, "error");
                    await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'MARKET', closePosition: 'true' });
                    activeOrdersTracker.delete(symbol);
                } else {
                    const data = activeOrdersTracker.get(symbol);
                    if (data) { data.tpId = tpId; data.slId = slId; }
                    addBotLog(`🎯 Giáp OK: ${symbol}`, "success");
                }
            }, 800);

            // TIMEOUT 5P
            setTimeout(async () => {
                const pos = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol });
                if (pos.some(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0)) {
                    addBotLog(`⏱ TIMEOUT: Đóng ${symbol}`, "info");
                    await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'MARKET', closePosition: 'true' });
                    await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
                }
                activeOrdersTracker.delete(symbol);
            }, 5 * 60 * 1000);

        } else {
            addBotLog(`❌ Mở lệnh fail ${symbol}: ${order.msg}`, "error");
            clearTimeout(lockTimer); pendingSymbols.delete(symbol);
        }
    } catch (e) { addBotLog(`❌ Error ${symbol}: ${e.message}`, "error"); pendingSymbols.delete(symbol); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);
        
        // 🛠️ BREAK-EVEN THỰC THỤ (Không phá TP)
        for (let p of activePositions) {
            const data = activeOrdersTracker.get(p.symbol);
            if (data && !data.isBE) {
                const profit = data.side === 'LONG' ? (parseFloat(p.markPrice) - data.entry)/data.entry*100 : (data.entry - parseFloat(p.markPrice))/data.entry*100;
                if (profit >= botSettings.beTrigger) {
                    const bePrice = data.side === 'LONG' ? (data.entry * 1.0005).toFixed(status.exchangeInfo[p.symbol].pricePrecision) : (data.entry * 0.9995).toFixed(status.exchangeInfo[p.symbol].pricePrecision);
                    // Chỉ hủy SL cũ, giữ TP
                    if (data.slId) await callBinance('/fapi/v1/order', 'DELETE', { symbol: p.symbol, orderId: data.slId }).catch(()=>{});
                    const r = await callBinance('/fapi/v1/order', 'POST', { symbol: p.symbol, side: data.side === 'LONG' ? 'SELL' : 'BUY', positionSide: data.side, type: 'STOP_MARKET', stopPrice: bePrice, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'true' });
                    if (r.orderId) { data.isBE = true; data.slId = r.orderId; addBotLog(`🛡️ BE: ${p.symbol} dời SL về entry`, "success"); }
                }
            }
        }

        // SYNC TRACKER
        for (let [symbol, data] of activeOrdersTracker) {
            if (!activePositions.some(p => p.symbol === symbol)) {
                addBotLog(`✨ ${symbol} hoàn tất`, "success");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(()=>{});
                activeOrdersTracker.delete(symbol);
            }
        }

        if (activePositions.length >= botSettings.maxPositions || Date.now() < status.globalCooldown) return;

        for (const coin of status.candidatesList) {
            if (activePositions.some(p => p.symbol === coin.symbol) || pendingSymbols.has(coin.symbol)) continue;
            if (coin.maxV >= botSettings.minVol) {
                openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol], coin);
                break; 
            }
        }
    } catch (e) { console.log("Loop Error:", e.message); }
}

async function init() {
    try {
        await callBinance('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(()=>{});
        const info = await callBinance('/fapi/v1/exchangeInfo');
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = parseFloat(acc.totalWalletBalance);
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const notional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), minNotional: parseFloat(notional?.notional || 5) };
        });
        addBotLog("⚓ LUFFY v11.0 HEDGE FUND - GEAR 5 ACTIVATED!", "success");
    } catch (e) { console.log("Init Error:", e.message); }
}

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({
                    symbol: c.symbol, c1: c.c1, c5: c.c5, c15: c.c15 || c.m15 || 0,
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15 || c.m15 || 0))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

init(); setInterval(mainLoop, 3000);
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
