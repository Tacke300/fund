import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CẤU HÌNH ---
let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [], topOpportunities: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;
let coinCooldowns = new Map(); 
let lastLogMessage = ""; 

// --- HÀM LOG CHẶN SPAM ---
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
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
            });
        });
        req.end();
    });
}

// --- LẤY DỮ LIỆU TỪ PORT 9000 ---
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const raw = JSON.parse(d);
                const all = raw.live || [];
                // Cập nhật Top 5 Cơ hội
                status.topOpportunities = [...all]
                    .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5)))
                    .slice(0, 5);
                // Cập nhật Danh sách lọc vào lệnh
                status.candidatesList = all.filter(c => Math.abs(c.c5) >= botSettings.minVol);
            } catch (e) {}
        });
    }).on('error', () => {});
}

// --- SERVER EXPRESS ---
const APP = express();
APP.use(express.json());

// API: Lấy trạng thái cho UI
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
    } catch (e) { res.status(500).json({ error: "Binance Error" }); }
});

// API: Cập nhật cài đặt từ UI (Nút bấm)
APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog(`⚙️ Đã cập nhật cấu hình mới`, "warn");
    res.json({ success: true });
});

// GIAO DIỆN CHÍNH
APP.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>MONCEY D. LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono:wght@400;700&display=swap');
        :root { --luffy-red: #ff4d4d; --bg-dark: #0a0a0c; }
        body { background: var(--bg-dark); color: #eee; font-family: 'Inter', sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); backdrop-filter: blur(15px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); }
        .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); }
        .opp-card { background: rgba(255,255,255,0.05); border-left: 3px solid #444; padding: 8px; border-radius: 8px; min-width: 130px; }
    </style>
</head>
<body class="p-4">
    <header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <h1 class="luffy-font text-4xl text-white uppercase">Moncey D. Luffy</h1>
            <span id="botStatusText" class="text-[10px] px-2 py-1 bg-black rounded text-gray-500 font-bold">OFFLINE</span>
        </div>
        <div class="text-right">
            <p class="text-[10px] text-gray-500 font-bold uppercase">Kho Báu USDT</p>
            <p id="balance" class="text-3xl font-black text-yellow-400 mono">$0.00</p>
        </div>
    </header>

    <div id="topOpp" class="flex gap-3 mb-4 overflow-hidden"></div>

    <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <div class="card p-3 flex flex-col"><label class="text-[10px] text-gray-500 font-bold">VỐN %</label><input type="number" id="invValue" class="bg-transparent mono text-white" value="1.5"></div>
        <div class="card p-3 flex flex-col"><label class="text-[10px] text-gray-500 font-bold">LỌC SÓNG %</label><input type="number" id="minVol" class="bg-transparent mono text-red-400" value="5.0"></div>
        <div class="card p-3 flex flex-col"><label class="text-[10px] text-gray-500 font-bold">MAX LỆNH</label><input type="number" id="maxPositions" class="bg-transparent mono" value="10"></div>
        <div class="card p-3 flex flex-col"><label class="text-[10px] text-gray-500 font-bold">DỪNG TỔNG %</label><input type="number" id="accountSL" class="bg-transparent mono text-orange-400" value="30"></div>
        <button id="runBtn" onclick="handleToggle()" class="btn-start rounded-xl font-black text-[11px]">🚢 GIƯƠNG BUỒM</button>
        <button onclick="handleUpdate()" class="card text-gray-300 font-bold text-[10px]">CẬP NHẬT</button>
    </div>

    <div class="flex-grow grid grid-cols-12 gap-4 overflow-hidden">
        <div class="col-span-4 card flex flex-col overflow-hidden"><div id="botLogs" class="p-3 mono text-[10px] space-y-1 overflow-y-auto"></div></div>
        <div class="col-span-8 card overflow-hidden">
            <table class="w-full text-left text-[11px] mono">
                <thead class="bg-black/80 sticky top-0 text-gray-500 text-[9px] border-b border-white/10">
                    <tr><th class="p-4">CẶP TIỀN</th><th class="p-4">SIDE</th><th class="p-4">ENTRY/MARK</th><th class="p-4 text-right">PNL%</th></tr>
                </thead>
                <tbody id="positionTable" class="divide-y divide-white/5"></tbody>
            </table>
        </div>
    </div>

    <script>
        async function sync() {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            // Cập nhật Top 5 Coin
            document.getElementById('topOpp').innerHTML = data.status.topOpportunities.map(o => \`
                <div class="opp-card" style="border-left-color: \${o.c5 > 0 ? '#22c55e' : '#ef4444'}">
                    <div class="text-[10px] text-gray-500 font-bold">\${o.symbol}</div>
                    <div class="text-xs font-black \${o.c5 > 0 ? 'text-green-400' : 'text-red-400'}">\${o.c5.toFixed(2)}%</div>
                </div>
            \`).join('');

            document.getElementById('botStatusText').innerText = data.botSettings.isRunning ? "PATROLLING" : "OFFLINE";
            document.getElementById('runBtn').innerText = data.botSettings.isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
            document.getElementById('runBtn').className = data.botSettings.isRunning ? "btn-stop rounded-xl font-black text-[11px]" : "btn-start rounded-xl font-black text-[11px]";
            document.getElementById('balance').innerText = "$" + (data.status.currentBalance || 0).toFixed(2);
            document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`<div>[\${l.time}] \${l.msg}</div>\`).join('');
            document.getElementById('positionTable').innerHTML = data.activePositions.map(p => \`
                <tr><td class="p-4 font-bold text-white">\${p.symbol}</td><td class="p-4 \${p.side==='LONG'?'text-green-400':'text-red-400'} font-black">\${p.side}</td><td class="p-4 text-gray-500">\${p.entryPrice}→\${p.markPrice}</td><td class="p-4 text-right font-black \${parseFloat(p.pnlPercent)>=0?'text-green-400':'text-red-400'}">\${p.pnlPercent}%</td></tr>
            \`).join('');
        }

        async function handleToggle() {
            const current = document.getElementById('runBtn').innerText.includes("GIƯƠNG");
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning: current }) });
            sync();
        }

        async function handleUpdate() {
            const body = { 
                invValue: parseFloat(document.getElementById('invValue').value), 
                minVol: parseFloat(document.getElementById('minVol').value), 
                maxPositions: parseInt(document.getElementById('maxPositions').value), 
                accountSL: parseFloat(document.getElementById('accountSL').value) 
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
        }
        setInterval(sync, 2000); sync();
    </script>
</body>
</html>
    `);
});

// KHỞI CHẠY
setInterval(fetchCandidates, 3000);
APP.listen(9001, '0.0.0.0', () => console.log("Luffy Bot is sailing on Port 9001"));
