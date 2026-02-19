import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'fixed', minVol: 5.0 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {} };
let isLoggedStop = true;

function addBotLog(msg, type = 'info') {
    if (!botSettings.isRunning && type !== 'warn') return;
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try { 
                    const j = JSON.parse(d); 
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject(e); }
            });
        }).on('error', reject).end();
    });
}

function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
    const tpR = m / lev; const slR = (m * 0.5) / lev;
    return {
        tp: side === 'LONG' ? entryPrice * (1 + tpR) : entryPrice * (1 - tpR),
        sl: side === 'LONG' ? entryPrice * (1 - slR) : entryPrice * (1 + slR)
    };
}

// TUẦN TRA NGHIÊM NGẶT 15S/LẦN
async function patrol() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const active = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        const orders = await callBinance('/fapi/v1/openOrders');

        // 1. Hủy lệnh rác
        for (const o of orders) {
            if (!active.find(p => p.symbol === o.symbol && p.positionSide === o.positionSide)) {
                await callBinance('/fapi/v1/order', 'DELETE', { symbol: o.symbol, orderId: o.orderId });
                addBotLog(`🧹 Hủy lệnh rác: ${o.symbol}`, "warn");
            }
        }
        // 2. Ghim TP/SL thiếu
        for (const p of active) {
            const hasTP = orders.some(o => o.symbol === p.symbol && o.positionSide === p.positionSide && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === p.symbol && o.positionSide === p.positionSide && o.type === 'STOP_MARKET');
            if (!hasTP || !hasSL) {
                const plan = calcTPSL(parseFloat(p.leverage), p.positionSide, parseFloat(p.entryPrice));
                const side = p.positionSide === 'LONG' ? 'SELL' : 'BUY';
                const info = status.exchangeInfo[p.symbol];
                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol: p.symbol, side, positionSide: p.positionSide, type: 'TAKE_PROFIT_MARKET', stopPrice: plan.tp.toFixed(info.pricePrecision), quantity: Math.abs(p.positionAmt), workingType: 'MARK_PRICE' });
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol: p.symbol, side, positionSide: p.positionSide, type: 'STOP_MARKET', stopPrice: plan.sl.toFixed(info.pricePrecision), quantity: Math.abs(p.positionAmt), workingType: 'MARK_PRICE' });
                addBotLog(`🛡️ Đã ghim TP/SL cho ${p.symbol}`, "success");
            }
        }
    } catch (e) {}
}

async function hunt() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const active = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        if (active.length >= botSettings.maxPositions) return;

        http.get('http://127.0.0.1:9000/api/live', res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', async () => {
                const candidates = JSON.parse(d).filter(c => Math.abs(c.changePercent) >= botSettings.minVol);
                for (const c of candidates) {
                    if (!botSettings.isRunning) break;
                    const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';
                    if (active.find(p => p.symbol === c.symbol && p.positionSide === posSide)) continue;
                    
                    try {
                        const info = status.exchangeInfo[c.symbol];
                        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                        const lev = brackets[0].brackets[0].initialLeverage;
                        await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                        let margin = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
                        let qty = (margin * lev) / parseFloat(ticker.price);
                        qty = Math.floor(qty / info.stepSize) * info.stepSize;

                        addBotLog(`🚀 Mở ${posSide} ${c.symbol} (${lev}x)`, "info");
                        await callBinance('/fapi/v1/order', 'POST', { symbol: c.symbol, side: posSide === 'LONG' ? 'BUY' : 'SELL', positionSide: posSide, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision) });
                        setTimeout(patrol, 2000); // Mở xong 2s sau kiểm tra TP/SL ngay
                    } catch (err) { console.log(err); }
                }
            });
        });
    } catch (e) {}
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            let pnl = "0.00";
            if (parseFloat(p.entryPrice) > 0) pnl = ((parseFloat(p.unrealizedProfit) / ((parseFloat(p.entryPrice) * Math.abs(p.positionAmt)) / p.leverage)) * 100).toFixed(2);
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active });
    } catch (e) { res.status(500).send(); }
});
APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    if (!botSettings.isRunning) { isLoggedStop = false; addBotLog("⚓ HẠ BUỒM!", "warn"); }
    else addBotLog("🚢 GIƯƠNG BUỒM!", "success");
    res.sendStatus(200);
});

async function init() {
    try {
        https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                JSON.parse(d).symbols.forEach(s => {
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize) };
                });
            });
        });
    } catch (e) {}
}

init();
setInterval(hunt, 5000);
setInterval(patrol, 15000);
APP.listen(9001);
