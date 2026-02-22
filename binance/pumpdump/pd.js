import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = './bot_settings.json';

let botSettings = { 
    isRunning: false, 
    maxPositions: 10, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0, 
    accountSL: 30 
};

if (fs.existsSync(CONFIG_FILE)) {
    botSettings = JSON.parse(fs.readFileSync(CONFIG_FILE));
}

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
    console.log(`${colors[type] || ''}[${time}] [${type.toUpperCase()}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "LỖI_JSON" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
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
                addBotLog(`🔓 Giải phóng slot ${symbol}`, "success");
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
                if (!hasTP) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                        stopPrice: plan.tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    });
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    });
                }
            }
        }
    } catch (e) {}
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions || status.candidatesList.length === 0) return;

        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            try {
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                
                const acc = await callBinance('/fapi/v2/account');
                status.currentBalance = parseFloat(acc.totalMarginBalance);
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                const info = status.exchangeInfo[c.symbol];
                const side = c.changePercent > 0 ? 'LONG' : 'SHORT';

                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                if ((margin * lev) < 5.1) margin = 5.2 / lev;

                let qty = Math.floor(((margin * lev) / price) / info.stepSize) * info.stepSize;
                const finalQty = qty.toFixed(info.quantityPrecision);

                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL',
                    positionSide: side, type: 'MARKET', quantity: finalQty
                });

                botManagedSymbols.push(c.symbol);
                addBotLog(`🚀 Mở lệnh ${c.symbol}`, "success");
                await new Promise(res => setTimeout(res, 3000));
                await enforceTPSL();
            } catch (err) {}
        }
    } catch (e) {} finally { isProcessing = false; }
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

const APP = express();
APP.use(express.json());

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

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings));
    res.json({ status: "ok" });
});

APP.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MONCEY D. LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono:wght@400;700&display=swap');
        :root { --luffy-red: #ff4d4d; --bg-dark: #0a0a0c; }
        body { background: var(--bg-dark); color: #eee; font-family: 'Inter', sans-serif; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); }
        .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: var(--luffy-red); }
    </style>
</head>
<body class="p-4">
    <header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <h1 class="luffy-font text-5xl text-white uppercase leading-none italic">Moncey D. Luffy</h1>
            <span id="ipStatus" class="mono text-blue-400 text-xs font-bold uppercase">System Active</span>
        </div>
        <div class="flex gap-8 items-center">
            <div class="text-right">
                <p class="text-[10px] text-gray-500 uppercase font-bold">KHO BÁU USDT</p>
                <p id="balance" class="text-3xl font-black text-yellow-400 mono">$0.00</p>
            </div>
            <div id="botStatusText" class="px-4 py-1 bg-gray-800 rounded font-black text-xs">OFFLINE</div>
        </div>
    </header>

    <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <div class="card p-2">
            <label class="text-[10px] text-gray-500 font-bold block mb-1 uppercase">Vốn Lệnh</label>
            <div class="flex gap-1">
                <input type="number" id="invValue" class="w-full bg-black/40 p-1 text-xs mono text-white" value="\${botSettings.invValue}">
                <select id="invType" class="bg-black text-[10px] text-yellow-500 font-bold">
                    <option value="percent" \${botSettings.invType==='percent'?'selected':''}>%</option>
                    <option value="fixed" \${botSettings.invType==='fixed'?'selected':''}>$</option>
                </select>
            </div>
        </div>
        <div class="card p-2">
            <label class="text-[10px] text-gray-500 font-bold block mb-1 uppercase">Lọc Sóng %</label>
            <input type="number" id="minVol" class="w-full bg-black/40 p-1 text-xs mono text-red-400 font-bold" value="\${botSettings.minVol}">
        </div>
        <div class="card p-2">
            <label class="text-[10px] text-gray-500 font-bold block mb-1 uppercase">Max Slot</label>
            <input type="number" id="maxPositions" class="w-full bg-black/40 p-1 text-xs mono" value="\${botSettings.maxPositions}">
        </div>
        <div class="card p-2">
            <label class="text-[10px] text-gray-500 font-bold block mb-1 uppercase">Dừng Tổng %</label>
            <input type="number" id="accountSL" class="w-full bg-black/40 p-1 text-xs mono" value="\${botSettings.accountSL}">
        </div>
        <div class="card p-2 flex items-center">
            <button id="runBtn" onclick="handleToggle()" class="btn-start w-full h-full rounded-xl text-[11px] font-black py-2 uppercase">🚢 Giương Buồm</button>
        </div>
        <div class="card p-2 flex items-center">
            <button onclick="handleUpdate()" class="bg-white/5 border border-white/10 w-full h-full rounded-xl text-[10px] font-bold py-2 uppercase">Cập Nhật</button>
        </div>
    </div>

    <div class="flex-grow grid grid-cols-12 gap-4 overflow-hidden">
        <div class="col-span-3 card flex flex-col overflow-hidden border-t-4 border-yellow-500">
            <div class="p-3 border-b border-white/5 bg-yellow-500/10 font-black text-xs text-yellow-500 uppercase italic">📡 Sóng Dữ Live</div>
            <div id="signalList" class="flex-grow overflow-y-auto p-2 space-y-2"></div>
        </div>
        <div class="col-span-6 card flex flex-col overflow-hidden border-t-4 border-red-500">
            <div class="p-3 border-b border-white/5 bg-red-500/10 flex justify-between items-center">
                <span class="luffy-font text-2xl text-red-500 italic uppercase">Hải Chiến</span>
                <span id="posCount" class="bg-red-600 px-3 py-1 text-[10px] font-black rounded-lg">0 LỆNH</span>
            </div>
            <div class="flex-grow overflow-y-auto">
                <table class="w-full text-left text-[11px] mono">
                    <thead class="bg-black/80 sticky top-0 text-gray-500 uppercase text-[9px]">
                        <tr><th class="p-4">Cặp Tiền</th><th class="p-4">Side/Lev</th><th class="p-4">Entry/Mark</th><th class="p-4 text-right">PnL %</th></tr>
                    </thead>
                    <tbody id="positionTable"></tbody>
                </table>
            </div>
        </div>
        <div class="col-span-3 card flex flex-col overflow-hidden border-t-4 border-blue-500">
            <div class="p-3 border-b border-white/5 bg-blue-500/10 font-black text-xs text-blue-400 uppercase italic">Hải Trình Log</div>
            <div id="botLogs" class="flex-grow overflow-y-auto p-3 mono text-[10px] space-y-1"></div>
        </div>
    </div>

    <script>
        let isRunning = false;
        async function sync() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                isRunning = data.botSettings.isRunning;
                document.getElementById('balance').innerText = \`$\${(data.status.currentBalance || 0).toFixed(2)}\`;
                document.getElementById('posCount').innerText = \`\${data.activePositions.length} LỆNH\`;
                const txt = document.getElementById('botStatusText');
                txt.innerText = isRunning ? "ĐANG TUẦN TRA" : "OFFLINE";
                txt.className = \`px-4 py-1 rounded font-black text-xs \${isRunning ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}\`;
                const btn = document.getElementById('runBtn');
                btn.innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
                btn.className = isRunning ? "btn-stop w-full h-full rounded-xl text-[11px] font-black py-2 uppercase" : "btn-start w-full h-full rounded-xl text-[11px] font-black py-2 uppercase";
                document.getElementById('signalList').innerHTML = data.status.candidatesList.map(c => \`
                    <div class="flex justify-between items-center p-2 bg-white/5 rounded-lg border border-white/5">
                        <span class="font-bold text-white text-xs uppercase">\${c.symbol}</span>
                        <span class="\${c.changePercent >= 0 ? 'text-green-400' : 'text-red-400'} font-black mono text-xs">\${c.changePercent}%</span>
                    </div>
                \`).join('');
                document.getElementById('positionTable').innerHTML = data.activePositions.map(p => \`
                    <tr class="hover:bg-white/5 border-b border-white/5">
                        <td class="p-4 font-bold text-white uppercase">\${p.symbol}</td>
                        <td class="p-4"><span class="\${p.side === 'LONG' ? 'text-green-400' : 'text-red-400'} font-black italic">\${p.side} \${p.leverage}x</span></td>
                        <td class="p-4 text-[10px] text-gray-400">\${p.entryPrice}<br>\${p.markPrice}</td>
                        <td class="p-4 text-right font-black \${parseFloat(p.pnlPercent) >= 0 ? 'text-green-400' : 'text-red-400'}">\${p.pnlPercent}%</td>
                    </tr>
                \`).join('');
                document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`
                    <div class="mb-1"><span class="text-gray-600">[\${l.time}]</span> \${l.msg}</div>
                \`).join('');
            } catch (e) {}
        }
        async function handleToggle() {
            isRunning = !isRunning;
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning }) });
        }
        async function handleUpdate() {
            const body = {
                invValue: parseFloat(document.getElementById('invValue').value),
                invType: document.getElementById('invType').value,
                minVol: parseFloat(document.getElementById('minVol').value),
                maxPositions: parseInt(document.getElementById('maxPositions').value),
                accountSL: parseFloat(document.getElementById('accountSL').value)
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
        }
        setInterval(sync, 2000);
        sync();
    </script>
</body>
</html>`);
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
            addBotLog("Hệ thống khởi tạo thành công", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 2000);
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 10000);

APP.listen(9001, '0.0.0.0');
