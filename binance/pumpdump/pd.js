import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, minVol: 5.0, accountSL: 30, slUnit: 'percent', useTrailingSL: false };
let status = { currentBalance: 0, startBalance: 0, highestBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [], isProcessing: false };
let history = []; 
let isInitializing = true;

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, response => {
            let d = ''; 
            response.on('data', chunk => d += chunk);
            response.on('end', () => {
                try { 
                    const parsed = JSON.parse(d);
                    if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
                    else reject(parsed);
                } catch (e) { reject({ msg: "JSON_ERROR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

function addBotLog(msg, type = 'info') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 30) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function fastEnforce(symbol) {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol });
        const p = pos.find(x => parseFloat(x.positionAmt) !== 0);
        if (!p) { status.isProcessing = false; return; }
        const info = status.exchangeInfo[symbol];
        const entry = parseFloat(p.entryPrice);
        const lev = parseFloat(p.leverage);
        const side = p.positionSide;
        let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : 3.33);
        const rate = m / lev;
        const tp = side === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
        const sl = side === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
        await Promise.all([
            callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' }),
            callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' })
        ]);
        addBotLog(`🛡️ Ghim TP/SL ${symbol}`, "success");
    } catch (e) { } finally { status.isProcessing = false; }
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || status.isProcessing) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0);
        if (active.length >= botSettings.maxPositions) return;

        for (const c of status.candidatesList) {
            if (active.some(p => p.symbol === c.symbol)) continue;
            status.isProcessing = true;
            const info = status.exchangeInfo[c.symbol];
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const price = parseFloat(ticker.price);
            
            // LOGIC CŨ: Đòn bẩy 20x, nhưng tính Qty dư ra 1 chút để tránh lỗi 5$
            const lev = 20;
            let qty = (botSettings.invValue * lev * 1.05) / price; // Thêm 5% buffer
            qty = Math.ceil(qty / info.stepSize) * info.stepSize;

            try {
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: c.changePercent > 0 ? 'BUY' : 'SELL',
                    positionSide: c.changePercent > 0 ? 'LONG' : 'SHORT', 
                    type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision)
                });
                addBotLog(`🚀 Mở ${c.symbol}`);
                setTimeout(() => fastEnforce(c.symbol), 2500);
                break;
            } catch (err) {
                status.isProcessing = false;
                addBotLog(`Lỗi: ${c.symbol}`, "error");
            }
        }
    } catch (e) {}
}

// Giữ nguyên các hàm fetchCandidates, init và API Routes như cũ
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                status.candidatesList = JSON.parse(d)
                    .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 5);
            } catch (e) {}
        });
    }).on('error', () => {});
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnlVal = parseFloat(p.unrealizedProfit);
            const pnlPct = (entry > 0) ? ((pnlVal / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnlPct, pnlValue: pnlVal };
        });
        res.json({ botSettings, status, activePositions: active, history });
    } catch (e) { res.status(500).send(); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({status:"ok"}); });
APP.post('/api/stop-all', async (req, res) => {
    botSettings.isRunning = false;
    const pos = await callBinance('/fapi/v2/positionRisk');
    for (const p of pos.filter(x => parseFloat(x.positionAmt) !== 0)) {
        await callBinance('/fapi/v1/order', 'POST', { symbol: p.symbol, side: parseFloat(p.positionAmt) > 0 ? 'SELL' : 'BUY', positionSide: p.positionSide, type: 'MARKET', quantity: Math.abs(parseFloat(p.positionAmt)) });
    }
    res.json({status:"ok"});
});

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                JSON.parse(d).symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
                addBotLog("Hệ thống sẵn sàng!");
            } catch (e) {}
        });
    });
}
init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 4000);
APP.listen(9001, '0.0.0.0');
