const MIN_VOLATILITY_TO_SAVE = 5; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

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
let lastTradeClosed = {}; 

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
                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; pending.endTime = now;
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending && !isCooldown) {
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20 });
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
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; padding: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-main { background: #0b0e11; } .bg-card { background: #1e2329; }
        .dot-under { border-bottom: 1px dotted #5e6673; cursor: help; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 8px 0; font-size: 13px; font-weight: 600; text-align: center; width: 100%; cursor: pointer; }
        #user-id { color: #fcd535; font-size: 1.2rem; font-weight: 900; font-style: italic; }
        .text-gray-custom { color: #848e9c; }
        .text-12 { font-size: 12px; } .text-10 { font-size: 10px; }
        @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
        .warn-blink { animation: blink 0.8s infinite; color: #f6465d; font-weight: 900; }
        ::-webkit-scrollbar { width: 0px; }
    </style></head><body>
    
    <div class="p-4 bg-main sticky top-0 z-50">
        <div id="setup" class="flex flex-col gap-2 mb-4 bg-card p-3 rounded-lg border border-zinc-800">
            <div class="flex gap-2">
                <input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
                <input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            </div>
            <div class="flex gap-2">
                <button onclick="start()" class="bg-[#0ecb81] text-black flex-1 py-2 rounded font-bold uppercase text-xs">Start Bot</button>
                <button onclick="clearAllData()" class="bg-[#f6465d]/20 text-[#f6465d] px-4 py-2 rounded font-bold uppercase text-xs border border-[#f6465d]/50">Xóa lịch sử</button>
            </div>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic text-white tracking-tighter">BINANCE <span class="text-[#fcd535]">FUTURES</span></h1></div>
             <div id="user-id" onclick="stop()">Monkey_D_Luffy</div>
        </div>

        <div class="text-gray-custom text-12 mb-1"><span class="dot-under">Số dư ký quỹ</span> (USDT) <i class="far fa-eye text-10"></i></div>
        <div class="flex items-end gap-2 mb-4">
            <span id="displayBal" class="text-3xl font-bold tracking-tighter text-white">0.00</span>
            <span class="text-base font-medium text-white mb-1">USDT</span>
        </div>

        <div class="grid grid-cols-3 gap-2 text-center">
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold mb-1">24h PNL</div><div id="stat24" class="font-bold text-12">---</div></div>
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold mb-1">Ví</div><div id="walletBal" class="font-bold text-12 text-white">---</div></div>
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold mb-1">UnPnL</div><div id="unPnl" class="font-bold text-12">---</div></div>
        </div>
    </div>

    <div class="px-4 py-2"><div style="height: 120px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mt-4">
        <div class="flex gap-6 mb-4 border-b border-zinc-800 text-sm font-bold text-gray-custom uppercase">
            <span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế</span>
            <span>Lệnh mở</span>
            <span>Bot</span>
        </div>
        <div id="pendingContainer" class="space-y-6"></div>
    </div>

    <div class="px-4 mt-8 pb-32">
        <div class="bg-card rounded-lg p-3">
            <div class="text-10 font-bold text-gray-custom mb-3 uppercase border-b border-zinc-800 pb-1 italic">Lịch sử chốt lệnh chi tiết</div>
            <div class="overflow-x-auto">
                <table class="w-full text-[10px] text-left">
                    <thead class="text-gray-custom">
                        <tr class="border-b border-zinc-800">
                            <th class="py-2">Time</th><th class="py-2">Symbol</th><th class="py-2">Lev</th>
                            <th class="py-2">Entry</th><th class="py-2">TP/SL</th><th class="py-2">Margin</th><th class="py-2 text-right">Result</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000, historyLog = [];
    
    const saved = JSON.parse(localStorage.getItem('bot_config_v5') || '{}');
    if(saved.running) {
        running = true; initialBal = saved.initialBal; historyLog = saved.historyLog || [];
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('active').classList.remove('hidden');
    }

    function save() { localStorage.setItem('bot_config_v5', JSON.stringify({ running, initialBal, historyLog })); }
    function clearAllData() { if(confirm("Xóa sạch toàn bộ?")) { localStorage.removeItem('bot_config_v5'); location.reload(); } }
    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); save(); }
    function stop() { running = false; document.getElementById('setup').classList.remove('hidden'); document.getElementById('active').classList.add('hidden'); save(); }

    const ctx = document.getElementById('mainChart').getContext('2d');
    const chart = new Chart(ctx, {
        type: 'line', data: { labels: historyLog.map(p=>''), datasets: [{ data: historyLog.map(p=>p.b), borderColor: '#fcd535', borderWidth: 1.5, tension: 0.3, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#2b3139' }, ticks: { color: '#848e9c', font: { size: 9 } } } } }
    });

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            let totalUnPnl = 0, totalClosedP = 0, wD=0, lD=0, pD=0;

            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                const live = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                const mInp = document.getElementById('marginInp').value;
                const margin = mInp.includes('%') ? (initialBal * parseFloat(mInp)/100) : parseFloat(mInp);
                const roi = (h.type === 'UP' ? ((live - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - live)/h.snapPrice)*100) * (h.maxLev || 20);
                const pnl = margin * roi / 100; totalUnPnl += pnl;
                
                let excl = '<span class="text-gray-600 ml-1">!!!!</span>';
                if(roi > 0) excl = '<span class="up ml-1 font-bold">!!!!</span>';
                if(roi < -50) excl = '<span class="warn-blink ml-1">!!!!</span>';

                return \`<div class="bg-main border-b border-zinc-800 pb-4">
                    <div class="flex justify-between items-center mb-2">
                        <div class="flex items-center gap-1">
                            <span class="px-1 rounded text-[10px] font-bold \${h.type==='UP'?'bg-[#0ecb81]/20 up':'bg-[#f6465d]/20 down'}">\${h.type==='UP'?'Long':'Short'}</span>
                            <span class="font-bold text-white text-sm uppercase">\${h.symbol}</span>
                            <span class="text-gray-custom text-[10px]">Cross \${h.maxLev || 20}x</span>\${excl}
                        </div>
                        <i class="fas fa-share-alt text-gray-custom text-xs"></i>
                    </div>
                    <div class="grid grid-cols-2 mb-3">
                        <div><div class="text-gray-custom text-10 mb-1 dot-under">PnL (USDT)</div><div class="text-xl font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</div></div>
                        <div class="text-right"><div class="text-gray-custom text-10 mb-1 dot-under">ROI</div><div class="text-xl font-bold \${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</div></div>
                    </div>
                    <div class="grid grid-cols-3 text-[10px] text-gray-custom mb-4">
                        <div><div class="dot-under">Size</div><div class="text-white">\${(margin*(h.maxLev||20)).toFixed(1)}</div></div>
                        <div><div class="dot-under">Entry</div><div class="text-white">\${h.snapPrice.toFixed(4)}</div></div>
                        <div class="text-right"><div class="dot-under">Mark</div><div class="text-white">\${live.toFixed(4)}</div></div>
                    </div>
                    <div class="flex gap-2">
                        <div class="binance-btn py-1 text-10">TP/SL</div><div class="binance-btn py-1 text-10">Đóng</div>
                    </div>
                </div>\`;
            }).join('');

            const dayStart = new Date().setHours(7,0,0,0);
            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                const mInp = document.getElementById('marginInp').value;
                const margin = mInp.includes('%') ? (initialBal * parseFloat(mInp)/100) : parseFloat(mInp);
                const pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * (h.maxLev || 20)) / 100);
                totalClosedP += pnl;
                if(h.endTime >= dayStart) { h.status==='WIN'?wD++:lD++; pD+=pnl; }
                
                return \`<tr class="border-b border-zinc-800/30">
                    <td class="py-2 text-gray-custom">\${new Date(h.endTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
                    <td class="font-bold text-white">\${h.symbol}</td>
                    <td class="text-gray-custom">\${h.maxLev}x</td>
                    <td class="text-zinc-400">\${h.snapPrice.toFixed(3)}</td>
                    <td class="text-zinc-500">\${(h.snapPrice*1.05).toFixed(2)}/\${(h.snapPrice*0.95).toFixed(2)}</td>
                    <td class="text-zinc-400">\${margin.toFixed(1)}</td>
                    <td class="text-right font-black \${h.status==='WIN'?'up':'down'}">\${h.status}</td>
                </tr>\`;
            }).join('');

            if(running) {
                const cB = initialBal + totalClosedP + totalUnPnl;
                document.getElementById('displayBal').innerText = cB.toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('walletBal').innerText = (initialBal + totalClosedP).toFixed(1);
                document.getElementById('unPnl').innerText = totalUnPnl.toFixed(2);
                document.getElementById('unPnl').className = 'font-bold text-12 ' + (totalUnPnl >= 0 ? 'up' : 'down');
                document.getElementById('stat24').innerHTML = \`<span class="up">\${wD}W</span>-<span class="down">\${lD}L</span>\`;

                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) { 
                    historyLog.push({t: now, b: cB}); 
                    if(historyLog.length > 1440) historyLog.shift(); // Biểu đồ 24h = 1440 phút
                    save(); 
                }
                chart.data.labels = historyLog.map(p=>'');
                chart.data.datasets[0].data = historyLog.map(p=>p.b);
                chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 3000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Server: http://localhost:${PORT}/gui`); });
