// ================= CONFIGURATION =================
const MIN_VOLATILITY_TO_SAVE = 5; // Theo cấu hình mới của bạn
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
// =================================================

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 

async function fetchActualLeverage() {
    https.get('https://fapi.binance.com/fapi/v1/leverageBracket', (res) => {
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
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastStatusTime: 0 };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'DOWN' ? diff <= -5 : diff >= 5;
                const lose = pending.type === 'DOWN' ? diff >= 5 : diff <= -5;
                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; pending.endTime = now; pending.needSound = pending.status;
                    coinData[s].lastStatusTime = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE) {
                if (!pending && (now - coinData[s].lastStatusTime >= COOLDOWN_MINUTES * 60000)) {
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapVol: { c1, c5, c15 },
                        snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                        status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, isNew: true 
                    });
                }
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,15),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0,50)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: "IBM Plex Sans", sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 6px 0; font-size: 12px; font-weight: 500; text-align: center; width: 100%; }
        #user-id { color: #fcd535; font-size: 1.4rem; font-weight: 900; font-style: italic; }
        .text-gray-custom { color: #848e9c; } .text-10 { font-size: 10px; }
        ::-webkit-scrollbar { width: 0px; }
    </style></head><body>
    
    <div class="p-4">
        <div id="setup" class="flex gap-2 mb-4 bg-zinc-900 p-2 rounded">
            <input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-1 rounded w-20 text-yellow-500 text-xs font-bold">
            <input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-1 rounded w-16 text-yellow-500 text-xs font-bold">
            <button onclick="start()" class="bg-yellow-500 text-black px-4 py-1 rounded font-bold text-xs uppercase">Start</button>
        </div>

        <div id="active" class="hidden justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic text-white text-sm uppercase">BINANCE <span class="text-[#fcd535]">FUTURES</span></h1></div>
             <div id="user-id">Luffy_v3</div>
             <button onclick="stop()" class="text-red-500 text-10 font-bold uppercase">Stop</button>
        </div>

        <div class="grid grid-cols-3 gap-2 mb-6 text-center">
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold">Hôm nay</div><div id="stat24" class="font-bold text-12 text-white">---</div></div>
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold">7 Ngày</div><div id="stat7" class="font-bold text-12 text-white">---</div></div>
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold">30 Ngày</div><div id="stat30" class="font-bold text-12 text-white">---</div></div>
        </div>

        <div class="text-gray-custom text-12 mb-1">Số dư ký quỹ <i class="far fa-eye text-10"></i></div>
        <div class="flex items-end gap-2 mb-4">
            <span id="displayBal" class="text-3xl font-bold text-white">0.00</span>
            <span class="text-sm font-medium text-white mb-1">USDT</span>
        </div>
    </div>

    <div class="px-4 py-2"><div style="height: 140px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mt-4">
        <div class="flex gap-6 mb-6 border-b border-zinc-800 text-sm font-bold text-gray-custom uppercase tracking-tighter">
            <span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế</span>
            <span>Lệnh chờ</span>
            <span>Lịch sử</span>
        </div>
        <div id="pendingContainer" class="space-y-8 pb-10"></div>
    </div>

    <div class="px-2 space-y-4 pb-24">
        <div class="bg-card rounded p-3 mx-2">
            <div class="text-10 font-bold text-gray-custom mb-2 uppercase border-b border-zinc-800 pb-1">Biến động 1m | 5m | 15m</div>
            <table class="w-full text-[11px] text-left"><tbody id="liveTableBody"></tbody></table>
        </div>
        <div class="bg-card rounded p-3 mx-2 overflow-x-auto">
            <div class="text-10 font-bold text-gray-custom mb-3 uppercase border-b border-zinc-800 pb-1">Lịch sử chốt lệnh</div>
            <table class="w-full text-[10px] text-left min-w-[500px]">
                <thead class="text-gray-custom"><tr><th>Time</th><th>Coin</th><th>Entry</th><th>TP/SL</th><th>Lev/Margin</th><th class="text-right">PNL</th></tr></thead>
                <tbody id="historyBody" class="text-zinc-300 font-mono"></tbody>
            </table>
        </div>
    </div>

    <script>
    let running = false, currentBal = 0, initialBal = 0, historyLog = [];
    const openSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3');
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');
    const loseSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2014/2014-preview.mp3');

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function fP(p) { return p < 0.001 ? p.toFixed(8) : (p < 1 ? p.toFixed(6) : p.toFixed(4)); }

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); currentBal = initialBal; historyLog = [initialBal]; document.getElementById('setup').style.display='none'; document.getElementById('active').style.display='flex'; }
    function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').style.display='none'; }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            
            document.getElementById('liveTableBody').innerHTML = d.live.map(c => 
                \`<tr class="border-b border-zinc-800/50"><td class="py-1 font-bold text-white">\${c.symbol}</td><td class="text-center \${c.c1>=0?'up':'down'}">\${c.c1}%</td><td class="text-center \${c.c5>=0?'up':'down'}">\${c.c5}%</td><td class="text-center \${c.c15>=0?'up':'down'}">\${c.c15}%</td></tr>\`
            ).join('');

            let totalPnl = 0;
            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                if(h.isNew) { openSnd.play(); delete h.isNew; }
                let livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                let mStr = document.getElementById('marginInp').value;
                let margin = mStr.includes('%') ? (initialBal * parseFloat(mStr) / 100) : parseFloat(mStr);
                let roi = (h.type === 'UP' ? (livePrice-h.snapPrice)/h.snapPrice : (h.snapPrice-livePrice)/h.snapPrice) * 100 * (h.maxLev || 20);
                let pnl = margin * roi / 100; totalPnl += pnl;

                return \`<div class="relative">
                    <div class="flex items-center gap-1 mb-2">
                        <span class="w-4 h-4 flex items-center justify-center rounded-sm text-[10px] font-bold \${h.type==='UP'?'bg-[#0ecb81] text-black':'bg-[#f6465d] text-black'}">\${h.type==='UP'?'L':'S'}</span>
                        <span class="font-bold text-white text-base">\${h.symbol}</span>
                        <span class="bg-[#2b3139] px-1 rounded text-gray-custom text-[10px] ml-1 uppercase">Cross \${h.maxLev}X</span>
                    </div>
                    <div class="grid grid-cols-2 mb-3"><div><div class="text-gray-custom text-12 mb-1">PNL(USDT)</div><div class="text-2xl font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</div></div>
                    <div class="text-right"><div class="text-gray-custom text-12 mb-1">ROI</div><div class="text-2xl font-bold \${pnl>=0?'up':'down'}">\${roi.toFixed(2)}%</div></div></div>
                    <div class="grid grid-cols-3 text-12 mb-2 text-gray-custom"><div><div>Kích thước</div><div class="text-white">\${(margin*(h.maxLev||20)).toFixed(1)}</div></div>
                    <div class="text-center"><div>Giá vào</div><div class="text-white">\${fP(h.snapPrice)}</div></div><div class="text-right"><div>Giá đánh dấu</div><div class="text-white">\${fP(livePrice)}</div></div></div>
                    <div class="flex gap-2 mt-4"><div class="binance-btn">Đòn bẩy</div><div class="binance-btn">TP/SL</div><div class="binance-btn">Đóng</div></div></div>\`;
            }).join('');

            let closedPnl = 0;
            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                let mStr = document.getElementById('marginInp').value;
                let margin = mStr.includes('%') ? (initialBal * parseFloat(mStr) / 100) : parseFloat(mStr);
                let pnl = (h.status==='WIN'?1:-1) * (margin * 5 * (h.maxLev||20) / 100);
                closedPnl += pnl;
                if(h.needSound) { (h.status==='WIN'?winSnd:loseSnd).play(); delete h.needSound; }
                return \`<tr class="border-b border-zinc-800"><td class="py-2 text-gray-custom">\${new Date(h.endTime).toLocaleTimeString()}</td><td class="font-bold text-white">\${h.symbol}</td><td>\${fP(h.snapPrice)}</td><td>--</td><td>\${h.maxLev}x</td><td class="text-right \${pnl>=0?'up':'down'}">\${pnl.toFixed(1)}</td></tr>\`;
            }).join('');

            if(running) {
                currentBal = initialBal + closedPnl + totalPnl;
                document.getElementById('displayBal').innerText = currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 30000) { historyLog.push({t: now, b: currentBal}); if(historyLog.length > 60) historyLog.shift(); }
                chart.data.labels = historyLog.map((_,i)=>i); chart.data.datasets[0].data = historyLog.map(pt=>pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); });
