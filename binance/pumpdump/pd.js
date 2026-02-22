import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- LOGIC BOT (Giữ nguyên cấu trúc của bạn) ---
let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [], topOpportunities: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;
let coinCooldowns = new Map(); 
let lastLogMessage = ""; // Chặn spam log

// --- HÀM LOG CHỐNG SPAM ---
function addBotLog(msg, type = 'info') {
    if (msg === lastLogMessage) return; // Nếu tin nhắn giống hệt tin trước thì không lưu
    lastLogMessage = msg;

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
}

// --- LẤY DỮ LIỆU TỪ CỔNG 9000 ---
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const raw = JSON.parse(d);
                const all = raw.live || [];
                const now = Date.now();

                // Lấy Top 5 biến động mạnh nhất cho UI
                status.topOpportunities = [...all]
                    .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5)))
                    .slice(0, 5);

                status.candidatesList = all.filter(c => {
                    if (coinCooldowns.has(c.symbol) && (now - coinCooldowns.get(c.symbol) < 15 * 60 * 1000)) return false;
                    return Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol || Math.abs(c.c15) >= botSettings.minVol;
                });
            } catch (e) {}
        });
    }).on('error', () => { addBotLog("Mất kết nối Port 9000", "error"); });
}

// (Các hàm callBinance, hunt, cleanup, enforceTPSL của bạn giữ nguyên ở đây...)
// ...

const APP = express();
APP.use(express.json());

// --- TRANG HTML GỐC (TRẢ LẠI NGUYÊN VẸN) ---
APP.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
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
        body { background: var(--bg-dark); color: #eee; font-family: 'Inter', sans-serif; background-image: radial-gradient(circle at 50% 50%, rgba(255, 0, 0, 0.05) 0%, transparent 80%); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); backdrop-filter: blur(15px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .glow-text { text-shadow: 0 0 15px rgba(255, 77, 77, 0.7); }
        .avatar-container { position: relative; width: 70px; height: 70px; flex-shrink: 0; }
        .avatar-img { width: 100%; height: 100%; object-fit: cover; border-radius: 12px; border: 2px solid var(--luffy-red); background: #1a1a1a; }
        .btn-action { transition: all 0.3s ease; font-weight: 900; text-transform: uppercase; }
        .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); box-shadow: 0 4px 15px rgba(34, 197, 94, 0.4); }
        .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }
        .status-tag { font-size: 9px; padding: 2px 8px; border-radius: 4px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.1); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: var(--luffy-red); border-radius: 10px; }
        
        /* Style bổ sung cho Top 5 Cơ hội */
        .opp-card { background: rgba(255,255,255,0.05); border-radius: 10px; padding: 8px; border-left: 3px solid #444; min-width: 120px; }
    </style>
</head>
<body class="p-2 md:p-6">
    <header class="card p-4 mb-4 flex flex-wrap justify-between items-center gap-4 border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <div class="avatar-container">
                <div class="avatar-img flex items-center justify-center">
                    <svg viewBox="0 0 100 100" class="w-12 h-12"><path d="M50 15 L85 45 L85 55 L15 55 L15 45 Z" fill="#EAB308"/> <rect x="15" y="48" width="70" height="4" fill="#EF4444"/> <circle cx="50" cy="65" r="25" fill="#FBD38D"/> <circle cx="42" cy="65" r="3" fill="#000"/> <circle cx="58" cy="65" r="3" fill="#000"/> <path d="M42 75 Q50 82 58 75" stroke="#000" stroke-width="2" fill="none"/> </svg>
                </div>
                <div class="absolute -top-2 -left-2 bg-yellow-500 text-black text-[9px] font-black px-1.5 rounded uppercase">Captain</div>
            </div>
            <div>
                <h1 class="luffy-font text-3xl md:text-5xl text-white glow-text uppercase leading-none">Moncey D. Luffy</h1>
                <div class="flex gap-2 mt-2">
                    <span id="ipStatus" class="status-tag mono text-blue-400 font-bold tracking-tighter">IP: SCANNING...</span>
                    <span id="botStatusText" class="status-tag text-gray-500 uppercase font-black">OFFLINE</span>
                </div>
            </div>
        </div>
        <div class="flex gap-4 md:gap-8 items-center bg-black/50 p-4 rounded-2xl border border-white/5 shadow-inner">
            <div class="text-center">
                <p class="text-[10px] text-gray-500 uppercase font-bold tracking-widest">KHO BÁU USDT</p>
                <p id="balance" class="text-3xl font-black text-yellow-400 mono glow-yellow">$0.00</p>
            </div>
        </div>
    </header>

    <div id="topOpportunities" class="flex gap-3 mb-4 overflow-x-auto pb-2">
        </div>

    <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <div class="card p-3 flex flex-col justify-center">
            <label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Vốn Lệnh</label>
            <div class="flex gap-1">
                <input type="number" id="invValue" class="w-full bg-black/40 border border-white/10 p-2 rounded text-xs mono text-white outline-none" value="1.5">
                <select id="invType" class="bg-black border border-white/10 p-1 rounded text-[10px] text-yellow-500 font-bold">
                    <option value="percent">%</option>
                    <option value="fixed">$</option>
                </select>
            </div>
        </div>
        <div class="card p-3 flex flex-col justify-center">
            <label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Lọc Sóng %</label>
            <input type="number" id="minVol" class="w-full bg-black/40 border border-white/10 p-2 rounded text-xs text-red-400 font-bold mono" value="5.0">
        </div>
        <div class="card p-3 flex flex-col justify-center">
            <label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Số Lệnh Max</label>
            <input type="number" id="maxPositions" class="w-full bg-black/40 border border-white/10 p-2 rounded text-xs mono" value="10">
        </div>
        <div class="card p-3 flex flex-col justify-center">
            <label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Dừng Tổng %</label>
            <input type="number" id="accountSL" class="w-full bg-black/40 border border-white/10 p-2 rounded text-xs text-orange-400 mono" value="30">
        </div>
        <div class="card p-2 flex items-center justify-center">
            <button id="runBtn" onclick="handleToggle()" class="btn-action btn-start w-full h-full rounded-xl text-[11px] font-black">🚢 GIƯƠNG BUỒM</button>
        </div>
        <div class="card p-2 flex items-center justify-center">
            <button onclick="handleUpdate()" class="btn-action bg-white/5 border border-white/10 w-full h-full rounded-xl text-[10px] text-gray-300 font-bold">CẬP NHẬT</button>
        </div>
    </div>

    <div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-4 overflow-hidden">
        <div class="md:col-span-4 flex flex-col gap-4 overflow-hidden">
            <div class="card flex-grow flex flex-col overflow-hidden border-t-4 border-blue-500">
                <div class="p-3 border-b border-white/5 bg-blue-500/5 flex justify-between items-center">
                    <span class="text-[10px] font-black text-blue-400 uppercase tracking-widest italic">Nhật ký hải trình</span>
                </div>
                <div id="botLogs" class="flex-grow overflow-y-auto p-3 mono text-[10px] space-y-1 text-zinc-400"></div>
            </div>
        </div>
        <div class="md:col-span-8 card flex flex-col overflow-hidden border-t-4 border-red-500">
            <div class="p-4 border-b border-white/5 flex justify-between bg-red-500/5 items-center">
                <h3 class="luffy-font text-2xl text-red-500 tracking-widest uppercase italic">Chiến trường Live</h3>
                <span id="posCount" class="px-4 py-1 bg-red-600 text-white text-[10px] font-black rounded-lg">0 LỆNH</span>
            </div>
            <div class="flex-grow overflow-y-auto">
                <table class="w-full text-left text-[11px] mono">
                    <thead class="bg-black/80 sticky top-0 text-gray-500 uppercase text-[9px] border-b border-white/10">
                        <tr><th class="p-4">Cặp Tiền</th><th class="p-4">Side</th><th class="p-4">Entry/Mark</th><th class="p-4 text-right">PnL%</th></tr>
                    </thead>
                    <tbody id="positionTable" class="divide-y divide-white/5"></tbody>
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
                
                // Hiển thị Top 5 Cơ hội
                document.getElementById('topOpportunities').innerHTML = (data.status.topOpportunities || []).map(o => \`
                    <div class="opp-card" style="border-left-color: \${o.c5 > 0 ? '#22c55e' : '#ef4444'}">
                        <div class="text-[9px] text-gray-500 font-bold">\${o.symbol}</div>
                        <div class="\${o.c5 > 0 ? 'text-green-400' : 'text-red-400'} font-black text-xs">\${o.c5 > 0 ? '▲' : '▼'} \${o.c5.toFixed(2)}%</div>
                    </div>
                \`).join('');

                isRunning = data.botSettings.isRunning;
                const btn = document.getElementById('runBtn');
                btn.innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
                btn.className = isRunning ? "btn-action btn-stop w-full h-full rounded-xl text-[11px] font-black" : "btn-action btn-start w-full h-full rounded-xl text-[11px] font-black";
                
                document.getElementById('balance').innerText = "$" + (data.status.currentBalance || 0).toFixed(2);
                document.getElementById('posCount').innerText = data.activePositions.length + " LỆNH";
                document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`<div>[\${l.time}] \${l.msg}</div>\`).join('');
                document.getElementById('positionTable').innerHTML = data.activePositions.map(p => \`
                    <tr class="hover:bg-white/5 border-b border-white/5">
                        <td class="p-4 font-bold text-white">\${p.symbol}</td>
                        <td class="p-4 \${p.side==='LONG'?'text-green-400':'text-red-400'} font-black italic">\${p.side}</td>
                        <td class="p-4 text-gray-500">\${p.entryPrice} → \${p.markPrice}</td>
                        <td class="p-4 text-right font-black \${parseFloat(p.pnlPercent)>=0?'text-green-400':'text-red-400'}">\${p.pnlPercent}%</td>
                    </tr>
                \`).join('');
            } catch(e){}
        }
        async function handleToggle() { isRunning = !isRunning; await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning }) }); }
        async function handleUpdate() {
            const body = { invValue: parseFloat(document.getElementById('invValue').value), invType: document.getElementById('invType').value, minVol: parseFloat(document.getElementById('minVol').value), maxPositions: parseInt(document.getElementById('maxPositions').value), accountSL: parseFloat(document.getElementById('accountSL').value) };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
        }
        setInterval(sync, 2000); sync();
    </script>
</body>
</html>
    `);
});

// (Các API status, settings và khởi chạy Server 9001 giữ nguyên...)
APP.listen(9001, '0.0.0.0');
