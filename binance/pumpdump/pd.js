import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CẤU HÌNH GỐC ---
let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [], topOpportunities: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;
let coinCooldowns = new Map(); 
let lastLogMessage = ""; // Biến chặn spam log

// --- HÀM LOG CHẶN SPAM ---
function addBotLog(msg, type = 'info') {
    if (msg === lastLogMessage) return; // Chặn nếu tin nhắn trùng tin trước đó
    lastLogMessage = msg;

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

// LẤY TÍN HIỆU VÀ TOP 5 (SỬA LỖI KẾT NỐI SERVER)
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const raw = JSON.parse(d);
                const all = raw.live || [];
                const now = Date.now();

                // Lấy Top 5 biến động mạnh nhất (Cơ hội)
                status.topOpportunities = [...all]
                    .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5)))
                    .slice(0, 5);

                // Lọc danh sách vào lệnh
                status.candidatesList = all.filter(c => {
                    if (coinCooldowns.has(c.symbol) && (now - coinCooldowns.get(c.symbol) < 15 * 60 * 1000)) return false;
                    return Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol || Math.abs(c.c15) >= botSettings.minVol;
                });
            } catch (e) { console.log("Lỗi parse data 9000"); }
        });
    }).on('error', () => { console.log("Không kết nối được Port 9000"); });
}

// Các hàm xử lý giao dịch (Hunt, Cleanup, TPSL...) giữ nguyên như bản đầu của bạn
// [LƯU Ý: Đoạn này bạn giữ nguyên code xử lý lệnh của bạn nhé]

// --- GIAO DIỆN HTML (GIỮ NGUYÊN GỐC LUFFY CỦA BẠN) ---
const APP = express();
APP.use(express.json());

APP.get('/', (req, res) => {
    // Chỉ chèn thêm 1 dòng hiển thị TOP 5 vào giữa header và settings
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>MONCEY D. LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        /* GIỮ NGUYÊN TOÀN BỘ CSS CỦA BẠN */
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono:wght@400;700&display=swap');
        :root { --luffy-red: #ff4d4d; --luffy-yellow: #ffbe0b; --bg-dark: #0a0a0c; }
        body { background: var(--bg-dark); color: #eee; font-family: 'Inter', sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); backdrop-filter: blur(15px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        /* Thêm style cho thẻ cơ hội nhỏ */
        .opp-card { background: rgba(255,255,255,0.03); border-left: 2px solid #555; padding: 5px 10px; border-radius: 8px; }
    </style>
</head>
<body class="p-2 md:p-6">
    <header class="card p-4 mb-4 flex flex-wrap justify-between items-center gap-4 border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <div class="luffy-font text-3xl md:text-5xl text-white glow-text uppercase leading-none">Moncey D. Luffy</div>
        </div>
        <div class="flex gap-4 md:gap-8 items-center bg-black/50 p-4 rounded-2xl border border-white/5 shadow-inner">
            <div class="text-center"><p id="balance" class="text-3xl font-black text-yellow-400 mono">$0.00</p></div>
        </div>
    </header>

    <div id="topOpp" class="flex gap-3 mb-4 overflow-x-auto">
        </div>

    <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Vốn Lệnh</label><input type="number" id="invValue" class="w-full bg-black/40 border border-white/10 p-2 rounded text-xs mono text-white" value="1.5"></div>
        <div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Lọc Sóng %</label><input type="number" id="minVol" class="w-full bg-black/40 border border-white/10 p-2 rounded text-xs text-red-400 font-bold mono" value="5.0"></div>
        <button id="runBtn" onclick="handleToggle()" class="bg-green-600 rounded-xl text-[11px] font-black">🚢 GIƯƠNG BUỒM</button>
        <button onclick="handleUpdate()" class="card text-[10px] text-gray-300 font-bold">CẬP NHẬT</button>
    </div>

    <div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-4 overflow-hidden">
        <div class="md:col-span-4 card flex flex-col overflow-hidden"><div id="botLogs" class="p-3 mono text-[10px] space-y-2 overflow-y-auto"></div></div>
        <div class="md:col-span-8 card flex flex-col overflow-hidden">
            <table class="w-full text-left text-[11px] mono">
                <tbody id="positionTable"></tbody>
            </table>
        </div>
    </div>

    <script>
        // SCRIPT GỐC CỦA BẠN + THÊM PHẦN RENDER TOP 5
        let isRunning = false;
        async function sync() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                // Hiển thị Top 5 Cơ hội
                document.getElementById('topOpp').innerHTML = (data.status.topOpportunities || []).map(o => \`
                    <div class="opp-card border-l-\${o.c5 > 0 ? 'green' : 'red'}-500">
                        <div class="text-[10px] font-bold text-gray-400">\${o.symbol}</div>
                        <div class="text-xs font-black \${o.c5 > 0 ? 'text-green-400' : 'text-red-400'}">\${o.c5 > 0 ? '▲' : '▼'} \${o.c5.toFixed(2)}%</div>
                    </div>
                \`).join('');

                // Các phần update UI khác giữ nguyên theo code của bạn
                document.getElementById('balance').innerText = \`$\${(data.status.currentBalance || 0).toFixed(2)}\`;
                document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`<div>[\${l.time}] \${l.msg}</div>\`).join('');
                // ... map positionTable ...
            } catch (e) {}
        }
        setInterval(sync, 2000);
    </script>
</body>
</html>
    `);
});

// Các API status, settings và khởi chạy giữ nguyên
APP.listen(9001, '0.0.0.0');
