import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
// Đảm bảo bạn có file config.js chứa API_KEY và SECRET_KEY
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'fixed', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [], activePositions: [] };
let botManagedSymbols = []; 
let cooldownList = {}; 
let isInitializing = true;
let isProcessing = false;

// --- UTILS ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
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
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// --- CORE LOGIC ---
async function clearOrders(symbol) {
    return callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
}

async function updateBotStatus() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        status.activePositions = positions
            .filter(p => parseFloat(p.positionAmt) !== 0)
            .map(p => ({
                symbol: p.symbol,
                side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                leverage: p.leverage,
                entryPrice: parseFloat(p.entryPrice).toFixed(4),
                markPrice: parseFloat(p.markPrice).toFixed(4),
                pnlPercent: ((parseFloat(p.unRealizedProfit) / (parseFloat(p.isolatedWallet) || 1)) * 100).toFixed(2)
            }));

        // Cleanup managed list & Cooldown
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const sym = botManagedSymbols[i];
            if (!status.activePositions.find(p => p.symbol === sym)) {
                addBotLog(`🏁 ${sym} đã đóng. Ngủ đông 15p.`, "success");
                await clearOrders(sym);
                cooldownList[sym] = Date.now() + 15 * 60 * 1000;
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) { console.error("Lỗi cập nhật trạng thái:", e.message); }
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    if (botManagedSymbols.length >= botSettings.maxPositions) return;

    for (const c of status.candidatesList) {
        if (botManagedSymbols.includes(c.symbol) || (cooldownList[c.symbol] && Date.now() < cooldownList[c.symbol])) continue;
        
        const maxVol = Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15));
        if (maxVol >= botSettings.minVol) {
            isProcessing = true;
            try {
                const side = c.c1 > 0 ? 'BUY' : 'SELL';
                const posSide = c.c1 > 0 ? 'LONG' : 'SHORT';
                const info = status.exchangeInfo[c.symbol];
                
                if (!info) continue;

                // 1. Set Leverage
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: 20 });
                
                // 2. Tính số lượng (Qty) dựa trên invValue (mặc định Margin 10x cho an toàn)
                // Công thức: Qty = (Vốn * Đòn bẩy) / Giá hiện tại
                const price = c.currentPrice;
                let qty = (botSettings.invValue * 20) / price; 
                qty = parseFloat(qty.toFixed(info.quantityPrecision));

                if (qty === 0) {
                    addBotLog(`Số lượng quá nhỏ cho ${c.symbol}`, "error");
                } else {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: Math.abs(qty)
                    });
                    botManagedSymbols.push(c.symbol);
                    addBotLog(`🚢 GIƯƠNG BUỒM: ${c.symbol} [${posSide}] Qty: ${qty}`, "success");
                }
            } catch (e) { 
                addBotLog(`Lỗi lệnh ${c.symbol}: ${e.message}`, "error"); 
            }
            isProcessing = false;
            break; // Chỉ vào 1 lệnh mỗi chu kỳ quét để tránh spam
        }
    }
}

// --- EXPRESS SERVER ---
const APP = express();
APP.use(express.json());

APP.get('/', (req, res) => {
    // Render lại y nguyên UI Luffy của bạn
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
        body { background: var(--bg-dark); color: #eee; font-family: 'Inter', sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background: rgba(15, 15, 20, 0.9); backdrop-filter: blur(15px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .glow-text { text-shadow: 0 0 15px rgba(255, 77, 77, 0.7); }
        .avatar-container { position: relative; width: 70px; height: 70px; flex-shrink: 0; }
        .avatar-img { width: 100%; height: 100%; border-radius: 12px; border: 2px solid var(--luffy-red); background: #1a1a1a; display: flex; align-items: center; justify-content: center;}
        .btn-action { transition: all 0.3s ease; font-weight: 900; text-transform: uppercase; }
        .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); box-shadow: 0 4px 15px rgba(34, 197, 94, 0.4); }
        .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .status-tag { font-size: 9px; padding: 2px 8px; border-radius: 4px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.1); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: var(--luffy-red); border-radius: 10px; }
    </style>
</head>
<body class="p-2 md:p-6">
    <header class="card p-4 mb-4 flex flex-wrap justify-between items-center gap-4 border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <div class="avatar-container">
                <div class="avatar-img">
                    <svg viewBox="0 0 100 100" class="w-12 h-12">
                        <path d="M50 15 L85 45 L85 55 L15 55 L15 45 Z" fill="#EAB308"/> 
                        <rect x="15" y="48" width="70" height="4" fill="#EF4444"/> 
                        <circle cx="50" cy="65" r="25" fill="#FBD38D"/> 
                        <circle cx="42" cy="65" r="3" fill="#000"/> <circle cx="58" cy="65" r="3" fill="#000"/> 
                        <path d="M42 75 Q50 82 58 75" stroke="#000" stroke-width="2" fill="none"/> 
                    </svg>
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
                <p id="balance" class="text-3xl font-black text-yellow-400 mono">$0.00</p>
            </div>
            <div class="h-12 w-[1px] bg-white/10"></div>
            <div class="text-center">
                <p class="text-[10px] text-gray-500 uppercase font-bold tracking-widest">BOUNTY TOP 5</p>
                <div id="top5Bounty" class="flex gap-2 mt-1"></div>
            </div>
        </div>
    </header>

    <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <div class="card p-3 flex flex-col justify-center">
            <label class="text-[10px] text-gray-500 font-bold uppercase mb-1">Vốn Lệnh ($)</label>
            <input type="number" id="invValue" class="w-full bg-black/40 border border-white/10 p-2 rounded text-xs mono text-white outline-none" value="1.5">
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
        <div class="card p-2">
            <button id="runBtn" onclick="handleToggle()" class="btn-action btn-start w-full h-full rounded-xl text-[11px] font-black">🚢 GIƯƠNG BUỒM</button>
        </div>
        <div class="card p-2">
            <button onclick="handleUpdate()" class="btn-action bg-white/5 border border-white/10 w-full h-full rounded-xl text-[10px] text-gray-300 font-bold">CẬP NHẬT</button>
        </div>
    </div>

    <div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-4 overflow-hidden">
        <div class="md:col-span-4 flex flex-col gap-4 overflow-hidden">
            <div class="card flex-grow flex flex-col overflow-hidden border-t-4 border-blue-500">
                <div class="p-3 border-b border-white/5 bg-blue-500/5 flex justify-between items-center">
                    <span class="text-[10px] font-black text-blue-400 uppercase tracking-widest italic">Nhật ký hải trình</span>
                    <button onclick="clearLogsUI()" class="text-[9px] text-gray-600">Xóa</button>
                </div>
                <div id="botLogs" class="flex-grow overflow-y-auto p-3 mono text-[10px] space-y-2"></div>
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
                        <tr><th class="p-4">Cặp Tiền</th><th class="p-4">Side/Lev</th><th class="p-4">Entry/Mark</th><th class="p-4 text-right">PnL %</th></tr>
                    </thead>
                    <tbody id="positionTable" class="divide-y divide-white/5"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let isRunning = false;
        async function checkPublicIP() {
            try {
                const res = await fetch('https://api.ipify.org?format=json');
                const data = await res.json();
                document.getElementById('ipStatus').innerText = "IP WAN: " + data.ip;
                document.getElementById('ipStatus').classList.replace('text-blue-400', 'text-green-400');
            } catch (e) { document.getElementById('ipStatus').innerText = "IP: OFFLINE"; }
        }

        function updateUI(status_bool) {
            isRunning = status_bool;
            const btn = document.getElementById('runBtn');
            const txt = document.getElementById('botStatusText');
            if(isRunning) {
                btn.innerText = "🛑 HẠ BUỒM"; btn.className = "btn-action btn-stop w-full h-full rounded-xl text-[11px] font-black";
                txt.innerText = "ĐANG TUẦN TRA..."; txt.className = "status-tag text-green-500 border-green-500/50";
            } else {
                btn.innerText = "🚢 GIƯƠNG BUỒM"; btn.className = "btn-action btn-start w-full h-full rounded-xl text-[11px] font-black";
                txt.innerText = "OFFLINE"; txt.className = "status-tag text-gray-500";
            }
        }

        async function sync() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                if(data.botSettings.isRunning !== isRunning) updateUI(data.botSettings.isRunning);
                document.getElementById('balance').innerText = \`$\${data.status.currentBalance.toFixed(2)}\`;
                document.getElementById('posCount').innerText = \`\${data.activePositions.length} LỆNH\`;
                
                const top5 = data.status.candidatesList.slice(0, 5);
                document.getElementById('top5Bounty').innerHTML = top5.map(c => \`
                    <div class="bg-white/5 px-2 py-1 rounded border border-white/10 text-[10px]">
                        <span class="text-white font-bold">\${c.symbol.replace('USDT','')}</span>
                        <span class="\${c.c1 >= 0 ? 'text-green-400':'text-red-400'}">\${c.c1}%</span>
                    </div>
                \`).join('');

                document.getElementById('positionTable').innerHTML = data.activePositions.map(p => \`
                    <tr class="hover:bg-white/5 border-b border-white/5">
                        <td class="p-4 font-bold text-white text-xs">\${p.symbol}</td>
                        <td class="p-4"><span class="\${p.side === 'LONG' ? 'text-green-400' : 'text-red-400'} font-black italic mr-1">\${p.side} \${p.leverage}x</span></td>
                        <td class="p-4 text-[10px]"><span class="text-gray-500">\$\${p.entryPrice}</span><br><span class="text-white">\$\${p.markPrice}</span></td>
                        <td class="p-4 text-right font-black \${parseFloat(p.pnlPercent) >= 0 ? 'text-green-400' : 'text-red-400'} text-xs">\${p.pnlPercent}%</td>
                    </tr>\`).join('');

                document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`
                    <div class="border-l-2 \${l.type === 'success' ? 'border-green-500' : l.type === 'error' ? 'border-red-500' : 'border-blue-500'} pl-2 py-1 bg-white/5">
                        <span class="text-zinc-600">[\${l.time}]</span> \${l.msg}
                    </div>\`).join('');
            } catch (e) {}
        }

        async function handleToggle() {
            const next = !isRunning;
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning: next }) });
            updateUI(next);
        }

        async function handleUpdate() {
            const body = {
                invValue: parseFloat(document.getElementById('invValue').value),
                minVol: parseFloat(document.getElementById('minVol').value),
                maxPositions: parseInt(document.getElementById('maxPositions').value),
                accountSL: parseFloat(document.getElementById('accountSL').value)
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            alert("Đã cập nhật lệnh truy nã!");
        }

        function clearLogsUI() { document.getElementById('botLogs').innerHTML = ''; }
        checkPublicIP(); setInterval(sync, 2000);
    </script>
</body>
</html>
    `);
});

APP.get('/api/status', (req, res) => res.json({ botSettings, status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ status: "ok" }); });

// --- INIT BOT ---
async function startBot() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision };
        });
        isInitializing = false;
        addBotLog("Hệ thống đã sẵn sàng ra khơi!", "info");
    } catch (e) {
        console.error("Lỗi khởi tạo:", e.message);
        setTimeout(startBot, 5000);
    }
    
    // Đồng bộ candidates từ Server 9000
    setInterval(() => {
        http.get('http://127.0.0.1:9000/api/live', res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => { 
                try { 
                    status.candidatesList = JSON.parse(d); 
                } catch(e){} 
            });
        }).on('error', () => { /* Server 9000 chưa bật */ });
    }, 2000);

    setInterval(updateBotStatus, 4000);
    setInterval(hunt, 2000);
}

APP.listen(9001, '0.0.0.0', () => {
    console.log("LUFFY BOT READY ON PORT 9001");
    startBot();
});
