import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent',
    minVol: 5.0, 
    accountSL: 30 
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let blockedSymbols = new Map(); 
let isInitializing = true;
let isProcessing = false;
let marginErrorTime = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() - 2500; 
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=20000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); 
                    else reject({ ...j, statusCode: res.statusCode });
                } catch (e) { reject({ msg: "API_REJECT", detail: d }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                const all = response.live || [];
                status.candidatesList = all.map(c => ({
                    symbol: c.symbol, 
                    changePercent: c.c1, 
                    triggerFrame: "1M", 
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15)),
                    c1: c.c1, c5: c.c5, c15: c.c15
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;

    if (marginErrorTime > 0 && Date.now() < marginErrorTime) {
        return;
    }

    try {
        isProcessing = true;
        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();
        const targets = status.candidatesList.filter(c => c.maxV >= botSettings.minVol);

        for (const c of targets) {
            if (botManagedSymbols.length >= botSettings.maxPositions) break;
            
            const hasPos = positions.find(p => p.symbol === c.symbol && parseFloat(p.positionAmt) !== 0);
            if (hasPos) {
                if (!botManagedSymbols.includes(c.symbol)) botManagedSymbols.push(c.symbol);
                continue;
            }

            if (blockedSymbols.has(c.symbol) && now < blockedSymbols.get(c.symbol)) continue;

            try {
                addBotLog(`🎯 Phát hiện biến động mạnh: ${c.symbol} (${c.maxV}%)`, "info");
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const info = status.exchangeInfo[c.symbol];
                const side = c.changePercent > 0 ? 'BUY' : 'SELL';
                const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                let qty = Math.floor(((margin * lev) / parseFloat(ticker.price)) / info.stepSize) * info.stepSize;
                const finalQty = qty.toFixed(info.quantityPrecision);

                addBotLog(`📤 Đang mở vị thế ${posSide} ${c.symbol} | Qty: ${finalQty}`, "info");

                const order = await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty
                });

                if (order.orderId) {
                    addBotLog(`✅ Mở lệnh thành công: ${c.symbol}`, "success");
                    botManagedSymbols.push(c.symbol);
                    setTimeout(() => enforceTPSL(), 2000);
                }
            } catch (err) {
                if (err.code === -2019 || (err.msg && err.msg.toLowerCase().includes("margin"))) {
                    addBotLog(`🚨 LỖI MARGIN: Không đủ tiền mở lệnh. Tạm dừng quét 1 giờ.`, "error");
                    marginErrorTime = Date.now() + 60 * 60 * 1000;
                    break;
                } else {
                    addBotLog(`❌ Thất bại ${c.symbol}: ${err.msg || "Lỗi API"}`, "error");
                }
            }
        }
    } finally { isProcessing = false; }
}

async function cleanupClosedPositions() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const s = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === s);
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🏁 Đã đóng vị thế ${s}. Nghỉ 15p.`, "warn");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: s }).catch(()=>{});
                blockedSymbols.set(s, now + 15 * 60 * 1000);
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

async function enforceTPSL() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');
        for (const s of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === s && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;
            const side = p.positionSide;
            const hasTP = orders.some(o => o.symbol === s && o.positionSide === side && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === s && o.positionSide === side && o.type === 'STOP_MARKET');
            
            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[s];
                const entry = parseFloat(p.entryPrice);
                const rate = 1.2 / p.leverage;
                const tp = side === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
                const sl = side === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol: s, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol: s, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
                addBotLog(`🛡️ Đã cài TP/SL cho ${s}`, "debug");
            }
        }
    } catch (e) {}
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice,
            pnlPercent: (parseFloat(p.unrealizedProfit) / ((parseFloat(p.entryPrice) * Math.abs(p.positionAmt)) / p.leverage) * 100).toFixed(2)
        }));
        res.json({ 
            botSettings, 
            status, 
            activePositions: active,
            topVolatility: status.candidatesList.slice(0, 5)
        });
    } catch (e) { res.status(500).send("ERR"); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog(`⚙️ Đã cập nhật cấu hình mới.`, "warn");
    res.json({ status: "ok" });
});

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            const info = JSON.parse(d);
            info.symbols.forEach(s => {
                const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
            });
            isInitializing = false;
            addBotLog("🚀 Bot đã khởi động thành công.", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 2000);
setInterval(hunt, 3000);
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 10000);
APP.listen(9001, '0.0.0.0');
