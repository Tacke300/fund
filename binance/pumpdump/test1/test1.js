const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

// Cấu hình mặc định
let botConfig = {
    initialBal: 1000,
    marginVal: "10%",
    tp: 0.5,
    sl: 10.0,
    vol: 6.5,
    mode: 'FOLLOW',
    running: false
};

// Load dữ liệu
if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        if (!botConfig.running) return;
        const tickers = JSON.parse(data);
        const now = Date.now();
        const allPending = Array.from(historyMap.values()).filter(h => h.status === 'PENDING');

        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            const c1 = calculateChange(coinData[s].prices, 1), 
                  c5 = calculateChange(coinData[s].prices, 5), 
                  c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = allPending.find(h => h.symbol === s);
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) { 
                    pending.maxNegativeRoi = currentRoi;
                    pending.maxNegativeTime = now;
                }
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
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
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = (botConfig.mode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                        if (botConfig.mode === 'LONG_ONLY') type = 'LONG';
                        if (botConfig.mode === 'SHORT_ONLY') type = 'SHORT';
                        historyMap.set(`${s}_${now}`, { symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl, snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, maxNegativeTime: null, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }] });
                    }});
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    botConfig = { ...botConfig, ...req.query, running: req.query.running === 'true' };
    botConfig.tp = parseFloat(botConfig.tp); botConfig.sl = parseFloat(botConfig.sl); botConfig.vol = parseFloat(botConfig.vol); botConfig.initialBal = parseFloat(botConfig.initialBal);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig));
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime),
        botConfig
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
    body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
    .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
    input, select { background: #0b0e11; border: 1px solid #30363d; color: white; padding: 8px; border-radius: 4px; outline: none; }
    .recovery-row { background: rgba(75, 0, 130, 0.2); }</style></head><body>
    <div class="p-4 sticky top-0 z-50 bg-[#0b0e11] border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-400 font-bold uppercase">Vốn ($)</label><input id="balanceInp" type="number" class="w-full text-yellow-500 font-bold"></div>
            <div><label class="text-[10px] text-gray-400 font-bold uppercase">Margin Per Trade</label><input id="marginInp" type="text" class="w-full text-yellow-500 font-bold"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 pt-2 border-t border-zinc-800">
                <input id="tpInp" type="number" step="0.1" placeholder="TP">
                <input id="slInp" type="number" step="0.1" placeholder="DCA">
                <input id="volInp" type="number" step="0.1" placeholder="Vol">
                <select id="modeInp"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option><option value="LONG_ONLY">LONG ONLY</option><option value="SHORT_ONLY">SHORT ONLY</option></select>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] text-black font-bold p-2 rounded uppercase text-xs">START BOT</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold text-xl italic text-white">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-[10px] font-bold text-green-500">WIN: <span id="winCount">0</span> | PNL: <span id="winPnl">0</span></div>
            <button onclick="save(false)" class="text-[#fcd535] border border-[#fcd535] px-2 py-1 rounded text-xs font-bold">STOP</button>
        </div>
        <div class="flex justify-between items-end">
            <div><div class="text-gray-400 text-[10px] uppercase font-bold">Equity</div><div id="displayBal" class="text-4xl font-bold">0.00</div><div class="text-blue-400 text-[10px] font-bold uppercase">Avail: <span id="displayAvail">0.00</span></div></div>
            <div class="text-right"><div class="text-gray-400 text-[10px] uppercase font-bold">PnL Live</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>
    <div class="px-4 mt-4"><div class="bg-card p-4 rounded-xl" style="height:180px"><canvas id="balanceChart"></canvas></div></div>
    <div class="p-4"><div class="bg-card p-4 rounded-xl"><div class="text-[11px] font-bold mb-3 uppercase italic">Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead><tr class="text-gray-400 border-b border-zinc-800"><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>
    <div class="p-4"><div class="bg-card p-4 rounded-xl"><div class="text-[11px] font-bold mb-3 uppercase italic">Lịch sử giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead><tr class="text-gray-400 border-b border-zinc-800"><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>
    <script>
    let myChart = null, isFirst = true;
    function fPrice(p) { return parseFloat(p).toFixed(p < 1 ? 5 : 2); }
    function save(status) {
        const q = new URLSearchParams({ running: status, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value });
        fetch('/api/config?' + q.toString()).then(() => location.reload());
    }
    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        if(isFirst) {
            document.getElementById('balanceInp').value = d.botConfig.initialBal; document.getElementById('marginInp').value = d.botConfig.marginVal;
            document.getElementById('tpInp').value = d.botConfig.tp; document.getElementById('slInp').value = d.botConfig.sl;
            document.getElementById('volInp').value = d.botConfig.vol; document.getElementById('modeInp').value = d.botConfig.mode;
            if(d.botConfig.running) { document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
            isFirst = false;
        }
        let rBal = d.botConfig.initialBal, unPnl = 0, uMargin = 0, wCount = 0, wSum = 0;
        let cLab = ['Start'], cDat = [rBal];
        let hHTML = [...d.history].sort((a,b)=>a.endTime-b.endTime).map((h, i) => {
            let mB = d.botConfig.marginVal.includes('%') ? (rBal * parseFloat(d.botConfig.marginVal)/100) : parseFloat(d.botConfig.marginVal);
            let tM = mB * (h.dcaCount + 1);
            let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
            rBal += pnl; if(pnl>0){wCount++; wSum+=pnl;} cLab.push(""); cDat.push(rBal);
            return \`<tr class="border-b border-zinc-800/30"><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="down">\${h.maxNegativeRoi.toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td><td class="text-right">\${rBal.toFixed(1)}</td></tr>\`;
        }).reverse().join('');
        let pHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let mB = d.botConfig.marginVal.includes('%') ? (rBal * parseFloat(d.botConfig.marginVal)/100) : parseFloat(d.botConfig.marginVal);
            let tM = mB * (h.dcaCount + 1);
            let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
            let pnl = tM*roi/100; unPnl+=pnl; uMargin+=tM;
            return \`<tr class="border-b border-zinc-800"><td>\${h.symbol} <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td>\${fPrice(h.avgPrice)}<br>\${fPrice(lp)}</td><td class="text-right \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
        }).join('');
        let av = rBal - uMargin + (unPnl<0?unPnl:0);
        document.getElementById('displayBal').innerText = (rBal+unPnl).toFixed(2);
        document.getElementById('displayAvail').innerText = av.toFixed(2);
        document.getElementById('unPnl').innerText = unPnl.toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl>=0?'up':'down');
        document.getElementById('winCount').innerText = wCount; document.getElementById('winPnl').innerText = wSum.toFixed(2);
        document.getElementById('historyBody').innerHTML = hHTML; document.getElementById('pendingBody').innerHTML = pHTML;
        if(myChart){ myChart.data.labels = cLab; myChart.data.datasets[0].data = cDat; myChart.update('none'); }
    }
    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
