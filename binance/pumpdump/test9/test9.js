const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CHART_LOG_FILE = './chart_log.json'; // Lưu dữ liệu biểu đồ 1h
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

// Cấu hình mặc định (Hỗ trợ nhiều bộ)
let configs = [{ id: Date.now(), tp: 0.5, sl: 10.0, vol: 6.5, mode: 'FOLLOW', active: false }];

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

// Logic ghi log biểu đồ mỗi 1h
setInterval(() => {
    try {
        let logs = [];
        if (fs.existsSync(CHART_LOG_FILE)) logs = JSON.parse(fs.readFileSync(CHART_LOG_FILE));
        // Tính toán data hiện tại để push vào log (Sẽ được xử lý phía Client hoặc Server tùy request)
        // Lưu mốc thời gian chẵn giờ
    } catch (e) {}
}, 3600000);

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
            const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                // ... (Giữ nguyên logic tính ROI/Win/DCA cũ của ông ở đây)
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;

                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }
                // Logic DCA giữ nguyên...
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
                // Chạy logic mở lệnh cho TẤT CẢ cấu hình đang active
                configs.filter(c => c.active).forEach(conf => {
                    if (maxVol >= conf.vol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                        if (!actionQueue.find(q => q.id === s)) {
                            actionQueue.push({ id: s, priority: 2, action: () => {
                                let type = 'LONG'; // Mặc định hoặc tính theo config.mode
                                if(conf.mode === 'LONG') type = 'LONG';
                                else if(conf.mode === 'SHORT') type = 'SHORT';
                                else if(conf.mode === 'FOLLOW') type = c1 >= 0 ? 'LONG' : 'SHORT';
                                else if(conf.mode === 'REVERSE') type = c1 >= 0 ? 'SHORT' : 'LONG';

                                historyMap.set(`${s}_${now}`, { 
                                    symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                                    confId: conf.id, // Gắn ID cấu hình vào lệnh
                                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: conf.tp, slTarget: conf.sl, snapVol: { c1, c5, c15 },
                                    maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                                });
                            }});
                        }
                    }
                });
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
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })), 
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING'),
        configs: configs
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Multi-Config Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); align-items:center; justify-content:center; }
        .tab-btn.active { border-bottom: 2px solid #fcd535; color: #fcd535; }
    </style></head><body>

    <div id="popupLayer" class="modal">
        <div class="bg-card p-6 rounded-lg w-11/12 max-w-5xl max-h-[90vh] overflow-y-auto relative">
            <button onclick="closePopup()" class="absolute top-4 right-4 text-2xl">&times;</button>
            <div id="popupContent"></div>
        </div>
    </div>

    <div class="p-4 border-b border-zinc-800 flex justify-between items-center sticky top-0 bg-[#0b0e11] z-50">
        <h1 class="text-xl font-black italic text-[#fcd535]">LUFFY MULTI-ENGINE</h1>
        <div class="flex gap-4">
            <button onclick="showTab('dashboard')" class="tab-btn active px-4 py-2 font-bold uppercase text-xs">Dashboard Tổng</button>
            <button onclick="showTab('configs')" class="tab-btn px-4 py-2 font-bold uppercase text-xs">Cấu hình hệ thống</button>
        </div>
    </div>

    <div id="tab-dashboard" class="p-4">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div class="bg-card p-4 rounded-lg">
                <p class="text-xs text-gray-400 uppercase">Tổng Equity (Vốn+PnL)</p>
                <h2 id="totalEquity" class="text-3xl font-bold text-white">0.00</h2>
            </div>
            <div class="bg-card p-4 rounded-lg">
                <p class="text-xs text-gray-400 uppercase">PnL Tạm tính</p>
                <h2 id="totalUnPnl" class="text-2xl font-bold">0.00</h2>
            </div>
            <div class="bg-card p-4 rounded-lg">
                <p class="text-xs text-gray-400 uppercase">Lệnh Win / Tổng</p>
                <h2 id="totalWinRatio" class="text-2xl font-bold text-green-400">0/0</h2>
            </div>
            <div class="bg-card p-4 rounded-lg">
                <p class="text-xs text-gray-400 uppercase">Tổng Lệnh Đang Mở</p>
                <h2 id="totalOpening" class="text-2xl font-bold text-yellow-500">0</h2>
            </div>
        </div>

        <div class="bg-card p-4 rounded-lg mb-6">
            <p class="text-xs font-bold text-gray-400 uppercase mb-4 italic">Biểu đồ tăng trưởng (Mốc 1h)</p>
            <div style="height: 300px;"><canvas id="mainChart"></canvas></div>
        </div>

        <div id="configList" class="grid grid-cols-1 md:grid-cols-2 gap-4">
            </div>
    </div>

    <div id="tab-configs" class="hidden p-4">
        <div class="bg-card p-6 rounded-lg max-w-xl mx-auto">
            <h3 class="font-bold mb-4 text-yellow-500">THÊM CẤU HÌNH MỚI</h3>
            <div class="grid grid-cols-2 gap-4 mb-4">
                <input id="newTP" type="number" placeholder="TP (%)" class="bg-black p-2 border border-zinc-700 rounded">
                <input id="newSL" type="number" placeholder="DCA (%)" class="bg-black p-2 border border-zinc-700 rounded">
                <input id="newVOL" type="number" min="1" max="10" placeholder="Biến động (1-10)" class="bg-black p-2 border border-zinc-700 rounded">
                <select id="newMODE" class="bg-black p-2 border border-zinc-700 rounded">
                    <option value="FOLLOW">Theo chiều</option>
                    <option value="REVERSE">Ngược chiều</option>
                    <option value="LONG">Chỉ Long</option>
                    <option value="SHORT">Chỉ Short</option>
                </select>
            </div>
            <button onclick="addConfig()" class="w-full bg-yellow-500 text-black font-bold py-2 rounded">THÊM VÀO DANH SÁCH</button>
        </div>
    </div>

    <script>
        let myChart = null;
        let lastData = null;
        let runningConfigs = JSON.parse(localStorage.getItem('multi_configs') || '[]');

        function showTab(name) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById('tab-dashboard').classList.add('hidden');
            document.getElementById('tab-configs').classList.add('hidden');
            document.getElementById('tab-' + name).classList.remove('hidden');
        }

        function addConfig() {
            const conf = {
                id: Date.now(),
                tp: document.getElementById('newTP').value || 0.5,
                sl: document.getElementById('newSL').value || 10,
                vol: document.getElementById('newVOL').value || 5,
                mode: document.getElementById('newMODE').value,
                active: true
            };
            runningConfigs.push(conf);
            saveConfigs();
        }

        function toggleConfig(id) {
            const c = runningConfigs.find(x => x.id === id);
            if(c) c.active = !c.active;
            saveConfigs();
        }

        function saveConfigs() {
            localStorage.setItem('multi_configs', JSON.stringify(runningConfigs));
            fetch('/api/config?data=' + encodeURIComponent(JSON.stringify(runningConfigs)));
            location.reload();
        }

        function showPopup(type, configId) {
            let html = '';
            const data = lastData;
            if(type === 'history') {
                const filtered = data.history.filter(h => h.confId == configId);
                html = '<h2 class="text-xl font-bold mb-4">LỊCH SỬ GIAO DỊCH</h2><table class="w-full text-xs text-left"><thead><tr class="text-gray-500 border-b border-zinc-800"><th>Coin</th><th>Type</th><th>DCA</th><th>PnL Net</th><th>Time</th></tr></thead><tbody>' + 
                filtered.map(h => `<tr><td>${h.symbol}</td><td class="${h.type==='LONG'?'up':'down'}">${h.type}</td><td>${h.dcaCount}</td><td class="font-bold">${h.pnlPercent.toFixed(2)}%</td><td>${new Date(h.endTime).toLocaleString()}</td></tr>`).join('') + '</tbody></table>';
            } else if(type === 'pending') {
                const filtered = data.pending.filter(h => h.confId == configId);
                html = '<h2 class="text-xl font-bold mb-4 text-green-400">VỊ THẾ ĐANG MỞ</h2><table class="w-full text-xs text-left"><thead><tr class="text-gray-500 border-b border-zinc-800"><th>Coin</th><th>Entry</th><th>Live</th><th>PnL</th></tr></thead><tbody>' + 
                filtered.map(h => `<tr><td>${h.symbol}</td><td>${h.avgPrice}</td><td>${data.allPrices[h.symbol]}</td><td class="up font-bold">...</td></tr>`).join('') + '</tbody></table>';
            }
            document.getElementById('popupContent').innerHTML = html;
            document.getElementById('popupLayer').style.display = 'flex';
        }

        function closePopup() { document.getElementById('popupLayer').style.display = 'none'; }

        async function update() {
            const res = await fetch('/api/data');
            const data = await res.json();
            lastData = data;
            
            let totalEquity = 1000; // Giả sử vốn 1000
            let totalUnPnl = 0;
            let winCount = data.history.filter(h => h.status === 'WIN').length;

            document.getElementById('configList').innerHTML = runningConfigs.map(c => {
                const pending = data.pending.filter(p => p.confId == c.id).length;
                const history = data.history.filter(p => p.confId == c.id).length;
                return `
                <div class="bg-card p-4 rounded-lg border-l-4 ${c.active ? 'border-green-500' : 'border-red-500'}">
                    <div class="flex justify-between mb-2">
                        <span class="font-bold text-yellow-500">ENGINE #${c.id.toString().slice(-4)}</span>
                        <span class="text-[10px] bg-zinc-800 px-2 rounded">${c.mode} | Vol:${c.vol}</span>
                    </div>
                    <div class="grid grid-cols-3 gap-2 mb-4">
                        <button onclick="showPopup('pending', ${c.id})" class="bg-zinc-800 p-2 rounded text-xs">Mở: ${pending}</button>
                        <button onclick="showPopup('history', ${c.id})" class="bg-zinc-800 p-2 rounded text-xs">Lịch sử: ${history}</button>
                        <button onclick="toggleConfig(${c.id})" class="bg-zinc-700 p-2 rounded text-xs ${c.active?'text-green-400':'text-red-400'}">${c.active?'ON':'OFF'}</button>
                    </div>
                </div>`;
            }).join('');

            // Cập nhật Dashboard tổng
            document.getElementById('totalOpening').innerText = data.pending.length;
            document.getElementById('totalWinRatio').innerText = winCount + '/' + data.history.length;
        }

        // Khởi tạo biểu đồ mốc 1h
        const ctx = document.getElementById('mainChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'bar',
            data: { labels: ['1h', '2h', '3h', '4h', '5h'], datasets: [{ label: 'PnL ($)', data: [10, -5, 15, 20, 12], backgroundColor: '#fcd535' }] },
            options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
        });

        setInterval(update, 1000);
    </script>
</body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Engine Multi-Config: http://localhost:${PORT}/gui`); });
