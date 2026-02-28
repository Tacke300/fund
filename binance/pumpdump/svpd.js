const TP_PERCENT = 1.0; // Chốt lời tại 1% (chưa tính đòn bẩy)
const SL_PERCENT = 1.0; // Cắt lỗ tại 5% (chưa tính đòn bẩy)
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
                const win = pending.type === 'UP' ? diff >= TP_PERCENT : diff <= -TP_PERCENT; 
                const lose = pending.type === 'UP' ? diff <= -SL_PERCENT : diff >= SL_PERCENT; 

                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = win ? TP_PERCENT : -SL_PERCENT;
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
                    snapVol: { c1, c5, c15 },
                    tpTarget: TP_PERCENT,
                    slTarget: SL_PERCENT
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
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0,100),
        config: { tp: TP_PERCENT, sl: SL_PERCENT }
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro v2</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; padding: 0; }
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
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic text-white tracking-tighter">BINANCE <span class="text-[#fcd535]">FUTURES</span></h1></div>
             <div id="user-id" onclick="stop()">Monkey_D_Luffy</div>
        </div>

        <div class="text-gray-custom text-12 mb-1">Số dư ký quỹ hiện tại (USDT)</div>
        <div class="flex items-end gap-2 mb-4">
            <span id="displayBal" class="text-3xl font-bold tracking-tighter text-white">0.00</span>
            <span class="text-base font-medium text-white mb-1">USDT</span>
        </div>

        <div class="grid grid-cols-2 gap-4 text-sm border-t border-zinc-800 pt-3">
            <div><div class="text-gray-custom text-10 uppercase">Số dư ví (Khả dụng)</div><div id="walletBal" class="font-bold text-white">0.00</div></div>
            <div class="text-right"><div class="text-gray-custom text-10 uppercase">Tổng PnL chưa chốt</div><div id="unPnl" class="font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 py-2 bg-main"><div style="height: 100px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mt-4">
        <div class="flex gap-6 mb-4 border-b border-zinc-800 text-sm font-bold text-gray-custom uppercase">
            <span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế đang mở</span>
        </div>
        <div id="pendingContainer" class="space-y-4 pb-6"></div>
    </div>

    <div class="px-4 mb-4">
        <div class="bg-card rounded-lg p-3">
             <div class="text-10 font-bold text-gray-custom mb-3 uppercase italic border-b border-zinc-800 pb-1">Biến động thị trường</div>
             <table class="w-full text-12 text-left"><tbody id="liveBody"></tbody></table>
        </div>
    </div>

    <div class="px-4 pb-32">
        <div class="bg-card rounded-lg p-3">
            <div class="text-10 font-bold text-gray-custom mb-3 uppercase italic border-b border-zinc-800 pb-1">Lịch sử giao dịch chi tiết</div>
            <div class="overflow-x-auto">
                <table class="w-full text-[9px] text-left">
                    <thead class="text-gray-custom uppercase border-b border-zinc-800">
                        <tr>
                            <th class="pb-2">Mở/Đóng</th>
                            <th class="pb-2">Coin/Snapshot</th>
                            <th class="pb-2 text-center">Lev</th>
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
        running = !!saved.running; initialBal = parseFloat(saved.initialBal) || 1000; historyLog = saved.historyLog || [];
        if(running) { document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    }
    function saveConfig() { localStorage.setItem('bot_v6', JSON.stringify({ running, initialBal, historyLog })); }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: historyLog.map((_,i)=>i), datasets: [{ data: historyLog.map(pt=>pt.b), borderColor: '#fcd535', borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value) || 1000; document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); saveConfig(); }
    function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').classList.add('hidden'); saveConfig(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            let mVal = document.getElementById('marginInp').value;
            let mNum = parseFloat(mVal) || 0;

            document.getElementById('liveBody').innerHTML = (d.live || []).map(c => 
                \`<tr class="border-b border-zinc-800/50"><td class="py-2 font-bold text-white">\${c.symbol}</td>
                <td class="\${c.c1>=0?'up':'down'} text-center">\${c.c1}%</td>
                <td class="\${c.c5>=0?'up':'down'} text-center">\${c.c5}%</td>
                <td class="\${c.c15>=0?'up':'down'} text-right">\${c.c15}%</td></tr>\`
            ).join('');

            let runningBal = initialBal;
            let historyHTML = [...(d.history || [])].reverse().map(h => {
                let margin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let pnl = margin * (h.maxLev || 20) * ((h.pnlPercent || 0) / 100);
                runningBal += pnl;
                let vol = h.snapVol || {c1:0, c5:0, c15:0};
                return \`<tr class="border-b border-zinc-800/30">
                    <td class="py-2 text-zinc-500">\${new Date(h.startTime).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}<br>\${new Date(h.endTime).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</td>
                    <td><b class="text-white">\${h.symbol}</b><br><span class="text-zinc-500">\${vol.c1}|\${vol.c5}|\${vol.c15}</span></td>
                    <td class="text-center">\${h.maxLev}x</td>
                    <td>\${(h.snapPrice||0).toFixed(4)}<br>\${(h.finalPrice||0).toFixed(4)}</td>
                    <td>\${margin.toFixed(1)}</td>
                    <td class="font-bold \${pnl>=0?'up':'down'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}</td>
                    <td class="text-right \${runningBal>=initialBal?'up':'down'}">\${runningBal.toFixed(1)}</td>
                </tr>\`;
            }).reverse().join('');
            document.getElementById('historyBody').innerHTML = historyHTML;

            let totalUnPnl = 0;
            let currentMarginUsed = 0;
            document.getElementById('pendingContainer').innerHTML = (d.pending || []).map(h => {
                let livePrice = (d.live || []).find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                let margin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                currentMarginUsed += margin;
                
                let diff = ((livePrice - h.snapPrice) / h.snapPrice) * 100;
                let roi = (h.type === 'UP' ? diff : -diff) * (h.maxLev || 20);
                let pnl = margin * roi / 100;
                totalUnPnl += pnl;

                let tpPrice = h.type === 'UP' ? h.snapPrice * (1 + d.config.tp/100) : h.snapPrice * (1 - d.config.tp/100);
                let slPrice = h.type === 'UP' ? h.snapPrice * (1 - d.config.sl/100) : h.snapPrice * (1 + d.config.sl/100);
                let liqPrice = h.type === 'UP' ? h.snapPrice * (1 - 0.8 / h.maxLev) : h.snapPrice * (1 + 0.8 / h.maxLev);

                return \`<div class="bg-card p-3 rounded-md border-l-4 \${h.type==='UP'?'border-green-500':'border-red-500'}">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <div class="flex items-center gap-2">
                                <span class="text-lg font-bold text-white">\${h.symbol}</span>
                                <span class="bg-zinc-800 text-[10px] px-1 rounded text-zinc-400">Vĩnh cửu</span>
                                <span class="bg-zinc-800 text-[10px] px-1 rounded text-[#fcd535]">\${h.maxLev}x</span>
                            </div>
                            <div class="text-[10px] \${h.type==='UP'?'up':'down'} font-bold mt-1">\${h.type==='UP'?'Long':'Short'} | Isolated</div>
                        </div>
                        <div class="text-right">
                            <div class="text-gray-custom text-[10px]">PnL chưa chốt (USDT)</div>
                            <div class="text-lg font-bold \${pnl>=0?'up':'down'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}</div>
                            <div class="text-[11px] font-medium \${roi>=0?'up':'down'}">ROI \${roi>=0?'+':''}\${roi.toFixed(2)}%</div>
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 mt-3 text-[11px]">
                        <div><div class="text-gray-custom">Ký quỹ</div><div class="text-white font-medium">\${margin.toFixed(2)}</div></div>
                        <div><div class="text-gray-custom">Giá vào lệnh</div><div class="text-white font-medium">\${h.snapPrice.toFixed(4)}</div></div>
                        <div class="text-right"><div class="text-gray-custom">Giá đánh dấu</div><div class="text-white font-medium">\${livePrice.toFixed(4)}</div></div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 mt-2 text-[11px] border-t border-zinc-800/50 pt-2">
                         <div><div class="text-gray-custom">Giá thanh lý</div><div class="text-orange-400 font-medium">\${liqPrice.toFixed(4)}</div></div>
                         <div><div class="text-gray-custom">TP (Target)</div><div class="up font-medium">\${tpPrice.toFixed(4)}</div></div>
                         <div class="text-right"><div class="text-gray-custom">SL (Stop)</div><div class="down font-medium">\${slPrice.toFixed(4)}</div></div>
                    </div>
                </div>\`;
            }).join('');

            if(running) {
                let totalEquity = runningBal + totalUnPnl;
                document.getElementById('displayBal').innerText = totalEquity.toFixed(2);
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
