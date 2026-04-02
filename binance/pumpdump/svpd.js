const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
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

let currentTP = 0.5, currentSL = 100.0, currentMinVol = 6.5;

// --- GIỮ NGUYÊN LOGIC HÀNG CHỜ ---
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
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) {
                    pending.maxNegativeRoi = currentRoi;
                }
                const win = pending.type === 'UP' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);
                if (win || isTimeout) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'UP' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }
                const lastPrice = pending.dcaHistory[pending.dcaHistory.length - 1].p;
                const diffFromLast = ((p - lastPrice) / lastPrice) * 100;
                const triggerDCA = pending.type === 'UP' ? diffFromLast <= -pending.slTarget : diffFromLast >= pending.slTarget;
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        setTimeout(() => { pending.avgPrice = newAvg; pending.dcaCount = newCount; }, 200); 
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
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); align-items:center; justify-content:center; }
        .scroll-custom::-webkit-scrollbar { width: 4px; } .scroll-custom::-webkit-scrollbar-thumb { background: #30363d; }
    </style></head><body>
    
    <div id="statsModal" class="modal">
        <div class="bg-card p-4 rounded-lg w-full max-w-2xl border border-zinc-700 flex flex-col max-h-[85vh]">
            <div class="flex justify-between items-center mb-4">
                <h2 id="statsModalTitle" class="text-yellow-500 font-bold uppercase italic"></h2>
                <button onclick="closeModal('statsModal')" class="text-2xl text-gray-400 hover:text-white">&times;</button>
            </div>
            <div class="overflow-y-auto scroll-custom flex-1">
                <table class="w-full text-[10px] text-left">
                    <thead class="text-gray-400 border-b border-zinc-800"><tr><th>STT</th><th>Thời gian</th><th>Entry/Out</th><th>DCA</th><th>PnL Net</th></tr></thead>
                    <tbody id="statsModalBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <div id="detailModal" class="modal">
        <div class="bg-card p-6 rounded-lg w-11/12 max-w-xl border border-zinc-700 relative">
            <button onclick="closeModal('detailModal')" class="absolute top-2 right-4 text-2xl text-gray-400 hover:text-white">&times;</button>
            <h2 id="modalTitle" class="text-yellow-500 font-bold mb-4 uppercase"></h2>
            <div id="modalSummary" class="grid grid-cols-3 gap-2 mb-4 text-center"></div>
            <table class="w-full text-[10px] text-left"><thead class="text-gray-400 border-b border-zinc-800"><tr><th>Lần</th><th>Thời gian</th><th>Giá DCA</th><th>Giá TB</th></tr></thead><tbody id="modalBody"></tbody></table>
        </div>
    </div>

    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <input id="balanceInp" type="number" placeholder="Vốn khởi tạo" class="bg-[#0b0e11] p-2 rounded text-yellow-500 font-bold">
            <input id="marginInp" type="text" placeholder="Margin (10% hoặc 50)" class="bg-[#0b0e11] p-2 rounded text-white">
            <input id="tpInp" type="number" step="0.1" placeholder="TP %" class="bg-[#0b0e11] p-2 rounded text-white">
            <input id="slInp" type="number" step="0.1" placeholder="DCA %" class="bg-[#0b0e11] p-2 rounded text-white">
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold uppercase text-xs">KHỞI CHẠY</button>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div><div class="text-gray-400 text-[11px] mb-1 uppercase font-bold">Tài sản</div><span id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</span></div>
            <div class="text-right"><div class="text-gray-400 text-[11px] mb-1 uppercase font-bold">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="p-4 h-[250px]"><canvas id="balanceChart"></canvas></div>

    <div class="p-4 space-y-6">
        <div>
            <div class="text-[10px] font-bold text-green-500 uppercase mb-2">Vị thế đang mở</div>
            <div class="bg-card rounded-lg overflow-x-auto"><table class="w-full text-[10px] text-left">
                <thead class="text-gray-400 border-b border-zinc-800"><tr><th class="p-2">Pair</th><th>DCA</th><th>Entry/Live</th><th>ROI%</th><th class="text-right p-2">PnL ($)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table></div>
        </div>

        <div>
            <div class="text-[10px] font-bold text-gray-400 uppercase mb-2">Nhật ký giao dịch</div>
            <div class="bg-card rounded-lg overflow-x-auto"><table class="w-full text-[9px] text-left">
                <thead class="text-gray-400 border-b border-zinc-800"><tr><th class="p-2">Time</th><th>Pair</th><th>DCA</th><th>Entry/Out</th><th>ROI%</th><th class="text-right p-2">PnL Net</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table></div>
        </div>

        <div>
            <div class="text-[10px] font-bold text-yellow-500 uppercase mb-2">Hiệu suất Coin</div>
            <div class="bg-card rounded-lg overflow-x-auto"><table class="w-full text-[10px] text-left">
                <thead class="text-gray-400 border-b border-zinc-800"><tr><th class="p-2">Tên Coin</th><th>Lệnh</th><th>DCA</th><th>PnL Chốt</th><th>Tạm Tính</th><th class="text-right p-2">Tổng PnL</th></tr></thead>
                <tbody id="statsBody"></tbody>
            </table></div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000, lastRawData = null, myChart = null;
    let balanceHistory = JSON.parse(localStorage.getItem('luffy_hist_v2') || '[]');

    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.initialBal) {
        document.getElementById('balanceInp').value = saved.initialBal;
        document.getElementById('marginInp').value = saved.marginVal;
        document.getElementById('tpInp').value = saved.tp;
        document.getElementById('slInp').value = saved.sl;
        if(saved.running) { running = true; initialBal = saved.initialBal; document.getElementById('setup').classList.add('hidden'); syncConfig(); }
    }

    function fDate(t) {
        const d = new Date(t);
        return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0') + ':' + d.getSeconds().toString().padStart(2,'0') + ' - ' + d.getDate() + '/' + (d.getMonth()+1);
    }

    function closeModal(id) { document.getElementById(id).style.display = 'none'; }

    function showStatsModal(sym) {
        const history = lastRawData.history.filter(h => h.symbol === sym);
        document.getElementById('statsModalTitle').innerText = 'LỊCH SỬ: ' + sym;
        document.getElementById('statsModalBody').innerHTML = history.map((h, i) => {
            let mVal = document.getElementById('marginInp').value;
            let mBase = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
            let net = (mBase * (h.dcaCount + 1) * (h.maxLev || 20) * (h.pnlPercent/100)) - (mBase * (h.dcaCount + 1) * (h.maxLev || 20) * 0.001);
            return \`<tr class="border-b border-zinc-800/30 cursor-pointer hover:bg-white/5" onclick="showDetail('\${h.symbol}', \${h.startTime})">
                <td class="py-3 text-gray-500">\${i+1}</td><td>\${fDate(h.startTime)}</td><td>\${fPrice(h.snapPrice)} → \${fPrice(h.finalPrice)}</td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td class="font-bold \${net>=0?'up':'down'}">\${net.toFixed(2)}</td></tr>\`;
        }).join('');
        document.getElementById('statsModal').style.display = 'flex';
    }

    function showDetail(symbol, startTime) {
        const item = [...lastRawData.pending, ...lastRawData.history].find(h => h.symbol === symbol && h.startTime == startTime);
        if(!item) return;
        document.getElementById('modalTitle').innerText = symbol + ' (DCA Steps)';
        document.getElementById('modalSummary').innerHTML = \`
            <div class="bg-zinc-800 p-2 rounded">STATUS: <span class="font-bold">\${item.status}</span></div>
            <div class="bg-zinc-800 p-2 rounded">AVG: <span class="font-bold">\${fPrice(item.avgPrice)}</span></div>
            <div class="bg-zinc-800 p-2 rounded">ROI: <span class="font-bold \${item.pnlPercent>=0?'up':'down'}">\${(item.pnlPercent||0).toFixed(2)}%</span></div>\`;
        document.getElementById('modalBody').innerHTML = item.dcaHistory.map((d, i) => \`
            <tr class="border-b border-zinc-800/50"><td class="py-2">\${i}</td><td>\${fDate(d.t)}</td><td>\${fPrice(d.p)}</td><td>\${fPrice(d.avg)}</td></tr>\`).join('');
        document.getElementById('detailModal').style.display = 'flex';
    }

    function syncConfig() { fetch(\`/api/config?tp=\${document.getElementById('tpInp').value}&sl=\${document.getElementById('slInp').value}\`); }
    function start() { localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value })); location.reload(); }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line', data: { labels: [], datasets: [{ data: [], borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0, segment: { borderColor: c => c.p1.parsed.y < initialBal ? '#f6465d' : '#0ecb81' }, backgroundColor: 'rgba(255,255,255,0.01)' }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1e2329' } } } }
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastRawData = d;
            let mVal = document.getElementById('marginInp').value, runningBal = initialBal, totalUnPnl = 0, coinStats = {};

            document.getElementById('historyBody').innerHTML = [...d.history].reverse().map(h => {
                let mBase = mVal.includes('%') ? (runningBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                let net = (mBase * (h.dcaCount + 1) * (h.maxLev || 20) * (h.pnlPercent/100)) - (mBase * (h.dcaCount + 1) * (h.maxLev || 20) * 0.001);
                runningBal += net;
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count:0, dca:0, chot:0, tam:0 };
                coinStats[h.symbol].count++; coinStats[h.symbol].dca += h.dcaCount; coinStats[h.symbol].chot += net;
                return \`<tr class="border-b border-zinc-800/30 text-zinc-400"><td class="p-2">\${fDate(h.endTime)}</td><td class="font-bold text-white cursor-pointer" onclick="showDetail('\${h.symbol}', \${h.startTime})">\${h.symbol}</td><td class="text-yellow-500">\${h.dcaCount}</td><td>\${fPrice(h.snapPrice)}/\${fPrice(h.finalPrice)}</td><td class="\${h.pnlPercent>=0?'up':'down'}">\${h.pnlPercent.toFixed(2)}%</td><td class="text-right p-2 font-bold \${net>=0?'up':'down'}">\${net.toFixed(2)}</td></tr>\`;
            }).join('');

            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBase = mVal.includes('%') ? (runningBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                let roi = (h.type === 'UP' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = (mBase * (h.dcaCount + 1)) * roi / 100; totalUnPnl += pnl;
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count:0, dca:0, chot:0, tam:0 };
                coinStats[h.symbol].tam += pnl;
                return \`<tr class="bg-white/5 border-b border-zinc-800"><td class="p-2 font-bold text-yellow-500 cursor-pointer" onclick="showDetail('\${h.symbol}', \${h.startTime})">\${h.symbol}</td><td>\${h.dcaCount}</td><td>\${fPrice(h.avgPrice)}→\${fPrice(lp)}</td><td class="font-bold \${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</td><td class="text-right p-2 font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td></tr>\`;
            }).join('');

            document.getElementById('statsBody').innerHTML = Object.entries(coinStats).map(([sym, s]) => \`
                <tr class="border-b border-zinc-800/50"><td class="p-2 font-bold text-white cursor-pointer underline" onclick="showStatsModal('\${sym}')">\${sym}</td><td>\${s.count}</td><td>\${s.dca}</td><td class="up">\${s.chot.toFixed(2)}</td><td class="\${s.tam>=0?'up':'down'}">\${s.tam.toFixed(2)}</td><td class="text-right p-2 font-bold \${(s.chot+s.tam)>=0?'up':'down'}">\${(s.chot+s.tam).toFixed(2)}</td></tr>\`).join('');

            let now = Date.now(); let currentTotal = runningBal + totalUnPnl;
            if(myChart) { myChart.data.labels = [...balanceHistory.map(i => i.t), now]; myChart.data.datasets[0].data = [...balanceHistory.map(i => i.v), currentTotal]; myChart.update('none'); }
            if(running) { document.getElementById('displayBal').innerText = currentTotal.toFixed(2); document.getElementById('displayBal').className = 'text-4xl font-bold ' + (currentTotal >= initialBal ? 'up' : 'down'); document.getElementById('unPnl').innerText = (totalUnPnl>=0?'+':'') + totalUnPnl.toFixed(2); document.getElementById('unPnl').className = 'text-xl font-bold ' + (totalUnPnl>=0?'up':'down'); }
        } catch(e) {}
    }
    initChart(); setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
