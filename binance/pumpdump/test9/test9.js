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
let activeConfigs = []; // Chứa 40 cấu hình

// QUEUE CHUẨN 350MS CỦA ÔNG
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// HÀM FPRICE HUYỀN THOẠI CỦA ÔNG
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
            
            // XỬ LÝ LỆNH CHO TỪNG LUỒNG
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

                // LOGIC DCA CHUẨN CỦA ÔNG (TÍNH TỪ SNAPPRICE)
                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;

                if (triggerDCA && !actionQueue.find(q => q.id === `${s}_${pending.confTag}`)) {
                    actionQueue.push({ id: `${s}_${pending.confTag}`, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        pending.avgPrice = newAvg; pending.dcaCount = newCount;
                    }});
                }
            });

            // QUÉT MỞ LỆNH THEO 40 CẤU HÌNH
            activeConfigs.forEach(conf => {
                const tag = `${conf.vol}%-${conf.mode}`;
                const isBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                if (!isBusy && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= conf.vol) {
                    if (!actionQueue.find(q => q.id === `${s}_${tag}`)) {
                        actionQueue.push({ id: `${s}_${tag}`, priority: 2, action: () => {
                            const sumVol = c1 + c5 + c15;
                            let type = sumVol >= 0 ? 'LONG' : 'SHORT';
                            if (conf.mode === 'REVERSE') type = (type === 'LONG' ? 'SHORT' : 'LONG');
                            if (conf.mode === 'LONG') type = 'LONG';
                            if (conf.mode === 'SHORT') type = 'SHORT';

                            historyMap.set(`${s}_${now}_${tag}`, { 
                                symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                                maxLev: symbolMaxLeverage[s] || 20, tpTarget: conf.tp, slTarget: conf.sl, 
                                maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: now, p, avg: p }], confTag: tag 
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
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro Multi-Core</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; font-size: 11px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:#0b0e11; overflow-y:auto; }
        .column-box { border-radius: 4px; padding: 6px; cursor: pointer; border: 1px solid #333; margin-bottom: 5px; }
        .column-box:hover { border-color: #fcd535; }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-2 rounded border border-yellow-500">
        <div class="grid grid-cols-4 gap-2 mb-4">
            <input id="balInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded text-yellow-500">
            <input id="marInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded text-yellow-500">
            <input id="tpInp" type="number" step="0.1" value="0.5" class="bg-black border border-zinc-700 p-2 rounded">
            <input id="slInp" type="number" step="0.1" value="10.0" class="bg-black border border-zinc-700 p-2 rounded">
        </div>
        <div id="grid" class="grid grid-cols-10 gap-1 mb-4"></div>
        <button onclick="start()" class="w-full bg-[#fcd535] text-black py-4 rounded font-bold uppercase">KÍCH HOẠT 40 LUỒNG TRUY QUÉT</button>
    </div>

    <div id="master" class="hidden p-2">
        <div class="flex justify-between items-center mb-4 px-2 border-b border-zinc-800 pb-2">
            <div class="text-xl font-black italic">BINANCE <span class="text-yellow-500">LUFFY MULTI-CORE</span></div>
            <div class="flex gap-10">
                <div class="text-right text-gray-400 uppercase font-bold text-[10px]">Equity Tổng: <br><span id="gEq" class="text-xl text-white">0.00</span></div>
                <button onclick="stop()" class="bg-red-600 px-4 rounded font-bold">STOP</button>
            </div>
        </div>
        <div class="grid grid-cols-4 gap-2">
            <div id="col-LONG"></div><div id="col-SHORT"></div><div id="col-FOLLOW"></div><div id="col-REVERSE"></div>
        </div>
    </div>

    <div id="popup" class="modal">
        <div id="popContent"></div>
    </div>

    <script>
    let state = JSON.parse(localStorage.getItem('luffy_v5') || '{}'), lastRaw = null, myChart = null;
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'], gridEl = document.getElementById('grid');
    for(let v=1; v<=10; v++) { modes.forEach(m => { 
        const d = document.createElement('div'); d.className = 'border border-zinc-800 text-center p-1 cursor-pointer rounded text-[8px]'; d.innerText = v+'%-'+m; 
        d.onclick = () => d.classList.toggle('bg-yellow-600'); gridEl.appendChild(d); 
    });}

    function fPrice(p) {
        if (!p || p === 0) return "0.0000";
        let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/);
        if (!match) return p.toFixed(4);
        let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
    }

    function start() {
        const configs = []; document.querySelectorAll('#grid .bg-yellow-600').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
        localStorage.setItem('luffy_v5', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balInp').value), margin: document.getElementById('marInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }

    function stop() { if(confirm('Dừng?')) { state.running = false; localStorage.setItem('luffy_v5', JSON.stringify(state)); location.reload(); } }

    async function update() {
        if(!state.running) return;
        const res = await fetch('/api/data'); lastRaw = await res.json();
        let tEq = 0;
        modes.forEach(m => { const c = document.getElementById('col-'+m); c.innerHTML = '<div class="text-center font-bold mb-2 py-1 bg-zinc-900 border-b border-zinc-700">'+m+'</div>'; });

        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            let bal = state.initialBal, winSum = 0, uPnl = 0, dcaCount = 0;
            const hists = lastRaw.allData.filter(h => h.confTag === tag && h.status !== 'PENDING');
            const pends = lastRaw.allData.filter(h => h.confTag === tag && h.status === 'PENDING');
            
            hists.forEach(h => {
                let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
                let net = (m * (h.dcaCount + 1) * 20 * (h.pnlPercent/100)) - (m * (h.dcaCount + 1) * 20 * 0.001);
                bal += net; winSum += net; dcaCount += h.dcaCount;
            });
            pends.forEach(p => {
                let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
                let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
                uPnl += (m * (p.dcaCount+1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
            });
            tEq += (bal+uPnl);

            const box = document.createElement('div'); box.className = 'column-box bg-card';
            box.onclick = () => renderOriginal(tag);
            box.innerHTML = \`
                <div class="flex justify-between border-b border-zinc-800 pb-1 mb-1">
                    <b class="text-yellow-500">\${tag}</b> <span class="\${uPnl>=0?'up':'down'} font-bold">ROI: \${uPnl.toFixed(1)}</span>
                </div>
                <div class="flex justify-between text-[9px] text-gray-500 mb-1">
                    <span>Win: \${hists.length} | DCA: \${dcaCount}</span> <span>Eq: \${(bal+uPnl).toFixed(1)}</span>
                </div>
                <div class="bg-black/30 p-1 rounded">
                    \${pends.map(p => \`<div class="flex justify-between text-[9px]"><span>\${p.symbol} \${p.type}</span><span class="up">DCA \${p.dcaCount}</span></div>\`).join('') || '<div class="text-zinc-700 text-center">No Position</div>'}
                </div>
            \`;
            document.getElementById('col-'+conf.mode).appendChild(box);
        });
        document.getElementById('gEq').innerText = tEq.toFixed(2);
    }

    function renderOriginal(tag) {
        document.getElementById('popup').style.display = 'block';
        const hists = lastRaw.allData.filter(h => h.confTag === tag && h.status !== 'PENDING');
        const pends = lastRaw.allData.filter(h => h.confTag === tag && h.status === 'PENDING');
        let bal = state.initialBal, winSum = 0, winCount = 0, totalDCA = 0, unPnl = 0;
        let chartLabels = ['Start'], chartData = [bal];

        hists.forEach((h, i) => {
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            let net = (m * (h.dcaCount+1) * 20 * (h.pnlPercent/100)) - (m * (h.dcaCount+1) * 20 * 0.001);
            bal += net; winSum += net; winCount++; totalDCA += h.dcaCount;
            chartLabels.push(i); chartData.push(bal);
        });

        pends.forEach(p => {
            let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            unPnl += (m * (p.dcaCount+1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
        });

        // ĐỔ NGUYÊN XI 100% LAYOUT ÔNG CUNG CẤP VÀO ĐÂY
        document.getElementById('popContent').innerHTML = \`
            <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
                <button onclick="document.getElementById('popup').style.display='none'" class="float-right text-4xl">&times;</button>
                <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span> <span class="text-xs bg-zinc-800 px-2 rounded ml-2">\${tag}</span></div>
                <div class="flex justify-between items-end my-4">
                    <div><div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Vốn + PnL Live)</div><span class="text-4xl font-bold text-white">\${(bal+unPnl).toFixed(2)}</span></div>
                    <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div class="text-xl font-bold \${unPnl>=0?'up':'down'}">\${unPnl.toFixed(2)}</div></div>
                </div>
                <div class="grid grid-cols-3 gap-2 text-center">
                    <div class="bg-card p-2 rounded border border-zinc-800"><div>Win</div><div class="text-lg font-bold text-green-400">\${winCount}</div></div>
                    <div class="bg-card p-2 rounded border border-zinc-800"><div>PnL Win ($)</div><div class="text-lg font-bold text-white">\${winSum.toFixed(2)}</div></div>
                    <div class="bg-card p-2 rounded border border-zinc-800"><div>Tổng DCA</div><div class="text-lg font-bold text-yellow-500">\${totalDCA}</div></div>
                </div>
            </div>
            <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 border border-zinc-800"><div style="height:200px;"><canvas id="popChart"></canvas></div></div></div>
            <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
                <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
                <table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Entry/Live</th><th>PnL (ROI%)</th></tr></thead>
                <tbody>\${pends.map(p => \`<tr><td class="font-bold">\${p.symbol} <span class="\${p.type==='LONG'?'up':'down'}">\${p.type}</span></td><td>\${p.dcaCount}</td><td>\${fPrice(p.avgPrice)}<br>\${fPrice(lastRaw.allPrices[p.symbol]||0)}</td><td class="up font-bold">\${unPnl.toFixed(2)}</td></tr>\`).join('')}</tbody></table>
            </div></div>
            <div class="px-4 mt-5 pb-20"><div class="bg-card rounded-xl p-4">
                <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
                <table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>MaxDD</th><th>PnL Net</th></tr></thead>
                <tbody>\${hists.slice(-10).reverse().map(h => \`<tr><td>\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td class="font-bold">\${h.symbol}</td><td class="text-yellow-500">\${h.dcaCount}</td><td class="down font-bold">\${h.maxNegativeRoi.toFixed(1)}%</td><td class="up font-bold">+\${h.pnlPercent.toFixed(2)}%</td></tr>\`).join('')}</tbody></table>
            </div></div>\`;
        
        const ctx = document.getElementById('popChart').getContext('2d');
        new Chart(ctx, { type: 'line', data: { labels: chartLabels, datasets: [{ data: chartData, borderColor: '#0ecb81', fill: true, backgroundColor: 'rgba(14,203,129,0.1)', pointRadius: 0 }] }, options: { maintainAspectRatio: false, animation: false, scales: { x: { display: false }, y: { grid: { color: '#2b3139' } } }, plugins: { legend: { display: false } } } });
    }

    if(state.running) { document.getElementById('setup').classList.add('hidden'); document.getElementById('master').classList.remove('hidden'); setInterval(update, 1000); fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs))); }
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Binance Multi-Original Running: http://localhost:${PORT}/gui`); });
