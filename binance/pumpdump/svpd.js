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

let currentTP = 0.5, currentSL = 100.0, currentMinVol = 6.5;

// --- LOGIC HÀNG CHỜ ƯU TIÊN ---
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

setInterval(() => {
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING');
    const currentPnl = hist.reduce((sum, h) => {
        let marginBase = 10; 
        let totalMargin = marginBase * (h.dcaCount + 1);
        return sum + ((totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001));
    }, 0);
    balanceLogs.push({ t: Date.now(), pnl: currentPnl });
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
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;
                const win = pending.type === 'UP' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'UP' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }
                const lastPrice = pending.dcaHistory[pending.dcaHistory.length - 1].p;
                const triggerDCA = pending.type === 'UP' ? ((p - lastPrice) / lastPrice) * 100 <= -pending.slTarget : ((p - lastPrice) / lastPrice) * 100 >= pending.slTarget;
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (pending.dcaCount + 2);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        setTimeout(() => { pending.avgPrice = newAvg; pending.dcaCount++; }, 200); 
                    }});
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                            maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                        });
                    }});
                }
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
        balanceLogs: balanceLogs 
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.8); align-items:center; justify-content:center; }
    </style></head><body>
    
    <div id="detailModal" class="modal"><div class="bg-card p-6 rounded-lg w-11/12 max-w-2xl relative">
        <button onclick="closeModal('detailModal')" class="absolute top-2 right-4 text-2xl">&times;</button>
        <h2 id="modalTitle" class="text-yellow-500 font-bold mb-4 uppercase"></h2>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="border-b border-zinc-800"><tr><th>Lần</th><th>Thời gian</th><th>Giá DCA</th><th>Giá TB</th><th>Margin</th><th>Lev</th><th>TP sau DCA</th></tr></thead><tbody id="modalBody"></tbody></table></div>
    </div></div>

    <div class="p-4 sticky top-0 z-50 bg-[#0b0e11] border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <input id="balanceInp" type="number" class="bg-black p-2 rounded text-yellow-500 font-bold" placeholder="Vốn">
            <input id="marginInp" type="text" class="bg-black p-2 rounded text-yellow-500 font-bold" placeholder="Margin">
            <div class="col-span-2 grid grid-cols-3 gap-2">
                <input id="tpInp" type="number" step="0.1" class="bg-black p-2 rounded text-white text-xs" placeholder="TP">
                <input id="slInp" type="number" step="0.1" class="bg-black p-2 rounded text-white text-xs" placeholder="DCA">
                <input id="volInp" type="number" step="0.1" class="bg-black p-2 rounded text-white text-xs" placeholder="Vol">
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold">KHỞI CHẠY</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <button onclick="stop()" class="text-[#fcd535] text-xs border border-[#fcd535] px-2 py-1 rounded">STOP ENGINE</button>
        </div>
        <div class="flex justify-between items-end">
            <div><div class="text-[10px] uppercase font-bold text-gray-500">Total Asset</div><span id="displayBal" class="text-4xl font-bold">0.00</span><span class="text-sm text-gray-500 ml-1">USDT</span></div>
            <div id="unPnl" class="text-xl font-bold">0.00</div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-yellow-500 uppercase italic mb-2">Biểu đồ Real-time (Bấm xem PnL Tạm tính)</div>
        <div style="height: 220px;"><canvas id="balanceChart"></canvas></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-white mb-2 uppercase flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span>Vị thế đang mở</div>
        <table class="w-full text-[10px] text-left"><tbody id="pendingBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="flex justify-between items-center mb-3">
            <div class="text-[11px] font-bold text-gray-500 uppercase italic">Nhật ký giao dịch <span id="filterLabel" class="text-yellow-500 ml-2"></span></div>
            <button id="btnReset" class="hidden text-[10px] bg-zinc-800 px-2 py-1 rounded" onclick="filterByCoin(null)">BỎ LỌC</button>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 pb-32"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase italic">Thống kê hiệu suất (Bấm vào Coin để lọc)</div>
        <table class="w-full text-[10px] text-left"><tbody id="statsBody"></tbody></table>
    </div></div>

    <script>
    let running = false, initialBal = 1000, lastRawData = null, myChart = null, coinFilter = null;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;

    if(saved.running) { running = true; initialBal = saved.initialBal; document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }

    function fPrice(p) { if (!p || p === 0) return "0.0000"; let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/); if (!match) return p.toFixed(4); let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3); }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }
    function filterByCoin(s) { coinFilter = s; document.getElementById('filterLabel').innerText = s ? \`[Lọc: \${s}]\` : ""; document.getElementById('btnReset').classList.toggle('hidden', !s); update(); }
    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value })); location.reload(); }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    function showDetail(symbol, startTime) {
        const item = [...lastRawData.pending, ...lastRawData.history].find(h => h.symbol === symbol && h.startTime == startTime);
        if(!item) return;
        document.getElementById('modalTitle').innerText = \`Chi tiết DCA: \${symbol}\`;
        let mVal = document.getElementById('marginInp').value;
        let mBase = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
        document.getElementById('modalBody').innerHTML = item.dcaHistory.map((d, i) => \`<tr><td class="py-2">\${i}</td><td>\${new Date(d.t).toLocaleTimeString()}</td><td>\${fPrice(d.p)}</td><td>\${fPrice(d.avg)}</td><td>\${mBase.toFixed(2)}</td><td>\${item.maxLev}x</td><td class="up font-bold">\${fPrice(item.type==='UP'? d.avg*(1+item.tpTarget/100) : d.avg*(1-item.tpTarget/100))}</td></tr>\`).join('');
        document.getElementById('detailModal').style.display = 'flex';
    }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line', data: { labels: [], datasets: [{ label: 'Balance', data: [], borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, borderColor: '#0ecb81', backgroundColor: 'rgba(14, 203, 129, 0.05)' }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
                scales: { x: { display: false }, y: { grid: { color: '#30363d' }, ticks: { font: { size: 9 } } } } }
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastRawData = d;
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let runningBal = initialBal, winSum = 0, coinStats = {};

            let histHTML = [...d.history].sort((a,b)=>a.endTime-b.endTime).map((h, idx) => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let totalM = mBase * (h.dcaCount + 1);
                let netPnl = (totalM * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalM * (h.maxLev || 20) * 0.001);
                runningBal += netPnl;
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count: 0, dcas: 0, pnl: 0, livePnl: 0 };
                coinStats[h.symbol].count++; coinStats[h.symbol].dcas += h.dcaCount; coinStats[h.symbol].pnl += netPnl;
                if(coinFilter && h.symbol !== coinFilter) return null;
                return \`<tr class="border-b border-zinc-800 text-zinc-400"><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b class="text-white underline cursor-pointer" onclick="showDetail('\${h.symbol}',\${h.startTime})">\${h.symbol}</b></td><td>DCA:\${h.dcaCount}</td><td class="\${netPnl>=0?'up':'down'} font-bold">\${netPnl.toFixed(2)}</td><td class="text-right text-white">\${runningBal.toFixed(1)}</td></tr>\`;
            }).filter(x=>x).reverse().join('');

            let unPnl = 0;
            document.getElementById('pendingBody').innerHTML = (d.pending || []).map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let totalM = (mVal.includes('%') ? (runningBal * mNum / 100) : mNum) * (h.dcaCount + 1);
                let roi = (h.type === 'UP' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = totalM * roi / 100; unPnl += pnl;
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count: 0, dcas: 0, pnl: 0, livePnl: 0 };
                coinStats[h.symbol].livePnl += pnl;
                return \`<tr class="border-b border-zinc-800"><td><b class="text-white underline cursor-pointer" onclick="showDetail('\${h.symbol}',\${h.startTime})">\${h.symbol}</b></td><td>DCA:\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td class="text-right \${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
            }).join('');

            if(myChart && d.balanceLogs) {
                let labels = d.balanceLogs.map(l => new Date(l.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
                let values = d.balanceLogs.map(l => initialBal + l.pnl);
                labels.push("LIVE"); values.push(runningBal + unPnl);
                myChart.data.labels = labels; myChart.data.datasets[0].data = values;
                myChart.update('none');
            }

            document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
            document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
            document.getElementById('historyBody').innerHTML = histHTML;
            document.getElementById('statsBody').innerHTML = Object.entries(coinStats).map(([s, v]) => \`<tr class="border-b border-zinc-800" onclick="filterByCoin('\${s}')"><td class="py-2 text-white font-bold underline cursor-pointer">\${s}</td><td>Lệnh:\${v.count}</td><td>DCA:\${v.dcas}</td><td class="text-right font-bold \${(v.pnl+v.livePnl)>=0?'up':'down'}">\${(v.pnl+v.livePnl).toFixed(2)}</td></tr>\`).join('');
        } catch(e) {}
    }
    initChart(); setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
