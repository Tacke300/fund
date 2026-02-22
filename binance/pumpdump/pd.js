import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
app.use(express.json());

let botSettings = { isRunning: false, maxPositions: 5, invValue: 1.5, minVol: 5.0 };
let status = { currentBalance: 0, botLogs: [], candidatesList: [], activePositions: [], exchangeInfo: {} };
let botManagedSymbols = new Set();

async function binanceReq(path, method = 'GET', params = {}) {
    const ts = Date.now();
    const query = new URLSearchParams({...params, timestamp: ts, recvWindow: 10000}).toString();
    const sig = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const url = `https://fapi.binance.com${path}?${query}&signature=${sig}`;
    return new Promise((res) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, r => {
            let d = ''; r.on('data', chunk => d += chunk);
            r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { res({}); } });
        });
        req.on('error', () => res({}));
        req.end();
    });
}

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
}

async function patrol() {
    http.get('http://127.0.0.1:9000/api/live', (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d); } catch(e) {} });
    }).on('error', () => {});

    if (!botSettings.isRunning) return;

    for (const coin of status.candidatesList) {
        if (botManagedSymbols.has(coin.symbol) || status.activePositions.length >= botSettings.maxPositions) continue;
        const vol = Math.max(Math.abs(coin.c1), Math.abs(coin.c5), Math.abs(coin.c15));
        if (vol >= botSettings.minVol) {
            executeTrade(coin);
            break;
        }
    }
}

async function executeTrade(coin) {
    const symbol = coin.symbol;
    const side = coin.c1 > 0 ? 'BUY' : 'SELL';
    const posSide = coin.c1 > 0 ? 'LONG' : 'SHORT';
    botManagedSymbols.add(symbol); 
    try {
        const info = status.exchangeInfo[symbol];
        const qty = parseFloat(((botSettings.invValue * 20) / coin.currentPrice).toFixed(info?.quantityPrecision || 2));
        if (qty <= 0) { botManagedSymbols.delete(symbol); return; }
        await binanceReq('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        const order = await binanceReq('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });
        if (order.orderId) { 
            addLog(`🚀 [${posSide}] ${symbol} thành công!`, 'success'); 
        } else { 
            botManagedSymbols.delete(symbol);
            addLog(`❌ Lỗi đặt lệnh ${symbol}: ${order.msg || 'Unknown'}`, 'error');
        }
    } catch (e) { botManagedSymbols.delete(symbol); }
}

async function syncAccount() {
    const acc = await binanceReq('/fapi/v2/account');
    if (acc.totalMarginBalance) status.currentBalance = parseFloat(acc.totalMarginBalance);
    const pos = await binanceReq('/fapi/v2/positionRisk');
    if (Array.isArray(pos)) {
        status.activePositions = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol, 
            side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
            entryPrice: parseFloat(p.entryPrice).toFixed(4),
            markPrice: parseFloat(p.markPrice).toFixed(4),
            pnlPercent: ((parseFloat(p.unRealizedProfit) / (parseFloat(p.isolatedWallet) || 1)) * 100).toFixed(2)
        }));
        botManagedSymbols.forEach(s => { 
            if (!status.activePositions.find(p => p.symbol === s)) botManagedSymbols.delete(s); 
        });
    }
}

app.get('/api/status', (req, res) => res.json({ botSettings, status }));
app.post('/api/settings', (req, res) => { botSettings = {...botSettings, ...req.body}; res.json({ok:true}); });

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MONCEY D. LUFFY | DASHBOARD</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono:wght@400;700&display=swap');
        :root { --luffy-red: #ff4d4d; --luffy-yellow: #ffbe0b; --bg-dark: #0a0a0c; }
        body { background: var(--bg-dark); color: #eee; font-family: 'Inter', sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); backdrop-filter: blur(15px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); box-shadow: 0 4px 15px rgba(34, 197, 94, 0.4); }
        .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: var(--luffy-red); border-radius: 10px; }
        .status-tag { font-size: 10px; padding: 2px 8px; border-radius: 4px; background: rgba(0,0,0,0.5); }
        .up { color: #22c55e; } .down { color: #ef4444; }
    </style>
</head>
<body class="p-2 md:p-4">
    <header class="card p-4 mb-3 flex flex-wrap justify-between items-center gap-4 border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <div class="w-12 h-12 bg-yellow-500 rounded-lg flex items-center justify-center text-black text-2xl font-black italic">L</div>
            <div>
                <h1 class="luffy-font text-3xl text-white uppercase leading-none">MONCEY D. LUFFY</h1>
                <div class="flex gap-2 mt-1">
                    <span id="botStatusText" class="status-tag text-gray-500 font-bold uppercase">OFFLINE</span>
                    <span id="balance" class="status-tag text-yellow-400 mono font-bold">$0.00</span>
                </div>
            </div>
        </div>
        
        <div class="flex-grow max-w-2xl hidden md:flex gap-2 overflow-x-auto" id="topBounty"></div>

        <div class="flex gap-2">
            <button id="runBtn" onclick="toggleBot()" class="px-6 py-2 rounded-xl font-black text-white btn-start transition-all uppercase">🚢 Giương Buồm</button>
        </div>
    </header>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div class="card p-3">
            <label class="text-[10px] text-gray-500 font-bold uppercase block">Vốn Lệnh ($)</label>
            <input type="number" id="invValue" class="w-full bg-transparent text-white font-bold mono outline-none" value="1.5">
        </div>
        <div class="card p-3">
            <label class="text-[10px] text-gray-500 font-bold uppercase block">Lọc Sóng (%)</label>
            <input type="number" id="minVol" class="w-full bg-transparent text-red-500 font-bold mono outline-none" value="5.0">
        </div>
        <div class="card p-3">
            <label class="text-[10px] text-gray-500 font-bold uppercase block">Max Lệnh</label>
            <input type="number" id="maxPositions" class="w-full bg-transparent text-white font-bold mono outline-none" value="5">
        </div>
        <button onclick="updateSettings()" class="card bg-white/5 hover:bg-white/10 font-bold text-xs uppercase transition-all">Cập Nhật</button>
    </div>

    <div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-3 overflow-hidden">
        <div class="md:col-span-3 card flex flex-col overflow-hidden">
            <div class="p-3 border-b border-white/5 text-[10px] font-bold text-blue-400 uppercase tracking-widest italic">Nhật ký hải trình</div>
            <div id="botLogs" class="flex-grow overflow-y-auto p-3 mono text-[10px] space-y-2"></div>
        </div>

        <div class="md:col-span-9 card flex flex-col overflow-hidden border-t-2 border-red-500">
            <div class="p-3 border-b border-white/5 flex justify-between items-center">
                <span class="luffy-font text-xl text-red-500 uppercase">Chiến trường Live</span>
                <span id="posCount" class="text-[10px] bg-red-600 px-2 py-0.5 rounded font-bold uppercase">0 Lệnh</span>
            </div>
            <div class="flex-grow overflow-y-auto">
                <table class="w-full text-left text-[11px] mono">
                    <thead class="bg-black/50 sticky top-0 text-gray-500 uppercase text-[9px]">
                        <tr>
                            <th class="p-3">Cặp Tiền</th>
                            <th class="p-3">1M %</th>
                            <th class="p-3">5M %</th>
                            <th class="p-3">15M %</th>
                            <th class="p-3 text-right">PnL %</th>
                        </tr>
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
                
                isRunning = data.botSettings.isRunning;
                const btn = document.getElementById('runBtn');
                btn.innerText = isRunning ? "🛑 Hạ Buồm" : "🚢 Giương Buồm";
                btn.className = isRunning ? "px-6 py-2 rounded-xl font-black text-white btn-stop" : "px-6 py-2 rounded-xl font-black text-white btn-start";
                
                document.getElementById('botStatusText').innerText = isRunning ? "Đang tuần tra..." : "OFFLINE";
                document.getElementById('botStatusText').className = isRunning ? "status-tag text-green-400 font-bold" : "status-tag text-gray-500 font-bold";
                document.getElementById('balance').innerText = "$" + data.status.currentBalance.toFixed(2);
                document.getElementById('posCount').innerText = data.status.activePositions.length + " LỆNH";

                document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`
                    <div class="border-l-2 border-white/20 pl-2 py-1">
                        <span class="text-gray-500">[\${l.time}]</span> \${l.msg}
                    </div>
                \`).join('');

                const active = data.status.activePositions;
                const candidates = data.status.candidatesList.slice(0, 15);

                let html = active.map(p => \`
                    <tr class="bg-red-500/10 font-bold border-l-4 border-red-500">
                        <td class="p-3 text-white">\${p.symbol} <span class="text-[9px] bg-white/10 px-1">\${p.side}</span></td>
                        <td class="p-3">-</td><td class="p-3">-</td><td class="p-3">-</td>
                        <td class="p-3 text-right font-bold \${p.pnlPercent >= 0 ? 'up' : 'down'}">\${p.pnlPercent}%</td>
                    </tr>
                \`).join('');

                document.getElementById('positionTable').innerHTML = html + candidates.map(c => \`
                    <tr class="opacity-40 hover:opacity-100 transition-all border-b border-white/5">
                        <td class="p-3 text-gray-400">\${c.symbol}</td>
                        <td class="p-3 \${c.c1 >= 0 ? 'up' : 'down'}">\${c.c1}%</td>
                        <td class="p-3 \${c.c5 >= 0 ? 'up' : 'down'} font-bold bg-white/5">\${c.c5}%</td>
                        <td class="p-3 \${c.c15 >= 0 ? 'up' : 'down'}">\${c.c15}%</td>
                        <td class="p-3 text-right text-gray-600 italic">Watching</td>
                    </tr>
                \`).join('');

                document.getElementById('topBounty').innerHTML = candidates.slice(0, 5).map(c => \`
                    <div class="bg-white/5 px-3 py-1 rounded-lg border border-white/10 text-[10px] whitespace-nowrap">
                        <span class="text-gray-500 font-bold">\${c.symbol}</span>
                        <span class="ml-1 font-bold \${c.c1 >= 0 ? 'up' : 'down'}">\${c.c1}%</span>
                    </div>
                \`).join('');

            } catch (e) {}
        }

        async function toggleBot() {
            await fetch('/api/settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ isRunning: !isRunning })
            });
            sync();
        }

        async function updateSettings() {
            const body = {
                invValue: parseFloat(document.getElementById('invValue').value),
                minVol: parseFloat(document.getElementById('minVol').value),
                maxPositions: parseInt(document.getElementById('maxPositions').value)
            };
            await fetch('/api/settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });
            alert("Đã cập nhật lệnh truy nã!");
        }

        setInterval(sync, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(9001, async () => {
    const info = await binanceReq('/fapi/v1/exchangeInfo');
    info.symbols?.forEach(s => status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision });
    setInterval(patrol, 1000);
    setInterval(syncAccount, 3000);
});
