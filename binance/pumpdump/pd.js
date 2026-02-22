import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

// --- BIẾN TOÀN CỤC ---
let coinData = {}; 
let historyMap = new Map();
let botSettings = {
    isRunning: false,
    invValue: 1.5,
    invType: 'fixed',
    minVol: 5.0,
    maxPositions: 10,
    accountSL: 30
};
let activePositions = []; // Giả lập danh sách lệnh đang chạy

// --- HELPER FUNCTIONS ---
function getPivotTime() {
    const now = new Date();
    let pivot = new Date(now);
    pivot.setHours(7, 0, 0, 0);
    if (now < pivot) pivot.setDate(pivot.getDate() - 1);
    return pivot.getTime();
}

async function callPublicAPI(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return new Promise((res, rej) => {
        https.get(`https://fapi.binance.com${path}${qs ? '?' + qs : ''}`, (r) => {
            let d = ''; r.on('data', chunk => d += chunk);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    if (!startPriceObj) return 0;
    return parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2));
}

// --- CORE LOGIC ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        
        tickers.forEach(t => {
            const s = t.s; 
            const p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices = coinData[s].prices.slice(-100);

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            let hist = historyMap.get(s);
            
            // 1. Kiểm tra Win/Lose cho lệnh cũ
            if (hist && hist.status === 'PENDING') {
                const diff = ((p - hist.snapPrice) / hist.snapPrice) * 100;
                if (hist.type === 'DOWN' && (diff <= -5 || diff >= 5)) hist.status = diff <= -5 ? 'WIN' : 'LOSE';
                if (hist.type === 'UP' && (diff >= 5 || diff <= -5)) hist.status = diff >= 5 ? 'WIN' : 'LOSE';
            }

            // 2. Logic Mở Lệnh (Ghi vào History)
            if (botSettings.isRunning && (Math.abs(c1) >= botSettings.minVol || Math.abs(c5) >= botSettings.minVol || Math.abs(c15) >= botSettings.minVol)) {
                if (!hist || hist.status !== 'PENDING') {
                    const type = (c1 >= botSettings.minVol || c5 >= botSettings.minVol || c15 >= botSettings.minVol) ? 'UP' : 'DOWN';
                    historyMap.set(s, { 
                        symbol: s, startTime: now, snapPrice: p, 
                        max1: c1, max5: c5, max15: c15,
                        type: type, status: 'PENDING' 
                    });
                    // Giảm Log Spam: Chỉ in ra console khi mở lệnh mới
                    console.log(`[BOT] Mở lệnh ${type} cho ${s} tại giá ${p}`);
                }
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
}

// --- API ROUTES ---
app.use(express.json());

app.get('/api/status', (req, res) => {
    const pivot = getPivotTime();
    const historyArr = Array.from(historyMap.values());
    
    // Lấy top biến động cho bảng Live
    const live = Object.entries(coinData)
        .filter(([_, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live }))
        .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5), Math.abs(b.c15)) - Math.max(Math.abs(a.c1), Math.abs(a.c5), Math.abs(a.c15)))
        .slice(0, 10);

    res.json({
        botSettings,
        live,
        history: historyArr.sort((a,b) => b.startTime - a.startTime).slice(0, 20),
        stats: {
            win: historyArr.filter(h => h.startTime >= pivot && h.status === 'WIN').length,
            lose: historyArr.filter(h => h.startTime >= pivot && h.status === 'LOSE').length
        },
        activePositions // Trong thực tế bạn sẽ lấy từ Binance API
    });
});

app.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ status: 'ok' });
});

// --- GUI ---
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8"><title>LUFFY ENGINE V5</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono&display=swap" rel="stylesheet">
    <style>
        body { background: #0a0a0c; color: #eee; font-family: 'Inter', sans-serif; overflow-x: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); backdrop-filter: blur(15px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .up { color: #22c55e; } .down { color: #ef4444; }
        .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); }
        .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #ff4d4d; }
    </style>
</head>
<body class="p-4">
    <header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <h1 class="luffy-font text-4xl text-white uppercase italic">Moncey D. Luffy Bot</h1>
            <span id="botStatusText" class="px-2 py-1 rounded text-[10px] font-black bg-gray-800">OFFLINE</span>
        </div>
        <div class="flex gap-6 text-center">
            <div><p class="text-[9px] text-gray-500 uppercase">Win (7h)</p><p id="winStats" class="text-xl font-bold up">0</p></div>
            <div><p class="text-[9px] text-gray-500 uppercase">Lose (7h)</p><p id="loseStats" class="text-xl font-bold down">0</p></div>
        </div>
    </header>

    <div class="grid grid-cols-12 gap-4 mb-4">
        <div class="col-span-12 md:col-span-3 card p-4 space-y-3">
            <div><label class="text-[10px] text-gray-400">BIẾN ĐỘNG %</label>
            <input type="number" id="minVol" class="w-full bg-black/50 border border-white/10 p-2 rounded text-sm mono" value="5"></div>
            <div><label class="text-[10px] text-gray-400">VỐN LỆNH ($)</label>
            <input type="number" id="invValue" class="w-full bg-black/50 border border-white/10 p-2 rounded text-sm mono" value="1.5"></div>
            <button id="runBtn" onclick="handleToggle()" class="w-full p-3 rounded-xl font-black text-sm btn-start">🚢 GIƯƠNG BUỒM</button>
            <button onclick="handleUpdate()" class="w-full text-[10px] text-gray-500 uppercase font-bold">Lưu Cài Đặt</button>
        </div>

        <div class="col-span-12 md:col-span-4 card overflow-hidden">
            <div class="p-2 bg-blue-500/10 border-b border-white/5 text-[10px] font-black text-blue-400">🚀 LIVE VOLATILITY (SERVER)</div>
            <table class="w-full text-[11px] mono">
                <tbody id="liveBody"></tbody>
            </table>
        </div>

        <div class="col-span-12 md:col-span-5 card overflow-hidden">
            <div class="p-2 bg-red-500/10 border-b border-white/5 text-[10px] font-black text-red-400">📊 HISTORY SIGNALS</div>
            <div class="max-h-[300px] overflow-y-auto">
                <table class="w-full text-[10px] mono">
                    <tbody id="historyBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let isRunning = false;
        async function refresh() {
            try {
                const res = await fetch('/api/status');
                const d = await res.json();
                
                // Cập nhật trạng thái Bot
                isRunning = d.botSettings.isRunning;
                const btn = document.getElementById('runBtn');
                btn.innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
                btn.className = \`w-full p-3 rounded-xl font-black text-sm \${isRunning ? 'btn-stop' : 'btn-start'}\`;
                document.getElementById('botStatusText').innerText = isRunning ? "RUNNING" : "OFFLINE";
                document.getElementById('botStatusText').className = \`px-2 py-1 rounded text-[10px] font-black \${isRunning ? 'bg-green-600' : 'bg-gray-800'}\`;

                // Cập nhật Stats
                document.getElementById('winStats').innerText = d.stats.win;
                document.getElementById('loseStats').innerText = d.stats.lose;

                // Cập nhật Live Table
                document.getElementById('liveBody').innerHTML = d.live.map(c => \`
                    <tr class="border-b border-white/5">
                        <td class="p-2 font-bold">\${c.symbol}</td>
                        <td class="p-2 \${c.c1 >= 0 ? 'up':'down'}">1m: \${c.c1}%</td>
                        <td class="p-2 \${c.c5 >= 0 ? 'up':'down'}">5m: \${c.c5}%</td>
                        <td class="p-2 \${c.c15 >= 0 ? 'up':'down'}">15m: \${c.c15}%</td>
                    </tr>
                \`).join('');

                // Cập nhật History Table
                document.getElementById('historyBody').innerHTML = d.history.map(h => \`
                    <tr class="border-b border-white/5">
                        <td class="p-2 text-gray-500">\${new Date(h.startTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
                        <td class="p-2 font-bold \${h.type === 'UP' ? 'up':'down'}">\${h.symbol}</td>
                        <td class="p-2 text-right font-black \${h.status === 'WIN' ? 'up' : (h.status === 'LOSE' ? 'down' : 'text-gray-500')}">\${h.status}</td>
                    </tr>
                \`).join('');
            } catch(e) {}
        }

        async function handleToggle() {
            isRunning = !isRunning;
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning }) });
            refresh();
        }

        async function handleUpdate() {
            const body = {
                minVol: parseFloat(document.getElementById('minVol').value),
                invValue: parseFloat(document.getElementById('invValue').value)
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            alert("Đã cập nhật cấu hình!");
        }

        setInterval(refresh, 1000); refresh();
    </script>
</body>
</html>`);
});

// --- KHỞI CHẠY ---
async function start() {
    console.log("⚓ Đang nạp dữ liệu hải trình...");
    if (fs.existsSync(HISTORY_FILE)) {
        try { historyMap = new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE)))); } catch(e){}
    }
    initWS();
}

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Luffy Engine v5 đã sẵn sàng tại cảng ${port}`);
    start();
});

setInterval(() => {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(historyMap)));
}, 60000);
