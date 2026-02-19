import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let botSettings = { isRunning: false, maxPositions: 10, invValue: 0.06, invType: 'fixed', minVol: 5.0 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] }; // Thêm danh sách kèo vào status
let isLoggedStop = true;
let isInitializing = true;

function addBotLog(msg, type = 'info') {
    // Luôn cho phép log success/error/warn kể cả khi dừng bot
    if (!botSettings.isRunning && !['success', 'error', 'warn'].includes(type)) return;
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
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try { 
                    const j = JSON.parse(d); 
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "Dữ liệu sàn lỗi", code: "JSON_ERR" }); }
            });
        });
        req.on('error', e => reject(e));
        req.end();
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

// LUÔN QUÉT KÈO TỪ MÁY QUÉT 9000 (CHẠY ĐỘC LẬP)
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const allData = JSON.parse(d);
                // Lọc kèo theo volume tối thiểu ngay từ lúc quét
                status.candidatesList = allData
                    .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
            } catch (e) { status.candidatesList = []; }
        });
    }).on('error', () => { status.candidatesList = []; });
}

// TUẦN TRA LỆNH
async function patrol() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const active = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        const orders = await callBinance('/fapi/v1/openOrders');

        for (const o of orders) {
            if (!active.find(p => p.symbol === o.symbol && p.positionSide === o.positionSide)) {
                await callBinance('/fapi/v1/order', 'DELETE', { symbol: o.symbol, orderId: o.orderId });
                addBotLog(`🧹 Dọn rác: ${o.symbol}`, "warn");
            }
        }
        for (const p of active) {
            const hasTP = orders.some(o => o.symbol === p.symbol && o.positionSide === p.positionSide && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === p.symbol && o.positionSide === p.positionSide && o.type === 'STOP_MARKET');
            if (!hasTP || !hasSL) {
                const plan = calcTPSL(parseFloat(p.leverage), p.positionSide, parseFloat(p.entryPrice));
                const side = p.positionSide === 'LONG' ? 'SELL' : 'BUY';
                const info = status.exchangeInfo[p.symbol];
                const qty = Math.abs(parseFloat(p.positionAmt)).toFixed(info.quantityPrecision);
                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol: p.symbol, side, positionSide: p.positionSide, type: 'TAKE_PROFIT_MARKET', stopPrice: plan.tp.toFixed(info.pricePrecision), quantity: qty, workingType: 'MARK_PRICE' });
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol: p.symbol, side, positionSide: p.positionSide, type: 'STOP_MARKET', stopPrice: plan.sl.toFixed(info.pricePrecision), quantity: qty, workingType: 'MARK_PRICE' });
                addBotLog(`🛡️ Ghim bổ sung TP/SL cho ${p.symbol}`, "success");
            }
        }
    } catch (e) {}
}

// ĐI SĂN (DỰA TRÊN DANH SÁCH KÈO ĐÃ QUÉT)
async function hunt() {
    if (!botSettings.isRunning || isInitializing) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const active = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        if (active.length >= botSettings.maxPositions) return;

        for (const c of status.candidatesList) {
            if (!botSettings.isRunning) break;
            const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';
            if (active.find(p => p.symbol === c.symbol && p.positionSide === posSide)) continue;
            
            try {
                const info = status.exchangeInfo[c.symbol];
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                let qty = Math.ceil(((botSettings.invValue * lev) / price) / info.stepSize) * info.stepSize;
                if ((qty * price) < 5.0) qty = Math.ceil(5.1 / price / info.stepSize) * info.stepSize;

                addBotLog(`🚀 Mở ${posSide} ${c.symbol} (${lev}x)`, "info");
                await callBinance('/fapi/v1/order', 'POST', { symbol: c.symbol, side: posSide === 'LONG' ? 'BUY' : 'SELL', positionSide: posSide, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision) });
                setTimeout(patrol, 3000); 
            } catch (err) { 
                if (['ENOTFOUND', 'ETIMEDOUT'].includes(err.code)) {
                    addBotLog("📡 Sóng yếu, bỏ qua kèo...", "warn");
                } else {
                    botSettings.isRunning = false;
                    addBotLog(`🚨 LỖI LỆNH: ${err.msg || JSON.stringify(err)}. DỪNG BOT!`, "error");
                    break; 
                }
            }
        }
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
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            if (entry > 0 && amt > 0) pnl = ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2);
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
        https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
            let d = ''; r.on('data', c => d += c);
            res.on('end', () => {
                JSON.parse(d).symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
                addBotLog("⚓ Hệ thống sẵn sàng!", "success");
            });
        });
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(fetchCandidates, 5000); // Luôn quét kèo 5s/lần bất kể Start/Stop
setInterval(hunt, 5000); // Kiểm tra đập kèo 5s/lần
setInterval(patrol, 15000); // Tuần tra 15s/lần
APP.listen(9001, '0.0.0.0');
