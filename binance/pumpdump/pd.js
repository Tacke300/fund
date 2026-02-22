import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
// Đảm bảo file config.js của bạn có API_KEY và SECRET_KEY
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
app.use(express.json());

let botSettings = { isRunning: false, maxPositions: 5, invValue: 1.5, minVol: 5.0 };
let status = { currentBalance: 0, botLogs: [], candidatesList: [], activePositions: [], exchangeInfo: {} };
let botManagedSymbols = new Set();

// --- TIỆN ÍCH BINANCE ---
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

// --- LOGIC ĐIỀU KHIỂN CHÍNH ---
async function patrol() {
    // 1. Lấy dữ liệu từ Server 9000
    http.get('http://127.0.0.1:9000/api/live', (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try { 
                const data = JSON.parse(d);
                status.candidatesList = data;
            } catch(e) {}
        });
    }).on('error', () => {});

    if (!botSettings.isRunning) return;

    // 2. Quét điều kiện vào lệnh
    for (const coin of status.candidatesList) {
        if (botManagedSymbols.has(coin.symbol) || status.activePositions.length >= botSettings.maxPositions) continue;

        const vol = Math.max(Math.abs(coin.c1), Math.abs(coin.c5), Math.abs(coin.c15));
        if (vol >= botSettings.minVol) {
            executeTrade(coin);
            break; // Mỗi giây chỉ vào 1 lệnh để tránh nghẽn
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
        // Đòn bẩy cố định 20x để tối ưu tốc độ
        const qty = parseFloat(((botSettings.invValue * 20) / coin.currentPrice).toFixed(info?.quantityPrecision || 2));

        if (qty <= 0) {
            botManagedSymbols.delete(symbol);
            return;
        }

        await binanceReq('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        const order = await binanceReq('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty
        });

        if (order.orderId) {
            addLog(`🚀 GIƯƠNG BUỒM: ${symbol} [${posSide}]`, 'success');
        } else {
            botManagedSymbols.delete(symbol);
            addLog(`❌ Lệnh ${symbol} thất bại`, 'error');
        }
    } catch (e) {
        botManagedSymbols.delete(symbol);
    }
}

async function syncAccount() {
    const acc = await binanceReq('/fapi/v2/account');
    if (acc.totalMarginBalance) status.currentBalance = parseFloat(acc.totalMarginBalance);
    
    const pos = await binanceReq('/fapi/v2/positionRisk');
    if (Array.isArray(pos)) {
        status.activePositions = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol,
            side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
            leverage: p.leverage,
            entryPrice: parseFloat(p.entryPrice).toFixed(4),
            markPrice: parseFloat(p.markPrice).toFixed(4),
            pnlPercent: ((parseFloat(p.unRealizedProfit) / (parseFloat(p.isolatedWallet) || 1)) * 100).toFixed(2)
        }));
        
        // Giải phóng symbol nếu lệnh đã đóng trên sàn
        botManagedSymbols.forEach(s => {
            if (!status.activePositions.find(p => p.symbol === s)) botManagedSymbols.delete(s);
        });
    }
}

// --- API & GIAO DIỆN ---
app.get('/api/status', (req, res) => res.json({ botSettings, status }));
app.post('/api/settings', (req, res) => { botSettings = {...botSettings, ...req.body}; res.json({ok:true}); });

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>LUFFY BOT DASHBOARD</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono:wght@400;700&display=swap');
        body { background: #0a0a0c; color: #eee; font-family: 'Inter', sans-serif; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; }
        .up { color: #22c55e; } .down { color: #ef4444; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #ff4d4d; border-radius: 10px; }
    </style>
</head>
<body class="p-3">
    <header class="card p-4 mb-3 flex justify-between items-center border-b-2 border-red-500">
        <div>
            <h1 class="luffy-font text-4xl text-white uppercase">Moncey D. Luffy</h1>
            <div id="statusTag" class="text-[10px] font-bold text-gray-500">OFFLINE</div>
        </div>
        <div class="text-right">
            <div class="text-[10px] text-gray-500 font-bold uppercase">Kho báu USDT</div>
            <div id="balance" class="text-3xl font-black text-yellow-400 mono">$0.00</div>
        </div>
        <button id="runBtn" onclick="toggleBot()" class="bg-green-600 hover:bg-green-500 px-8 py-3 rounded-xl font-black text-white transition-all">🚢 GIƯƠNG BUỒM</button>
    </header>

    <div class="grid grid-cols-4 gap-3 mb-3">
        <div class="card p-3">
            <label class="text-[10px] text-gray-500 font-bold block uppercase">Vốn Lệnh ($)</label>
            <input type="number" id="invValue" class="bg-transparent text-white font-bold mono outline-none w-full" value="1.5">
        </div>
        <div class="card p-3">
            <label class="text-[10px] text-gray-500 font-bold block uppercase">Lọc Sóng (%)</label>
            <input type="number" id="minVol" class="bg-transparent text-red-500 font-bold mono outline-none w-full" value="5.0">
        </div>
        <div class="card p-3">
            <label class="text-[10px] text-gray-500 font-bold block uppercase">Số Lệnh Max</label>
            <input type="number" id="maxPositions" class="bg-transparent text-white font-bold mono outline-none w-full" value="5">
        </div>
        <button onclick="updateSettings()" class="card bg-white/10 hover:bg-white/20 font-bold text-xs uppercase">Cập Nhật</button>
    </div>

    <div class="flex-grow grid grid-cols-12 gap-3 overflow-hidden">
        <div class="col-span-3 card flex flex-col overflow-hidden">
            <div class="p-3 border-b border-white/5 text-[10px] font-bold text-blue-400 uppercase">Nhật ký hải trình</div>
            <div id="logs" class="p-3 text-[10px] mono space-y-2 overflow-y-auto flex-grow"></div>
        </div>
        <div class="col-span-9 card flex flex-col overflow-hidden border-t-2 border-red-500">
            <table class="w-full text-left text-[11px] mono">
                <thead class="bg-black/50 sticky top-0 uppercase text-[9px] text-gray-500">
                    <tr><th class="p-3">Cặp Tiền</th><th class="p-3">1M %</th><th class="p-3">5M %</th><th class="p-3">15M %</th><th class="p-3 text-right">PnL %</th></tr>
                </thead>
                <tbody id="tableBody"></tbody>
            </table>
        </div>
    </div>

    <script>
        let isRunning = false;
        async function sync() {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            isRunning = data.botSettings.isRunning;
            const btn = document.getElementById('runBtn');
            btn.innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
            btn.className = isRunning ? "bg-red-600 px-8 py-3 rounded-xl font-black text-white" : "bg-green-600 px-8 py-3 rounded-xl font-black text-white";
            
            document.getElementById('statusTag').innerText = isRunning ? "ĐANG TUẦN TRA..." : "OFFLINE";
            document.getElementById('balance').innerText = "$" + data.status.currentBalance.toFixed(2);

            document.getElementById('logs').innerHTML = data.status.botLogs.map(l => \`
                <div class="border-l-2 border-white/10 pl-2">[\${l.time}] \${l.msg}</div>
            \`).join('');

            const active = data.status.activePositions;
            const candidates = data.status.candidatesList.slice(0, 15);

            let html = active.map(p => \`
                <tr class="bg-red-500/10 font-bold">
                    <td class="p-3 text-white">\${p.symbol} [\${p.side}]</td>
                    <td class="p-3">-</td><td class="p-3">-</td><td class="p-3">-</td>
                    <td class="p-3 text-right \${p.pnlPercent >= 0 ? 'up' : 'down'}">\${p.pnlPercent}%</td>
                </tr>
            \`).join('');

            document.getElementById('tableBody').innerHTML = html + candidates.map(c => \`
                <tr class="opacity-50 border-b border-white/5">
                    <td class="p-3">\${c.symbol}</td>
                    <td class="p-3 \${c.c1 >= 0 ? 'up' : 'down'}">\${c.c1}%</td>
                    <td class="p-3 \${c.c5 >= 0 ? 'up' : 'down'}">\${c.c5}%</td>
                    <td class="p-3 \${c.c15 >= 0 ? 'up' : 'down'}">\${c.c15}%</td>
                    <td class="p-3 text-right text-gray-600">WATCHING</td>
                </tr>
            \`).join('');
        }

        async function toggleBot() {
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({isRunning: !isRunning}) });
            sync();
        }

        async function updateSettings() {
            const body = {
                invValue: parseFloat(document.getElementById('invValue').value),
                minVol: parseFloat(document.getElementById('minVol').value),
                maxPositions: parseInt(document.getElementById('maxPositions').value)
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
            alert("Đã cập nhật!");
        }

        setInterval(sync, 1000);
    </script>
</body>
</html>
    `);
});

// --- KHỞI CHẠY ---
app.listen(9001, async () => {
    console.log("⚓ LUFFY BOT READY ON PORT 9001");
    const info = await binanceReq('/fapi/v1/exchangeInfo');
    info.symbols?.forEach(s => status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision });
    
    setInterval(patrol, 1000);      // Quét Server 9000 mỗi giây
    setInterval(syncAccount, 3000); // Đồng bộ tài khoản mỗi 3 giây
});
