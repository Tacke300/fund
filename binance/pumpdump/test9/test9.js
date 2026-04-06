const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIGS_FILE = './configs_saved.json';
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
let userConfigs = [];

// Khởi tạo file cấu hình nếu chưa có
if (fs.existsSync(CONFIGS_FILE)) {
    try { userConfigs = JSON.parse(fs.readFileSync(CONFIGS_FILE)); } catch(e) { userConfigs = []; }
}

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
            
            const pendingTrades = Array.from(historyMap.values()).filter(h => h.symbol === s && h.status === 'PENDING');
            
            pendingTrades.forEach(pending => {
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
                    lastTradeClosed[`${s}_${pending.configId}`] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }

                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
                
                if (triggerDCA && !actionQueue.find(q => q.id === `${s}_${pending.startTime}`)) {
                    actionQueue.push({ id: `${s}_${pending.startTime}`, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        setTimeout(() => {
                            pending.avgPrice = newAvg;
                            pending.dcaCount = newCount;
                        }, 200); 
                    }});
                }
            });

            // Logic Mở lệnh theo đa cấu hình
            userConfigs.filter(cfg => cfg.active).forEach(cfg => {
                const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                const cooldownKey = `${s}_${cfg.id}`;
                const isPending = pendingTrades.some(h => h.configId === cfg.id);

                if (maxVol >= cfg.minVol && !isPending && !(lastTradeClosed[cooldownKey] && (now - lastTradeClosed[cooldownKey] < COOLDOWN_MINUTES * 60000))) {
                    if (!actionQueue.find(q => q.id === cooldownKey)) {
                        actionQueue.push({ id: cooldownKey, priority: 2, action: () => {
                            let type = 'LONG';
                            if (cfg.mode === 'REVERSE') type = c1 >= 0 ? 'SHORT' : 'LONG';
                            else if (cfg.mode === 'FOLLOW') type = c1 >= 0 ? 'LONG' : 'SHORT';
                            else if (cfg.mode === 'ONLY_LONG') type = 'LONG';
                            else if (cfg.mode === 'ONLY_SHORT') type = 'SHORT';

                            historyMap.set(`${s}_${now}`, { 
                                symbol: s, configId: cfg.id, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                                maxLev: symbolMaxLeverage[s] || 20, tpTarget: cfg.tp, slTarget: cfg.sl, snapVol: { c1, c5, c15 },
                                maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                            });
                        }});
                    }
                }
            });
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/save-configs', (req, res) => {
    try {
        userConfigs = JSON.parse(req.query.data);
        fs.writeFileSync(CONFIGS_FILE, JSON.stringify(userConfigs));
        res.sendStatus(200);
    } catch(e) { res.status(500).send(e.message); }
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING'),
        configs: userConfigs
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Multi-Config</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; overflow-x: hidden; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); align-items:center; justify-content:center; }
        .config-card { transition: all 0.2s; cursor: pointer; border-left: 4px solid transparent; }
        .config-card:hover { background: #2b3139; }
        .config-active { border-left-color: #fcd535; background: #2b3139; }
    </style></head><body>

    <div id="configModal" class="modal">
        <div class="bg-card p-6 rounded-lg w-full h-full md:w-11/12 md:h-5/6 overflow-y-auto relative">
            <button onclick="closeModal('configModal')" class="absolute top-4 right-6 text-3xl text-gray-400">&times;</button>
            <h2 id="modalTitle" class="text-yellow-500 font-bold text-xl mb-6 uppercase tracking-widest"></h2>
            
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div class="bg-[#0b0e11] p-4 rounded-lg">
                    <h3 class="text-xs font-bold text-gray-500 mb-4 uppercase">Vị thế đang mở</h3>
                    <div id="modalPending" class="overflow-x-auto text-[10px]"></div>
                </div>
                <div class="bg-[#0b0e11] p-4 rounded-lg">
                    <h3 class="text-xs font-bold text-gray-500 mb-4 uppercase">Hiệu suất Coin</h3>
                    <div id="modalStats" class="overflow-x-auto text-[10px]"></div>
                </div>
                <div class="col-span-1 lg:col-span-2 bg-[#0b0e11] p-4 rounded-lg">
                    <h3 class="text-xs font-bold text-gray-500 mb-4 uppercase">Lịch sử lệnh gần đây</h3>
                    <div id="modalHistory" class="overflow-x-auto text-[10px]"></div>
                </div>
            </div>
        </div>
    </div>

    <div class="flex flex-col md:flex-row h-screen">
        <div class="w-full md:w-80 bg-[#161a1e] p-4 border-r border-zinc-800 overflow-y-auto">
            <div class="font-black italic text-white text-xl mb-6 tracking-tighter">LUFFY <span class="text-[#fcd535]">MULTI-SYSTEM</span></div>
            
            <div class="space-y-3 mb-6">
                <div class="bg-card p-3 rounded">
                    <label class="text-[10px] text-gray-500 uppercase font-bold">Vốn Khởi Tạo ($)</label>
                    <input id="baseBalance" type="number" class="w-full bg-transparent text-yellow-500 font-bold outline-none text-lg" value="1000">
                </div>
                <div class="bg-card p-3 rounded">
                    <label class="text-[10px] text-gray-500 uppercase font-bold">Margin Mỗi Lệnh</label>
                    <input id="baseMargin" type="text" class="w-full bg-transparent text-white font-bold outline-none" value="10%">
                </div>
            </div>

            <button onclick="addNewConfig()" class="w-full border border-dashed border-zinc-600 py-2 rounded text-xs text-gray-400 hover:text-white mb-4">+ Thêm Cấu Hình Mới</button>
            <div id="configList" class="space-y-2"></div>
        </div>

        <div class="flex-1 p-6 overflow-y-auto">
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <div class="bg-card p-4 rounded-xl">
                    <div class="text-gray-500 text-[10px] uppercase font-bold mb-1">Equity Hiện Tại</div>
                    <div id="totalEquity" class="text-3xl font-bold text-white">0.00</div>
                    <div id="totalUnPnl" class="text-sm font-bold mt-1">0.00</div>
                </div>
                <div class="bg-card p-4 rounded-xl">
                    <div class="text-gray-500 text-[10px] uppercase font-bold mb-1">Số dư Khả dụng (Available)</div>
                    <div id="availBal" class="text-2xl font-bold text-yellow-500">0.00</div>
                </div>
                <div class="bg-card p-4 rounded-xl">
                    <div class="text-gray-500 text-[10px] uppercase font-bold mb-1">Tổng Lệnh Win</div>
                    <div id="totalWin" class="text-2xl font-bold text-green-500">0</div>
                </div>
                <div class="bg-card p-4 rounded-xl">
                    <div class="text-gray-500 text-[10px] uppercase font-bold mb-1">Lệnh Đang Chạy</div>
                    <div id="totalRunning" class="text-2xl font-bold text-blue-400">0</div>
                </div>
            </div>

            <div class="bg-card p-6 rounded-xl mb-8">
                <h3 class="text-xs font-bold text-gray-500 mb-6 uppercase tracking-widest">Biểu đồ hiệu suất hệ thống (1H/Bar)</h3>
                <div class="h-[300px]"><canvas id="mainChart"></canvas></div>
            </div>

            <div class="bg-card p-4 rounded-xl overflow-hidden">
                 <h3 class="text-xs font-bold text-gray-500 mb-4 uppercase tracking-widest">Top Biến Động Market</h3>
                 <div id="marketTable" class="overflow-x-auto"></div>
            </div>
        </div>
    </div>

    <script>
    let configs = JSON.parse(localStorage.getItem('luffy_configs') || '[]');
    let lastData = null;
    let mainChart = null;
    let hourlyStats = {}; // Lưu trữ để vẽ biểu đồ cột

    function addNewConfig() {
        const id = Date.now();
        configs.push({ id, minVol: 5.0, tp: 0.5, sl: 10.0, mode: 'FOLLOW', active: true });
        saveConfigs();
        renderConfigs();
    }

    function saveConfigs() {
        localStorage.setItem('luffy_configs', JSON.stringify(configs));
        fetch('/api/save-configs?data=' + encodeURIComponent(JSON.stringify(configs)));
    }

    function removeConfig(id) {
        configs = configs.filter(c => c.id !== id);
        saveConfigs();
        renderConfigs();
    }

    function updateCfgValue(id, key, val) {
        const cfg = configs.find(c => c.id === id);
        if(cfg) { cfg[key] = (key === 'mode' ? val : parseFloat(val)); saveConfigs(); }
    }

    function renderConfigs() {
        const container = document.getElementById('configList');
        container.innerHTML = configs.map(cfg => \`
            <div class="config-card bg-card p-3 rounded-lg relative group">
                <div onclick="openConfigDetail(\${cfg.id})" class="mb-3">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-[10px] font-bold text-yellow-500">CFG-\${cfg.id.toString().slice(-4)}</span>
                        <input type="checkbox" \${cfg.active?'checked':''} onchange="updateCfgValue(\${cfg.id}, 'active', this.checked)" onclick="event.stopPropagation()">
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-[10px]">
                        <div>Vol: <b>\${cfg.minVol}%</b></div>
                        <div>TP: <b>\${cfg.tp}%</b></div>
                        <div class="col-span-2">Mode: <b class="text-blue-400">\${cfg.mode}</b></div>
                    </div>
                </div>
                <div class="flex gap-1">
                    <select onchange="updateCfgValue(\${cfg.id}, 'mode', this.value)" class="bg-[#0b0e11] text-[9px] p-1 rounded border border-zinc-700 w-full">
                        <option value="FOLLOW" \${cfg.mode==='FOLLOW'?'selected':''}>FOLLOW</option>
                        <option value="REVERSE" \${cfg.mode==='REVERSE'?'selected':''}>REVERSE</option>
                        <option value="ONLY_LONG" \${cfg.mode==='ONLY_LONG'?'selected':''}>ONLY LONG</option>
                        <option value="ONLY_SHORT" \${cfg.mode==='ONLY_SHORT'?'selected':''}>ONLY SHORT</option>
                    </select>
                    <button onclick="removeConfig(\${cfg.id})" class="text-red-500 hover:bg-red-500/10 px-2 rounded">&times;</button>
                </div>
            </div>
        \`).join('');
    }

    function openConfigDetail(id) {
        const cfg = configs.find(c => c.id === id);
        if(!cfg || !lastData) return;
        document.getElementById('modalTitle').innerText = \`Cấu hình Vol \${cfg.minVol}% - Mode \${cfg.mode}\`;
        
        const pending = lastData.pending.filter(h => h.configId === id);
        const history = lastData.history.filter(h => h.configId === id).reverse();
        
        // Render Pending
        document.getElementById('modalPending').innerHTML = \`<table class="w-full text-left">
            <thead class="text-gray-500 border-b border-zinc-800"><tr><th>Symbol</th><th>DCA</th><th>Price</th><th>ROI</th></tr></thead>
            <tbody>\${pending.map(p => \`<tr><td class="py-2 text-white">\${p.symbol}</td><td class="text-yellow-500">\${p.dcaCount}</td><td>\${p.avgPrice}</td><td class="up">Live</td></tr>\`).join('')}</tbody>
        </table>\`;

        // Render History
        document.getElementById('modalHistory').innerHTML = \`<table class="w-full text-left">
            <thead class="text-gray-500 border-b border-zinc-800"><tr><th>Time</th><th>Symbol</th><th>PnL</th><th>Status</th></tr></thead>
            <tbody>\${history.slice(0,10).map(h => \`<tr><td class="py-2 text-zinc-500">\${new Date(h.endTime).toLocaleTimeString()}</td><td class="text-white">\${h.symbol}</td><td class="\${h.pnlPercent>=0?'up':'down'}">\${h.pnlPercent.toFixed(2)}%</td><td>\${h.status}</td></tr>\`).join('')}</tbody>
        </table>\`;

        document.getElementById('configModal').style.display = 'flex';
    }

    function closeModal(id) { document.getElementById(id).style.display = 'none'; }

    async function update() {
        try {
            const res = await fetch('/api/data');
            const d = await res.json();
            lastData = d;

            let initialBal = parseFloat(document.getElementById('baseBalance').value);
            let mVal = document.getElementById('baseMargin').value;
            let mNum = parseFloat(mVal);

            let runningBal = initialBal;
            let totalUnPnl = 0;
            let totalMarginUsed = 0;
            let winCount = 0;

            // Tính toán lịch sử lệnh
            d.history.forEach(h => {
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let totalMargin = marginBase * (h.dcaCount + 1);
                let netPnl = (totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001);
                runningBal += netPnl;
                if(netPnl > 0) winCount++;
                
                // Gom dữ liệu biểu đồ theo giờ
                let hourKey = new Date(h.endTime).getHours() + ':00';
                if(!hourlyStats[hourKey]) hourlyStats[hourKey] = { profit: 0, count: 0 };
                hourlyStats[hourKey].profit += netPnl;
                hourlyStats[hourKey].count++;
            });

            // Tính toán lệnh đang mở
            d.pending.forEach(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let totalMargin = marginBase * (h.dcaCount + 1);
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                totalUnPnl += (totalMargin * roi / 100);
                totalMarginUsed += totalMargin;
            });

            // Cập nhật UI Dashboard
            const currentEquity = runningBal + totalUnPnl;
            const availableBalance = currentEquity - totalMarginUsed;

            document.getElementById('totalEquity').innerText = currentEquity.toFixed(2);
            document.getElementById('totalUnPnl').innerText = (totalUnPnl >= 0 ? '+' : '') + totalUnPnl.toFixed(2);
            document.getElementById('totalUnPnl').className = 'text-sm font-bold mt-1 ' + (totalUnPnl >= 0 ? 'up' : 'down');
            document.getElementById('availBal').innerText = availableBalance.toFixed(2);
            document.getElementById('totalWin').innerText = winCount;
            document.getElementById('totalRunning').innerText = d.pending.length;

            // Cập nhật Biểu đồ cột
            updateChart();

            // Market Table
            document.getElementById('marketTable').innerHTML = \`<table class="w-full text-[10px] text-left">
                <thead class="text-gray-500 uppercase border-b border-zinc-800"><tr><th class="py-2">Coin</th><th>Price</th><th>1M</th><th>5M</th><th>15M</th></tr></thead>
                <tbody>\${d.live.slice(0,8).map(m => \`<tr><td class="py-2 font-bold">\${m.symbol}</td><td class="text-yellow-500">\${m.currentPrice}</td><td class="\${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('')}</tbody>
            </table>\`;

        } catch(e) { console.error(e); }
    }

    function initChart() {
        const ctx = document.getElementById('mainChart').getContext('2d');
        mainChart = new Chart(ctx, {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'PnL Theo Giờ ($)', data: [], backgroundColor: '#fcd535' }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    x: { ticks: { color: '#848e9c', font: { size: 9 } }, grid: { display: false } },
                    y: { ticks: { color: '#848e9c', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
                },
                plugins: { 
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => 'Lãi: ' + ctx.raw.toFixed(2) + ' USD'
                        }
                    }
                }
            }
        });
    }

    function updateChart() {
        if(!mainChart) return;
        const labels = Object.keys(hourlyStats).slice(-12);
        const data = labels.map(l => hourlyStats[l].profit);
        mainChart.data.labels = labels;
        mainChart.data.datasets[0].data = data;
        mainChart.update('none');
    }

    renderConfigs();
    initChart();
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Hệ thống Multi-Config chạy tại: http://localhost:${PORT}/gui`); });
