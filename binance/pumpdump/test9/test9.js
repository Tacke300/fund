const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const STATS_SNAPSHOT_FILE = './stats_snapshots.json'; // Lưu dữ liệu biểu đồ 1h
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
let statsSnapshots = []; // [{t, balance, wins, pnl, pendingCount}]

// Cấu hình mặc định (Hỗ trợ nhiều cấu hình)
let configs = [{ id: Date.now(), tp: 0.5, sl: 10.0, vol: 5.0, mode: 'FOLLOW', active: true }];

if (fs.existsSync(STATS_SNAPSHOT_FILE)) { try { statsSnapshots = JSON.parse(fs.readFileSync(STATS_SNAPSHOT_FILE)); } catch(e){} }

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// Logic lưu snapshot mỗi 1 giờ cho biểu đồ
setInterval(() => {
    const now = Date.now();
    // Logic tính toán nhanh stats để lưu
    const all = Array.from(historyMap.values());
    const winPnl = all.filter(h => h.status === 'WIN').reduce((a, b) => a + (b.pnlPercent || 0), 0);
    statsSnapshots.push({
        t: now,
        wins: all.filter(h => h.status === 'WIN').length,
        pending: all.filter(h => h.status === 'PENDING').length,
        pnl: winPnl
    });
    if (statsSnapshots.length > 168) statsSnapshots.shift(); // Giữ 1 tuần
    fs.writeFileSync(STATS_SNAPSHOT_FILE, JSON.stringify(statsSnapshots));
}, 3600000);

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
                // ... (Giữ nguyên logic xử lý PENDING và DCA gốc)
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) { pending.maxNegativeRoi = currentRoi; }
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
                        setTimeout(() => { pending.avgPrice = newAvg; pending.dcaCount = newCount; }, 200); 
                    }});
                }
            } else {
                // Duyệt qua tất cả cấu hình để tìm điểm vào lệnh
                for (let cfg of configs) {
                    if (!cfg.active) continue;
                    const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                    if (maxVol >= cfg.vol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                        if (!actionQueue.find(q => q.id === s)) {
                            actionQueue.push({ id: s, priority: 2, action: () => {
                                let type = 'LONG';
                                const mainTrend = c1 >= 0 ? 'LONG' : 'SHORT';
                                if (cfg.mode === 'LONG') type = 'LONG';
                                else if (cfg.mode === 'SHORT') type = 'SHORT';
                                else if (cfg.mode === 'FOLLOW') type = mainTrend;
                                else if (cfg.mode === 'REVERSE') type = mainTrend === 'LONG' ? 'SHORT' : 'LONG';

                                historyMap.set(`${s}_${now}`, { 
                                    symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                                    configId: cfg.id, // Lưu id cấu hình để lọc
                                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: cfg.tp, slTarget: cfg.sl, snapVol: { c1, c5, c15 },
                                    maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                                });
                            }});
                            break; // Ưu tiên cấu hình đầu tiên khớp
                        }
                    }
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    configs = JSON.parse(req.query.data);
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING'),
        configs: configs,
        snapshots: statsSnapshots
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Multi-Config</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); align-items:center; justify-content:center; }
        .config-card { border-left: 4px solid #fcd535; transition: all 0.2s; }
        .config-card:hover { transform: translateY(-2px); background: #2b3139; }
    </style></head><body>

    <div id="configModal" class="modal">
        <div class="bg-card p-6 rounded-lg w-full h-full md:h-5/6 md:w-11/12 overflow-y-auto relative">
            <button onclick="closeModal('configModal')" class="absolute top-4 right-6 text-3xl">&times;</button>
            <h2 id="modalTitle" class="text-xl font-bold text-[#fcd535] mb-6">CHI TIẾT CẤU HÌNH</h2>
            <div id="modalContent">
                </div>
        </div>
    </div>

    <div class="p-4 border-b border-zinc-800 flex justify-between items-center sticky top-0 bg-[#0b0e11] z-50">
        <h1 class="font-bold text-xl italic text-[#fcd535]">LUFFY MULTI-BOT</h1>
        <div class="flex gap-2">
             <button onclick="addConfig()" class="bg-zinc-800 px-3 py-1 rounded text-xs font-bold">+ THÊM CẤU HÌNH</button>
             <button onclick="saveAllConfigs()" class="bg-[#fcd535] text-black px-3 py-1 rounded text-xs font-bold">LƯU & CHẠY</button>
        </div>
    </div>

    <div class="p-4 grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="md:col-span-3">
             <div class="bg-card rounded-xl p-4 mb-4">
                <div class="flex justify-between items-end mb-4">
                    <div>
                        <p class="text-gray-400 text-[10px] uppercase font-bold">Tổng Equity Hệ Thống</p>
                        <h2 id="totalEquity" class="text-4xl font-bold">0.00 <span class="text-sm font-normal text-gray-500">USDT</span></h2>
                    </div>
                    <div class="text-right">
                        <p class="text-gray-400 text-[10px] uppercase font-bold">PnL Tạm Tính</p>
                        <h2 id="totalUnPnl" class="text-xl font-bold">0.00</h2>
                    </div>
                </div>
                <div style="height: 250px;"><canvas id="mainChart"></canvas></div>
             </div>

             <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <div class="bg-card p-3 rounded-lg text-center">
                    <p class="text-[9px] text-gray-500 font-bold uppercase">Tổng Lệnh Win</p>
                    <p id="totalWin" class="text-xl font-bold text-green-500">0</p>
                </div>
                <div class="bg-card p-3 rounded-lg text-center">
                    <p class="text-[9px] text-gray-500 font-bold uppercase">Lợi nhuận gộp</p>
                    <p id="totalProfit" class="text-xl font-bold text-white">0.00</p>
                </div>
                <div class="bg-card p-3 rounded-lg text-center">
                    <p class="text-[9px] text-gray-500 font-bold uppercase">Vị thế mở</p>
                    <p id="totalOpening" class="text-xl font-bold text-yellow-500">0</p>
                </div>
                <div class="bg-card p-3 rounded-lg text-center">
                    <p class="text-[9px] text-gray-500 font-bold uppercase">Vốn khởi tạo</p>
                    <input id="baseBal" type="number" class="bg-transparent text-center w-full font-bold text-xl outline-none" value="1000">
                </div>
             </div>
        </div>

        <div class="space-y-3">
            <h3 class="text-xs font-bold text-gray-500 uppercase">Cấu hình hoạt động</h3>
            <div id="configList" class="space-y-2"></div>
        </div>
    </div>

    <script>
        let myConfigs = JSON.parse(localStorage.getItem('luffy_configs') || '[{"id":1,"tp":0.5,"sl":10,"vol":5,"mode":"FOLLOW","active":true}]');
        let chart = null;

        function addConfig() {
            myConfigs.push({ id: Date.now(), tp: 0.5, sl: 10, vol: 5, mode: "FOLLOW", active: true });
            renderConfigs();
        }

        function removeConfig(id) {
            myConfigs = myConfigs.filter(c => c.id !== id);
            renderConfigs();
        }

        function saveAllConfigs() {
            localStorage.setItem('luffy_configs', JSON.stringify(myConfigs));
            fetch('/api/config?data=' + encodeURIComponent(JSON.stringify(myConfigs)));
            alert("Đã áp dụng cấu hình!");
        }

        function renderConfigs() {
            const container = document.getElementById('configList');
            container.innerHTML = myConfigs.map((c, i) => \`
                <div class="bg-card p-4 rounded-lg config-card relative cursor-pointer" onclick="openConfigDetail(\${c.id})">
                    <div class="flex justify-between items-start mb-2">
                        <span class="text-[10px] font-bold bg-yellow-500 text-black px-1 rounded">CFG #\${i+1}</span>
                        <button onclick="event.stopPropagation(); removeConfig(\${c.id})" class="text-gray-500 hover:text-red-500">&times;</button>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-[11px]">
                        <div>VOL: <input type="number" step="0.1" class="bg-transparent w-12 font-bold" value="\${c.vol}" onchange="updateCfg(\${c.id}, 'vol', this.value)"></div>
                        <div>MODE: <select class="bg-transparent font-bold" onchange="updateCfg(\${c.id}, 'mode', this.value)">
                            <option value="FOLLOW" \${c.mode=='FOLLOW'?'selected':''}>THUẬN</option>
                            <option value="REVERSE" \${c.mode=='REVERSE'?'selected':''}>NGƯỢC</option>
                            <option value="LONG" \${c.mode=='LONG'?'selected':''}>LONG</option>
                            <option value="SHORT" \${c.mode=='SHORT'?'selected':''}>SHORT</option>
                        </select></div>
                    </div>
                    <p class="text-[9px] text-gray-500 mt-2 italic">Bấm để xem lịch sử & vị thế</p>
                </div>
            \`).join('');
        }

        function updateCfg(id, key, val) {
            const c = myConfigs.find(x => x.id === id);
            if(c) c[key] = isNaN(val) ? val : parseFloat(val);
        }

        function openConfigDetail(id) {
            const cfg = myConfigs.find(x => x.id === id);
            document.getElementById('modalTitle').innerText = "CHI TIẾT CẤU HÌNH: BIẾN ĐỘNG > " + cfg.vol + "%";
            document.getElementById('configModal').style.display = 'flex';
            window.currentViewingConfigId = id;
            update(true); 
        }

        function closeModal(id) { document.getElementById(id).style.display = 'none'; }

        async function update(isPopup = false) {
            const res = await fetch('/api/data');
            const data = await res.json();
            
            // Tính toán tổng hệ thống
            const base = parseFloat(document.getElementById('baseBal').value);
            let totalWinPnl = 0, winCount = 0, openCount = data.pending.length;
            
            data.history.forEach(h => {
                if(h.status === 'WIN') {
                    winCount++;
                    // Giả định margin 10$ cho demo tính toán
                    totalWinPnl += (10 * (h.pnlPercent || 0) / 100);
                }
            });

            document.getElementById('totalWin').innerText = winCount;
            document.getElementById('totalProfit').innerText = totalWinPnl.toFixed(2);
            document.getElementById('totalOpening').innerText = openCount;
            document.getElementById('totalEquity').innerText = (base + totalWinPnl).toFixed(2);

            // Cập nhật Biểu đồ 1h
            if(chart && data.snapshots) {
                chart.data.labels = data.snapshots.map(s => new Date(s.t).getHours() + 'h');
                chart.data.datasets[0].data = data.snapshots.map(s => base + s.pnl);
                chart.update('none');
            }

            // Nếu đang mở popup, render nội dung theo configId
            if(document.getElementById('configModal').style.display === 'flex') {
                const cid = window.currentViewingConfigId;
                const p = data.pending.filter(x => x.configId === cid);
                const h = data.history.filter(x => x.configId === cid).slice(0, 20);

                document.getElementById('modalContent').innerHTML = \`
                    <h3 class="text-green-500 font-bold mb-2 text-sm uppercase italic">Vị thế đang mở (\${p.length})</h3>
                    <table class="w-full text-[10px] mb-8">
                        <tr class="text-gray-500 border-b border-zinc-800"><th>Cặp</th><th>Type</th><th>DCA</th><th>PnL</th></tr>
                        \${p.map(x => \`<tr class="border-b border-zinc-800/50"><td class="py-2">\${x.symbol}</td><td class="\${x.type=='LONG'?'up':'down'}">\${x.type}</td><td>\${x.dcaCount}</td><td class="up">Đang chạy...</td></tr>\`).join('')}
                    </table>

                    <h3 class="text-gray-500 font-bold mb-2 text-sm uppercase italic">Lịch sử gần đây</h3>
                    <table class="w-full text-[10px]">
                        <tr class="text-gray-500 border-b border-zinc-800"><th>Thời gian</th><th>Cặp</th><th>Kết quả</th><th>PnL%</th></tr>
                        \${h.map(x => \`<tr class="border-b border-zinc-800/50"><td class="py-2">\${new Date(x.endTime).toLocaleString()}</td><td>\${x.symbol}</td><td class="\${x.status=='WIN'?'up':'down'}">\${x.status}</td><td>\${x.pnlPercent?.toFixed(2)}%</td></tr>\`).join('')}
                    </table>
                \`;
            }
        }

        const ctx = document.getElementById('mainChart').getContext('2d');
        chart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'Equity (1h)', data: [], borderColor: '#fcd535', tension: 0.3, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }] },
            options: { 
                maintainAspectRatio: false, 
                plugins: { 
                    tooltip: { 
                        callbacks: {
                            afterLabel: function(context) {
                                // Bạn có thể thêm nội dung chi tiết khi chạm mốc tại đây
                                return "Time: " + context.label;
                            }
                        }
                    }
                },
                scales: { x: { display: true }, y: { grid: { color: '#1e2329' } } } 
            }
        });

        renderConfigs();
        setInterval(update, 2000);
    </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
