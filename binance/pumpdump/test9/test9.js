const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 
let activeConfigs = []; 

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

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
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[`${s}_${pending.confTag}`] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }
                const totalDiff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const triggerDCA = pending.type === 'LONG' ? totalDiff <= -((pending.dcaCount + 1) * pending.slTarget) : totalDiff >= ((pending.dcaCount + 1) * pending.slTarget);
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, action: () => {
                        pending.avgPrice = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (pending.dcaCount + 2);
                        pending.dcaCount++;
                    }});
                }
            } else {
                activeConfigs.forEach(conf => {
                    const tag = `${conf.vol}%-${conf.mode}`;
                    const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                    const isBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                    if (!isBusy && maxVol >= conf.vol && !(lastTradeClosed[`${s}_${tag}`] && (now - lastTradeClosed[`${s}_${tag}`] < COOLDOWN_MINUTES * 60000))) {
                        if (!actionQueue.find(q => q.id === s)) {
                            actionQueue.push({ id: s, action: () => {
                                let type = conf.mode;
                                if(conf.mode === 'FOLLOW') type = c1 >= 0 ? 'LONG' : 'SHORT';
                                if(conf.mode === 'REVERSE') type = c1 >= 0 ? 'SHORT' : 'LONG';
                                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: conf.tp, slTarget: conf.sl, dcaCount: 0, confTag: tag });
                            }});
                        }
                    }
                });
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => { activeConfigs = JSON.parse(req.query.activeConfigs || '[]'); res.sendStatus(200); });
app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])), pending: all.filter(h => h.status === 'PENDING'), history: all.filter(h => h.status !== 'PENDING') });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Multi-Board</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; font-size: 12px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .config-btn { border: 1px solid #30363d; padding: 4px; border-radius: 4px; cursor: pointer; text-align: center; }
        .config-btn.active { border-color: #fcd535; background: rgba(252, 213, 53, 0.1); color: #fcd535; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.85); align-items:center; justify-content:center; }
        tr:hover { background: rgba(255,255,255,0.02); }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-2 rounded">
        <div class="grid grid-cols-4 gap-2 mb-4">
            <input id="balanceInp" type="number" value="1000" placeholder="Vốn" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded">
            <input id="marginInp" type="text" value="10%" placeholder="Margin" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded">
            <input id="tpInp" type="number" step="0.1" value="0.5" placeholder="TP" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded">
            <input id="slInp" type="number" step="0.1" value="10.0" placeholder="DCA" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded">
        </div>
        <div id="gridBtn" class="grid grid-cols-4 md:grid-cols-8 gap-1 mb-4"></div>
        <div class="flex gap-2">
            <button onclick="selectAll(true)" class="flex-1 bg-zinc-700 py-2 rounded font-bold uppercase">Chọn tất cả</button>
            <button onclick="selectAll(false)" class="flex-1 bg-zinc-800 py-2 rounded font-bold uppercase">Bỏ chọn</button>
        </div>
        <button onclick="start()" class="w-full bg-[#fcd535] text-black py-3 mt-2 rounded font-bold uppercase">Chạy đa luồng</button>
    </div>

    <div id="mainPopup" class="modal"><div class="bg-card p-6 rounded-lg w-11/12 max-h-[80vh] overflow-y-auto relative"><button onclick="closePopup()" class="absolute top-2 right-4 text-2xl">&times;</button><div id="popupTitle" class="text-yellow-500 font-bold mb-4 uppercase"></div><div id="popupBody"></div></div></div>

    <div id="monitor" class="p-2 overflow-x-auto">
        <table class="w-full text-left bg-card rounded overflow-hidden">
            <thead class="bg-[#2b3139] text-gray-400 text-[10px] uppercase">
                <tr><th class="p-3">Cấu hình</th><th>Win/Open</th><th>PnL Win</th><th>PnL Live</th><th class="w-24">Chart (30p)</th></tr>
            </thead>
            <tbody id="boardBody"></tbody>
        </table>
    </div>

    <script>
    let charts = {}, state = JSON.parse(localStorage.getItem('luffy_multi_state') || '{}'), lastRaw = null;
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'];
    const grid = document.getElementById('gridBtn');
    
    for(let v=1; v<=10; v++) { modes.forEach(m => {
        const d = document.createElement('div'); d.className = 'config-btn'; d.innerText = v+'%-'+m;
        d.onclick = () => d.classList.toggle('active');
        grid.appendChild(d);
    });}

    function selectAll(v) { document.querySelectorAll('.config-btn').forEach(el => v ? el.classList.add('active') : el.classList.remove('active')); }

    function start() {
        const configs = [];
        document.querySelectorAll('.config-btn.active').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
        if(!configs.length) return alert('Chọn cấu hình!');
        localStorage.setItem('luffy_multi_state', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), margin: document.getElementById('marginInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }

    function closePopup() { document.getElementById('mainPopup').style.display = 'none'; }
    function openPopup(tag) {
        document.getElementById('mainPopup').style.display = 'flex';
        document.getElementById('popupTitle').innerText = 'Chi tiết: ' + tag;
        const pend = lastRaw.pending.filter(h => h.confTag === tag);
        const hist = lastRaw.history.filter(h => h.confTag === tag).slice(0,20);
        document.getElementById('popupBody').innerHTML = \`
            <div class="mb-4 font-bold">Vị thế đang mở (\${pend.length})</div>
            \${pend.map(p => \`<div class="p-2 border-b border-zinc-700">\${p.symbol} | \${p.type} | DCA: \${p.dcaCount}</div>\`).join('') || 'Trống'}
            <div class="mt-6 mb-4 font-bold">Nhật ký gần đây</div>
            \${hist.map(h => \`<div class="p-2 border-b border-zinc-700 text-[10px]">\${h.symbol} | \${h.pnlPercent.toFixed(2)}% | \${new Date(h.endTime).toLocaleTimeString()}</div>\`).join('')}
        \`;
    }

    if(state.running) {
        document.getElementById('setup').classList.add('hidden');
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs)));
        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            const tr = document.createElement('tr');
            tr.className = 'border-b border-zinc-800 cursor-pointer';
            tr.onclick = () => openPopup(tag);
            tr.innerHTML = \`
                <td class="p-3 font-bold text-yellow-500">\${tag}</td>
                <td id="info-\${tag}">0/0</td>
                <td id="winpnl-\${tag}" class="up">0.00</td>
                <td id="livepnl-\${tag}">0.00</td>
                <td class="p-1"><canvas id="chart-\${tag}" height="30"></canvas></td>
            \`;
            document.getElementById('boardBody').appendChild(tr);
            charts[tag] = new Chart(document.getElementById('chart-'+tag).getContext('2d'), { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ data: [], borderColor: '#0ecb81', borderWidth: 1, pointRadius: 0 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } }, animation: false } });
        });
    }

    async function update() {
        if(!state.running) return;
        const res = await fetch('/api/data'); lastRaw = await res.json();
        const mNum = parseFloat(state.margin);

        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            let bal = state.initialBal, winSum = 0, winCount = 0, liveSum = 0;
            let hist = lastRaw.history.filter(h => h.confTag === tag).sort((a,b)=>a.endTime-b.endTime);
            let cData = [];

            hist.forEach(h => {
                let m = state.margin.includes('%') ? (bal * mNum / 100) : mNum;
                let net = (m * (h.dcaCount + 1) * 20 * (h.pnlPercent/100));
                bal += net; winSum += net; winCount++;
                cData.push(bal);
            });

            const pends = lastRaw.pending.filter(h => h.confTag === tag);
            pends.forEach(p => {
                let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
                let m = state.margin.includes('%') ? (bal * mNum / 100) : mNum;
                liveSum += (m * (p.dcaCount + 1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
            });

            document.getElementById('info-'+tag).innerText = winCount + '/' + pends.length;
            document.getElementById('winpnl-'+tag).innerText = winSum.toFixed(2);
            document.getElementById('livepnl-'+tag).innerText = liveSum.toFixed(2);
            document.getElementById('livepnl-'+tag).className = liveSum >= 0 ? 'up font-bold' : 'down font-bold';
            
            if(charts[tag]) {
                charts[tag].data.datasets[0].data = cData.slice(-30);
                charts[tag].update();
            }
        });
    }
    if(state.running) setInterval(update, 2000);
    function stop() { localStorage.removeItem('luffy_multi_state'); location.reload(); }
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Board: http://localhost:${PORT}/gui`); });
