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
let tempMinuteLogs = []; // Lưu tạm 1p/điểm để biểu đồ mượt, không ghi file

let currentTP = 0.5, currentSL = 100.0, currentMinVol = 6.5;

// --- LOGIC HÀNG CHỜ ---
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

// Hàm tính PnL hiện tại để lấy điểm biểu đồ
function getCurrentTotalPnl() {
    const hist = Array.from(historyMap.values()).filter(h => h.status !== 'PENDING');
    return hist.reduce((sum, h) => {
        let marginBase = 10; // Con số tượng trưng để tính toán pnl tương đối
        let totalMargin = marginBase * (h.dcaCount + 1);
        return sum + ((totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001));
    }, 0);
}

// Interval 1 phút: Lấy điểm tạm thời (không lưu file)
setInterval(() => {
    tempMinuteLogs.push({ t: Date.now(), pnl: getCurrentTotalPnl() });
    if (tempMinuteLogs.length > 100) tempMinuteLogs.shift();
}, 60000);

// Interval 10 phút: Lưu điểm vĩnh viễn (ghi file)
setInterval(() => {
    balanceLogs.push({ t: Date.now(), pnl: getCurrentTotalPnl() });
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
                if (((pending.type === 'UP' ? (p - lastPrice)/lastPrice : (lastPrice - p)/lastPrice) * 100) <= -pending.slTarget && !actionQueue.find(q => q.id === s)) {
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
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime),
        balanceLogs: balanceLogs,
        tempLogs: tempMinuteLogs
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.8); align-items:center; justify-content:center; }
    </style></head><body>
    
    <div id="detailModal" class="modal">
        <div class="bg-card p-6 rounded-lg w-11/12 max-w-2xl border border-zinc-700 relative">
            <button onclick="closeModal('detailModal')" class="absolute top-2 right-4 text-2xl text-gray-custom">&times;</button>
            <h2 id="modalTitle" class="text-yellow-500 font-bold mb-4 uppercase"></h2>
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom"><tr><th>Lần</th><th>Thời gian</th><th>Giá DCA</th><th>Giá TB</th><th>Margin</th><th>Lev</th><th>TP</th></tr></thead><tbody id="modalBody"></tbody></table></div>
        </div>
    </div>

    <div id="coinHistoryModal" class="modal">
        <div class="bg-card p-6 rounded-lg w-11/12 max-w-4xl border border-zinc-700 relative">
            <button onclick="closeModal('coinHistoryModal')" class="absolute top-2 right-4 text-2xl text-gray-custom">&times;</button>
            <h2 id="coinModalTitle" class="text-yellow-500 font-bold mb-4 uppercase"></h2>
            <div class="overflow-x-auto" style="max-height: 70vh;"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Out</th><th>Avg</th><th class="text-center">MaxDD</th><th>PnL Net</th></tr></thead><tbody id="coinHistoryBody"></tbody></table></div>
        </div>
    </div>

    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn ($)</label><input id="balanceInp" type="number" class="bg-[#0b0e11] p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin</label><input id="marginInp" type="text" class="bg-[#0b0e11] p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-3 gap-2">
                <input id="tpInp" type="number" step="0.1" class="bg-card p-2 rounded text-white text-xs">
                <input id="slInp" type="number" step="0.1" class="bg-card p-2 rounded text-white text-xs">
                <input id="volInp" type="number" step="0.1" class="bg-card p-2 rounded text-white text-xs">
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold text-xs uppercase">Khởi chạy</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-[#fcd535] font-black text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP</div>
        </div>

        <div class="flex justify-between items-end">
            <div><span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span><span class="text-sm text-gray-custom ml-1">USDT</span></div>
            <div class="text-right"><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>

        <div class="grid grid-cols-3 gap-2 mt-4">
            <div class="bg-card p-2 rounded border border-zinc-800 text-center"><div class="text-[9px] text-gray-custom uppercase">Win</div><div id="sumWinCount" class="text-lg font-bold text-green-400">0</div></div>
            <div class="bg-card p-2 rounded border border-zinc-800 text-center"><div class="text-[9px] text-gray-custom uppercase">PnL Win</div><div id="sumWinPnl" class="text-lg font-bold text-white">0.00</div></div>
            <div class="bg-card p-2 rounded border border-zinc-800 text-center"><div class="text-[9px] text-gray-custom uppercase">DCA</div><div id="sumDCACount" class="text-lg font-bold text-yellow-500">0</div></div>
        </div>
    </div>

    <div class="px-4 mt-5">
        <div class="bg-card rounded-xl p-4">
            <div class="text-[11px] font-bold text-yellow-500 uppercase mb-2">Biến động tài sản</div>
            <div style="height: 220px;"><canvas id="balanceChart"></canvas></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase">Biến động Market</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Coin</th><th>Giá</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-center">15M</th></tr></thead><tbody id="marketBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-white mb-3 uppercase">Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>STT</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 pb-32"><div class="bg-card rounded-xl p-4 border border-yellow-500/20">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase">Hiệu suất theo Coin</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>STT</th><th>Coin</th><th>Lev</th><th>Lệnh</th><th>DCA</th><th>PnL Win</th><th class="text-right">Tổng PnL</th></tr></thead><tbody id="statsBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, initialBal = 1000, lastRawData = null, myChart = null;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;

    if(saved.running) { running = true; initialBal = saved.initialBal; document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); syncConfig(); }

    function fPrice(p) { if (!p || p === 0) return "0.0000"; let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/); if (!match) return p.toFixed(4); let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3); }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }
    function syncConfig() { fetch(\`/api/config?tp=\${document.getElementById('tpInp').value}&sl=\${document.getElementById('slInp').value}&vol=\${document.getElementById('volInp').value}\`); }
    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value })); syncConfig(); location.reload(); }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    function showDetail(symbol, startTime) {
        const item = [...lastRawData.pending, ...lastRawData.history].find(h => h.symbol === symbol && h.startTime == startTime);
        if(!item) return;
        document.getElementById('modalTitle').innerText = \`DCA: \${symbol}\`;
        let mVal = document.getElementById('marginInp').value;
        let marginBase = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
        document.getElementById('modalBody').innerHTML = item.dcaHistory.map((d, i) => \`<tr><td>\${i}</td><td>\${new Date(d.t).toLocaleTimeString()}</td><td>\${fPrice(d.p)}</td><td>\${fPrice(d.avg)}</td><td>\${marginBase.toFixed(2)}</td><td>\${item.maxLev}x</td><td class="up font-bold">\${fPrice(item.type==='UP'? d.avg*(1+item.tpTarget/100) : d.avg*(1-item.tpTarget/100))}</td></tr>\`).join('');
        document.getElementById('detailModal').style.display = 'flex';
    }

    function showCoinHistory(symbol) {
        const list = lastRawData.history.filter(h => h.symbol === symbol);
        document.getElementById('coinModalTitle').innerText = \`Lịch sử: \${symbol}\`;
        let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
        document.getElementById('coinHistoryBody').innerHTML = list.map((h, i) => {
            let mBase = mVal.includes('%') ? (initialBal * mNum / 100) : mNum;
            let totalM = mBase * (h.dcaCount + 1);
            let pnl = (totalM * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalM * (h.maxLev || 20) * 0.001);
            return \`<tr class="border-b border-zinc-800/50"><td>\${i+1}</td><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b></td><td>\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td>\${fPrice(h.snapPrice)}/\${fPrice(h.finalPrice)}</td><td>\${fPrice(h.avgPrice)}</td><td class="down">\${h.maxNegativeRoi.toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td></tr>\`;
        }).join('');
        document.getElementById('coinHistoryModal').style.display = 'flex';
    }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line', 
            data: { labels: [], datasets: [{ data: [], borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, borderColor: '#0ecb81', backgroundColor: 'rgba(14, 203, 129, 0.05)', segment: { borderColor: ctx => ctx.p1.raw < initialBal ? '#f6465d' : '#0ecb81', backgroundColor: ctx => ctx.p1.raw < initialBal ? 'rgba(246, 70, 93, 0.05)' : 'rgba(14, 203, 129, 0.05)' } }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' }, ticks: { color: '#848e9c', font: { size: 9 } } } } }
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastRawData = d;
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let runningBal = initialBal, winSum = 0, totalDCA = 0, winCount = 0, coinStats = {};

            document.getElementById('marketBody').innerHTML = (d.live || []).slice(0, 10).map(m => \`<tr class="border-b border-zinc-800/30"><td>\${m.symbol}</td><td>\${fPrice(m.currentPrice)}</td><td class="text-center \${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="text-center \${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="text-center \${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('');

            d.history.reverse().forEach(h => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let netPnl = (mBase * (h.dcaCount + 1) * (h.maxLev || 20) * (h.pnlPercent/100)) - (mBase * (h.dcaCount + 1) * (h.maxLev || 20) * 0.001);
                runningBal += netPnl; totalDCA += h.dcaCount;
                if(netPnl >= 0) { winSum += netPnl; winCount++; }
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { lev: h.maxLev, count: 0, dcas: 0, pnlW: 0, livePnl: 0 };
                coinStats[h.symbol].count++; coinStats[h.symbol].dcas += h.dcaCount;
                if(netPnl >= 0) coinStats[h.symbol].pnlW += netPnl;
            });

            let unPnl = 0;
            document.getElementById('pendingBody').innerHTML = (d.pending || []).map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let totalMargin = (mVal.includes('%') ? (runningBal * mNum / 100) : mNum) * (h.dcaCount + 1);
                let roi = (h.type === 'UP' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = totalMargin * roi / 100; unPnl += pnl;
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { lev: h.maxLev, count: 0, dcas: 0, pnlW: 0, livePnl: 0 };
                coinStats[h.symbol].livePnl += pnl;
                return \`<tr class="border-b border-zinc-800"><td>\${idx+1}</td><td class="text-white font-bold underline cursor-pointer" onclick="showDetail('\${h.symbol}', \${h.startTime})">\${h.symbol}</td><td>\${h.dcaCount}</td><td>\${totalMargin.toFixed(1)}</td><td>\${fPrice(h.snapPrice)}/\${fPrice(lp)}</td><td class="text-right \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
            }).join('');

            // Logic Biểu đồ Hybrid
            if(myChart) {
                let combinedLogs = [];
                if(d.balanceLogs && d.balanceLogs.length > 0) {
                    combinedLogs = [...d.balanceLogs]; // Ưu tiên điểm 10p đã lưu
                } else if(d.tempLogs) {
                    combinedLogs = [...d.tempLogs]; // Nếu chưa có 10p nào thì lấy điểm 1p tạm thời
                }
                let labels = combinedLogs.map(l => new Date(l.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
                let values = combinedLogs.map(l => initialBal + l.pnl);
                labels.push("LIVE"); values.push(runningBal + unPnl);
                myChart.data.labels = labels; myChart.data.datasets[0].data = values; myChart.update('none');
            }

            document.getElementById('sumWinCount').innerText = winCount;
            document.getElementById('sumWinPnl').innerText = winSum.toFixed(2);
            document.getElementById('sumDCACount').innerText = totalDCA;
            document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
            document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
            document.getElementById('statsBody').innerHTML = Object.entries(coinStats).map(([sym, s], i) => \`<tr class="border-b border-zinc-800/50"><td>\${i+1}</td><td class="text-white font-bold underline cursor-pointer hover:text-yellow-500" onclick="showCoinHistory('\${sym}')">\${sym}</td><td>\${s.lev}x</td><td>\${s.count}</td><td>\${s.dcas}</td><td class="up">\${s.pnlW.toFixed(2)}</td><td class="text-right font-bold \${(s.pnlW+s.livePnl)>=0?'up':'down'}">\${(s.pnlW+s.livePnl).toFixed(2)}</td></tr>\`).join('');
        } catch(e) {}
    }
    initChart(); setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
