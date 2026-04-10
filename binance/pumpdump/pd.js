import https from 'https';
import crypto from 'crypto';
import express from 'express';
import axios from 'axios';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ⚙️ CẤU HÌNH & TRẠNG THÁI
// ============================================================================
let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', 
    minVol: 6.5, posTP: 0.5, posSL: 5.0, dcaStep: 10.0, maxDCA: 8 
};

let status = { 
    initialBalance: 0, currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
                req.on('error', reject); req.end();
            });
            if (res.code === -1021) {
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now();
                continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(400); }
    }
}

// ============================================================================
// 🛡️ HỆ THỐNG GIÁP 3 LỚP (CÁCH NHAU 1.5S)
// ============================================================================
async function setupTripleProtection(symbol, side, posSide, tp, sl) {
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    
    // --- LỚP 1: AXIOS (External) ---
    try {
        const timestamp = Date.now() + serverTimeOffset;
        const query = `symbol=${symbol}&side=${closeSide}&positionSide=${posSide}&type=TAKE_PROFIT_MARKET&stopPrice=${tp}&closePosition=true&timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': API_KEY } });
        addBotLog(`🛡️ [LỚP 1] Axios TP OK: ${symbol}`, "success");
    } catch (e) { addBotLog(`⚠️ [LỚP 1] Axios Lỗi: ${symbol}`, "error"); }

    await sleep(1500); // Cách 1.5s

    // --- LỚP 2: FAPI (Native) ---
    try {
        const res = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true'
        });
        if (res.orderId) addBotLog(`🛡️ [LỚP 2] FAPI SL OK: ${symbol}`, "success");
        else throw new Error(res.msg);
    } catch (e) { addBotLog(`⚠️ [LỚP 2] FAPI Lỗi: ${e.message}`, "error"); }

    addBotLog(`🛡️ [LỚP 3] Bot Monitor Đã Kích Hoạt cho ${symbol}`, "info");
}

// 🎯 HÀM SMART CLOSE (DÙNG QTY + REDUCE ONLY)
async function smartClose(symbol, posSide) {
    try {
        const risk = await callBinance('/fapi/v2/positionRisk');
        const p = risk.find(x => x.symbol === symbol && x.positionSide === posSide);
        const qty = Math.abs(parseFloat(p?.positionAmt || 0));
        if (qty > 0) {
            const side = posSide === 'LONG' ? 'SELL' : 'BUY';
            const res = await callBinance('/fapi/v1/order', 'POST', {
                symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty, reduceOnly: 'true'
            });
            if (res.orderId) {
                addBotLog(`✅ [LỚP 3] Đã vã Market thành công ${symbol}`, "success");
                return true;
            }
        }
    } catch (e) { addBotLog(`❌ [LỚP 3] Lỗi vã Market: ${e.message}`, "error"); }
    return false;
}

// 🚀 MỞ VỊ THẾ
async function openPosition(symbol, side, info, isReverse = false) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    try {
        const acc = await callBinance('/fapi/v2/account');
        const price = parseFloat((await callBinance('/fapi/v1/ticker/price', 'GET', { symbol })).price);
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        if (isReverse) margin *= 10;

        let qty = (Math.floor(((margin * 20) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });
        if (order.orderId) {
            await sleep(2000);
            const pos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === posSide && Math.abs(p.positionAmt) > 0);
            if (!pos) return;

            const entry = parseFloat(pos.entryPrice);
            const tpRate = isReverse ? 50 : botSettings.posTP;
            const slRate = isReverse ? 50 : botSettings.posSL;

            const tp = (posSide === 'LONG' ? entry * (1 + tpRate/100) : entry * (1 - tpRate/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - slRate/100) : entry * (1 + slRate/100)).toFixed(info.pricePrecision);

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entry, initialEntry: entry, 
                qty: Math.abs(parseFloat(pos.positionAmt)), tp, sl, 
                dcaCount: 0, isClosing: false, orderIds: [order.orderId] 
            });

            await setupTripleProtection(symbol, side, posSide, tp, sl);
        }
    } catch (e) { addBotLog(`❌ Lỗi Open: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);
        const posRisk = await callBinance('/fapi/v2/positionRisk');

        for (let [symbol, data] of activeOrdersTracker) {
            if (data.isClosing) continue;

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const price = parseFloat(ticker.price);
            const floorPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side && Math.abs(parseFloat(p.positionAmt)) > 0);

            // 1. CHECK ĐÃ ĐÓNG (TRÊN SÀN)
            if (!floorPos) {
                data.isClosing = true;
                addBotLog(`💰 [XÁC NHẬN] ${symbol} đã đóng vị thế.`, "success");
                activeOrdersTracker.delete(symbol);
                setTimeout(() => callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }), 5000);
                continue;
            }

            // 2. LỚP 3: BOT MONITOR (LOCAL)
            let hit = (data.side === 'LONG' && (price >= data.tp || price <= data.sl)) || 
                      (data.side === 'SHORT' && (price <= data.tp || price >= data.sl));

            if (hit) {
                data.isClosing = true;
                addBotLog(`🚨 [LỚP 3 KÍCH HOẠT] ${symbol} chạm ${price}. Đang dứt điểm...`, "warning");
                await smartClose(symbol, data.side);
                continue;
            }

            // 3. DCA LOGIC
            const diff = ((price - data.initialEntry) / data.initialEntry) * 100;
            const isAgainst = (data.side === 'LONG' && diff <= -botSettings.dcaStep * (data.dcaCount + 1)) || 
                              (data.side === 'SHORT' && diff >= botSettings.dcaStep * (data.dcaCount + 1));

            if (isAgainst && !data.isClosing) {
                if (data.dcaCount < 8) {
                    data.dcaCount++;
                    addBotLog(`📉 DCA TẦNG ${data.dcaCount}: ${symbol} (${diff.toFixed(2)}%)`, "warning");
                    const dcaQty = (data.qty / data.dcaCount).toFixed(status.exchangeInfo[symbol].quantityPrecision);
                    const res = await callBinance('/fapi/v1/order', 'POST', { 
                        symbol, side: data.side === 'LONG' ? 'BUY' : 'SELL', 
                        positionSide: data.side, type: 'MARKET', quantity: dcaQty 
                    });
                    if (res.orderId) data.orderIds.push(res.orderId);
                    await sleep(2500);
                    const nPos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === data.side);
                    data.entry = parseFloat(nPos.entryPrice);
                    data.qty = Math.abs(parseFloat(nPos.positionAmt));
                    data.tp = (data.side === 'LONG' ? data.entry * (1 + botSettings.posTP/100) : data.entry * (1 - botSettings.posTP/100)).toFixed(status.exchangeInfo[symbol].pricePrecision);
                    data.sl = (data.side === 'LONG' ? data.entry * (1 - botSettings.posSL/100) : data.entry * (1 + botSettings.posSL/100)).toFixed(status.exchangeInfo[symbol].pricePrecision);
                    await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
                    await setupTripleProtection(symbol, data.side === 'LONG' ? 'BUY' : 'SELL', data.side, data.tp, data.sl);
                } else {
                    data.isClosing = true;
                    addBotLog(`💀 DCA CHẠY HẾT TẦNG. REVERSE x10 ${symbol}!`, "error");
                    await smartClose(symbol, data.side);
                    await sleep(3000);
                    await openPosition(symbol, data.side === 'LONG' ? 'SELL' : 'BUY', status.exchangeInfo[symbol], true);
                }
            }
        }
    } catch (e) {}
}

// --- KHỞI CHẠY ---
async function init() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = status.currentBalance = parseFloat(acc.totalWalletBalance);
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
        });
        addBotLog("👿 LUFFY v15.9 - TRIPLE SHIELD ACTIVATED", "success");
    } catch (e) { console.log(e); }
}

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({ symbol: c.symbol, c1: c.c1, c5: c.c5, maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5)) })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

init(); 
setInterval(mainLoop, 3500);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
