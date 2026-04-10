import https from 'https';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ⚙️ CẤU HÌNH HỆ THỐNG (FULL ANTI-FAIL)
// ============================================================================
let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', 
    minVol: 6.5, posTP: 0.5, posSL: 5.0, dcaStep: 10.0, maxDCA: 8 
};

let status = { 
    initialBalance: 0, currentBalance: 0, botLogs: [], 
    exchangeInfo: {}, candidatesList: [] 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    if (status.botLogs.length > 0 && status.botLogs[0].msg === msg) return;
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 500) status.botLogs.pop();
    
    let color = '\x1b[36m'; 
    if (type === 'success') color = '\x1b[32m'; 
    if (type === 'error') color = '\x1b[31m';   
    if (type === 'warning') color = '\x1b[33m'; 
    console.log(`${color}[${time}] ${msg}\x1b[0m`);
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
                const req = https.request(url, { method, timeout: 5000, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { 
                        try { resolve(JSON.parse(d)); } catch (e) { reject(e); } 
                    });
                });
                req.on('error', reject); req.end();
            });
            if (res.code === -1021) { 
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now(); continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(500); }
    }
}

// ============================================================================
// 🛡️ CHIẾN THUẬT 5 LỚP BẢO VỆ & VERIFY
// ============================================================================

// 1. Check vị thế thực tế (Verify 1)
async function getActualPosition(symbol, side) {
    try {
        const res = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol });
        return res.find(p => p.symbol === symbol && p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
    } catch { return null; }
}

// 2. Check lệnh treo thực tế (Verify 2)
async function verifyTPSLOnExchange(symbol) {
    try {
        const orders = await callBinance('/fapi/v1/openOrders', 'GET', { symbol });
        return {
            hasTP: orders.some(o => o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET'),
            hasSL: orders.some(o => o.type === 'STOP_MARKET')
        };
    } catch { return { hasTP: false, hasSL: false }; }
}

// 3. Đặt giáp 3 lớp (TP Limit, SL Market, Bot Monitor)
async function updateSànGiáp(symbol, side, posSide, tp, sl, qty) {
    try {
        const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });

        // Cách 1: TP LIMIT (Khớp giá mục tiêu)
        await callBinance('/fapi/v1/order', 'POST', {
            symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT',
            stopPrice: tp, price: tp, quantity: qty, reduceOnly: 'true', workingType: 'MARK_PRICE'
        });

        // Cách 2: SL MARKET (Giáp sàn - closePosition tự clear)
        await callBinance('/fapi/v1/order', 'POST', {
            symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET',
            stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE'
        });

        await sleep(1000);
        const check = await verifyTPSLOnExchange(symbol);
        if (check.hasTP && check.hasSL) {
            addBotLog(`✅ [${symbol}] GIÁP OK: TP @${tp} | SL @${sl}`, "success");
        } else {
            addBotLog(`⚠️ [${symbol}] Thiếu giáp sàn! Bot Layer 3 (Monitor) đang cầm lái.`, "warning");
        }
    } catch (e) { addBotLog(`❌ Lỗi giáp ${symbol}: ${e.message}`, "error"); }
}

// 4. Đóng lệnh cưỡng chế (Loop 5 lần - Anti-Log-Ảo)
async function smartClose(symbol, posSide, reason) {
    let cleared = false;
    for (let i = 1; i <= 5; i++) {
        const pos = await getActualPosition(symbol, posSide);
        if (!pos) { cleared = true; break; }

        const qty = Math.abs(parseFloat(pos.positionAmt));
        const side = posSide === 'LONG' ? 'SELL' : 'BUY';

        addBotLog(`🔄 [${symbol}] Đóng Market lần ${i} (${reason})`, "info");
        await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty, reduceOnly: 'true'
        });
        
        await sleep(1500);
    }
    
    if (cleared) {
        addBotLog(`✅ [${symbol}] Đóng & Verify thành công.`, "success");
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        return true;
    } else {
        addBotLog(`💀 [${symbol}] KHÔNG THỂ ĐÓNG! Kiểm tra ngay số dư/lệnh kẹt.`, "error");
        return false;
    }
}

// ============================================================================
// 🚀 CORE LOGIC
// ============================================================================

async function openPosition(symbol, side, info, isReverse = false) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    try {
        const acc = await callBinance('/fapi/v2/account');
        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        if (isReverse) margin *= 10;

        let qty = (Math.floor(((margin * 20) / parseFloat(ticker.price)) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        const res = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });

        if (res.orderId) {
            await sleep(2000);
            const pos = await getActualPosition(symbol, posSide);
            if (pos) {
                const entry = parseFloat(pos.entryPrice);
                const qtyFloor = Math.abs(parseFloat(pos.positionAmt));
                const tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
                const sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

                activeOrdersTracker.set(symbol, { symbol, side: posSide, entry, qty: qtyFloor, tp, sl, dcaCount: 0, isClosing: false });
                await updateSànGiáp(symbol, side, posSide, tp, sl, qtyFloor);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi Open ${symbol}: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);

        for (let [symbol, data] of activeOrdersTracker) {
            if (data.isClosing) continue;

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const price = parseFloat(ticker.price);
            const pos = await getActualPosition(symbol, data.side);

            // Check sàn tự khớp
            if (!pos) {
                data.isClosing = true;
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const pnl = trades.filter(t => t.positionSide === data.side).reduce((s, t) => s + parseFloat(t.realizedPnl), 0);
                addBotLog(`💰 [${symbol}] Sàn khớp. PnL: ${pnl.toFixed(2)}$`, "success");
                activeOrdersTracker.delete(symbol);
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
                continue;
            }

            // Layer 3: Bot Monitor (Failsafe)
            let hitTP = (data.side === 'LONG' && price >= data.tp) || (data.side === 'SHORT' && price <= data.tp);
            let hitSL = (data.side === 'LONG' && price <= data.sl) || (data.side === 'SHORT' && price >= data.sl);

            if (hitTP || hitSL) {
                data.isClosing = true;
                const ok = await smartClose(symbol, data.side, hitTP ? "BOT_TP" : "BOT_SL");
                if (ok) activeOrdersTracker.delete(symbol);
                continue;
            }

            // DCA Logic
            const diff = ((price - data.entry) / data.entry) * 100;
            const isAgainst = (data.side === 'LONG' && diff <= -botSettings.dcaStep) || (data.side === 'SHORT' && diff >= botSettings.dcaStep);

            if (isAgainst && data.dcaCount < botSettings.maxDCA) {
                data.dcaCount++;
                addBotLog(`📉 [${symbol}] DCA Tầng ${data.dcaCount}`, "warning");
                await callBinance('/fapi/v1/order', 'POST', { symbol, side: data.side === 'LONG' ? 'BUY' : 'SELL', positionSide: data.side, type: 'MARKET', quantity: data.qty });
                await sleep(3000);
                const nPos = await getActualPosition(symbol, data.side);
                if (nPos) {
                    data.entry = parseFloat(nPos.entryPrice);
                    data.qty = Math.abs(parseFloat(nPos.positionAmt));
                    await updateSànGiáp(symbol, data.side === 'LONG' ? 'BUY' : 'SELL', data.side, data.tp, data.sl, data.qty);
                }
            }
        }

        // Tìm kèo mới
        if (activeOrdersTracker.size < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (!activeOrdersTracker.has(coin.symbol) && !pendingSymbols.has(coin.symbol) && coin.maxV >= botSettings.minVol) {
                    pendingSymbols.add(coin.symbol);
                    await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol]);
                    setTimeout(() => pendingSymbols.delete(coin.symbol), 5000);
                    break;
                }
            }
        }
    } catch (e) { }
}

// ============================================================================
// 🔌 INIT & SERVER
// ============================================================================

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({ 
                    symbol: c.symbol, c1: c.c1, maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5 || 0)) 
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
        });
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = parseFloat(acc.totalWalletBalance);
        botSettings.isRunning = true;
        addBotLog("👿 LUFFY v15.8 FULL - ANTI-FAIL SYSTEM ACTIVE", "success");
    } catch (e) { console.log(e); }
}

init(); 
setInterval(mainLoop, 3500);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
