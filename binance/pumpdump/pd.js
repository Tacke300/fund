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
// ⚙️ CONFIG & STATUS
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
                const req = https.request(url, { method, timeout: 5000, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
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
        } catch (e) { if (i === retries - 1) throw e; await sleep(500); }
    }
}

// ============================================================================
// 🛡️ TRIPLE SHIELD (AXIOS -> FAPI -> MONITOR) 
// ============================================================================
async function setupShield(symbol, side, posSide, tp, sl) {
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    try {
        const ts = Date.now() + serverTimeOffset;
        const q = `symbol=${symbol}&side=${closeSide}&positionSide=${posSide}&type=TAKE_PROFIT_MARKET&stopPrice=${tp}&closePosition=true&timestamp=${ts}`;
        const sig = crypto.createHmac('sha256', SECRET_KEY).update(q).digest('hex');
        await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sig}`, null, { headers: { 'X-MBX-APIKEY': API_KEY } });
    } catch (e) {}
    await sleep(1500);
    try {
        await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true' });
    } catch (e) {}
}

async function smartClose(symbol, posSide) {
    try {
        const risk = await callBinance('/fapi/v2/positionRisk');
        const p = risk.find(x => x.symbol === symbol && x.positionSide === posSide);
        const qty = Math.abs(parseFloat(p?.positionAmt || 0));
        if (qty > 0) {
            const side = posSide === 'LONG' ? 'SELL' : 'BUY';
            await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty, reduceOnly: 'true' });
            return true;
        }
    } catch (e) {}
    return false;
}

// ============================================================================
// 🚀 CORE ENGINE
// ============================================================================
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
            await sleep(2500);
            const pos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === posSide && Math.abs(p.positionAmt) > 0);
            if (!pos) return;

            const entry = parseFloat(pos.entryPrice);
            const tp = (posSide === 'LONG' ? entry * (1 + (isReverse?50:botSettings.posTP)/100) : entry * (1 - (isReverse?50:botSettings.posTP)/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - (isReverse?50:botSettings.posSL)/100) : entry * (1 + (isReverse?50:botSettings.posSL)/100)).toFixed(info.pricePrecision);

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entry, initialEntry: entry, 
                qty: Math.abs(parseFloat(pos.positionAmt)), tp, sl, 
                dcaCount: 0, isClosing: false
            });

            addBotLog(`🚀 MỞ LỆNH: ${symbol} (${posSide}) @${entry}`, "success");
            await setupShield(symbol, side, posSide, tp, sl);
        }
    } catch (e) { addBotLog(`❌ Lỗi Mở: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const currentOpenPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        const currentOpenCount = currentOpenPositions.length;

        // Quản lý lệnh đang chạy
        for (let [symbol, data] of activeOrdersTracker) {
            if (data.isClosing) continue;
            const floorPos = currentOpenPositions.find(p => p.symbol === symbol && p.positionSide === data.side);
            if (!floorPos) {
                addBotLog(`💰 [XONG] ${symbol} đã đóng.`, "success");
                activeOrdersTracker.delete(symbol);
                continue;
            }

            // LỚP 3: MONITOR GIÁ
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const price = parseFloat(ticker.price);
            let hit = (data.side === 'LONG' && (price >= data.tp || price <= data.sl)) || 
                      (data.side === 'SHORT' && (price <= data.tp || price >= data.sl));

            if (hit) {
                data.isClosing = true;
                addBotLog(`🚨 [LỚP 3] Chốt Market ${symbol} @${price}`, "warning");
                await smartClose(symbol, data.side);
                continue;
            }
        }

        // Mở lệnh mới dựa trên biến động từ Server 9000
        if (currentOpenCount < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (!activeOrdersTracker.has(coin.symbol) && !pendingSymbols.has(coin.symbol)) {
                    if (coin.maxV >= botSettings.minVol) {
                        pendingSymbols.add(coin.symbol);
                        addBotLog(`🎯 KÈO: ${coin.symbol} (V:${coin.maxV.toFixed(2)}%)`, "entry");
                        openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol])
                            .finally(() => setTimeout(() => pendingSymbols.delete(coin.symbol), 5000));
                        break; 
                    }
                }
            }
        }
    } catch (e) {}
}

// ============================================================================
// 📡 SYNC DATA (FIXED FOR YOUR SERVER)
// ============================================================================
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                // Server của ông trả về mảng nằm trong r.live
                const rawList = r.live || []; 
                status.candidatesList = rawList.map(c => {
                    const v1 = Math.abs(parseFloat(c.c1) || 0);
                    const v5 = Math.abs(parseFloat(c.c5) || 0);
                    const v15 = Math.abs(parseFloat(c.c15) || 0);
                    return { 
                        symbol: c.symbol, 
                        c1: parseFloat(c.c1) || 0, 
                        maxV: Math.max(v1, v5, v15) 
                    };
                })
                .filter(c => c.symbol.endsWith('USDT'))
                .sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize) 
            };
        });
        addBotLog("👿 BOT LUFFY v16.3 READY", "success");
    } catch (e) {}
}

init(); 
setInterval(mainLoop, 3500);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
