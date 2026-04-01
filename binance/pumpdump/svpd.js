const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const BALANCE_LOG_FILE = './balance_history.json'; 
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 1440; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 
let balanceLogs = []; 
let tempMinuteLogs = []; 

let currentTP = 0.5, currentSL = 100.0, currentMinVol = 6.5;

// --- LOGIC QUEUE ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    let s = p.toFixed(20);
    let match = s.match(/^-?\d+\.0*[1-9]/);
    if (!match) return p.toFixed(4);
    let index = match[0].length;
    return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
}

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}
if (fs.existsSync(BALANCE_LOG_FILE)) {
    try { balanceLogs = JSON.parse(fs.readFileSync(BALANCE_LOG_FILE)); } catch(e) { balanceLogs = []; }
}

function calcTotalClosedPnl() {
    const hist = Array.from(historyMap.values()).filter(h => h.status !== 'PENDING');
    return hist.reduce((sum, h) => {
        let totalMargin = 10 * (h.dcaCount + 1); // Giả định margin cơ bản để log
        return sum + ((totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001));
    }, 0);
}

setInterval(() => {
    tempMinuteLogs.push({ t: Date.now(), pnl: calcTotalClosedPnl() });
    if (tempMinuteLogs.length > 60) tempMinuteLogs.shift();
}, 60000);

setInterval(() => {
    balanceLogs.push({ t: Date.now(), pnl: calcTotalClosedPnl() });
    if (balanceLogs.length > 1000) balanceLogs.shift();
    fs.writeFileSync(BALANCE_LOG_FILE, JSON.stringify(balanceLogs));
}, 10 * 60000);

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'UP' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;
                if (pending.type === 'UP' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'UP' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                actionQueue.push({ id: s, priority: 2, action: () => {
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                        maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                        maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                    });
                }});
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp) || 0.5; currentSL = parseFloat(req.query.sl) || 10.0; currentMinVol = parseFloat(req.query.vol) || 5;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING'),
        balanceLogs: balanceLogs, tempLogs: tempMinuteLogs
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
    body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
    .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
    </style></head><body>
    <div class="p-4 sticky top-0 z-50 bg-[#0b0e11] border-b border-zinc-800">
        <div id="setup" class="bg-card p-3 rounded-lg mb-4 grid grid-cols-2 gap-2">
            <input id="balanceInp" type="number" class="bg-black p-2 rounded text-yellow-500 font-bold" placeholder="Vốn">
            <input id="marginInp" type="text" class="bg-black p-2 rounded text-yellow-500 font-bold" placeholder="Margin">
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold">KHỞI CHẠY HỆ THỐNG</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4"><div class="font-bold text-xl italic">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div><button onclick="stop()" class="text-xs border border-red-500 px-2 py-1 text-red-500 rounded">STOP</button></div>
        <div class="flex justify-between items-end">
            <div><div class="text-[10px] text-gray-400 font-bold">TOTAL ASSET</div><span id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</span><span class="text-sm ml-1 text-gray-400">USDT</span></div>
            <div id="unPnl" class="text-xl font-bold text-right">0.00</div>
        </div>
    </div>
    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-yellow-500 uppercase italic mb-2">Biến động (Hover xem PnL Tạm tính)</div>
        <div style="height: 220px;"><canvas id="balanceChart"></canvas></div>
    </div></div>
    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 overflow-x-auto">
        <div class="text-[11px] font-bold text-white mb-2 uppercase">Vị thế đang mở</div>
        <table class="w-full text-[10px] text-left"><tbody id="pendingBody"></tbody></table>
    </div></div>
    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="flex justify-between text-[11px] font-bold mb-3 uppercase italic text-gray-400">Nhật ký giao dịch <span id="fLabel" class="text-yellow-500"></span></div>
        <div class="overflow-x-auto" style="max-height:300px;"><table class="w-full text-[9px]"><tbody id="historyBody"></tbody></table></div>
    </div></div>
    <div class="px-4 mt-5 pb-32"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase italic">Hiệu suất Coin (Bấm để lọc)</div>
        <table class="w-full text-[10px]"><tbody id="statsBody"></tbody></table>
    </div></div>
    <script>
    let running = false, initialBal = 1000, lastData = null, myChart = null, filterSym = null, currentUnPnl = 0;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    if(saved.running) { running=true; initialBal=saved.initialBal; document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }

    function start() { localStorage.setItem('luffy_state', JSON.stringify({ running:true, initialBal:parseFloat(document.getElementById('balanceInp').value), marginVal:document.getElementById('marginInp').value })); location.reload(); }
    function stop() { let s=JSON.parse(localStorage.getItem('luffy_state')); s.running=false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }
    function setFilter(s) { filterSym = (filterSym === s) ? null : s; document.getElementById('fLabel').innerText = filterSym ? "["+filterSym+"]" : ""; update(); }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line', data: { labels: [], datasets: [{ label: 'Asset', data: [], borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, borderColor: '#0ecb81', backgroundColor: 'rgba(14, 203, 129, 0.05)' }] },
            options: { 
                responsive: true, maintainAspectRatio: false, 
                plugins: { 
                    legend: { display: false },
                    tooltip: {
                        mode: 'index', intersect: false,
                        callbacks: {
                            label: function(ctx) {
                                let val = ctx.raw;
                                let pnlLãi = val - initialBal - currentUnPnl;
                                return [
                                    "Số dư: " + val.toFixed(2) + " $",
                                    "PnL Lãi: " + pnlLãi.toFixed(2) + " $",
                                    "Tạm tính: " + currentUnPnl.toFixed(2) + " $"
                                ];
                            }
                        }
                    }
                },
                scales: { x: { display: false }, y: { grid: { color: '#30363d' }, ticks: { font: { size: 9 } } } }
            }
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastData = d;
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let curBal = initialBal, totalWin = 0, totalDCA = 0, coinStats = {};

            let histHTML = [...d.history].sort((a,b)=>a.endTime-b.endTime).map((h, i) => {
                let mBase = mVal.includes('%') ? (curBal * mNum / 100) : mNum;
                let totalM = mBase * (h.dcaCount + 1);
                let netPnl = (totalM * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalM * (h.maxLev || 20) * 0.001);
                curBal += netPnl; totalDCA += h.dcaCount; if(netPnl>0) totalWin += netPnl;
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count: 0, dcas: 0, pnl: 0 };
                coinStats[h.symbol].count++; coinStats[h.symbol].dcas += h.dcaCount; coinStats[h.symbol].pnl += netPnl;
                if(filterSym && h.symbol !== filterSym) return null;
                return \`<tr class="border-b border-zinc-800 text-zinc-400"><td class="py-1 text-white">\${h.symbol}</td><td>DCA:\${h.dcaCount}</td><td class="\${netPnl>=0?'up':'down'}">\${netPnl.toFixed(2)}</td><td class="text-right">\${curBal.toFixed(1)}</td></tr>\`;
            }).filter(x=>x).reverse().join('');

            let unPnl = 0;
            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let p = d.allPrices[h.symbol] || h.avgPrice;
                let totalM = (mVal.includes('%') ? (curBal * mNum / 100) : mNum) * (h.dcaCount+1);
                let roi = (h.type === 'UP' ? (p-h.avgPrice)/h.avgPrice : (h.avgPrice-p)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = totalM * roi / 100; unPnl += pnl;
                return \`<tr class="border-b border-zinc-800"><td>\${h.symbol} <span class="text-[8px] bg-zinc-700 px-1">\${h.type}</span></td><td>DCA:\${h.dcaCount}</td><td>M:\${totalM.toFixed(1)}</td><td class="text-right \${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
            }).join('');
            currentUnPnl = unPnl;

            if(myChart) {
                let logs = d.balanceLogs.concat(d.tempLogs).sort((a,b)=>a.t-b.t);
                myChart.data.labels = logs.map(l => new Date(l.t).toLocaleTimeString()).concat(["NOW"]);
                myChart.data.datasets[0].data = logs.map(l => initialBal + l.pnl).concat([curBal + unPnl]);
                myChart.update('none');
            }

            document.getElementById('displayBal').innerText = (curBal + unPnl).toFixed(2);
            document.getElementById('unPnl').innerText = (unPnl>=0?'+':'')+unPnl.toFixed(2);
            document.getElementById('unPnl').className = "text-xl font-bold " + (unPnl>=0?'up':'down');
            document.getElementById('historyBody').innerHTML = histHTML;
            document.getElementById('statsBody').innerHTML = Object.entries(coinStats).map(([s, v]) => \`<tr class="border-b border-zinc-800" onclick="setFilter('\${s}')"><td class="py-1 text-white underline cursor-pointer">\${s}</td><td>Lệnh:\${v.count}</td><td>DCA:\${v.dcas}</td><td class="text-right font-bold \${v.pnl>=0?'up':'down'}">\${v.pnl.toFixed(2)}</td></tr>\`).join('');
        } catch(e) {}
    }
    initChart(); setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
