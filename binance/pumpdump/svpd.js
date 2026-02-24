// ================= CONFIGURATION =================
const MIN_VOLATILITY_TO_SAVE = 0.5; // Ngưỡng biến động 0.5% để bắt đầu gồng vị thế
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

// --- HÀM LẤY ĐÒN BẨY THẬT TỪ SÀN BINANCE ---
async function fetchActualLeverage() {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const options = {
        hostname: 'fapi.binance.com',
        path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
        headers: { 'X-MBX-APIKEY': API_KEY }
    };
    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                if (Array.isArray(brackets)) {
                    brackets.forEach(item => {
                        if (item.brackets && item.brackets.length > 0) {
                            symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                        }
                    });
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

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    return startPriceObj ? parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2)) : 0;
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

            const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
            if (maxVol >= MIN_VOLATILITY_TO_SAVE) {
                if (!pending && (now - coinData[s].lastStatusTime >= 900000)) {
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapVol: { c1, c5, c15 }, 
                        snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                        status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20 
                    });
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,20),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.startTime-a.startTime).slice(0,100)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro V2.6</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: -apple-system, system-ui, sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #27272a; }
        .dot-border { border-bottom: 1px dotted #5e6673; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 10px 0; font-size: 13px; font-weight: 500; text-align: center; }
        ::-webkit-scrollbar { width: 0px; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] border-b border-zinc-800">
        <div class="flex justify-between items-center mb-4">
            <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic">BINANCE <span class="text-[#fcd535]">PRO</span></h1></div>
            <div id="active" class="hidden text-[#fcd535] font-black text-xs uppercase italic">Moncey_D_Luffy</div>
        </div>
        
        <div id="setup" class="grid grid-cols-2 gap-2 mb-4">
            <div class="bg-[#1e2329] p-2 rounded border border-zinc-700">
                <label class="block text-[8px] text-zinc-500 font-bold uppercase">Vốn Gốc (USDT)</label>
                <input id="balanceInp" type="number" value="1000" class="bg-transparent w-full font-bold outline-none text-lg">
            </div>
            <div class="bg-[#1e2329] p-2 rounded border border-zinc-700">
                <label class="block text-[8px] text-zinc-500 font-bold uppercase">Margin (%)</label>
                <input id="marginInp" type="text" value="10%" class="bg-transparent w-full font-bold outline-none text-lg text-[#fcd535]">
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black font-bold py-3 rounded-lg uppercase text-xs">Start Bot</button>
        </div>

        <div>
            <div class="text-zinc-500 text-xs">Số dư margin</div>
            <div class="flex items-baseline gap-1"><span id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</span><span class="text-lg font-medium">USDT</span></div>
        </div>
        
        <div class="grid grid-cols-2 mt-4 text-xs">
            <div><div class="text-zinc-500">Số dư ví (USDT)</div><div id="walletBal" class="font-bold text-sm">0.00</div></div>
            <div class="text-right"><div class="text-zinc-500">PNL chưa ghi nhận</div><div id="unPnl" class="font-bold text-sm">0.00</div></div>
        </div>
    </div>

    <div class="p-4"><div style="height: 120px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mb-6">
        <div class="flex gap-4 mb-4 border-b border-zinc-800 pb-2 text-sm font-bold"><span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế</span></div>
        <div id="pendingContainer" class="space-y-4"></div>
    </div>

    <div class="px-4 pb-20">
        <div class="flex gap-4 mb-2 border-b border-zinc-800 pb-2 text-sm font-bold"><span class="text-white border-b-2 border-[#fcd535] pb-2 uppercase">Real History Log</span></div>
        <div class="bg-card rounded overflow-hidden">
            <div class="overflow-x-auto">
                <table class="w-full text-[10px] text-left">
                    <thead class="text-zinc-500 bg-[#2b3139]">
                        <tr>
                            <th class="p-2">TIME</th>
                            <th class="p-2">COIN/MAXLEV</th>
                            <th class="p-2">SNAP VOL</th>
                            <th class="p-2 text-right">PNL ($)</th>
                            <th class="p-2 text-right">STATUS</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody" class="font-mono"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 0, historyLog = [];
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

    if(localStorage.getItem('bot_luffy_v3')) {
        const s = JSON.parse(localStorage.getItem('bot_luffy_v3'));
        running = s.running; initialBal = s.initialBal; historyLog = s.historyLog || [];
        if(running) { document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }]},
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); historyLog = [{t: Date.now(), b: initialBal}]; document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); save(); }
    function save() { localStorage.setItem('bot_luffy_v3', JSON.stringify({ running, initialBal, historyLog })); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            let totalUnPnl = 0;

            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                const livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                const mVal = document.getElementById('marginInp').value;
                const margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                const roi = (h.type === 'UP' ? ((livePrice - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - livePrice)/h.snapPrice)*100) * (h.maxLev);
                const pnl = margin * roi / 100;
                totalUnPnl += pnl;

                return \`
                <div class="bg-[#1e2329] p-3 rounded-lg border-l-4 \${h.type==='UP'?'border-[#0ecb81]':'border-[#f6465d]'}">
                    <div class="flex justify-between items-center mb-2">
                        <div class="flex items-center gap-2"><span class="font-bold">\${h.symbol}</span><span class="bg-[#2b3139] px-1 rounded text-zinc-400 text-[10px]">Cross \${h.maxLev}X</span></div>
                        <span class="up text-[10px]">\${h.type}</span>
                    </div>
                    <div class="grid grid-cols-2">
                        <div><div class="text-zinc-500 text-[10px]">PNL</div><div class="font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</div></div>
                        <div class="text-right"><div class="text-zinc-500 text-[10px]">ROI</div><div class="font-bold \max-w-[40px] \${pnl>=0?'up':'down'}">\${roi.toFixed(2)}%</div></div>
                    </div>
                </div>\`;
            }).join('');

            let totalClosedP = 0;
            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                let mVal = document.getElementById('marginInp').value;
                let margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                let pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                totalClosedP += pnl;
                if(h.needSound) { winSnd.play(); delete h.needSound; }

                return \`<tr class="border-b border-zinc-800">
                    <td class="p-2 text-zinc-500">\${new Date(h.startTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
                    <td class="p-2 font-bold text-white">\${h.symbol} <span class="text-[#fcd535]">\${h.maxLev}x</span></td>
                    <td class="p-2 text-zinc-500">[\${h.snapVol.c1}/\${h.snapVol.c5}]</td>
                    <td class="p-2 text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}$</td>
                    <td class="p-2 text-right font-black \${h.status==='WIN'?'up':'down'}">\${h.status}</td>
                </tr>\`;
            }).join('');

            if(running) {
                const currentBal = initialBal + totalClosedP + totalUnPnl;
                document.getElementById('displayBal').innerText = currentBal.toFixed(2);
                document.getElementById('walletBal').innerText = (initialBal + totalClosedP).toFixed(2);
                document.getElementById('unPnl').innerText = totalUnPnl.toFixed(2);
                document.getElementById('unPnl').className = totalUnPnl >= 0 ? 'font-bold up' : 'font-bold down';

                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) {
                    historyLog.push({t: now, b: currentBal}); if(historyLog.length > 60) historyLog.shift(); save();
                }
                chart.data.labels = historyLog.map(pt => pt.t); chart.data.datasets[0].data = historyLog.map(pt => pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); });
