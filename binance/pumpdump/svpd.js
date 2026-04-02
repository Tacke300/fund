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
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
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
        input { border: 1px solid #30363d !important; }
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
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-400 border-b border-zinc-800"><tr><th>Lần</th><th>Thời gian</th><th>Giá DCA</th><th>Giá TB</th></tr></thead><tbody id="modalBody"></tbody></table></div>
        </div>
    </div>

    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="bg-[#0b0e11] p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade</label><input id="marginInp" type="text" class="bg-[#0b0e11] p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">KHỞI CHẠY HỆ THỐNG</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP ENGINE</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div><div class="text-gray-400 text-[11px] uppercase font-bold tracking-widest mb-1">Tài sản Realtime</div><span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span><span class="text-sm text-gray-400 ml-1">USDT</span></div>
            <div class="text-right"><div class="text-gray-400 text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-5">
        <div class="bg-card rounded-xl p-4" style="height: 250px;"><canvas id="balanceChart"></canvas></div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 border border-yellow-500/20">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase italic tracking-widest">Biến động Market (3 khung)</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-400 border-b border-zinc-800 uppercase"><tr><th>Coin</th><th>Giá Hiện Tại</th><th class="text-center">1M (%)</th><th class="text-center">5M (%)</th><th class="text-center">15M (%)</th></tr></thead><tbody id="marketBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang chạy</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-400 uppercase border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Entry/Live</th><th>ROI%</th><th class="text-right">PnL ($)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
         <div class="text-[11px] font-bold text-gray-400 mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-400 border-b border-zinc-800 uppercase"><tr><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>Entry/Out</th><th>ROI%</th><th class="text-right">PnL Net</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 pb-32"><div class="bg-card rounded-xl p-4 shadow-lg border border-yellow-500/20">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase italic">Hiệu suất theo Coin</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-400 border-b border-zinc-800 uppercase"><tr><th>Tên Coin</th><th>Lệnh</th><th>DCA</th><th>PnL Lãi</th><th>Tạm tính</th><th class="text-right">Tổng PnL</th></tr></thead><tbody id="statsBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, initialBal = 1000, lastRawData = null, myChart = null;
    let balanceHistory = JSON.parse(localStorage.getItem('luffy_v3_hist') || '[]');
    let lastHistorySave = 0;

    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.initialBal) {
        document.getElementById('balanceInp').value = saved.initialBal;
        document.getElementById('marginInp').value = saved.marginVal;
        document.getElementById('tpInp').value = saved.tp;
        document.getElementById('slInp').value = saved.sl;
        document.getElementById('volInp').value = saved.vol;
        if(saved.running) { running = true; initialBal = saved.initialBal; document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); syncConfig(); }
    }

    function fDate(t) {
        const d = new Date(t);
        const h = String(d.getHours()).padStart(2,'0'), m = String(d.getMinutes()).padStart(2,'0'), s = String(d.getSeconds()).padStart(2,'0');
        return \`\${h}:\${m}:\${s} - \${d.getDate()}/\${d.getMonth()+1}\`;
    }

    function closeModal(id) { document.getElementById(id).style.display = 'none'; }

    function showStatsModal(sym) {
        const history = lastRawData.history.filter(h => h.symbol === sym);
        document.getElementById('statsModalTitle').innerText = 'LỊCH SỬ: ' + sym;
        document.getElementById('statsModalBody').innerHTML = history.map((h, i) => {
            let mVal = document.getElementById('marginInp').value;
            let marginBase = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
            let totalMargin = marginBase * (h.dcaCount + 1);
            let netPnl = (totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001);
            return \`<tr class="border-b border-zinc-800/30 cursor-pointer hover:bg-white/5" onclick="showDetail('\${h.symbol}', \${h.startTime})">
                <td class="py-3">\${i+1}</td><td>\${fDate(h.startTime)}</td><td>\${fPrice(h.snapPrice)} → \${fPrice(h.finalPrice)}</td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td class="font-bold \${netPnl>=0?'up':'down'}">\${netPnl.toFixed(2)}</td></tr>\`;
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

    function syncConfig() { fetch(\`/api/config?tp=\${document.getElementById('tpInp').value}&sl=\${document.getElementById('slInp').value}&vol=\${document.getElementById('volInp').value}\`); }
    function start() { localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value })); location.reload(); }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line', 
            data: { labels: [], datasets: [{ data: [], borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0, segment: { borderColor: c => c.p1.parsed.y < initialBal ? '#f6465d' : '#0ecb81' }, backgroundColor: 'rgba(255,255,255,0.02)' }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1e2329' } } } }
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastRawData = d;
            let mVal = document.getElementById('marginInp').value, runningBal = initialBal, totalUnPnl = 0, coinStats = {};

            document.getElementById('marketBody').innerHTML = (d.live || []).slice(0, 10).map(m => \`
                <tr class="border-b border-zinc-800/30 text-[11px]"><td class="font-bold text-white py-2">\${m.symbol}</td><td class="text-yellow-500">\${fPrice(m.currentPrice)}</td><td class="text-center font-bold \${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="text-center font-bold \${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="text-center font-bold \${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('');

            document.getElementById('historyBody').innerHTML = [...d.history].reverse().map(h => {
                let mBase = mVal.includes('%') ? (runningBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                let tMargin = mBase * (h.dcaCount + 1);
                let net = (tMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (tMargin * (h.maxLev || 20) * 0.001);
                runningBal += net;
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count:0, dca:0, chotPnl:0, tamPnl:0 };
                coinStats[h.symbol].count++; coinStats[h.symbol].dca += h.dcaCount; coinStats[h.symbol].chotPnl += net;
                return \`<tr class="border-b border-zinc-800/30 text-gray-400"><td class="py-2">\${fDate(h.startTime)}<br>\${fDate(h.endTime)}</td><td class="font-bold text-white cursor-pointer" onclick="showDetail('\${h.symbol}', \${h.startTime})">\${h.symbol}</td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${fPrice(h.snapPrice)} / \${fPrice(h.finalPrice)}</td><td class="\${h.pnlPercent>=0?'up':'down'}">\${h.pnlPercent.toFixed(2)}%</td><td class="text-right font-bold \${net>=0?'up':'down'}">\${net.toFixed(2)}</td></tr>\`;
            }).join('');

            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBase = mVal.includes('%') ? (runningBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                let tMargin = mBase * (h.dcaCount + 1);
                let roi = (h.type === 'UP' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = tMargin * roi / 100; totalUnPnl += pnl;
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count:0, dca:0, chotPnl:0, tamPnl:0 };
                coinStats[h.symbol].tamPnl += pnl;
                return \`<tr class="bg-white/5 border-b border-zinc-800"><td class="p-2 font-bold text-yellow-500 cursor-pointer" onclick="showDetail('\${h.symbol}', \${h.startTime})">\${h.symbol} <small class="text-gray-500">\${h.type}</small></td><td class="font-bold">\${h.dcaCount}</td><td>\${fPrice(h.avgPrice)} → \${fPrice(lp)}</td><td class="font-bold \${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</td><td class="text-right p-2 font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td></tr>\`;
            }).join('');

            document.getElementById('statsBody').innerHTML = Object.entries(coinStats).map(([sym, s]) => \`
                <tr class="border-b border-zinc-800/50"><td class="py-2 font-bold text-white cursor-pointer underline" onclick="showStatsModal('\${sym}')">\${sym}</td><td>\${s.count}</td><td>\${s.dca}</td><td class="up font-bold">\${s.chotPnl.toFixed(2)}</td><td class="\${s.tamPnl>=0?'up':'down'}">\${s.tamPnl.toFixed(2)}</td><td class="text-right font-bold \${(s.chotPnl+s.tamPnl)>=0?'up':'down'}">\${(s.chotPnl+s.tamPnl).toFixed(2)}</td></tr>\`).join('');

            let now = Date.now(); let currentTotal = runningBal + totalUnPnl;
            if (now - lastHistorySave > 600000) { balanceHistory.push({ t: now, v: currentTotal }); if(balanceHistory.length > 500) balanceHistory.shift(); localStorage.setItem('luffy_v3_hist', JSON.stringify(balanceHistory)); lastHistorySave = now; }
            if(myChart) { myChart.data.labels = [...balanceHistory.map(i => i.t), now].map(t => new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})); myChart.data.datasets[0].data = [...balanceHistory.map(i => i.v), currentTotal]; myChart.update('none'); }
            if(running) { document.getElementById('displayBal').innerText = currentTotal.toFixed(2); document.getElementById('displayBal').className = 'text-4xl font-bold ' + (currentTotal >= initialBal ? 'up' : 'down'); document.getElementById('unPnl').innerText = (totalUnPnl >= 0 ? '+' : '') + totalUnPnl.toFixed(2); document.getElementById('unPnl').className = 'text-xl font-bold ' + (totalUnPnl >= 0 ? 'up' : 'down'); }
        } catch(e) {}
    }
    initChart(); setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
