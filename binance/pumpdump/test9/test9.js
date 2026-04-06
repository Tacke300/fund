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

// QUEUE CHUẨN 350MS
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
            
            // XỬ LÝ LỆNH (PENDING & DCA)
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

            // QUÉT MỞ LỆNH MỚI CHO 40 CẤU HÌNH
            activeConfigs.forEach(conf => {
                const tag = `${conf.vol}%-${conf.mode}`;
                const isBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                if (!isBusy && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= conf.vol) {
                    if (!actionQueue.find(q => q.id === `${s}_${tag}`)) {
                        actionQueue.push({ id: `${s}_${tag}`, action: () => {
                            let type = (conf.mode === 'LONG') ? 'LONG' : (conf.mode === 'SHORT' ? 'SHORT' : (c1 >= 0 ? (conf.mode === 'FOLLOW' ? 'LONG' : 'SHORT') : (conf.mode === 'FOLLOW' ? 'SHORT' : 'LONG')));
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
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])), 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        allData: Array.from(historyMap.values())
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Ultra</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; font-size: 11px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .config-btn { border: 1px solid #30363d; padding: 10px; border-radius: 4px; cursor: pointer; text-align: center; }
        .config-btn.active { border-color: #fcd535; background: rgba(252,213,53,0.1); color: #fcd535; font-weight: bold; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:#0b0e11; overflow-y:auto; }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-2 rounded border border-yellow-500/20">
        <div class="flex justify-between mb-4"><div class="text-yellow-500 font-bold italic uppercase">Cấu hình Đa Luồng (Vốn riêng)</div><button onclick="toggleAll()" class="bg-zinc-700 px-4 py-1 rounded text-[10px]">CHỌN HẾT</button></div>
        <div class="grid grid-cols-4 gap-2 mb-4">
            <input id="balInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded text-yellow-500"><input id="marInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded text-yellow-500"><input id="tpInp" type="number" step="0.1" value="0.5" class="bg-black border border-zinc-700 p-2 rounded"><input id="slInp" type="number" step="0.1" value="10.0" class="bg-black border border-zinc-700 p-2 rounded">
        </div>
        <div id="grid" class="grid grid-cols-4 md:grid-cols-8 gap-1 mb-4"></div>
        <button onclick="start()" class="w-full bg-[#fcd535] text-black py-4 rounded font-black italic shadow-lg">KHỞI CHẠY TẤT CẢ LUỒNG</button>
    </div>

    <div id="master" class="hidden p-4">
        <div class="flex justify-between items-center mb-6 border-b border-zinc-800 pb-4">
            <div class="text-2xl font-black italic">HỆ THỐNG <span class="text-yellow-500">LUFFY PRO</span></div>
            <button onclick="stop()" class="bg-red-600 px-6 py-2 rounded font-bold uppercase">STOP ALL</button>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8 text-center">
            <div class="bg-card p-4 rounded border-l-4 border-yellow-500"><div>EQUITY TỔNG</div><div id="gEq" class="text-2xl font-bold">0.00</div></div>
            <div class="bg-card p-4 rounded"><div>WIN TỔNG</div><div id="gWin" class="text-2xl font-bold text-green-400">0</div></div>
            <div class="bg-card p-4 rounded"><div>LÃI TỔNG</div><div id="gProf" class="text-2xl font-bold">0.00</div></div>
            <div class="bg-card p-4 rounded"><div>TREO TỔNG</div><div id="gUn" class="text-2xl font-bold">0.00</div></div>
        </div>
        
        <div id="miniGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3"></div>
    </div>

    <div id="popup" class="modal">
        <div class="p-2 relative">
            <button onclick="closePop()" class="fixed top-2 right-4 text-5xl font-bold text-white z-[1100]">&times;</button>
            <div id="popContent" class="max-w-6xl mx-auto"></div>
        </div>
    </div>

    <script>
    let state = JSON.parse(localStorage.getItem('luffy_v3') || '{}'), lastRaw = null, popChart = null;
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'], gridEl = document.getElementById('grid');
    for(let v=1; v<=10; v++) { modes.forEach(m => { const d = document.createElement('div'); d.className = 'config-btn'; d.innerText = v+'%-'+m; d.onclick = () => d.classList.toggle('active'); gridEl.appendChild(d); });}
    
    function toggleAll() { const btns = document.querySelectorAll('.config-btn'); const any = document.querySelectorAll('.config-btn.active').length > 0; btns.forEach(b => any ? b.classList.remove('active') : b.classList.add('active')); }
    function start() {
        const configs = []; document.querySelectorAll('.config-btn.active').forEach(el => { const [v, m] = el.innerText.split('%-'); configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) }); });
        localStorage.setItem('luffy_v3', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balInp').value), margin: document.getElementById('marInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }
    function stop() { if(confirm('Dừng?')) { state.running = false; localStorage.setItem('luffy_v3', JSON.stringify(state)); location.reload(); } }
    function closePop() { document.getElementById('popup').style.display = 'none'; popChart = null; }

    async function update() {
        if(!state.running) return;
        const res = await fetch('/api/data'); lastRaw = await res.json();
        let tEq = 0, tWin = 0, tProf = 0, tUn = 0;
        const mGrid = document.getElementById('miniGrid'); mGrid.innerHTML = '';

        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            let bal = state.initialBal, wCount = 0, wPnl = 0, uPnl = 0, dcaTotal = 0;
            const hists = lastRaw.allData.filter(h => h.confTag === tag && h.status !== 'PENDING');
            const pends = lastRaw.allData.filter(h => h.confTag === tag && h.status === 'PENDING');
            
            hists.forEach(h => {
                let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
                let net = m * (h.dcaCount+1) * 20 * (h.pnlPercent/100); bal += net; wPnl += net; wCount++; dcaTotal += h.dcaCount;
            });
            pends.forEach(p => {
                let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
                let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
                uPnl += (m * (p.dcaCount+1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
            });

            tEq += (bal+uPnl); tWin += wCount; tProf += wPnl; tUn += uPnl;

            // BOX CHI TIẾT BÊN NGOÀI
            const box = document.createElement('div'); box.className = 'bg-card p-3 rounded cursor-pointer border border-zinc-800 hover:border-yellow-500';
            box.onclick = () => { document.getElementById('popup').style.display = 'block'; renderOriginal(tag); };
            box.innerHTML = \`<div class="flex justify-between mb-1"><b class="text-yellow-500">\${tag}</b><span class="\${uPnl>=0?'up':'down'}">\${uPnl.toFixed(1)}</span></div>
                <div class="grid grid-cols-2 gap-x-4 text-[9px] text-gray-400">
                    <div>Win: <b class="text-white">\${wCount}</b></div><div>DCA: <b class="text-white">\${dcaTotal}</b></div>
                    <div>PnL Win: <b class="text-white">\${wPnl.toFixed(1)}</b></div><div>Vị thế: <b class="text-white">\${pends.length}</b></div>
                    <div class="col-span-2 mt-1 border-t border-zinc-800 pt-1">Equity: <b class="text-yellow-500">\${(bal+uPnl).toFixed(1)}</b></div>
                </div>\`;
            mGrid.appendChild(box);
            if(document.getElementById('popup').style.display === 'block' && document.getElementById('popContent').innerHTML.includes(tag)) renderOriginal(tag);
        });
        document.getElementById('gEq').innerText = tEq.toFixed(2); document.getElementById('gWin').innerText = tWin; document.getElementById('gProf').innerText = tProf.toFixed(2); document.getElementById('gUn').innerText = tUn.toFixed(2);
    }

    function renderOriginal(tag) {
        const conf = state.configs.find(c => (c.vol+'%-'+c.mode) === tag);
        const pends = lastRaw.allData.filter(h => h.confTag === tag && h.status === 'PENDING');
        const hists = lastRaw.allData.filter(h => h.confTag === tag && h.status !== 'PENDING');
        let bal = state.initialBal, winSum = 0, winCount = 0, unPnl = 0, totalDCA = 0;
        let chartData = [bal], chartLabels = ['Start'];
        
        hists.forEach((h, i) => {
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            let net = m * (h.dcaCount+1) * 20 * (h.pnlPercent/100); bal += net; winSum += net; winCount++; totalDCA += h.dcaCount;
            chartData.push(bal); chartLabels.push(i+1);
        });
        pends.forEach(p => {
            let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            unPnl += (m * (p.dcaCount+1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
        });

        // ĐỔ NGUYÊN XI 100% LAYOUT BẢN GỐC VÀO POPUP
        document.getElementById('popContent').innerHTML = \`
            <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
                <div class="flex justify-between items-center mb-4">
                    <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span> <span class="text-sm bg-zinc-800 px-2 rounded">\${tag}</span></div>
                    <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded">ENGINE RUNNING</div>
                </div>
                <div class="flex justify-between items-end mb-3">
                    <div><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">Equity (Vốn + PnL Live)</div><span class="text-4xl font-bold text-white">\${(bal+unPnl).toFixed(2)}</span></div>
                    <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div class="text-xl font-bold \${unPnl>=0?'up':'down'}">\${unPnl.toFixed(2)}</div></div>
                </div>
                <div class="grid grid-cols-3 gap-2 mt-4 text-center">
                    <div class="bg-card p-2 rounded border border-zinc-800"><div>Win</div><div class="text-lg font-bold text-green-400">\${winCount}</div></div>
                    <div class="bg-card p-2 rounded border border-zinc-800"><div>PnL Win ($)</div><div class="text-lg font-bold text-white">\${winSum.toFixed(2)}</div></div>
                    <div class="bg-card p-2 rounded border border-zinc-800"><div>Tổng DCA</div><div class="text-lg font-bold text-yellow-500">\${totalDCA}</div></div>
                </div>
            </div>
            <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 border border-zinc-800"><div style="height: 220px;"><canvas id="popC"></canvas></div></div></div>
            <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
                <div class="text-white mb-3 uppercase flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
                <table class="w-full text-[10px]"><thead><tr class="text-gray-500 border-b border-zinc-800"><th>STT</th><th>Pair</th><th>DCA</th><th>Entry/Live</th><th>PnL (ROI%)</th></tr></thead>
                <tbody>\${pends.map((p,i) => \`<tr><td>\${i+1}</td><td class="font-bold">\${p.symbol} <span class="\${p.type==='LONG'?'up':'down'}">\${p.type}</span></td><td>\${p.dcaCount}</td><td>\${p.avgPrice.toFixed(4)}<br>\${(lastRaw.allPrices[p.symbol]||0).toFixed(4)}</td><td class="font-bold \${unPnl>=0?'up':'down'}">\${unPnl.toFixed(1)}%</td></tr>\`).join('')}</tbody></table>
            </div></div>
            <div class="px-4 mt-5 pb-20"><div class="bg-card rounded-xl p-4">
                <div class="text-gray-400 mb-3 uppercase italic">Nhật ký giao dịch</div>
                <table class="w-full text-[9px]"><thead><tr class="text-gray-500 border-b border-zinc-800"><th>Time</th><th>Pair</th><th>DCA</th><th>MaxDD</th><th>PnL Net</th></tr></thead>
                <tbody>\${hists.slice(-30).reverse().map(h => \`<tr><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td class="font-bold">\${h.symbol}</td><td>\${h.dcaCount}</td><td class="down">\${h.maxNegativeRoi.toFixed(1)}%</td><td class="up font-bold">+\${h.pnlPercent.toFixed(2)}%</td></tr>\`).join('')}</tbody></table>
            </div></div>\`;
        const ctx = document.getElementById('popC').getContext('2d');
        popChart = new Chart(ctx, { type: 'line', data: { labels: chartLabels, datasets: [{ data: chartData, borderColor: '#0ecb81', fill: true, backgroundColor: 'rgba(14,203,129,0.1)', pointRadius: 0 }] }, options: { animation: false, maintainAspectRatio: false, scales: { x: { display: false }, y: { grid: { color: '#2b3139' } } }, plugins: { legend: { display: false } } } });
    }

    if(state.running) { document.getElementById('setup').classList.add('hidden'); document.getElementById('master').classList.remove('hidden'); setInterval(update, 1000); fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs))); }
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Dashboard Multi-Original: http://localhost:${PORT}/gui`); });
