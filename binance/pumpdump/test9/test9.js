const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let activeConfigs = []; 

// Logic Queue 350ms chuẩn bản gốc
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.shift().action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

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
            
            // Logic xử lý lệnh PENDING
            const pends = Array.from(historyMap.values()).filter(h => h.symbol === s && h.status === 'PENDING');
            pends.forEach(pending => {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }
                const totalDiff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const triggerDCA = pending.type === 'LONG' ? totalDiff <= -((pending.dcaCount + 1) * pending.slTarget) : totalDiff >= ((pending.dcaCount + 1) * pending.slTarget);
                if (triggerDCA && !actionQueue.find(q => q.id === `${s}_${pending.confTag}`)) {
                    actionQueue.push({ id: `${s}_${pending.confTag}`, action: () => {
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (pending.dcaCount + 2);
                        pending.dcaHistory.push({ t: Date.now(), p, avg: newAvg });
                        pending.avgPrice = newAvg; pending.dcaCount++;
                    }});
                }
            });

            // Quét mở lệnh cho 40 luồng
            activeConfigs.forEach(conf => {
                const tag = `${conf.vol}%-${conf.mode}`;
                const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                const isBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                if (!isBusy && maxVol >= conf.vol) {
                    if (!actionQueue.find(q => q.id === `${s}_${tag}`)) {
                        actionQueue.push({ id: `${s}_${tag}`, action: () => {
                            let type = conf.mode === 'REVERSE' ? (c1 >= 0 ? 'SHORT' : 'LONG') : (c1 >= 0 ? 'LONG' : 'SHORT');
                            if(conf.mode === 'LONG') type = 'LONG'; if(conf.mode === 'SHORT') type = 'SHORT';
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
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: all.filter(h => h.status === 'PENDING'), 
        history: all.filter(h => h.status !== 'PENDING') 
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Master Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; font-size: 11px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .config-btn { border: 1px solid #30363d; padding: 10px; border-radius: 4px; cursor: pointer; text-align: center; }
        .config-btn.active { border-color: #fcd535; background: rgba(252,213,53,0.1); color: #fcd535; font-weight: bold; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:#0b0e11; overflow-y:auto; }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-2 rounded border border-yellow-500/20">
        <div class="flex justify-between mb-4">
            <div class="text-yellow-500 font-bold uppercase italic">Cài đặt Đa Luồng (Vốn riêng biệt)</div>
            <button onclick="toggleAll()" class="bg-zinc-700 px-4 py-1 rounded text-[10px]">CHỌN TẤT CẢ</button>
        </div>
        <div class="grid grid-cols-4 gap-2 mb-4">
            <input id="balInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded text-yellow-500">
            <input id="marInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded text-yellow-500">
            <input id="tpInp" type="number" step="0.1" value="0.5" class="bg-black border border-zinc-700 p-2 rounded">
            <input id="slInp" type="number" step="0.1" value="10.0" class="bg-black border border-zinc-700 p-2 rounded">
        </div>
        <div id="grid" class="grid grid-cols-4 md:grid-cols-8 gap-1 mb-4"></div>
        <button onclick="start()" class="w-full bg-[#fcd535] text-black py-4 rounded font-black italic">CHẠY ENGINE</button>
    </div>

    <div id="master" class="hidden p-4">
        <div class="flex justify-between items-center mb-6 border-b border-zinc-800 pb-4">
            <div class="text-2xl font-black italic">TỔNG HỆ THỐNG <span class="text-yellow-500">LUFFY</span></div>
            <button onclick="stop()" class="bg-red-600 px-6 py-2 rounded font-bold uppercase shadow-lg">STOP ENGINE</button>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div class="bg-card p-4 rounded border-l-4 border-yellow-500">
                <div class="text-gray-500 text-[10px] uppercase">Equity Tổng</div>
                <div id="gEq" class="text-3xl font-bold">0.00</div>
            </div>
            <div class="bg-card p-4 rounded">
                <div class="text-gray-500 text-[10px] uppercase">Win Tổng</div>
                <div id="gWin" class="text-3xl font-bold text-green-400">0</div>
            </div>
            <div class="bg-card p-4 rounded">
                <div class="text-gray-500 text-[10px] uppercase">Lãi Tổng ($)</div>
                <div id="gProf" class="text-3xl font-bold">0.00</div>
            </div>
            <div class="bg-card p-4 rounded">
                <div class="text-gray-500 text-[10px] uppercase">Treo / Mở</div>
                <div class="flex gap-2 items-baseline"><span id="gUn" class="text-2xl font-bold">0.00</span><span id="gOp" class="text-gray-400">/ 0</span></div>
            </div>
        </div>
        <div id="miniGrid" class="grid grid-cols-2 md:grid-cols-5 gap-2"></div>
    </div>

    <div id="popup" class="modal">
        <div class="p-4 relative">
            <button onclick="closePop()" class="fixed top-2 right-4 text-5xl font-bold text-white z-[1100]">&times;</button>
            <div id="popContent"></div>
        </div>
    </div>

    <script>
    let state = JSON.parse(localStorage.getItem('luffy_multi_v2') || '{}'), lastRaw = null, popChart = null;
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'];
    const gridEl = document.getElementById('grid');
    
    for(let v=1; v<=10; v++) { modes.forEach(m => {
        const d = document.createElement('div'); d.className = 'config-btn'; d.innerText = v+'%-'+m;
        d.onclick = () => d.classList.toggle('active'); gridEl.appendChild(d);
    });}

    function toggleAll() {
        const btns = document.querySelectorAll('.config-btn');
        const anyActive = document.querySelectorAll('.config-btn.active').length > 0;
        btns.forEach(b => anyActive ? b.classList.remove('active') : b.classList.add('active'));
    }

    function start() {
        const configs = [];
        document.querySelectorAll('.config-btn.active').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
        localStorage.setItem('luffy_multi_v2', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balInp').value), margin: document.getElementById('marInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }

    function stop() { if(confirm('Dừng?')) { state.running = false; localStorage.setItem('luffy_multi_v2', JSON.stringify(state)); location.reload(); } }
    function closePop() { document.getElementById('popup').style.display = 'none'; popChart = null; }

    function openDetail(tag) {
        document.getElementById('popup').style.display = 'block';
        renderOriginalBảnGốc(tag);
    }

    function renderOriginalBảnGốc(tag) {
        const conf = state.configs.find(c => (c.vol+'%-'+c.mode) === tag);
        const pends = lastRaw.pending.filter(h => h.confTag === tag);
        const hists = lastRaw.history.filter(h => h.confTag === tag);
        
        let bal = state.initialBal, winSum = 0, totalDCA = 0, winCount = 0, unPnl = 0;
        let chartData = [bal], chartLabels = ['Start'];
        
        hists.forEach((h, i) => {
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            let net = m * (h.dcaCount+1) * 20 * (h.pnlPercent/100);
            bal += net; winSum += net; winCount++; totalDCA += h.dcaCount;
            chartData.push(bal); chartLabels.push(i+1);
        });

        pends.forEach(p => {
            let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            unPnl += (m * (p.dcaCount+1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
        });

        document.getElementById('popContent').innerHTML = \`
            <div class="p-2 sticky top-0 bg-[#0b0e11] z-50 border-b border-zinc-800 mb-4">
                <div class="text-2xl font-black italic">BINANCE <span class="text-[#fcd535]">LUFFY PRO - \${tag}</span></div>
                <div class="flex justify-between items-end mt-4">
                    <div><div class="text-gray-400 text-[10px] font-bold">Equity</div><span class="text-4xl font-bold">\${(bal+unPnl).toFixed(2)}</span></div>
                    <div class="text-right"><div class="text-gray-400 text-[10px] font-bold">PnL Tạm tính</div><div class="text-xl font-bold \${unPnl>=0?'up':'down'}">\${unPnl.toFixed(2)}</div></div>
                </div>
                <div class="grid grid-cols-3 gap-2 mt-4">
                    <div class="bg-card p-2 rounded text-center"><div>Win</div><div class="text-green-400 font-bold">\${winCount}</div></div>
                    <div class="bg-card p-2 rounded text-center"><div>PnL Win</div><div class="font-bold">\${winSum.toFixed(2)}</div></div>
                    <div class="bg-card p-2 rounded text-center"><div>DCA</div><div class="text-yellow-500 font-bold">\${totalDCA}</div></div>
                </div>
            </div>
            <div class="bg-card p-4 rounded mb-6"><canvas id="cChart" height="200"></canvas></div>
            <div class="bg-card p-4 rounded mb-6">
                <div class="text-yellow-500 font-bold mb-2 uppercase italic">Vị thế đang mở</div>
                <table class="w-full text-[10px]"><thead><tr class="text-gray-500 border-b border-zinc-800"><th>STT</th><th>Pair</th><th>DCA</th><th>Entry/Live</th><th>PnL (ROI%)</th></tr></thead>
                <tbody>\${pends.map((p,i) => \`<tr><td>\${i+1}</td><td class="font-bold">\${p.symbol} <span class="p-0.5 \${p.type==='LONG'?'bg-green-600':'bg-red-600'} rounded text-[8px]">\${p.type}</span></td><td>\${p.dcaCount}</td><td>\${p.avgPrice.toFixed(4)}<br><span class="up">\${(lastRaw.allPrices[p.symbol]||0).toFixed(4)}</span></td><td class="font-bold \${((((lastRaw.allPrices[p.symbol]||p.avgPrice)-p.avgPrice)/p.avgPrice)*2000)>=0?'up':'down'}">\${((((lastRaw.allPrices[p.symbol]||p.avgPrice)-p.avgPrice)/p.avgPrice)*2000).toFixed(1)}%</td></tr>\`).join('')}</tbody></table>
            </div>
            <div class="bg-card p-4 rounded">
                <div class="text-gray-400 font-bold mb-2 uppercase italic">Nhật ký giao dịch</div>
                <table class="w-full text-[9px]"><thead><tr class="text-gray-500 border-b border-zinc-800"><th>Time</th><th>Pair</th><th>DCA</th><th>MaxDD</th><th>PnL Net</th></tr></thead>
                <tbody>\${hists.slice(-20).reverse().map(h => \`<tr><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td class="font-bold text-white">\${h.symbol}</td><td>\${h.dcaCount}</td><td class="down">\${h.maxNegativeRoi.toFixed(1)}%</td><td class="up font-bold">+\${h.pnlPercent.toFixed(2)}%</td></tr>\`).join('')}</tbody></table>
            </div>\`;

        const ctx = document.getElementById('cChart').getContext('2d');
        popChart = new Chart(ctx, { type: 'line', data: { labels: chartLabels, datasets: [{ label: 'Equity', data: chartData, borderColor: '#0ecb81', fill: true, backgroundColor: 'rgba(14,203,129,0.1)', pointRadius: 0, tension: 0.1 }] }, options: { animation: false, scales: { x: { display: false }, y: { grid: { color: '#2b3139' } } }, plugins: { legend: { display: false } } } });
    }

    async function update() {
        if(!state.running) return;
        const res = await fetch('/api/data'); lastRaw = await res.json();
        let totalEq = 0, totalWin = 0, totalProf = 0, totalUn = 0, totalOp = 0;
        const mGrid = document.getElementById('miniGrid'); mGrid.innerHTML = '';

        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            let b = state.initialBal, wCount = 0, wPnl = 0, uPnl = 0;
            lastRaw.history.filter(h => h.confTag === tag).forEach(h => {
                let m = state.margin.includes('%') ? (b * parseFloat(state.margin)/100) : parseFloat(state.margin);
                let net = m * (h.dcaCount+1) * 20 * (h.pnlPercent/100); b += net; wPnl += net; wCount++;
            });
            const p = lastRaw.pending.filter(h => h.confTag === tag);
            p.forEach(px => {
                let lp = lastRaw.allPrices[px.symbol] || px.avgPrice;
                let m = state.margin.includes('%') ? (b * parseFloat(state.margin)/100) : parseFloat(state.margin);
                uPnl += (m * (px.dcaCount + 1)) * ((px.type === 'LONG' ? (lp-px.avgPrice)/px.avgPrice : (px.avgPrice-lp)/px.avgPrice) * 100 * 20) / 100;
            });

            totalEq += (b + uPnl); totalWin += wCount; totalProf += wPnl; totalUn += uPnl; totalOp += p.length;

            const box = document.createElement('div'); box.className = 'bg-card p-3 rounded cursor-pointer hover:border-yellow-500 border border-zinc-800';
            box.onclick = () => openDetail(tag);
            box.innerHTML = \`<div class="text-yellow-500 font-bold">\${tag}</div><div class="text-lg font-bold">\${(b+uPnl).toFixed(1)}</div><div class="text-[9px] \${uPnl>=0?'up':'down'}">UnPnL: \${uPnl.toFixed(1)}</div>\`;
            mGrid.appendChild(box);

            if(document.getElementById('popup').style.display === 'block' && document.getElementById('popContent').querySelector('.text-[#fcd535]').innerText.includes(tag)) renderOriginalBảnGốc(tag);
        });

        document.getElementById('gEq').innerText = totalEq.toFixed(2);
        document.getElementById('gWin').innerText = totalWin;
        document.getElementById('gProf').innerText = totalProf.toFixed(2);
        document.getElementById('gUn').innerText = totalUn.toFixed(2);
        document.getElementById('gUn').className = 'text-2xl font-bold ' + (totalUn >= 0 ? 'up' : 'down');
        document.getElementById('gOp').innerText = '/ ' + totalOp;
    }

    if(state.running) {
        document.getElementById('setup').classList.add('hidden'); document.getElementById('master').classList.remove('hidden');
        setInterval(update, 1000);
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs)));
    }
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Master Engine: http://localhost:${PORT}/gui`); });
