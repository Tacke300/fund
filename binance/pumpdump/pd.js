import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CẤU HÌNH & TRẠNG THÁI ---
let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [], topOpportunities: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;
let coinCooldowns = new Map(); 
let lastLogMessage = ""; 

// --- HÀM LOG CHỐNG SPAM ---
function addBotLog(msg, type = 'info') {
    if (msg === lastLogMessage) return;
    lastLogMessage = msg;
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
}

// --- KẾT NỐI BINANCE ---
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

// --- QUẢN LÝ VỊ THẾ & LỆNH CHỜ ---
async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🧹 Đã đóng ${symbol}. Nghỉ 15p.`, "info");
                coinCooldowns.set(symbol, now);
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

async function enforceTPSL() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');
        for (const symbol of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;
            const hasTP = orders.some(o => o.symbol === symbol && o.type === 'TAKE_PROFIT_MARKET');
            if (!hasTP) {
                const entry = parseFloat(p.entryPrice);
                const side = p.positionSide;
                const info = status.exchangeInfo[symbol];
                const lev = parseFloat(p.leverage);
                let m = lev < 26 ? 1.5 : 2.5; 
                const rate = m / lev;
                const tp = side === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
                const sl = side === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
                await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
                await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
                addBotLog(`🎯 Set TP/SL cho ${symbol}`, "success");
            }
        }
    } catch (e) {}
}

// --- LOGIC VÀO LỆNH (OR 1-5-15P) ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) return;
        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol) || botManagedSymbols.length >= botSettings.maxPositions) continue;
            
            await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: c.symbol }).catch(() => {});
            const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
            const lev = Math.min(20, brackets[0].brackets[0].initialLeverage);
            await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

            const acc = await callBinance('/fapi/v2/account');
            status.currentBalance = parseFloat(acc.totalMarginBalance);
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const info = status.exchangeInfo[c.symbol];
            
            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            let qty = (margin * lev) / parseFloat(ticker.price);
            const finalQty = (Math.floor(qty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            const isLong = (c.c1 >= botSettings.minVol || c.c5 >= botSettings.minVol || c.c15 >= botSettings.minVol);
            await callBinance('/fapi/v1/order', 'POST', { symbol: c.symbol, side: isLong?'BUY':'SELL', positionSide: isLong?'LONG':'SHORT', type: 'MARKET', quantity: finalQty });
            botManagedSymbols.push(c.symbol);
            addBotLog(`🚀 Mở ${isLong?'LONG':'SHORT'} ${c.symbol}`, "success");
        }
    } catch (e) {} finally { isProcessing = false; }
}

// --- LẤY DATA PORT 9000 & TOP 5 ---
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const raw = JSON.parse(d);
                const all = raw.live || [];
                const now = Date.now();
                status.topOpportunities = [...all].sort((a,b)=>Math.max(Math.abs(b.c1),Math.abs(b.c5))-Math.max(Math.abs(a.c1),Math.abs(a.c5))).slice(0,5);
                status.candidatesList = all.filter(c => {
                    if (coinCooldowns.has(c.symbol) && (now - coinCooldowns.get(c.symbol) < 900000)) return false;
                    return Math.abs(c.c1)>=botSettings.minVol || Math.abs(c.c5)>=botSettings.minVol || Math.abs(c.c15)>=botSettings.minVol;
                });
            } catch (e) {}
        });
    }).on('error', () => {});
}

// --- GIAO DIỆN & API ---
const APP = express(); APP.use(express.json());
APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active });
    } catch (e) { res.status(500).send(); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ status: "ok" }); });

APP.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8"><title>MONCEY D. LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono&display=swap');
        body { background: #0a0a0c; color: #eee; font-family: 'Inter', sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .opp-card { background: rgba(255,255,255,0.05); border-left: 3px solid #444; padding: 5px 10px; border-radius: 8px; min-width: 120px; }
    </style>
</head>
<body class="p-4 flex flex-col gap-4">
    <header class="card p-4 flex justify-between items-center border-b-2 border-red-500">
        <h1 class="luffy-font text-4xl text-white uppercase leading-none">Moncey D. Luffy</h1>
        <div class="text-right">
            <p class="text-[10px] text-gray-500 font-bold uppercase">KHO BÁU USDT</p>
            <p id="balance" class="text-3xl font-black text-yellow-400 mono">$0.00</p>
        </div>
    </header>

    <div id="topOpp" class="flex gap-3 overflow-x-auto pb-2"></div>

    <div class="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div class="card p-3 flex flex-col"><label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Vốn %</label><input type="number" id="invValue" class="bg-transparent text-white mono" value="1.5"></div>
        <div class="card p-3 flex flex-col"><label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Lọc Sóng %</label><input type="number" id="minVol" class="bg-transparent text-red-400 font-bold mono" value="5.0"></div>
        <div class="card p-3 flex flex-col"><label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Số Lệnh Max</label><input type="number" id="maxPositions" class="bg-transparent mono" value="10"></div>
        <div class="card p-3 flex flex-col"><label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Dừng Tổng %</label><input type="number" id="accountSL" class="bg-transparent text-orange-400 mono" value="30"></div>
        <button id="runBtn" onclick="handleToggle()" class="bg-green-600 rounded-xl font-black text-[11px] uppercase">🚢 GIƯƠNG BUỒM</button>
        <button onclick="handleUpdate()" class="card text-[10px] text-gray-300 font-bold uppercase">CẬP NHẬT</button>
    </div>

    <div class="flex-grow grid grid-cols-12 gap-4 overflow-hidden">
        <div class="col-span-4 card flex flex-col overflow-hidden">
            <div id="botLogs" class="flex-grow p-3 mono text-[10px] space-y-1 overflow-y-auto"></div>
        </div>
        <div class="col-span-8 card overflow-hidden">
            <table class="w-full text-left text-[11px] mono">
                <thead class="bg-black/80 sticky top-0 text-gray-500 text-[9px] border-b border-white/10">
                    <tr><th class="p-4">Cặp Tiền</th><th class="p-4">Side</th><th class="p-4">Entry/Mark</th><th class="p-4 text-right">PnL%</th></tr>
                </thead>
                <tbody id="positionTable" class="divide-y divide-white/5"></tbody>
            </table>
        </div>
    </div>

    <script>
        async function sync() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                document.getElementById('topOpp').innerHTML = data.status.topOpportunities.map(o => \`
                    <div class="opp-card" style="border-left-color: \${o.c5 > 0 ? '#22c55e' : '#ef4444'}">
                        <div class="text-[10px] text-gray-500 font-bold">\${o.symbol}</div>
                        <div class="text-xs font-black \${o.c5 > 0 ? 'text-green-400' : 'text-red-400'}">\${o.c5 > 0 ? '▲' : '▼'} \${o.c5.toFixed(2)}%</div>
                        <div class="text-[8px] font-bold opacity-50 uppercase">\${o.c5 > 0 ? 'Long' : 'Short'}</div>
                    </div>\`).join('');
                document.getElementById('runBtn').innerText = data.botSettings.isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
                document.getElementById('runBtn').style.background = data.botSettings.isRunning ? "red" : "green";
                document.getElementById('balance').innerText = "$" + (data.status.currentBalance || 0).toFixed(2);
                document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`<div>[\${l.time}] \${l.msg}</div>\`).join('');
                document.getElementById('positionTable').innerHTML = data.activePositions.map(p => \`
                    <tr><td class="p-4 font-bold text-white">\${p.symbol}</td><td class="p-4 \${p.side==='LONG'?'text-green-400':'text-red-400'} font-black">\${p.side}</td><td class="p-4 text-gray-500">\${p.entryPrice}→\${p.markPrice}</td><td class="p-4 text-right font-black \${parseFloat(p.pnlPercent)>=0?'text-green-400':'text-red-400'}">\${p.pnlPercent}%</td></tr>\`).join('');
            } catch(e){}
        }
        async function handleToggle() {
            const isRun = document.getElementById('runBtn').innerText.includes("GIƯƠNG");
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning: isRun }) });
            sync();
        }
        async function handleUpdate() {
            const body = { invValue: parseFloat(document.getElementById('invValue').value), minVol: parseFloat(document.getElementById('minVol').value), maxPositions: parseInt(document.getElementById('maxPositions').value), accountSL: parseFloat(document.getElementById('accountSL').value) };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
        }
        setInterval(sync, 2000); sync();
    </script>
</body>
</html>
    `);
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
        });
    });
}
init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 2000);
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 10000);
APP.listen(9001, '0.0.0.0');
