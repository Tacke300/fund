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

// Queue xử lý tránh spam API
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 300); 
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
            
            // Tìm lệnh đang treo cho cặp coin này
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                
                if (win) {
                    pending.status = 'WIN'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[`${s}_${pending.confTag}`] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }

                // Logic DCA
                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -((pending.dcaCount + 1) * pending.slTarget) : totalDiffFromEntry >= ((pending.dcaCount + 1) * pending.slTarget);
                
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, action: () => {
                        const newCount = pending.dcaCount + 1;
                        pending.avgPrice = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaCount = newCount;
                    }});
                }
            } else {
                // QUÉT TỪNG CẤU HÌNH RIÊNG BIỆT
                activeConfigs.forEach(conf => {
                    const tag = `${conf.vol}%-${conf.mode}`;
                    const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                    
                    // Kiểm tra xem cấu hình này đã có lệnh nào đang chạy chưa (Mỗi cấu hình 1 lệnh 1 lúc)
                    const isConfBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                    
                    if (!isConfBusy && maxVol >= conf.vol && !(lastTradeClosed[`${s}_${tag}`] && (now - lastTradeClosed[`${s}_${tag}`] < COOLDOWN_MINUTES * 60000))) {
                        if (!actionQueue.find(q => q.id === s)) {
                            actionQueue.push({ id: s, action: () => {
                                let type = conf.mode;
                                if(conf.mode === 'FOLLOW') type = c1 >= 0 ? 'LONG' : 'SHORT';
                                if(conf.mode === 'REVERSE') type = c1 >= 0 ? 'SHORT' : 'LONG';

                                historyMap.set(`${s}_${now}`, { 
                                    symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: conf.tp, slTarget: conf.sl,
                                    dcaCount: 0, confTag: tag
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
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING')
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Multi-Strategy Tracker</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .config-btn { border: 1px solid #30363d; padding: 4px; border-radius: 4px; cursor: pointer; font-size: 10px; text-align: center; }
        .config-btn.active { border-color: #fcd535; background: rgba(252, 213, 53, 0.1); color: #fcd535; }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-4 rounded-lg">
        <div class="grid grid-cols-2 gap-3 mb-4">
            <div><label class="text-[10px] uppercase">Vốn mỗi bản ($)</label><input id="balanceInp" type="number" value="1000" class="w-full bg-[#0b0e11] border border-zinc-700 p-2 rounded"></div>
            <div><label class="text-[10px] uppercase">Margin per Trade</label><input id="marginInp" type="text" value="10%" class="w-full bg-[#0b0e11] border border-zinc-700 p-2 rounded"></div>
            <div><label class="text-[10px] uppercase">TP %</label><input id="tpInp" type="number" step="0.1" value="0.5" class="w-full bg-[#0b0e11] border border-zinc-700 p-2 rounded"></div>
            <div><label class="text-[10px] uppercase">DCA %</label><input id="slInp" type="number" step="0.1" value="10.0" class="w-full bg-[#0b0e11] border border-zinc-700 p-2 rounded"></div>
        </div>
        <div id="gridBtn" class="grid grid-cols-4 gap-1 mb-4"></div>
        <button onclick="start()" class="w-full bg-[#fcd535] text-black py-3 rounded font-bold uppercase">Kích hoạt đa cấu hình</button>
    </div>

    <div id="activeHeader" class="hidden p-4 flex justify-between border-b border-zinc-800">
        <div class="font-bold text-yellow-500">SYSTEM MULTI-ACTIVE</div>
        <button onclick="stop()" class="text-red-500 text-xs">STOP ALL</button>
    </div>

    <div id="monitor" class="p-4 grid grid-cols-1 md:grid-cols-2 gap-4"></div>

    <script>
    let charts = {}, selectedConfigs = [];
    const grid = document.getElementById('gridBtn');
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'];

    for(let v=1; v<=10; v++) { modes.forEach(m => {
        const d = document.createElement('div'); d.className = 'config-btn'; d.innerText = v+'%-'+m;
        d.onclick = () => { d.classList.toggle('active'); };
        grid.appendChild(d);
    });}

    function start() {
        const configs = [];
        document.querySelectorAll('.config-btn.active').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
        if(configs.length === 0) return alert('Chọn ít nhất 1 cấu hình');
        localStorage.setItem('luffy_multi_state', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), margin: document.getElementById('marginInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }

    function stop() { localStorage.removeItem('luffy_multi_state'); location.reload(); }

    const state = JSON.parse(localStorage.getItem('luffy_multi_state') || '{}');
    if(state.running) {
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('activeHeader').classList.remove('hidden');
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs)));
        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            const card = document.createElement('div');
            card.className = 'bg-card p-3 rounded-lg border border-zinc-800';
            card.innerHTML = \`
                <div class="flex justify-between items-center mb-2">
                    <div class="font-bold text-sm text-yellow-500 italic">\${tag}</div>
                    <div id="pnl-\${tag}" class="font-bold">0.00</div>
                </div>
                <div class="flex justify-between text-[10px] text-gray-400 mb-2">
                    <div>Win: <span id="win-\${tag}" class="text-white">0</span></div>
                    <div>Đang treo: <span id="pend-\${tag}" class="text-white">None</span></div>
                </div>
                <div style="height: 60px;"><canvas id="chart-\${tag}"></canvas></div>
            \`;
            document.getElementById('monitor').appendChild(card);
            const ctx = document.getElementById('chart-'+tag).getContext('2d');
            charts[tag] = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#0ecb81', tension: 0.2, pointRadius: 0, borderWidth: 1.5 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } }, animation: false } });
        });
    }

    async function update() {
        if(!state.running) return;
        const res = await fetch('/api/data'); const d = await res.json();
        const mNum = parseFloat(state.margin);

        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            let runningBal = state.initialBal, winCount = 0;
            let cData = [];

            d.history.filter(h => h.confTag === tag).sort((a,b)=>a.endTime-b.endTime).forEach(h => {
                let marginBase = state.margin.includes('%') ? (runningBal * mNum / 100) : mNum;
                runningBal += (marginBase * (h.dcaCount + 1) * 20 * (h.pnlPercent/100));
                winCount++;
                cData.push(runningBal);
            });

            const p = d.pending.find(h => h.confTag === tag);
            let livePnl = 0;
            if(p) {
                let lp = d.allPrices[p.symbol] || p.avgPrice;
                let marginBase = state.margin.includes('%') ? (runningBal * mNum / 100) : mNum;
                let roi = (p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20;
                livePnl = (marginBase * (p.dcaCount + 1)) * roi / 100;
                document.getElementById('pend-'+tag).innerText = p.symbol + ' (DCA:'+p.dcaCount+')';
            } else {
                document.getElementById('pend-'+tag).innerText = 'WAITING...';
            }

            document.getElementById('pnl-'+tag).innerText = (runningBal + livePnl - state.initialBal).toFixed(2);
            document.getElementById('pnl-'+tag).className = (runningBal + livePnl >= state.initialBal) ? 'font-bold up' : 'font-bold down';
            document.getElementById('win-'+tag).innerText = winCount;
            
            if(charts[tag]) {
                charts[tag].data.labels = cData.map(()=>'');
                charts[tag].data.datasets[0].data = cData;
                charts[tag].update();
            }
        });
    }
    if(state.running) setInterval(update, 2000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Dashboard: http://localhost:${PORT}/gui`); });
