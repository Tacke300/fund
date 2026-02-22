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
const HISTORY_FILE = './history_db.json';

// --- CẤU HÌNH & TRẠNG THÁI ---
let botSettings = { 
    isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 
};
if (fs.existsSync(CONFIG_FILE)) botSettings = JSON.parse(fs.readFileSync(CONFIG_FILE));

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let historyMap = new Map();
let isInitializing = true;
let isProcessing = false;

if (fs.existsSync(HISTORY_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
        data.forEach(h => historyMap.set(h.symbol, h));
    } catch (e) {}
}

// --- LOGIC SERVER (THỐNG KÊ & LỊCH SỬ) ---
function getPivotTime() {
    const now = new Date();
    let pivot = new Date(now);
    pivot.setHours(7, 0, 0, 0);
    if (now < pivot) pivot.setDate(pivot.getDate() - 1);
    return pivot.getTime();
}

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
    return new Promise((resolve, reject) => {
        const req = https.request(`https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`, { 
            method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000 
        }, res => {
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

// --- LOGIC TP/SL GỐC CỦA BẠN (KHÔNG SỬA) ---
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
                addBotLog(`🔓 [SLOT] Giải phóng ${symbol}`, "success");
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

// --- HÀM HUNT GỐC ---
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

// --- ĐỒNG BỘ DỮ LIỆU TỪ SERVER CỔNG 9000 ---
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(d);
                // Cập nhật candidates cho Bot
                status.candidatesList = data.live.map(c => ({
                    symbol: c.symbol, changePercent: c.c1, c5: c.c5, c15: c.c15, currentPrice: c.currentPrice
                }));
                // Đồng bộ lịch sử Win/Lose từ Server
                data.history.forEach(h => historyMap.set(h.symbol + h.startTime, h));
            } catch (e) {}
        });
    }).on('error', () => {});
}

// --- API & GIAO DIỆN (GIỮ NGUYÊN HTML CỦA BẠN) ---
const APP = express();
APP.use(express.json());

APP.get('/api/status', async (req, res) => {
    try {
        const pivot = getPivotTime();
        const historyArr = Array.from(historyMap.values());
        const win = historyArr.filter(h => h.startTime >= pivot && h.status === 'WIN').length;
        const lose = historyArr.filter(h => h.startTime >= pivot && h.status === 'LOSE').length;
        
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active, history: historyArr.sort((a,b)=>b.startTime-a.startTime).slice(0, 30), stats: { win, lose } });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings));
    res.json({ status: "ok" });
});

APP.get('/', (req, res) => {
    // CHÈN TOÀN BỘ HTML GIAO DIỆN LUFFY CỦA BẠN VÀO ĐÂY
    res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
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
        .up { color: #ff4d4d; } .down { color: #22c55e; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }
    </style>
</head>
<body class="p-4">
    <header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <h1 class="luffy-font text-5xl text-white uppercase leading-none italic">Moncey D. Luffy</h1>
            <div id="stats" class="mono text-xs font-bold text-gray-400"></div>
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
            <button id="runBtn" onclick="handleToggle()" class="w-full h-full rounded-xl text-[11px] font-black py-2 uppercase">🚢 GIƯƠNG BUỒM</button>
        </div>
        <div class="card p-2 flex items-center">
            <button onclick="handleUpdate()" class="bg-white/5 border border-white/10 w-full h-full rounded-xl text-[10px] font-bold py-2">CẬP NHẬT</button>
        </div>
    </div>

    <div class="flex-grow grid grid-cols-12 gap-4 overflow-hidden">
        <div class="col-span-3 card flex flex-col overflow-hidden border-t-4 border-yellow-500">
            <div class="p-3 border-b border-white/5 bg-yellow-500/10 font-black text-xs text-yellow-500 uppercase">📡 Sóng Dữ (1m|5m|15m)</div>
            <div id="signalList" class="flex-grow overflow-y-auto p-2 space-y-1"></div>
        </div>
        <div class="col-span-6 card flex flex-col overflow-hidden border-t-4 border-red-500">
            <div class="p-3 border-b border-white/5 bg-red-500/10 flex justify-between items-center">
                <span class="luffy-font text-2xl text-red-500 italic">Hải Chiến</span>
                <span id="posCount" class="bg-red-600 px-3 py-1 text-[10px] font-black rounded-lg uppercase">0 LỆNH</span>
            </div>
            <div class="flex-grow overflow-y-auto">
                <table class="w-full text-left text-[11px] mono">
                    <thead class="bg-black/80 sticky top-0 text-gray-500 uppercase text-[9px]">
                        <tr><th class="p-4">Cặp Tiền</th><th class="p-4">Side/Lev</th><th class="p-4 text-right">PnL %</th></tr>
                    </thead>
                    <tbody id="positionTable"></tbody>
                </table>
            </div>
        </div>
        <div class="col-span-3 card flex flex-col overflow-hidden border-t-4 border-blue-500">
            <div class="p-3 border-b border-white/5 bg-blue-500/10 font-black text-xs text-blue-400 uppercase italic">Hải Trình Log & Lịch Sử</div>
            <div id="historyBox" class="p-2 border-b border-white/5 bg-black/20 overflow-y-auto max-h-40"></div>
            <div id="botLogs" class="flex-grow overflow-y-auto p-3 mono text-[9px] space-y-1 text-gray-400"></div>
        </div>
    </div>

    <script>
        let isRunning = false;
        async function sync() {
            try {
                const res = await fetch('/api/status');
                const d = await res.json();
                isRunning = d.botSettings.isRunning;
                document.getElementById('balance').innerText = \`$\${(d.status.currentBalance || 0).toFixed(2)}\`;
                document.getElementById('posCount').innerText = \`\${d.activePositions.length} LỆNH\`;
                document.getElementById('stats').innerHTML = \`<span class="text-green-500">WIN: \${d.stats.win}</span> | <span class="text-red-500">LOSE: \${d.stats.lose}</span>\`;
                
                const txt = document.getElementById('botStatusText');
                txt.innerText = isRunning ? "ĐANG TUẦN TRA" : "OFFLINE";
                txt.className = \`px-4 py-1 rounded font-black text-xs \${isRunning ? 'bg-green-600' : 'bg-gray-800'}\`;
                
                const btn = document.getElementById('runBtn');
                btn.innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
                btn.className = isRunning ? "btn-stop w-full h-full rounded-xl text-[11px] font-black py-2" : "btn-start w-full h-full rounded-xl text-[11px] font-black py-2";

                document.getElementById('signalList').innerHTML = d.status.candidatesList.map(c => \`
                    <div class="flex justify-between items-center p-2 bg-white/5 rounded-lg border border-white/5 text-[10px]">
                        <span class="font-bold text-white uppercase">\${c.symbol}</span>
                        <div class="flex gap-2">
                            <span class="\${c.changePercent >= 0 ? 'up' : 'down'} font-black">\${c.changePercent}%</span>
                            <span class="text-gray-600">\${c.c5}%</span>
                        </div>
                    </div>
                \`).join('');

                document.getElementById('positionTable').innerHTML = d.activePositions.map(p => \`
                    <tr class="hover:bg-white/5 border-b border-white/5">
                        <td class="p-4 font-bold text-white uppercase">\${p.symbol}</td>
                        <td class="p-4"><span class="\${p.side === 'LONG' ? 'text-red-400' : 'text-green-400'} font-black">\${p.side} \${p.leverage}x</span></td>
                        <td class="p-4 text-right font-black \${parseFloat(p.pnlPercent) >= 0 ? 'text-green-400' : 'text-red-400'}">\${p.pnlPercent}%</td>
                    </tr>
                \`).join('');

                document.getElementById('historyBox').innerHTML = d.history.map(h => \`
                    <div class="flex justify-between text-[9px] mb-1 border-b border-white/5">
                        <span>\${h.symbol}</span>
                        <span class="\${h.status==='WIN'?'text-green-500':'text-red-500'} font-bold">\${h.status}</span>
                    </div>
                \`).join('');

                document.getElementById('botLogs').innerHTML = d.status.botLogs.map(l => \`<div>[\${l.time}] \${l.msg}</div>\`).join('');
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
        setInterval(sync, 2000); sync();
    </script>
</body>
</html>`);
});

// --- KHỞI CHẠY ---
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
setInterval(() => fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()).slice(-500))), 30000);

APP.listen(9001, '0.0.0.0');
