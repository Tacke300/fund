import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- LOGIC GỐC 100% ---
let botSettings = { isRunning: false, maxPositions: 3, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => { try { const j = JSON.parse(d); resolve(j); } catch (e) { reject(e); } });
        });
        req.end();
    });
}

// Giữ nguyên các hàm cleanup, calcTPSL, enforceTPSL, hunt...
async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            if (!p || parseFloat(p.positionAmt) === 0) {
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(()=>{});
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
    const rate = m / lev;
    const tp = side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate);
    const sl = side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate);
    return { tp, sl };
}

async function enforceTPSL() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');
        for (const symbol of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;
            const side = p.positionSide;
            const entry = parseFloat(p.entryPrice);
            if (entry <= 0) continue;
            const hasTP = orders.some(o => o.symbol === symbol && o.positionSide === side && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === symbol && o.positionSide === side && o.type === 'STOP_MARKET');
            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[symbol];
                const plan = calcTPSL(parseFloat(p.leverage), side, entry);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: plan.tp.toFixed(info.pricePrecision), closePosition: 'true' });
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: plan.sl.toFixed(info.pricePrecision), closePosition: 'true' });
            }
        }
    } catch (e) {}
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) { isProcessing = false; return; }
        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol) || botManagedSymbols.length >= botSettings.maxPositions) continue;
            const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
            const lev = brackets[0].brackets[0].initialLeverage;
            await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
            const acc = await callBinance('/fapi/v2/account');
            status.currentBalance = parseFloat(acc.totalMarginBalance);
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const info = status.exchangeInfo[c.symbol];
            const side = c.changePercent > 0 ? 'LONG' : 'SHORT';
            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            if ((margin * lev) < 5.1) margin = 5.2 / lev;
            let qty = (Math.floor(((margin * lev) / parseFloat(ticker.price)) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
            await callBinance('/fapi/v1/order', 'POST', { symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL', positionSide: side, type: 'MARKET', quantity: qty });
            botManagedSymbols.push(c.symbol);
            addBotLog(`🚀 Hunter: Mở lệnh ${c.symbol}`, "success");
            setTimeout(enforceTPSL, 3000);
        }
    } finally { isProcessing = false; }
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                status.candidatesList = all.filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 10);
            } catch (e) {}
        });
    }).on('error', () => {});
}

// --- GIAO DIỆN HTML (CÓ BẢNG REVIEW BIẾN ĐỘNG) ---
const APP = express();
APP.use(express.json());
APP.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>MONCEY D. LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono&display=swap');
        :root { --luffy-red: #ff4d4d; --bg-dark: #0a0a0c; }
        body { background: var(--bg-dark); color: #eee; font-family: 'Inter', sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; }
        .status-tag { font-size: 9px; padding: 2px 8px; border-radius: 4px; background: rgba(0,0,0,0.6); }
    </style>
</head>
<body class="p-2 md:p-4">
    <header class="card p-4 mb-3 flex justify-between items-center border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <h1 class="luffy-font text-4xl text-white uppercase">Moncey D. Luffy</h1>
            <span id="botStatusText" class="status-tag text-gray-500 font-black">OFFLINE</span>
        </div>
        <div class="text-center">
            <p class="text-[10px] text-gray-500 uppercase">KHO BÁU USDT</p>
            <p id="balance" class="text-2xl font-black text-yellow-400 mono">$0.00</p>
        </div>
    </header>

    <div class="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
        <div class="card p-2"><label class="text-[9px] text-gray-500 uppercase">Vốn (%)</label><input type="number" id="invValue" class="w-full bg-transparent text-white mono outline-none"></div>
        <div class="card p-2"><label class="text-[9px] text-gray-500 uppercase">Sóng %</label><input type="number" id="minVol" class="w-full bg-transparent text-red-400 mono outline-none"></div>
        <div class="card p-2"><label class="text-[9px] text-gray-500 uppercase">Max Lệnh</label><input type="number" id="maxPositions" class="w-full bg-transparent mono outline-none"></div>
        <button id="runBtn" onclick="handleToggle()" class="bg-green-600 rounded-lg font-black text-white text-xs">🚢 RA KHƠI</button>
        <button onclick="handleUpdate()" class="bg-white/10 rounded-lg text-xs font-bold text-gray-300">CẬP NHẬT</button>
    </div>

    <div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-3 overflow-hidden">
        <div class="md:col-span-4 flex flex-col gap-3 overflow-hidden">
            <div class="card flex-grow flex flex-col overflow-hidden">
                <div class="p-2 border-b border-white/5 text-[10px] font-black text-blue-400 uppercase italic">Nhật ký hải trình</div>
                <div id="botLogs" class="flex-grow overflow-y-auto p-2 mono text-[10px] space-y-1"></div>
            </div>
            <div class="card h-1/2 flex flex-col overflow-hidden border-t-2 border-yellow-500">
                <div class="p-2 border-b border-white/5 text-[10px] font-black text-yellow-400 uppercase italic">Radar Ứng Viên</div>
                <div id="candidateReview" class="flex-grow overflow-y-auto p-2 mono text-[10px]"></div>
            </div>
        </div>
        <div class="md:col-span-8 card flex flex-col overflow-hidden border-t-2 border-red-500">
            <div class="p-3 border-b border-white/5 flex justify-between items-center"><h3 class="luffy-font text-xl text-red-500 italic uppercase">Chiến trường Live</h3></div>
            <div class="flex-grow overflow-y-auto">
                <table class="w-full text-left text-[11px] mono">
                    <thead class="bg-black/80 sticky top-0 text-gray-500 uppercase text-[9px]"><tr><th class="p-3">Cặp</th><th class="p-3">Side</th><th class="p-3">Giá</th><th class="p-3 text-right">PnL%</th></tr></thead>
                    <tbody id="positionTable"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let isRunning = false;
        async function sync() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                isRunning = data.botSettings.isRunning;
                document.getElementById('botStatusText').innerText = isRunning ? "ĐANG TUẦN TRA" : "OFFLINE";
                document.getElementById('botStatusText').className = isRunning ? "status-tag text-green-500" : "status-tag text-gray-500";
                document.getElementById('runBtn').innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 RA KHƠI";
                document.getElementById('runBtn').className = isRunning ? "bg-red-600 rounded-lg font-black text-white text-xs" : "bg-green-600 rounded-lg font-black text-white text-xs";
                document.getElementById('balance').innerText = "$" + (data.status.currentBalance || 0).toFixed(2);
                document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`<div>[\${l.time}] \${l.msg}</div>\`).join('');
                
                // Review ứng viên động
                document.getElementById('candidateReview').innerHTML = data.status.candidatesList.map(c => \`
                    <div class="flex justify-between border-b border-white/5 py-1">
                        <span>\${c.symbol}</span>
                        <span class="\${c.changePercent >= 0 ? 'text-green-400' : 'text-red-400'}">\${c.changePercent}%</span>
                    </div>
                \`).join('');

                document.getElementById('positionTable').innerHTML = data.activePositions.map(p => \`
                    <tr class="border-b border-white/5"><td class="p-3 font-bold">\${p.symbol}</td><td class="p-3 \${p.side === 'LONG' ? 'text-green-400' : 'text-red-400'}">\${p.side} \${p.leverage}x</td><td class="p-3 text-gray-500">\${p.entryPrice}</td><td class="p-3 text-right font-black \${parseFloat(p.pnlPercent) >= 0 ? 'text-green-400' : 'text-red-400'}">\${p.pnlPercent}%</td></tr>
                \`).join('');
                if(!document.activeElement.tagName.includes('INPUT')) {
                    document.getElementById('invValue').value = data.botSettings.invValue;
                    document.getElementById('minVol').value = data.botSettings.minVol;
                    document.getElementById('maxPositions').value = data.botSettings.maxPositions;
                }
            } catch(e){}
        }
        async function handleToggle() { isRunning = !isRunning; await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning }) }); }
        async function handleUpdate() {
            const body = { invValue: parseFloat(document.getElementById('invValue').value), minVol: parseFloat(document.getElementById('minVol').value), maxPositions: parseInt(document.getElementById('maxPositions').value) };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
        }
        setInterval(sync, 2000);
    </script>
</body>
</html>`);
});

// Các API và khởi tạo giữ nguyên như cũ
APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active });
    } catch (e) { res.status(500).send(); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ ok: true }); });

function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                const info = JSON.parse(d);
                info.symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
            } catch (e) {}
        });
    });
}

init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 2000);
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 10000);
APP.listen(9001, '0.0.0.0');
