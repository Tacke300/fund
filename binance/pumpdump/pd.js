import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- LOGIC GỐC CỦA BẠN (KHÔNG ĐỔI) ---
let botSettings = { isRunning: false, maxPositions: 3, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
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
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.end();
    });
}

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
                addBotLog(`🧹 Đã giải phóng Slot cho ${symbol}`, "info");
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
                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: plan.tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: plan.sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
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
            addBotLog(`🚀 Hunter: Mở lệnh thành công ${c.symbol}`, "success");
            
            setTimeout(enforceTPSL, 3000);
        }
    } catch (e) { addBotLog("Lỗi Hunt: " + (e.msg || "API Busy"), "error"); }
    finally { isProcessing = false; }
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                status.candidatesList = all.filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 15);
            } catch (e) {}
        });
    }).on('error', () => {});
}

// --- EXPRESS & HTML GỐC + BIẾN ĐỘNG ---
const APP = express();
APP.use(express.json());
APP.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MONCEY D. LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono:wght@400;700&display=swap');
        :root { --luffy-red: #ff4d4d; --luffy-yellow: #ffbe0b; --bg-dark: #0a0a0c; }
        body { background: var(--bg-dark); color: #eee; font-family: 'Inter', sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); }
        .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); }
        .status-tag { font-size: 9px; padding: 2px 8px; border-radius: 4px; background: rgba(0,0,0,0.6); }
        .review-item { border-bottom: 1px solid rgba(255,255,255,0.05); padding: 4px 0; }
    </style>
</head>
<body class="p-2 md:p-6">
    <header class="card p-4 mb-4 flex flex-wrap justify-between items-center gap-4 border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <div class="w-[70px] h-[70px] bg-[#1a1a1a] border-2 border-red-500 rounded-xl flex items-center justify-center">
                 <svg viewBox="0 0 100 100" class="w-12 h-12"><path d="M50 15 L85 45 L85 55 L15 55 L15 45 Z" fill="#EAB308"/><rect x="15" y="48" width="70" height="4" fill="#EF4444"/><circle cx="50" cy="65" r="25" fill="#FBD38D"/></svg>
            </div>
            <div>
                <h1 class="luffy-font text-3xl md:text-5xl text-white uppercase leading-none">Moncey D. Luffy</h1>
                <div class="flex gap-2 mt-2">
                    <span id="botStatusText" class="status-tag text-gray-500 uppercase font-black">OFFLINE</span>
                </div>
            </div>
        </div>
        <div class="flex gap-8 items-center bg-black/50 p-4 rounded-2xl border border-white/5">
            <div class="text-center">
                <p class="text-[10px] text-gray-500 font-bold uppercase">KHO BÁU USDT</p>
                <p id="balance" class="text-3xl font-black text-yellow-400 mono">$0.00</p>
            </div>
        </div>
    </header>

    <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Vốn Lệnh (%)</label><input type="number" id="invValue" class="w-full bg-black/40 text-white mono p-1" value="1.5"></div>
        <div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Sóng %</label><input type="number" id="minVol" class="w-full bg-black/40 text-red-400 mono p-1" value="5.0"></div>
        <div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Max Lệnh</label><input type="number" id="maxPositions" class="w-full bg-black/40 mono p-1" value="3"></div>
        <div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Dừng Tổng %</label><input type="number" id="accountSL" class="w-full bg-black/40 text-orange-400 mono p-1" value="30"></div>
        <button id="runBtn" onclick="handleToggle()" class="btn-start rounded-xl font-black text-white">🚢 RA KHƠI</button>
        <button onclick="handleUpdate()" class="bg-white/5 rounded-xl text-xs font-bold">CẬP NHẬT</button>
    </div>

    <div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-4 overflow-hidden">
        <div class="md:col-span-4 flex flex-col gap-4 overflow-hidden">
            <div class="card flex-grow overflow-hidden flex flex-col border-t-4 border-yellow-500">
                <div class="p-3 bg-yellow-500/10 text-yellow-500 text-[10px] font-bold uppercase">Radar Biến Động (Review)</div>
                <div id="candidateReview" class="p-3 overflow-y-auto mono text-[11px] flex-grow"></div>
            </div>
            <div class="card h-1/3 overflow-hidden flex flex-col border-t-4 border-blue-500">
                <div class="p-3 bg-blue-500/10 text-blue-400 text-[10px] font-bold uppercase">Nhật ký hải trình</div>
                <div id="botLogs" class="p-3 overflow-y-auto mono text-[10px] flex-grow"></div>
            </div>
        </div>

        <div class="md:col-span-8 card overflow-hidden border-t-4 border-red-500">
            <table class="w-full text-left text-[11px] mono">
                <thead class="bg-black/80 sticky top-0 text-gray-500">
                    <tr><th class="p-4">Cặp Tiền</th><th class="p-4">Side/Lev</th><th class="p-4">Entry</th><th class="p-4 text-right">PnL %</th></tr>
                </thead>
                <tbody id="positionTable"></tbody>
            </table>
        </div>
    </div>

    <script>
        let isRunning = false;
        async function sync() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                isRunning = data.botSettings.isRunning;
                document.getElementById('runBtn').innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 RA KHƠI";
                document.getElementById('runBtn').className = isRunning ? "btn-stop rounded-xl font-black text-white" : "btn-start rounded-xl font-black text-white";
                document.getElementById('botStatusText').innerText = isRunning ? "ĐANG TUẦN TRA" : "OFFLINE";
                document.getElementById('botStatusText').className = isRunning ? "status-tag text-green-500" : "status-tag text-gray-500";
                document.getElementById('balance').innerText = "$" + data.status.currentBalance.toFixed(2);
                
                // Logs
                document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`<div>[\${l.time}] \${l.msg}</div>\`).join('');
                
                // Candidates Review (Biến động)
                document.getElementById('candidateReview').innerHTML = data.status.candidatesList.map(c => \`
                    <div class="flex justify-between review-item">
                        <span class="font-bold">\${c.symbol}</span>
                        <span class="\${c.changePercent >= 0 ? 'text-green-400' : 'text-red-400'}">\${c.changePercent}%</span>
                    </div>
                \`).join('');

                // Positions
                document.getElementById('positionTable').innerHTML = data.activePositions.map(p => \`
                    <tr class="border-b border-white/5">
                        <td class="p-4 font-bold text-white">\${p.symbol}</td>
                        <td class="p-4 \${p.side === 'LONG' ? 'text-green-400' : 'text-red-400'} font-bold">\${p.side} \${p.leverage}x</td>
                        <td class="p-4 text-gray-400">\${p.entryPrice}</td>
                        <td class="p-4 text-right font-black \${parseFloat(p.pnlPercent) >= 0 ? 'text-green-400' : 'text-red-400'}">\${p.pnlPercent}%</td>
                    </tr>
                \`).join('');
            } catch(e) {}
        }
        async function handleToggle() { isRunning = !isRunning; await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning }) }); }
        async function handleUpdate() {
             const body = {
                invValue: parseFloat(document.getElementById('invValue').value),
                minVol: parseFloat(document.getElementById('minVol').value),
                maxPositions: parseInt(document.getElementById('maxPositions').value),
                accountSL: parseFloat(document.getElementById('accountSL').value)
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            alert("Đã cập nhật!");
        }
        setInterval(sync, 2000);
    </script>
</body>
</html>`);
});

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

async function init() {
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
