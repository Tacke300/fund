const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 500000; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

// Biến cấu hình mở rộng
let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW', sidePreference = 'BOTH';

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
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) {
                    pending.maxNegativeRoi = currentRoi;
                }

                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);
                if (win || isTimeout) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }

                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
                
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        setTimeout(() => {
                            pending.avgPrice = newAvg;
                            pending.dcaCount = newCount;
                        }, 200); 
                    }});
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        let volMax = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                        let isPositive = (volMax === Math.abs(c1)) ? c1 > 0 : (volMax === Math.abs(c5) ? c5 > 0 : c15 > 0);
                        
                        let type = 'LONG';
                        if (tradeMode === 'FOLLOW') type = isPositive ? 'LONG' : 'SHORT';
                        else if (tradeMode === 'REVERSE') type = isPositive ? 'SHORT' : 'LONG';
                        else if (tradeMode === 'ONLY_LONG') type = 'LONG';
                        else if (tradeMode === 'ONLY_SHORT') type = 'SHORT';

                        // Lọc theo sidePreference
                        if (sidePreference !== 'BOTH' && type !== sidePreference) return;

                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
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
    currentTP = parseFloat(req.query.tp); 
    currentSL = parseFloat(req.query.sl); 
    currentMinVol = parseFloat(req.query.vol); 
    tradeMode = req.query.mode || 'FOLLOW';
    sidePreference = req.query.side || 'BOTH';
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const topData = Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1));
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: topData, 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro - Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; overflow-x: hidden; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; }
        .modal-full { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:#0b0e11; overflow-y:auto; padding: 20px; }
        .tab-btn { border-bottom: 2px solid transparent; padding: 10px 20px; cursor: pointer; color: #848e9c; font-weight: bold; }
        .tab-btn.active { border-color: #fcd535; color: #fcd535; }
    </style></head><body>

    <div class="p-4 border-b border-zinc-800 bg-[#0b0e11] sticky top-0 z-50 flex justify-between items-center">
        <div class="font-bold italic text-white text-xl tracking-tighter">LUFFY <span class="text-[#fcd535]">COMMANDER</span></div>
        <div class="flex gap-2">
            <button onclick="openTab('configModal')" class="bg-zinc-800 px-3 py-1.5 rounded text-xs font-bold uppercase">Cấu hình</button>
            <button onclick="openTab('historyModal')" class="bg-zinc-800 px-3 py-1.5 rounded text-xs font-bold uppercase">Lịch sử & Vị thế</button>
        </div>
    </div>

    <div id="mainDashboard" class="p-4">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div class="bg-card p-4 rounded-xl">
                <div class="text-[10px] text-gray-400 uppercase font-bold mb-1">Equity (Balance + PnL)</div>
                <div id="displayBal" class="text-2xl font-bold text-white">0.00</div>
            </div>
            <div class="bg-card p-4 rounded-xl">
                <div class="text-[10px] text-gray-400 uppercase font-bold mb-1">PnL Tạm tính</div>
                <div id="unPnl" class="text-2xl font-bold">0.00</div>
            </div>
            <div class="bg-card p-4 rounded-xl">
                <div class="text-[10px] text-gray-400 uppercase font-bold mb-1">Lệnh Win / Đang mở</div>
                <div class="text-xl font-bold text-white"><span id="sumWinCount" class="text-green-400">0</span> / <span id="sumPendingCount" class="text-yellow-500">0</span></div>
            </div>
            <div class="bg-card p-4 rounded-xl">
                <div class="text-[10px] text-gray-400 uppercase font-bold mb-1">Tổng Lãi ròng ($)</div>
                <div id="sumWinPnl" class="text-2xl font-bold text-green-400">0.00</div>
            </div>
        </div>

        <div class="bg-card rounded-xl p-4 mb-6">
            <div class="text-[11px] font-bold text-gray-400 uppercase tracking-widest italic mb-4">Mốc tăng trưởng (1h/Point)</div>
            <div style="height: 300px;"><canvas id="balanceChart"></canvas></div>
        </div>

        <div class="bg-card rounded-xl p-4">
            <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase italic">Biến động Market</div>
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Coin</th><th>Giá</th><th>1M</th><th>5M</th><th>15M</th></tr></thead><tbody id="marketBody"></tbody></table></div>
        </div>
    </div>

    <div id="configModal" class="modal-full">
        <div class="max-w-xl mx-auto">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-xl font-bold text-yellow-500 uppercase">Cấu hình thông số</h2>
                <button onclick="closeTab('configModal')" class="text-2xl">&times;</button>
            </div>
            <div class="bg-card p-6 rounded-xl space-y-4">
                <div class="grid grid-cols-2 gap-4">
                    <div><label class="text-[10px] text-gray-400 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-3 rounded w-full outline-none"></div>
                    <div><label class="text-[10px] text-gray-400 uppercase font-bold">Margin / Lệnh</label><input id="marginInp" type="text" class="p-3 rounded w-full outline-none"></div>
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div><label class="text-[10px] text-gray-400 uppercase font-bold">TP (%)</label><input id="tpInp" type="number" step="0.1" class="p-3 rounded w-full outline-none"></div>
                    <div><label class="text-[10px] text-gray-400 uppercase font-bold">DCA Bước (%)</label><input id="slInp" type="number" step="0.1" class="p-3 rounded w-full outline-none"></div>
                </div>
                <div>
                    <label class="text-[10px] text-gray-400 uppercase font-bold">Biến động mở lệnh (Min Vol %)</label>
                    <input id="volInp" type="range" min="1" max="10" step="0.5" class="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-yellow-500">
                    <div class="flex justify-between text-xs mt-1 text-yellow-500 font-bold"><span>1%</span> <span id="volVal">5%</span> <span>10%</span></div>
                </div>
                <div>
                    <label class="text-[10px] text-gray-400 uppercase font-bold">Chế độ chiến thuật</label>
                    <select id="modeInp" class="p-3 rounded w-full outline-none">
                        <option value="FOLLOW">THUẬN CHIỀU BIẾN ĐỘNG</option>
                        <option value="REVERSE">NGƯỢC CHIỀU BIẾN ĐỘNG</option>
                        <option value="ONLY_LONG">CHỈ LONG</option>
                        <option value="ONLY_SHORT">CHỈ SHORT</option>
                    </select>
                </div>
                <button onclick="saveConfig()" class="w-full bg-[#fcd535] text-black py-4 rounded-xl font-bold uppercase hover:bg-yellow-400">Lưu & Áp dụng</button>
            </div>
        </div>
    </div>

    <div id="historyModal" class="modal-full">
        <div class="max-w-5xl mx-auto">
            <div class="flex justify-between items-center mb-6">
                <div class="flex gap-4">
                    <button id="btnP" onclick="switchHistTab('pending')" class="tab-btn active">VỊ THẾ ĐANG MỞ</button>
                    <button id="btnH" onclick="switchHistTab('history')" class="tab-btn">LỊCH SỬ LỆNH</button>
                    <button id="btnS" onclick="switchHistTab('stats')" class="tab-btn">HIỆU SUẤT COIN</button>
                </div>
                <button onclick="closeTab('historyModal')" class="text-2xl font-bold">&times;</button>
            </div>

            <div id="pendingBox" class="bg-card p-4 rounded-xl overflow-x-auto">
                <table class="w-full text-[10px] text-left"><thead class="border-b border-zinc-800 text-gray-400 uppercase"><tr><th>Time</th><th>Pair</th><th>Side</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th>PnL (ROI)</th></tr></thead><tbody id="pendingBody"></tbody></table>
            </div>
            <div id="historyBox" class="bg-card p-4 rounded-xl overflow-x-auto hidden">
                <table class="w-full text-[9px] text-left"><thead class="border-b border-zinc-800 text-gray-400 uppercase"><tr><th>Time In/Out</th><th>Pair</th><th>DCA</th><th>PnL Net</th><th>Balance</th></tr></thead><tbody id="historyBody"></tbody></table>
            </div>
            <div id="statsBox" class="bg-card p-4 rounded-xl overflow-x-auto hidden">
                 <table class="w-full text-[10px] text-left"><thead class="border-b border-zinc-800 text-gray-400 uppercase"><tr><th>Coin</th><th>Lệnh</th><th>DCA</th><th>Tổng PnL</th></tr></thead><tbody id="statsBody"></tbody></table>
            </div>
        </div>
    </div>

    <script>
    let running = true, initialBal = 1000, lastRawData = null, myChart = null;
    const saved = JSON.parse(localStorage.getItem('luffy_v2_state') || '{}');
    
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;
    document.getElementById('modeInp').value = saved.mode || "FOLLOW";
    document.getElementById('volVal').innerText = (saved.vol || 5.0) + "%";

    document.getElementById('volInp').oninput = function() { document.getElementById('volVal').innerText = this.value + "%"; };

    function openTab(id) { document.getElementById(id).style.display = 'block'; }
    function closeTab(id) { document.getElementById(id).style.display = 'none'; }

    function switchHistTab(tab) {
        ['pendingBox', 'historyBox', 'statsBox'].forEach(id => document.getElementById(id).classList.add('hidden'));
        ['btnP', 'btnH', 'btnS'].forEach(id => document.getElementById(id).classList.remove('active'));
        document.getElementById(tab + 'Box').classList.remove('hidden');
        document.getElementById('btn' + tab.charAt(0).toUpperCase()).classList.add('active');
    }

    function saveConfig() {
        initialBal = parseFloat(document.getElementById('balanceInp').value);
        let vol = document.getElementById('volInp').value;
        let tp = document.getElementById('tpInp').value;
        let sl = document.getElementById('slInp').value;
        let mode = document.getElementById('modeInp').value;
        let margin = document.getElementById('marginInp').value;

        localStorage.setItem('luffy_v2_state', JSON.stringify({ initialBal, marginVal: margin, tp, sl, vol, mode }));
        fetch(\`/api/config?tp=\${tp}&sl=\${sl}&vol=\${vol}&mode=\${mode}\`);
        closeTab('configModal');
    }

    function fPrice(p) {
        if (!p || p === 0) return "0.0000";
        let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/);
        if (!match) return p.toFixed(4);
        let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
    }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [{ 
                label: 'Equity', data: [], borderColor: '#fcd535', backgroundColor: 'rgba(252, 213, 53, 0.1)', 
                fill: true, tension: 0.4, pointRadius: 2, pointHoverRadius: 5
            }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { 
                    callbacks: { label: (ctx) => 'Equity: ' + ctx.raw.toFixed(2) + ' USDT' }
                } },
                scales: { 
                    x: { ticks: { color: '#848e9c', font: { size: 9 } }, grid: { display: false } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#848e9c' } }
                }
            }
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastRawData = d;
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let runningBal = initialBal, winSum = 0, winCount = 0, coinStats = {};
            let chartLabels = [], chartData = [];

            // Market
            document.getElementById('marketBody').innerHTML = (d.live || []).slice(0, 10).map(m => \`
                <tr class="border-b border-zinc-800/30 font-bold"><td class="py-2 text-white">\${m.symbol}</td><td class="text-yellow-500">\${fPrice(m.currentPrice)}</td><td class="\${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('');

            // History & Chart
            let histItems = [...d.history].reverse();
            histItems.forEach((h, i) => {
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let totalMargin = marginBase * (h.dcaCount + 1);
                let netPnl = (totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001);
                runningBal += netPnl;
                if(netPnl >= 0) { winSum += netPnl; winCount++; }
                
                // Gom nhóm biểu đồ 1h hoặc theo mỗi lệnh
                chartLabels.push(new Date(h.endTime).getHours() + 'h');
                chartData.push(runningBal);

                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count: 0, dcas: 0, pnl: 0 };
                coinStats[h.symbol].count++; coinStats[h.symbol].dcas += h.dcaCount; coinStats[h.symbol].pnl += netPnl;
            });

            // Pending
            let unPnl = 0;
            document.getElementById('pendingBody').innerHTML = (d.pending || []).map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let totalMargin = marginBase * (h.dcaCount + 1);
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = totalMargin * roi / 100; unPnl += pnl;
                return \`<tr class="border-b border-zinc-800"><td class="py-3 text-zinc-500">\${new Date(h.startTime).toLocaleTimeString()}</td><td class="font-bold text-white">\${h.symbol}</td><td class="\${h.type==='LONG'?'up':'down'} font-bold">\${h.type}</td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${totalMargin.toFixed(1)}</td><td>\${fPrice(h.avgPrice)}<br>\${fPrice(lp)}</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
            }).join('');

            // Thống kê & UI
            document.getElementById('sumWinCount').innerText = winCount;
            document.getElementById('sumPendingCount').innerText = d.pending.length;
            document.getElementById('sumWinPnl').innerText = winSum.toFixed(2);
            document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
            document.getElementById('unPnl').innerText = unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-2xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');

            document.getElementById('historyBody').innerHTML = d.history.slice(0, 50).map(h => \`
                <tr class="border-b border-zinc-800 text-zinc-400"><td>\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td class="text-white">\${h.symbol}</td><td class="text-yellow-500">\${h.dcaCount}</td><td class="up">\${(h.pnlPercent).toFixed(2)}%</td><td>\${runningBal.toFixed(1)}</td></tr>\`).join('');

            document.getElementById('statsBody').innerHTML = Object.entries(coinStats).map(([sym, s]) => \`
                <tr class="border-b border-zinc-800 text-white"><td>\${sym}</td><td>\${s.count}</td><td class="text-yellow-500">\${s.dcas}</td><td class="\${s.pnl>=0?'up':'down'}">\${s.pnl.toFixed(2)}</td></tr>\`).join('');

            if(myChart && chartData.length > 0) {
                myChart.data.labels = chartLabels;
                myChart.data.datasets[0].data = chartData;
                myChart.update('none');
            }
        } catch(e) {}
    }

    initChart();
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
