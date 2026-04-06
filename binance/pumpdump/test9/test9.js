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

// Logic lưu trữ nhiều cấu hình
let activeConfigs = []; 

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
            } else {
                activeConfigs.forEach(conf => {
                    const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                    if (maxVol >= conf.vol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                        if (!actionQueue.find(q => q.id === s)) {
                            actionQueue.push({ id: s, priority: 2, action: () => {
                                let type = 'LONG';
                                if(conf.mode === 'LONG') type = 'LONG';
                                else if(conf.mode === 'SHORT') type = 'SHORT';
                                else if(conf.mode === 'FOLLOW') type = c1 >= 0 ? 'LONG' : 'SHORT';
                                else if(conf.mode === 'REVERSE') type = c1 >= 0 ? 'SHORT' : 'LONG';

                                historyMap.set(`${s}_${now}`, { 
                                    symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: conf.tp, slTarget: conf.sl, snapVol: { c1, c5, c15 },
                                    maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }],
                                    confTag: `${conf.vol}%-${conf.mode}`
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
    activeConfigs = JSON.parse(req.query.activeConfigs || '[]');
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING')
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Multi</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input { border: 1px solid #30363d !important; background: #0b0e11; color: white; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.8); align-items:center; justify-content:center; }
        .config-item { border: 1px solid #30363d; padding: 5px; border-radius: 4px; cursor: pointer; font-size: 10px; text-align: center; }
        .config-item.active { border-color: #fcd535; background: rgba(252, 213, 53, 0.1); color: #fcd535; }
    </style></head><body>
    <div id="mainPopup" class="modal"><div class="bg-card p-6 rounded-lg w-11/12 max-h-[80vh] overflow-y-auto relative"><button onclick="closePopup()" class="absolute top-2 right-4 text-2xl">&times;</button><div id="popupTitle" class="text-yellow-500 font-bold mb-4 uppercase"></div><div id="popupBody"></div></div></div>
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="bg-card p-3 rounded-lg mb-4">
            <div class="grid grid-cols-2 gap-3 mb-3">
                <div><label class="text-[10px] text-gray-400 uppercase">Vốn khởi tạo</label><input id="balanceInp" type="number" value="1000" class="p-2 rounded w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-400 uppercase">Margin</label><input id="marginInp" type="text" value="10%" class="p-2 rounded w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-400 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" value="0.5" class="p-2 rounded w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-400 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" value="10.0" class="p-2 rounded w-full text-sm"></div>
            </div>
            <div id="configGrid" class="grid grid-cols-4 gap-1 mb-3"></div>
            <button onclick="selectAllConfigs()" class="w-full bg-zinc-700 text-white py-1 rounded text-[10px] mb-2 uppercase">Chọn tất cả cấu hình</button>
            <button onclick="start()" class="w-full bg-[#fcd535] text-black py-2 rounded font-bold uppercase text-xs">Khởi chạy</button>
        </div>
        <div id="activeHeader" class="hidden flex justify-between items-center mb-4"><div class="font-bold text-white italic">LUFFY MULTI-BOT</div><button onclick="stop()" class="text-red-500 text-xs border border-red-500 px-2 py-1 rounded">STOP</button></div>
        <div class="grid grid-cols-2 gap-4"><div onclick="showDetail('dashboard')" class="cursor-pointer"><div>Equity</div><span id="displayBal" class="text-2xl font-bold">0.00</span></div><div class="text-right"><div>PnL Live</div><div id="unPnl" class="text-xl font-bold">0.00</div></div></div>
        <div class="grid grid-cols-3 gap-2 mt-3 text-center text-[10px]">
            <div onclick="showDetail('pending')" class="bg-card p-2 rounded cursor-pointer">Mở: <span id="sumPending" class="text-yellow-500 font-bold">0</span></div>
            <div onclick="showDetail('history')" class="bg-card p-2 rounded cursor-pointer">Win: <span id="sumWinCount" class="text-green-500 font-bold">0</span></div>
            <div onclick="showDetail('history')" class="bg-card p-2 rounded cursor-pointer">Lãi: <span id="sumWinPnl" class="font-bold">0.00</span></div>
        </div>
    </div>
    <div class="px-4 mt-4"><div class="bg-card rounded p-4"><div style="height: 150px;"><canvas id="balanceChart"></canvas></div></div></div>
    <script>
    let running = false, initialBal = 1000, lastRawData = null, myChart = null, selectedConfigs = [];
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'];
    const grid = document.getElementById('configGrid');
    for(let v=1; v<=10; v++) { modes.forEach(m => {
        const div = document.createElement('div'); div.className = 'config-item'; div.innerText = v + '%-' + m;
        div.onclick = () => { div.classList.toggle('active'); updateSelected(); };
        grid.appendChild(div);
    });}
    function updateSelected() {
        selectedConfigs = [];
        document.querySelectorAll('.config-item.active').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            selectedConfigs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
    }
    function selectAllConfigs() { document.querySelectorAll('.config-item').forEach(el => el.classList.add('active')); updateSelected(); }
    function closePopup() { document.getElementById('mainPopup').style.display = 'none'; }
    function showDetail(type) {
        const d = lastRawData; if(!d) return; document.getElementById('mainPopup').style.display = 'flex';
        let body = '';
        if(type === 'pending') { body = d.pending.map(h => '<div>' + h.symbol + ' | DCA: ' + h.dcaCount + '</div>').join(''); }
        else if(type === 'history') { body = d.history.slice(0,20).map(h => '<div>' + h.symbol + ' | ' + h.pnlPercent.toFixed(2) + '%</div>').join(''); }
        document.getElementById('popupBody').innerHTML = body;
    }
    const saved = JSON.parse(localStorage.getItem('luffy_multi_state') || '{}');
    if(saved.running) {
        running = true; initialBal = saved.initialBal;
        document.getElementById('setup').classList.add('hidden'); document.getElementById('activeHeader').classList.remove('hidden');
        selectedConfigs = saved.configs; fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(selectedConfigs)));
    }
    function start() {
        updateSelected(); if(selectedConfigs.length === 0) return alert('Chọn ít nhất 1 cấu hình');
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), configs: selectedConfigs };
        localStorage.setItem('luffy_multi_state', JSON.stringify(state));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(selectedConfigs))).then(() => location.reload());
    }
    function stop() { localStorage.removeItem('luffy_multi_state'); location.reload(); }
    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#0ecb81', tension: 0.1, pointRadius: 0 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false } }, animation: false } });
    }
    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastRawData = d;
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let runningBal = initialBal, winSum = 0, winCount = 0, unPnl = 0;
            let labels = [], cData = [];
            d.history.reverse().forEach(h => {
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let netPnl = (marginBase * (h.dcaCount + 1) * 20 * (h.pnlPercent/100));
                runningBal += netPnl; if(netPnl >= 0) { winSum += netPnl; winCount++; }
                labels.push(''); cData.push(runningBal);
            });
            d.pending.forEach(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * 20;
                unPnl += (marginBase * (h.dcaCount + 1)) * roi / 100;
            });
            if(myChart) { myChart.data.labels = labels; myChart.data.datasets[0].data = cData; myChart.update(); }
            document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
            document.getElementById('unPnl').innerText = unPnl.toFixed(2);
            document.getElementById('sumPending').innerText = d.pending.length;
            document.getElementById('sumWinCount').innerText = winCount;
            document.getElementById('sumWinPnl').innerText = winSum.toFixed(2);
        } catch(e) {}
    }
    initChart(); setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Bot running on port ${PORT}`); });
