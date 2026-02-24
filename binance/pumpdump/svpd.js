// ================= CONFIGURATION =================
const MIN_VOLATILITY_TO_SAVE = 0.5; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
// =================================================

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 

async function fetchActualLeverage() {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const options = { hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`, headers: { 'X-MBX-APIKEY': API_KEY } };
    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                if (Array.isArray(brackets)) {
                    brackets.forEach(item => { if (item.brackets?.[0]) symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage; });
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                }
            } catch (e) {}
        });
    });
}

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const start = pArr.find(i => i.t >= (pArr[pArr.length-1].t - min*60000));
    return start ? parseFloat(((pArr[pArr.length-1].p - start.p) / start.p * 100).toFixed(2)) : 0;
}

function initWS() {
    fetchActualLeverage();
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'DOWN' ? diff <= -5 : diff >= 5;
                const lose = pending.type === 'DOWN' ? diff >= 5 : diff <= -5;
                if (win || lose) { pending.status = win ? 'WIN' : 'LOSE'; pending.finalPrice = p; pending.endTime = now; fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); }
            }
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending) {
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapVol: { c1, c5, c15 }, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20 });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,15),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.startTime-a.startTime).slice(0,20)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: -apple-system, system-ui, sans-serif; overflow-x: hidden; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #161a1e; }
        .dot-border { border-bottom: 1px dotted #5e6673; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 10px 0; font-size: 13px; font-weight: 500; text-align: center; }
        .yellow-btn { background: #fcd535; color: #000; padding: 10px; border-radius: 6px; font-size: 14px; font-weight: 600; flex: 1; text-align: center; }
        .tab-active { color: #fff; border-bottom: 2px solid #fcd535; padding-bottom: 8px; }
        ::-webkit-scrollbar { width: 0px; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] border-b border-zinc-800">
        <div id="configArea" class="flex gap-2 mb-4">
            <input id="balanceInp" type="number" value="1000" class="bg-[#1e2329] border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none">
            <input id="marginInp" type="text" value="10%" class="bg-[#1e2329] border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none">
            <button onclick="toggleBot(true)" class="bg-green-600 px-6 py-2 rounded font-bold uppercase text-xs">Start</button>
        </div>
        <div id="userArea" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic">BINANCE <span class="text-[#fcd535]">PRO</span></h1></div>
             <div onclick="toggleBot(false)" class="text-[#fcd535] text-2xl font-black italic cursor-pointer animate-pulse">Moncey_D_Luffy</div>
        </div>

        <div class="text-zinc-400 text-sm flex items-center gap-1 mb-1">Số dư margin <i class="far fa-eye text-xs"></i></div>
        <div class="flex items-center gap-2 mb-4">
            <span id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</span>
            <span class="text-lg font-medium">USDT</span>
        </div>
        <div class="grid grid-cols-2 gap-4 mb-6 text-sm">
            <div><div class="text-zinc-500 text-xs mb-1">Số dư ví (USDT)</div><div id="walletBal" class="font-bold">0.00</div></div>
            <div class="text-right"><div class="text-zinc-500 text-xs mb-1">PNL chưa ghi nhận</div><div id="unPnl" class="font-bold">0.00</div></div>
        </div>
        <div class="flex gap-2"><div class="yellow-btn">Giao dịch</div><div class="bg-[#2b3139] p-2 flex-1 rounded text-center text-sm font-bold pt-3">Hoán đổi</div><div class="bg-[#2b3139] p-2 flex-1 rounded text-center text-sm font-bold pt-3">Chuyển</div></div>
    </div>

    <div class="px-4 py-2"><div style="height: 100px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mt-4">
        <div class="flex gap-6 mb-6 border-b border-zinc-800 text-[13px] font-bold text-zinc-500">
            <span class="tab-active">Vị thế</span>
            <span>Lệnh chờ(0)</span>
            <span>Lịch sử lệnh</span>
            <span>Lịch sử giao dịch</span>
        </div>
        <div id="pendingContainer" class="space-y-10 pb-10"></div>
    </div>

    <div class="px-4 grid grid-cols-1 gap-6 pb-24">
        <div class="bg-[#161a1e] rounded p-2">
            <div class="text-[10px] font-bold text-zinc-500 mb-2 uppercase italic tracking-widest">Volatility (1m | 5m)</div>
            <table class="w-full text-[11px] text-left"><tbody id="liveBody"></tbody></table>
        </div>
        <div class="bg-[#161a1e] rounded p-2 overflow-hidden">
            <div class="text-[10px] font-bold text-zinc-500 mb-2 uppercase italic tracking-widest">Real History Log</div>
            <table class="w-full text-[10px] text-left">
                <thead class="text-zinc-600 border-b border-zinc-800"><tr><th class="pb-1">TIME</th><th class="pb-1">COIN/LEV</th><th class="pb-1 text-right">PNL</th><th class="pb-1 text-right">STATUS</th></tr></thead>
                <tbody id="historyBody" class="font-mono"></tbody>
            </table>
        </div>
    </div>

    <script>
    let running = false, initialBal = 0, historyLog = [];
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

    if(localStorage.getItem('bot_luffy_v3')) {
        const s = JSON.parse(localStorage.getItem('bot_luffy_v3'));
        running = s.running; initialBal = s.initialBal; historyLog = s.historyLog || [];
        if(running) applyState(true);
    }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }]},
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function toggleBot(state) {
        running = state;
        if(running) {
            initialBal = parseFloat(document.getElementById('balanceInp').value);
            historyLog = [{t: Date.now(), b: initialBal}];
        }
        applyState(state);
        save();
    }

    function applyState(state) {
        document.getElementById('configArea').style.display = state ? 'none' : 'flex';
        document.getElementById('userArea').style.display = state ? 'flex' : 'none';
    }

    function save() { localStorage.setItem('bot_luffy_v3', JSON.stringify({ running, initialBal, historyLog })); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now(); let totalUnPnl = 0;

            document.getElementById('liveBody').innerHTML = d.live.slice(0,8).map(c => \`
                <tr class="border-b border-zinc-900"><td class="py-1 font-bold">\${c.symbol}</td><td class="\${c.c1>=0?'up':'down'}">\${c.c1}%</td><td class="\${c.c5>=0?'up':'down'} text-right">\${c.c5}%</td></tr>\`).join('');

            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                const livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                const margin = document.getElementById('marginInp').value.includes('%') ? (initialBal * parseFloat(document.getElementById('marginInp').value) / 100) : parseFloat(document.getElementById('marginInp').value);
                const roi = (h.type === 'UP' ? ((livePrice - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - livePrice)/h.snapPrice)*100) * (h.maxLev);
                const pnl = margin * roi / 100; totalUnPnl += pnl;

                return \`<div>
                    <div class="flex items-center gap-2 mb-4">
                        <span class="w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold \${h.type==='UP'?'bg-[#0ecb81]/20 up':'bg-[#f6465d]/20 down'}">\${h.type==='UP'?'L':'S'}</span>
                        <span class="font-bold text-lg">\${h.symbol}</span>
                        <span class="bg-[#2b3139] px-1 rounded text-zinc-400 text-[10px]">Cross \${h.maxLev}X</span>
                    </div>
                    <div class="grid grid-cols-2 mb-4">
                        <div><div class="text-zinc-500 text-xs dot-border inline-block mb-1">PNL (USDT)</div><div class="text-2xl font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</div></div>
                        <div class="text-right"><div class="text-zinc-500 text-xs inline-block mb-1">ROI</div><div class="text-2xl font-bold \${pnl>=0?'up':'down'}">\${roi.toFixed(2)}%</div></div>
                    </div>
                    <div class="grid grid-cols-3 text-xs mb-3 text-zinc-400">
                        <div><div>Kích thước</div><div class="text-white font-bold">\${(margin*h.maxLev).toFixed(2)}</div></div>
                        <div class="text-center"><div>Margin</div><div class="text-white font-bold">\${margin.toFixed(2)}</div></div>
                        <div class="text-right"><div>Tỉ lệ ký quỹ</div><div class="up font-bold">6.51%</div></div>
                    </div>
                    <div class="grid grid-cols-3 text-xs mb-5 text-zinc-400 border-b border-zinc-800 pb-4">
                        <div><div>Giá vào</div><div class="text-white font-bold">\${h.snapPrice.toFixed(4)}</div></div>
                        <div class="text-center"><div>Giá đánh dấu</div><div class="text-zinc-200">\${livePrice.toFixed(4)}</div></div>
                        <div class="text-right"><div>Giá thanh lý</div><div class="text-orange-300 font-bold">--</div></div>
                    </div>
                    <div class="grid grid-cols-3 gap-2"><div class="binance-btn">Đòn bẩy</div><div class="binance-btn">TP/SL</div><div class="binance-btn">Đóng</div></div>
                </div>\`;
            }).join('');

            let totalClosedP = 0;
            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                const margin = document.getElementById('marginInp').value.includes('%') ? (initialBal * parseFloat(document.getElementById('marginInp').value) / 100) : parseFloat(document.getElementById('marginInp').value);
                let pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                totalClosedP += pnl;
                return \`<tr class="border-b border-zinc-900"><td class="py-2 text-zinc-600">\${new Date(h.startTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td><td class="font-bold">\${h.symbol} \${h.maxLev}x</td><td class="text-right \${pnl>=0?'up':'down'}">\${pnl.toFixed(1)}$</td><td class="text-right font-black \${h.status==='WIN'?'up':'down'}">\${h.status}</td></tr>\`;
            }).join('');

            if(running) {
                const currentBal = initialBal + totalClosedP + totalUnPnl;
                document.getElementById('displayBal').innerText = currentBal.toFixed(2);
                document.getElementById('walletBal').innerText = (initialBal + totalClosedP).toFixed(2);
                document.getElementById('unPnl').innerText = totalUnPnl.toFixed(2);
                document.getElementById('unPnl').className = totalUnPnl >= 0 ? 'font-bold up' : 'font-bold down';
                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) { historyLog.push({t: now, b: currentBal}); if(historyLog.length > 60) historyLog.shift(); save(); }
                chart.data.labels = historyLog.map(pt => pt.t); chart.data.datasets[0].data = historyLog.map(pt => pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); });
