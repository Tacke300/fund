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
                // Tính toán Win/Lose dựa trên vị thế Long (UP) hoặc Short (DOWN)
                const win = pending.type === 'UP' ? diff >= 1 : diff <= -1; // Chốt lời 1%
                const lose = pending.type === 'UP' ? diff <= -5 : diff >= 5; // Cắt lỗ 5%

                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = win ? 1 : -5; // Lưu lại biến động giá thực tế khi đóng
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending && !isCooldown) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, 
                    type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20,
                    snapVol: { c1, c5, c15 }
                });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,15),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0,100)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro v2</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-main { background: #0b0e11; } .bg-card { background: #1e2329; }
        #user-id { color: #fcd535; font-size: 1.2rem; font-weight: 900; font-style: italic; cursor: pointer; }
        .text-gray-custom { color: #848e9c; } .text-10 { font-size: 10px; } .text-12 { font-size: 12px; }
        ::-webkit-scrollbar { width: 0px; }
    </style></head><body>
    
    <div class="p-4 bg-main sticky top-0 z-50 shadow-xl">
        <div id="setup" class="flex gap-2 mb-4 bg-card p-3 rounded-lg border border-zinc-800">
            <input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            <input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            <button onclick="start()" class="bg-[#fcd535] text-black px-4 py-2 rounded font-bold uppercase text-xs">Start</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic text-white">BINANCE <span class="text-[#fcd535]">FUTURES</span></h1></div>
             <div id="user-id" onclick="stop()">Monkey_D_Luffy</div>
        </div>
        <div class="text-gray-custom text-12 mb-1">Số dư ký quỹ hiện tại (USDT)</div>
        <div class="flex items-end gap-2 mb-4">
            <span id="displayBal" class="text-3xl font-bold text-white">0.00</span>
            <span class="text-base text-white mb-1">USDT</span>
        </div>
        <div class="grid grid-cols-2 gap-4 text-sm border-t border-zinc-800 pt-3">
            <div><div class="text-gray-custom text-10 uppercase">Ví (Khả dụng)</div><div id="walletBal" class="font-bold text-white">0.00</div></div>
            <div class="text-right"><div class="text-gray-custom text-10 uppercase">PnL chưa chốt</div><div id="unPnl" class="font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 py-2 bg-main"><div style="height: 80px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mt-4">
        <div class="flex gap-6 mb-4 border-b border-zinc-800 text-sm font-bold text-gray-custom uppercase">
            <span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế đang mở</span>
        </div>
        <div id="pendingContainer" class="space-y-4 pb-6"></div>
    </div>

    <div class="px-4 mb-4">
        <div class="bg-card rounded-lg p-3">
             <table class="w-full text-12 text-left"><tbody id="liveBody"></tbody></table>
        </div>
    </div>

    <div class="px-4 pb-32">
        <div class="bg-card rounded-lg p-3">
            <div class="text-10 font-bold text-gray-custom mb-3 uppercase italic border-b border-zinc-800 pb-1">Lịch sử giao dịch</div>
            <div class="overflow-x-auto">
                <table class="w-full text-[10px] text-left">
                    <thead class="text-gray-custom uppercase">
                        <tr>
                            <th class="pb-2">Coin/Type</th>
                            <th class="pb-2">Vào/Ra</th>
                            <th class="pb-2">Margin</th>
                            <th class="pb-2 text-white">PnL</th>
                            <th class="pb-2 text-right">Balance</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody" class="text-zinc-300"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000, historyLog = [];
    
    if(localStorage.getItem('bot_v6')) {
        const saved = JSON.parse(localStorage.getItem('bot_v6'));
        running = saved.running; initialBal = saved.initialBal; historyLog = saved.historyLog || [];
        if(running) { document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    }
    function saveConfig() { localStorage.setItem('bot_v6', JSON.stringify({ running, initialBal, historyLog })); }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: historyLog.map((_,i)=>i), datasets: [{ data: historyLog.map(pt=>pt.b), borderColor: '#fcd535', borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); saveConfig(); }
    function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').classList.add('hidden'); saveConfig(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            let mInp = document.getElementById('marginInp').value;

            // 1. Live table
            document.getElementById('liveBody').innerHTML = d.live.map(c => 
                \`<tr class="border-b border-zinc-800/50"><td class="py-2 font-bold text-white">\${c.symbol}</td>
                <td class="\${c.c1>=0?'up':'down'} text-center">\${c.c1}%</td>
                <td class="\${c.c5>=0?'up':'down'} text-center">\${c.c5}%</td>
                <td class="\${c.c15>=0?'up':'down'} text-right">\${c.c15}%</td></tr>\`
            ).join('');

            // 2. Lịch sử & Wallet balance
            let runningBal = initialBal;
            let historyHTML = [...d.history].reverse().map(h => {
                let margin = mInp.includes('%') ? (runningBal * parseFloat(mInp)/100) : parseFloat(mInp);
                // PnL = Margin * Lev * % biến động giá thực tế (1% hoặc -5%)
                let pnl = margin * (h.maxLev || 20) * (h.pnlPercent / 100);
                runningBal += pnl;
                return \`<tr>
                    <td class="py-2"><b>\${h.symbol}</b> <span class="\${h.type==='UP'?'up':'down'}">\${h.type}</span></td>
                    <td>\${h.snapPrice.toFixed(3)}<br>\${h.finalPrice.toFixed(3)}</td>
                    <td>\${margin.toFixed(1)}</td>
                    <td class="font-bold \${pnl>=0?'up':'down'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}</td>
                    <td class="text-right">\${runningBal.toFixed(1)}</td>
                </tr>\`;
            }).reverse().join('');
            document.getElementById('historyBody').innerHTML = historyHTML;

            // 3. Pending Positions
            let totalUnPnl = 0;
            let currentMarginUsed = 0;
            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                let livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                let margin = mInp.includes('%') ? (runningBal * parseFloat(mInp)/100) : parseFloat(mInp);
                currentMarginUsed += margin;
                
                let diff = ((livePrice - h.snapPrice) / h.snapPrice) * 100;
                let roi = (h.type === 'UP' ? diff : -diff) * (h.maxLev || 20);
                let pnl = margin * roi / 100;
                totalUnPnl += pnl;

                let tpPrice = h.type === 'UP' ? h.snapPrice * 1.01 : h.snapPrice * 0.99;
                let slPrice = h.type === 'UP' ? h.snapPrice * 0.95 : h.snapPrice * 1.05;

                return \`<div class="bg-card p-3 rounded-lg border-l-4 \${h.type==='UP'?'border-green-500':'border-red-500'}">
                    <div class="flex justify-between mb-1">
                        <span class="font-bold text-white">\${h.symbol} <span class="text-[10px] bg-zinc-700 px-1">\${h.maxLev}x</span></span>
                        <span class="font-bold \${pnl>=0?'up':'down'}">\${roi.toFixed(2)}%</span>
                    </div>
                    <div class="flex justify-between text-[11px] mb-2">
                        <span class="text-gray-400">Entry: \${h.snapPrice.toFixed(4)}</span>
                        <span class="font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)} USDT</span>
                    </div>
                    <div class="grid grid-cols-2 text-[10px] text-gray-500 border-t border-zinc-800 pt-1">
                        <div>TP: <span class="up">\${tpPrice.toFixed(4)}</span></div>
                        <div class="text-right">SL: <span class="down">\${slPrice.toFixed(4)}</span></div>
                    </div>
                </div>\`;
            }).join('');

            // 4. Dashboard
            if(running) {
                let totalEquity = runningBal + totalUnPnl;
                document.getElementById('displayBal').innerText = totalEquity.toLocaleString('en-US', {minimumFractionDigits: 2});
                document.getElementById('walletBal').innerText = (runningBal - currentMarginUsed).toFixed(2);
                document.getElementById('unPnl').innerText = (totalUnPnl >= 0 ? '+' : '') + totalUnPnl.toFixed(2);
                document.getElementById('unPnl').className = 'font-bold ' + (totalUnPnl >= 0 ? 'up' : 'down');

                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) { 
                    historyLog.push({t: now, b: totalEquity}); 
                    if(historyLog.length > 100) historyLog.shift();
                    saveConfig(); 
                }
                chart.data.labels = historyLog.map((_,i)=>i); chart.data.datasets[0].data = historyLog.map(pt=>pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Server: http://localhost:${PORT}/gui`); });
