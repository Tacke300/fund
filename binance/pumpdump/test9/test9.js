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

// HÀM FPRICE HUYỀN THOẠI 100% GỐC
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
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }

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

            activeConfigs.forEach(conf => {
                const tag = `${conf.vol}%-${conf.mode}`;
                const isBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                if (!isBusy && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= conf.vol) {
                    if (!actionQueue.find(q => q.id === `${s}_${tag}`)) {
                        actionQueue.push({ id: `${s}_${tag}`, priority: 2, action: () => {
                            let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
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
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy 9063 - CHỌN TẤT CẢ</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; font-size: 11px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:#0b0e11; overflow-y:auto; }
        .column-box { border-radius: 4px; padding: 6px; cursor: pointer; border: 1px solid #444; margin-bottom: 5px; transition: 0.2s; }
        .column-box:hover { border-color: #fcd535; background: #2b3139; }
        .item-conf { border: 1px solid #333; text-align: center; padding: 4px 0; cursor: pointer; border-radius: 2px; font-size: 9px; }
        .item-conf.active { background: #fcd535; color: black; font-weight: bold; border-color: #fcd535; }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-2 rounded border border-yellow-500/50 shadow-2xl">
        <h1 class="text-yellow-500 font-bold mb-4 text-center text-lg">CẤU HÌNH ĐA LUỒNG 9063</h1>
        <div class="grid grid-cols-4 gap-2 mb-4">
            <div><label class="text-[9px] text-gray-500">VỐN ($)</label><input id="balInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500"></div>
            <div><label class="text-[9px] text-gray-500">MARGIN (%)</label><input id="marInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500"></div>
            <div><label class="text-[9px] text-gray-500">TP (%)</label><input id="tpInp" type="number" step="0.1" value="0.5" class="bg-black border border-zinc-700 p-2 rounded w-full"></div>
            <div><label class="text-[9px] text-gray-500">SL/DCA (%)</label><input id="slInp" type="number" step="0.1" value="10.0" class="bg-black border border-zinc-700 p-2 rounded w-full"></div>
        </div>
        
        <div class="flex justify-between items-center mb-2">
            <span class="text-gray-400 font-bold italic">BẢNG CHỌN LUỒNG (1-10%):</span>
            <div class="flex gap-2">
                <button onclick="selectAll()" class="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded font-black text-[10px] text-white shadow-lg">CHỌN TẤT CẢ LUỒNG</button>
                <button onclick="clearAll()" class="bg-zinc-700 hover:bg-zinc-600 px-4 py-1.5 rounded font-black text-[10px] text-white">XÓA HẾT</button>
            </div>
        </div>

        <div id="grid" class="grid grid-cols-10 gap-1 mb-6"></div>
        
        <button onclick="start()" class="w-full bg-[#fcd535] hover:bg-[#ffe066] text-black py-4 rounded-xl font-black uppercase text-base shadow-xl transform active:scale-95 transition-all">KÍCH HOẠT ĐỘNG CƠ LUFFY</button>
    </div>

    <div id="master" class="hidden p-2">
        <div class="flex justify-between items-center mb-4 px-2 border-b border-zinc-800 pb-2">
            <div class="text-xl font-black italic">BINANCE <span class="text-yellow-500">LUFFY 9063</span></div>
            <div class="flex gap-8 items-center">
                <div class="text-right"><div class="text-gray-500 text-[10px]">EQUITY TỔNG</div><span id="gEq" class="text-xl text-white font-bold">0.00</span></div>
                <button onclick="stop()" class="bg-red-600 hover:bg-red-500 px-6 py-2 rounded font-black text-white shadow-lg">STOP ALL</button>
            </div>
        </div>
        <div class="grid grid-cols-4 gap-2">
            <div id="col-LONG"></div><div id="col-SHORT"></div><div id="col-FOLLOW"></div><div id="col-REVERSE"></div>
        </div>
    </div>

    <div id="popup" class="modal"><div id="popContent" class="relative"></div></div>

    <script>
    let state = JSON.parse(localStorage.getItem('luffy_9063') || '{}'), lastRaw = null;
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'], gridEl = document.getElementById('grid');
    
    // RENDER GRID CHỌN CẤU HÌNH
    for(let v=1; v<=10; v++) { modes.forEach(m => { 
        const d = document.createElement('div'); d.className = 'item-conf'; d.innerText = v+'%-'+m; 
        d.onclick = () => d.classList.toggle('active'); gridEl.appendChild(d); 
    });}

    function selectAll() { document.querySelectorAll('.item-conf').forEach(el => el.classList.add('active')); }
    function clearAll() { document.querySelectorAll('.item-conf').forEach(el => el.classList.remove('active')); }
    function fPrice(p) { if (!p || p === 0) return "0.0000"; let s = p.toFixed(20); let m = s.match(/^-?\\d+\\.0*[1-9]/); if (!m) return p.toFixed(4); let i = m[0].length; return parseFloat(p).toFixed(i - m[0].indexOf('.') + 3); }

    function start() {
        const configs = []; document.querySelectorAll('#grid .active').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
        if(configs.length === 0) return alert('Chưa chọn cấu hình nào dmm!');
        localStorage.setItem('luffy_9063', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balInp').value), margin: document.getElementById('marInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }
    function stop() { if(confirm('Dừng toàn bộ hệ thống?')) { state.running = false; localStorage.setItem('luffy_9063', JSON.stringify(state)); location.reload(); } }

    async function update() {
        if(!state.running) return;
        const res = await fetch('/api/data'); lastRaw = await res.json();
        let tEq = 0;
        modes.forEach(m => { document.getElementById('col-'+m).innerHTML = '<div class="text-center font-bold mb-2 py-1 bg-zinc-900 border border-zinc-700 text-yellow-500 rounded uppercase tracking-widest">'+m+'</div>'; });

        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            let bal = state.initialBal, winSum = 0, uPnl = 0;
            const hists = lastRaw.allData.filter(h => h.confTag === tag && h.status !== 'PENDING');
            const pends = lastRaw.allData.filter(h => h.confTag === tag && h.status === 'PENDING');
            
            hists.forEach(h => {
                let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
                bal += (m * (h.dcaCount + 1) * 20 * (h.pnlPercent/100)) - (m * (h.dcaCount + 1) * 20 * 0.001);
                if(h.pnlPercent >= 0) winSum += (m * (h.dcaCount + 1) * 20 * (h.pnlPercent/100));
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
                <div class="flex justify-between border-b border-zinc-800 pb-1 mb-1"><b class="text-yellow-500">\${tag}</b> <span class="\${uPnl>=0?'up':'down'} font-bold">ROI: \${uPnl.toFixed(1)}</span></div>
                <div class="grid grid-cols-2 text-[9px] text-gray-400 mb-1">
                    <div>P.Win: <b class="text-white">\${winSum.toFixed(1)}</b></div><div>Vị thế: <b class="text-yellow-500">\${pends.length}</b></div>
                </div>
                <div class="bg-black/40 p-1 rounded border border-zinc-800/50">\${pends.map(p => \`<div class="flex justify-between text-[8px] italic"><span class="text-zinc-300">\${p.symbol}</span><span class="up">DCA \${p.dcaCount}</span></div>\`).join('') || '<div class="text-zinc-600 text-center py-1">Đang quét...</div>'}</div>
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
        let coinStats = {};

        hists.forEach((h, i) => {
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            let net = (m * (h.dcaCount+1) * 20 * (h.pnlPercent/100)) - (m * (h.dcaCount+1) * 20 * 0.001);
            bal += net; if(net>=0){ winSum+=net; winCount++; } totalDCA += h.dcaCount;
            chartLabels.push(i); chartData.push(bal);
            if(!coinStats[h.symbol]) coinStats[h.symbol] = { lev: h.maxLev, count: 0, dcas: 0, pnlW: 0, pnlHist: 0, livePnl: 0 };
            coinStats[h.symbol].count++; coinStats[h.symbol].dcas += h.dcaCount; coinStats[h.symbol].pnlHist += net; if(net>=0) coinStats[h.symbol].pnlW += net;
        });

        pends.forEach(p => {
            let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
            let m = state.margin.includes('%') ? (bal * parseFloat(state.margin)/100) : parseFloat(state.margin);
            let pnl = (m * (p.dcaCount+1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
            unPnl += pnl;
            if(!coinStats[p.symbol]) coinStats[p.symbol] = { lev: p.maxLev, count: 0, dcas: 0, pnlW: 0, pnlHist: 0, livePnl: 0 };
            coinStats[p.symbol].livePnl += pnl;
        });

        // 100% NỘI DUNG BẢN GỐC ĐÚNG Ý ÔNG
        document.getElementById('popContent').innerHTML = \`
            <div class="p-6 bg-[#0b0e11] min-h-screen">
                <button onclick="document.getElementById('popup').style.display='none'" class="fixed top-4 right-6 text-5xl text-gray-500 hover:text-white transition-all">&times;</button>
                <div class="font-black italic text-white text-2xl mb-6 tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span> <span class="text-xs bg-zinc-800 px-3 py-1 rounded-full ml-3 text-zinc-400 not-italic font-bold tracking-normal">\${tag}</span></div>
                
                <div class="grid grid-cols-2 gap-4 mb-6">
                    <div class="bg-card p-5 rounded-xl border border-zinc-800 shadow-lg">
                        <div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Live)</div>
                        <div class="text-4xl font-bold text-white tracking-tighter">\${(bal+unPnl).toFixed(2)} <span class="text-sm text-zinc-600 font-normal">USDT</span></div>
                    </div>
                    <div class="bg-card p-5 rounded-xl border border-zinc-800 text-right shadow-lg">
                        <div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div>
                        <div class="text-2xl font-bold \${unPnl>=0?'up':'down'} tracking-tighter">\${unPnl >= 0 ? '+' : ''}\${unPnl.toFixed(2)}</div>
                    </div>
                </div>

                <div class="grid grid-cols-3 gap-3 mb-6 text-center">
                    <div class="bg-card p-4 rounded-xl border border-zinc-800"><div class="text-[9px] text-gray-500 uppercase font-bold">Lệnh Win</div><div class="text-2xl font-bold text-green-400">\${winCount}</div></div>
                    <div class="bg-card p-4 rounded-xl border border-zinc-800"><div class="text-[9px] text-gray-500 uppercase font-bold">PnL Win ($)</div><div class="text-2xl font-bold text-white">\${winSum.toFixed(2)}</div></div>
                    <div class="bg-card p-4 rounded-xl border border-zinc-800"><div class="text-[9px] text-gray-500 uppercase font-bold">Tổng DCA</div><div class="text-2xl font-bold text-yellow-500">\${totalDCA}</div></div>
                </div>

                <div class="bg-card p-5 rounded-xl border border-zinc-800 mb-6">
                    <div class="text-[11px] font-bold text-gray-500 uppercase tracking-widest italic mb-3">Growth Curve (Real-time)</div>
                    <div style="height:220px;"><canvas id="popChart"></canvas></div>
                </div>
                
                <div class="bg-card p-5 rounded-xl border border-zinc-800 mb-6 shadow-xl">
                    <div class="text-[11px] font-bold text-white mb-4 uppercase tracking-widest flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
                    <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead><tr class="text-gray-500 border-b border-zinc-800 pb-2"><th>Pair</th><th>DCA</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                    <tbody class="divide-y divide-zinc-800/50">\${pends.map(p => \`<tr><td class="py-3"><b class="text-white text-sm">\${p.symbol}</b> <span class="px-1.5 py-0.5 rounded text-[8px] font-black \${p.type==='LONG'?'bg-green-900/40 text-green-400':'bg-red-900/40 text-red-400'} ml-1">\${p.type}</span></td><td class="text-yellow-500 font-bold">\${p.dcaCount}</td><td>\${fPrice(p.snapPrice)}<br><b class="text-green-400">\${fPrice(lastRaw.allPrices[p.symbol]||0)}</b></td><td class="text-yellow-500 font-bold">\${fPrice(p.avgPrice)}</td><td class="text-right font-bold \${unPnl>=0?'up':'down'}">\${unPnl.toFixed(2)}<br>ROI%</td></tr>\`).join('')}</tbody></table></div>
                </div>

                <div class="bg-card p-5 rounded-xl border border-zinc-800 mb-6">
                    <div class="text-[11px] font-bold text-gray-500 mb-4 uppercase tracking-widest italic">Nhật ký giao dịch (8 lệnh gần nhất)</div>
                    <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead><tr class="text-gray-600 border-b border-zinc-800"><th>Time</th><th>Pair</th><th>DCA</th><th>Entry/Out</th><th>PnL Net</th></tr></thead>
                    <tbody class="divide-y divide-zinc-800/30">\${hists.slice(-8).reverse().map(h => \`<tr><td class="py-2 text-zinc-500">\${new Date(h.endTime).toLocaleTimeString()}</td><td class="font-bold text-white">\${h.symbol}</td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${fPrice(h.snapPrice)}<br><b class="text-zinc-300">\${fPrice(h.finalPrice)}</b></td><td class="up font-bold">+\${h.pnlPercent.toFixed(2)}%</td></tr>\`).join('')}</tbody></table></div>
                </div>

                <div class="bg-card rounded-xl p-5 border border-yellow-500/10 mb-20 shadow-2xl">
                    <div class="text-yellow-500 font-bold mb-4 uppercase italic text-[10px] tracking-widest">Hiệu suất chi tiết theo Coin</div>
                    <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead><tr class="text-gray-600 border-b border-zinc-800"><th>Coin</th><th>Lệnh</th><th>DCA</th><th>PnL Lịch Sử</th><th class="text-right">Tổng PnL</th></tr></thead>
                    <tbody class="divide-y divide-zinc-800/30">\${Object.entries(coinStats).map(([sym, s]) => \`<tr><td class="py-2 text-white font-bold">\${sym}</td><td>\${s.count}</td><td class="text-yellow-500">\${s.dcas}</td><td class="\${s.pnlHist>=0?'up':'down'} font-bold">\${s.pnlHist.toFixed(2)}</td><td class="text-right font-bold \${(s.pnlHist+s.livePnl)>=0?'up':'down'}">\${(s.pnlHist+s.livePnl).toFixed(2)}</td></tr>\`).join('')}</tbody></table></div>
                </div>
            </div>\`;
        
        const ctx = document.getElementById('popChart').getContext('2d');
        new Chart(ctx, { type: 'line', data: { labels: chartLabels, datasets: [{ data: chartData, borderColor: '#0ecb81', fill: true, backgroundColor: 'rgba(14,203,129,0.05)', pointRadius: 0, borderWidth: 2, tension: 0.2 }] }, options: { maintainAspectRatio: false, animation: false, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#555', font: { size: 9 } } } }, plugins: { legend: { display: false } } } });
    }

    if(state.running) { document.getElementById('setup').classList.add('hidden'); document.getElementById('master').classList.remove('hidden'); setInterval(update, 1000); fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs))); }
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Engine Luffy Running: http://localhost:${PORT}/gui`); });
