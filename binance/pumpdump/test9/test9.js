const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 
let activeConfigs = []; 

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.shift().action();
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
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}_${h.confTag}`, h));
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
            
            const pends = Array.from(historyMap.values()).filter(h => h.symbol === s && h.status === 'PENDING');
            pends.forEach(pending => {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;
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
                if (triggerDCA && !actionQueue.find(q => q.id === `${s}_${pending.confTag}`)) {
                    actionQueue.push({ id: `${s}_${pending.confTag}`, action: () => {
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (pending.dcaCount + 2);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        pending.avgPrice = newAvg; pending.dcaCount++;
                    }});
                }
            });

            activeConfigs.forEach(conf => {
                const tag = `${conf.vol}%-${conf.mode}`;
                const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                const isBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                if (!isBusy && maxVol >= conf.vol && !(lastTradeClosed[`${s}_${tag}`] && (now - lastTradeClosed[`${s}_${tag}`] < COOLDOWN_MINUTES * 60000))) {
                    if (!actionQueue.find(q => q.id === `${s}_${tag}`)) {
                        actionQueue.push({ id: `${s}_tag`, action: () => {
                            let type = conf.mode === 'REVERSE' ? (c1 >= 0 ? 'SHORT' : 'LONG') : (c1 >= 0 ? 'LONG' : 'SHORT');
                            historyMap.set(`${s}_${now}_${tag}`, { 
                                symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                                maxLev: symbolMaxLeverage[s] || 20, tpTarget: conf.tp, slTarget: conf.sl, dcaCount: 0, 
                                maxNegativeRoi: 0, dcaHistory: [{t: now, p, avg: p}], confTag: tag 
                            });
                        }});
                    }
                }
            });
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => { activeConfigs = JSON.parse(req.query.activeConfigs || '[]'); res.sendStatus(200); });
app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])), 
        market: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: all.filter(h => h.status === 'PENDING'), 
        history: all.filter(h => h.status !== 'PENDING') 
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Multi Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); overflow-y:auto; }
        .config-btn { border: 1px solid #30363d; padding: 8px; border-radius: 4px; cursor: pointer; text-align: center; font-weight: bold; font-size: 10px; }
        .config-btn.active { border-color: #fcd535; background: rgba(252, 213, 53, 0.1); color: #fcd535; }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-2 rounded border border-yellow-500/20">
        <div class="grid grid-cols-4 gap-2 mb-4">
            <input id="balanceInp" type="number" value="1000" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded text-yellow-500 font-bold">
            <input id="marginInp" type="text" value="10%" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded text-yellow-500 font-bold">
            <input id="tpInp" type="number" step="0.1" value="0.5" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded"><input id="slInp" type="number" step="0.1" value="10.0" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded">
        </div>
        <div id="gridBtn" class="grid grid-cols-4 md:grid-cols-8 gap-1 mb-4"></div>
        <button onclick="start()" class="w-full bg-[#fcd535] text-black py-3 rounded font-black uppercase italic">KÍCH HOẠT HỆ THỐNG</button>
    </div>

    <div id="boardSection" class="hidden p-2"><table class="w-full text-left bg-card rounded text-[11px]">
        <thead class="bg-[#2b3139] uppercase text-gray-400"><tr><th>Cấu hình</th><th>Balance Thực</th><th>PnL Win</th><th>PnL Treo</th><th>Vị thế</th></tr></thead>
        <tbody id="boardBody"></tbody>
    </table></div>

    <div id="detailModal" class="modal">
        <div class="p-4 relative">
            <button onclick="closeModal()" class="fixed top-2 right-4 text-4xl z-[1001]">&times;</button>
            <div id="dashboardContent"></div> </div>
    </div>

    <script>
    let state = JSON.parse(localStorage.getItem('luffy_multi_state') || '{}'), lastRaw = null, myChart = null;
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'];
    const grid = document.getElementById('gridBtn');
    
    for(let v=1; v<=10; v++) { modes.forEach(m => {
        const d = document.createElement('div'); d.className = 'config-btn'; d.innerText = v+'%-'+m;
        d.onclick = () => d.classList.toggle('active'); grid.appendChild(d);
    });}

    function start() {
        const configs = [];
        document.querySelectorAll('.config-btn.active').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
        localStorage.setItem('luffy_multi_state', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), margin: document.getElementById('marginInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }

    function stopScan() { if(confirm('Dừng quét lệnh mới cho tất cả?')) { state.running = false; localStorage.setItem('luffy_multi_state', JSON.stringify(state)); location.reload(); } }
    function closeModal() { document.getElementById('detailModal').style.display = 'none'; myChart = null; }

    function openDetail(tag) {
        document.getElementById('detailModal').style.display = 'block';
        renderDashboard(tag);
    }

    function renderDashboard(tag) {
        const conf = state.configs.find(c => (c.vol+'%-'+c.mode) === tag);
        const pends = lastRaw.pending.filter(h => h.confTag === tag);
        const hists = lastRaw.history.filter(h => h.confTag === tag);
        
        let bal = state.initialBal, winSum = 0, totalDCA = 0, winCount = 0, unPnl = 0;
        let chartData = [bal], chartLabels = ['Start'];
        
        hists.forEach(h => {
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            let net = m * (h.dcaCount+1) * 20 * (h.pnlPercent/100);
            bal += net; winSum += net; winCount++; totalDCA += h.dcaCount;
            chartData.push(bal); chartLabels.push('');
        });

        pends.forEach(p => {
            let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            unPnl += (m * (p.dcaCount+1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
        });

        document.getElementById('dashboardContent').innerHTML = \`
            <div class="bg-[#0b0e11] p-4 border-b border-zinc-800 flex justify-between">
                <div class="text-xl font-black uppercase italic text-[#fcd535]">CONFIG: \${tag}</div>
                <button onclick="stopScan()" class="text-red-500 border border-red-500 px-4 py-1 rounded text-xs">STOP SCAN</button>
            </div>
            <div class="p-4">
                <div class="grid grid-cols-2 gap-4 mb-4">
                    <div><div class="text-gray-400 text-[10px]">EQUITY</div><div class="text-3xl font-bold">\${(bal+unPnl).toFixed(2)}</div></div>
                    <div class="text-right"><div class="text-gray-400 text-[10px]">PNL TẠM TÍNH</div><div class="text-xl font-bold \${unPnl>=0?'up':'down'}">\${unPnl.toFixed(2)}</div></div>
                </div>
                <div class="grid grid-cols-3 gap-2 mb-6">
                    <div class="bg-card p-2 rounded text-center"><div class="text-[9px] text-gray-400">WIN</div><div class="text-green-400 font-bold">\${winCount}</div></div>
                    <div class="bg-card p-2 rounded text-center"><div class="text-[9px] text-gray-400">PNL WIN</div><div class="font-bold">\${winSum.toFixed(2)}</div></div>
                    <div class="bg-card p-2 rounded text-center"><div class="text-[9px] text-gray-400">DCA</div><div class="text-yellow-500 font-bold">\${totalDCA}</div></div>
                </div>
                <div class="bg-card p-4 rounded mb-6"><canvas id="pChart" height="150"></canvas></div>
                
                <div class="mb-6"><div class="text-yellow-500 font-bold mb-2 uppercase italic">Vị thế đang mở</div>
                <table class="w-full text-[10px]"><thead><tr><th>Pair</th><th>DCA</th><th>Entry/Live</th><th>ROI%</th></tr></thead>
                <tbody>\${pends.map(p => \`<tr><td>\${p.symbol}</td><td>\${p.dcaCount}</td><td>\${p.avgPrice.toFixed(4)}<br>\${(lastRaw.allPrices[p.symbol]||0).toFixed(4)}</td><td class="up font-bold">\${(((lastRaw.allPrices[p.symbol]-p.avgPrice)/p.avgPrice)*2000).toFixed(1)}%</td></tr>\`).join('')}</tbody></table></div>
                
                <div><div class="text-gray-400 font-bold mb-2 uppercase italic">Nhật ký giao dịch</div>
                <table class="w-full text-[9px]"><thead><tr><th>Time</th><th>Pair</th><th>DCA</th><th>PnL Net</th></tr></thead>
                <tbody>\${hists.reverse().map(h => \`<tr><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td>\${h.symbol}</td><td>\${h.dcaCount}</td><td class="up font-bold">\${h.pnlPercent.toFixed(2)}%</td></tr>\`).join('')}</tbody></table></div>
            </div>\`;

        const ctx = document.getElementById('pChart').getContext('2d');
        new Chart(ctx, { type: 'line', data: { labels: chartLabels, datasets: [{ data: chartData, borderColor: '#0ecb81', fill: true, backgroundColor: 'rgba(14,203,129,0.1)', pointRadius: 0 }] }, options: { animation: false, scales: { x: { display: false } } } });
    }

    if(state.running) {
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('boardSection').classList.remove('hidden');
        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            const tr = document.createElement('tr'); tr.onclick = () => openDetail(tag); tr.className = 'cursor-pointer hover:bg-zinc-800';
            tr.innerHTML = \`<td class="font-bold text-yellow-500">\${tag}</td><td id="bal-\${tag}">0.00</td><td id="winp-\${tag}" class="up">0.00</td><td id="livep-\${tag}">0.00</td><td id="count-\${tag}" class="font-bold text-white text-lg">0</td>\`;
            document.getElementById('boardBody').appendChild(tr);
        });
    }

    async function update() {
        if(!state.running) return;
        const res = await fetch('/api/data'); lastRaw = await res.json();
        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            let b = state.initialBal, w = 0, l = 0;
            lastRaw.history.filter(h => h.confTag === tag).forEach(h => {
                let m = state.margin.includes('%') ? (b * parseFloat(state.margin)/100) : parseFloat(state.margin);
                let net = m * (h.dcaCount+1) * 20 * (h.pnlPercent/100); b += net; w += net;
            });
            const p = lastRaw.pending.filter(h => h.confTag === tag);
            p.forEach(px => {
                let lp = lastRaw.allPrices[px.symbol] || px.avgPrice;
                let m = state.margin.includes('%') ? (b * parseFloat(state.margin)/100) : parseFloat(state.margin);
                l += (m * (px.dcaCount + 1)) * ((px.type === 'LONG' ? (lp-px.avgPrice)/px.avgPrice : (px.avgPrice-lp)/px.avgPrice) * 100 * 20) / 100;
            });
            document.getElementById('bal-'+tag).innerText = (b + l).toFixed(2);
            document.getElementById('winp-'+tag).innerText = w.toFixed(2);
            document.getElementById('livep-'+tag).innerText = l.toFixed(2);
            document.getElementById('count-'+tag).innerText = p.length;
            if(document.getElementById('detailModal').style.display === 'block') renderDashboard(tag);
        });
    }
    setInterval(update, 1000);
    if(state.running) fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs)));
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Expert Dashboard: http://localhost:${PORT}/gui`); });
