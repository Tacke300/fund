import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CẤU HÌNH GỐC
let botSettings = { 
    isRunning: false, maxPositions: 10, invValue: 1.5, minVol: 5.0, 
    accountSL: 30, slUnit: 'percent', useTrailingSL: false 
};

let status = { 
    currentBalance: 0, 
    startBalance: 0, 
    highestBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [] 
};
let history = []; 
let isInitializing = true;

function addBotLog(msg, type = 'info') {
    if (status.botLogs.length > 0 && status.botLogs[0].msg === msg) return;
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 20) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try { 
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "JSON_ERROR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// 1. TÍNH TOÁN TP/SL 1:1
function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
    const rate = m / lev; 
    return {
        tp: side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate),
        sl: side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate)
    };
}

// 2. GHIM TP/SL SIÊU TỐC
async function fastEnforce(symbol) {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol });
        const p = pos.find(x => parseFloat(x.positionAmt) !== 0);
        if (!p) return;

        const info = status.exchangeInfo[symbol];
        const entry = parseFloat(p.entryPrice);
        const side = p.positionSide;
        const plan = calcTPSL(parseFloat(p.leverage), side, entry);
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

        await Promise.all([
            callBinance('/fapi/v1/order', 'POST', {
                symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                stopPrice: plan.tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true'
            }),
            callBinance('/fapi/v1/order', 'POST', {
                symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true'
            })
        ]);
        addBotLog(`🛡️ Đã ghim TP/SL (1:1) cho ${symbol}`, "success");
    } catch (e) { console.log(`Lỗi ghim ${symbol}:`, e.msg); }
}

// 3. KIỂM TRA TRAILING ACCOUNT STOP LOSS
function checkAccountSL() {
    if (!botSettings.isRunning || status.currentBalance === 0) return;

    if (botSettings.useTrailingSL) {
        if (status.currentBalance > status.highestBalance) status.highestBalance = status.currentBalance;
    } else {
        status.highestBalance = status.startBalance;
    }

    let threshold = botSettings.slUnit === 'percent' 
        ? status.highestBalance * (1 - botSettings.accountSL / 100)
        : status.highestBalance - botSettings.accountSL;

    if (status.currentBalance <= threshold) {
        botSettings.isRunning = false;
        addBotLog(`🚨 CHẠM SL TÀI KHOẢN ($${status.currentBalance.toFixed(2)}). DỪNG BOT!`, "error");
    }
}

// 4. LUỒNG SĂN KÈO
async function hunt() {
    if (isInitializing) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        if (botSettings.isRunning && status.startBalance === 0) {
            status.startBalance = status.currentBalance;
            status.highestBalance = status.currentBalance;
        }
        if (!botSettings.isRunning) { status.startBalance = 0; return; }

        checkAccountSL();

        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0);
        if (active.length >= botSettings.maxPositions) return;

        for (const c of status.candidatesList) {
            if (active.some(p => p.symbol === c.symbol)) continue;
            const side = c.changePercent > 0 ? 'LONG' : 'SHORT';
            
            try {
                const info = status.exchangeInfo[c.symbol];
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                
                let qty = Math.floor(((botSettings.invValue * lev) / price) / info.stepSize) * info.stepSize;
                if ((qty * price) < 5.0) qty = Math.ceil(5.1 / price / info.stepSize) * info.stepSize;

                await callBinance('/fapi/v1/order', 'POST', { 
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL', 
                    positionSide: side, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision) 
                });

                addBotLog(`🚀 Mở ${side} ${c.symbol} (${c.changePercent.toFixed(2)}%)`, "success");
                setTimeout(() => fastEnforce(c.symbol), 5000);
            } catch (err) { console.log("Lỗi mở lệnh:", err.msg); }
        }
    } catch (e) {}
}

// 5. QUÉT KÈO TỪ SCANNER
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                status.candidatesList = all
                    .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
                    .slice(0, 5);
            } catch (e) {}
        });
    }).on('error', () => {});
}

// 6. SERVER API & GIAO DIỆN
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

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ status: "ok" });
});

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                JSON.parse(d).symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
                addBotLog("✅ HỆ THỐNG SẴN SÀNG", "success");
            } catch (e) {}
        });
    });
}

init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 4000);
APP.listen(9001, '0.0.0.0');
