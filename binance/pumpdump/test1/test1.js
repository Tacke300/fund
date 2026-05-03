const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

async function bootstrapData() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 100); 
        for (let t of usdtPairs) {
            const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=30`);
            const kData = await kRes.json();
            if(!coinData[t.symbol]) coinData[t.symbol] = { symbol: t.symbol, prices: [] };
            coinData[t.symbol].prices = kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }));
        }
    } catch (e) {}
}

async function fallbackAPI() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const data = await res.json();
        const now = Date.now();
        data.forEach(t => { if(t.symbol.endsWith('USDT')) handlePriceUpdate(t.symbol, parseFloat(t.price), now); });
    } catch (e) {}
    setTimeout(fallbackAPI, 3000);
}

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

function handlePriceUpdate(s, p, now) {
    if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
    coinData[s].prices.push({ p, t: now });
    if (coinData[s].prices.length > 1000) coinData[s].prices.shift(); 

    const c1 = calculateChange(coinData[s].prices, 1), 
          c5 = calculateChange(coinData[s].prices, 5), 
          c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };
    
    const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
    if (pending) {
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
        
        if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) { 
            pending.maxNegativeRoi = currentRoi;
            pending.maxNegativeTime = now;
        }

        const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
        if (win) {
            pending.status = 'WIN'; 
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
                pending.dcaCount++;
                if (pending.dcaCount === 5) pending.type = (pending.type === 'LONG' ? 'SHORT' : 'LONG');
                pending.avgPrice = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1);
            }});
        }
    } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
        if (!actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 2, action: () => {
                const sumVol = c1 + c5 + c15;
                let type = (sumVol >= 0 ? 'LONG' : 'SHORT');
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 }, maxNegativeRoi: 0 });
            }});
        }
    }
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => handlePriceUpdate(t.s, parseFloat(t.c), now));
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol);
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([s,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; }
        .recovery-row { background-color: rgba(147, 51, 234, 0.3) !important; color: #d8b4fe !important; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom uppercase font-bold">Margin per Trade</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-3 gap-2 mt-1">
                <div><label class="text-[10px] text-gray-custom uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">Lưu cấu hình & Khởi chạy Luffy</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-right text-[10px] uppercase font-bold text-gray-custom">WIN: <span id="winCount" class="text-green-500">0</span> | LOSE: <span id="loseCount" class="text-red-500">0</span></div>
            <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP ENGINE</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div>
                <div class="text-gray-custom text-[11px] uppercase font-bold mb-1">Equity (Vốn + PnL Live)</div>
                <span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span>
                <div class="text-[11px] text-blue-400 font-bold uppercase mt-1">Khả dụng (Avail): <span id="displayAvail">0.00</span> USDT</div>
            </div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-xl p-4 border border-zinc-800" style="height: 160px;"><canvas id="balanceChart"></canvas></div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider flex items-center italic">⚡ Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>STT</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Lev</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase italic">Biến động thị trường (LIVE)</div>
        <div class="grid grid-cols-4 gap-2 text-[10px] text-center" id="liveBody"></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg mb-10">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Out</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, myChart = null;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.initialBal) document.getElementById('balanceInp').value = saved.initialBal;
    if(saved.marginVal) document.getElementById('marginInp').value = saved.marginVal;
    if(saved.tp) document.getElementById('tpInp').value = saved.tp;
    if(saved.sl) document.getElementById('slInp').value = saved.sl;
    if(saved.vol) document.getElementById('volInp').value = saved.vol;

    if(saved.running) {
        running = true;
        document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
        fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=\${saved.vol}\`);
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(state)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        const state = JSON.parse(localStorage.getItem('luffy_state') || '{}');
        let mVal = state.marginVal || "10%", mNum = parseFloat(mVal);
        let runningBal = state.initialBal || 0, unPnlTotal = 0, usedMarginTotal = 0;
        let countWin = 0, countLose = 0;
        let chartLabels = ['Start'], chartData = [runningBal];

        let histHTML = [...d.history].reverse().map((h, idx) => {
            let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
            let totalMargin = (h.dcaCount >= 5) ? (mBase * 50) : (mBase * (h.dcaCount + 1));
            let pnl = (totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001);
            runningBal += pnl; 
            if(pnl > 0) countWin++; else countLose++;
            chartLabels.push(""); chartData.push(runningBal);
            return \`<tr class="border-b border-zinc-800/30 \${h.dcaCount >= 5 ? 'recovery-row' : ''}"><td>\${d.history.length - idx}</td><td class="py-2 text-[7px]">\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}<br>\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td><td><b class="text-white">\${h.symbol}</b> <br> <span class="\${h.type==='LONG'?'up':'down'} font-bold">\${h.type}</span></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${totalMargin.toFixed(1)}</td><td>\${h.snapPrice.toFixed(4)}<br>\${h.finalPrice.toFixed(4)}</td><td class="down font-bold">\${h.maxNegativeRoi.toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right text-white">\${runningBal.toFixed(1)}</td></tr>\`;
        }).reverse().join('');

        let availNow = (runningBal - usedMarginTotal + (unPnlTotal < 0 ? unPnlTotal : 0));
        let pendingHTML = d.pending.map((h, idx) => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            // % Margin tính trên Số dư khả dụng
            let mBase = mVal.includes('%') ? (availNow * mNum / 100) : mNum;
            let totalM = (h.dcaCount >= 5) ? (mBase * 50) : (mBase * (h.dcaCount + 1));
            let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
            let pnl = totalM * roi / 100; unPnlTotal += pnl; usedMarginTotal += totalM;
            return \`<tr class="border-b border-zinc-800 \${h.dcaCount >= 5 ? 'recovery-row' : ''}"><td>\${idx+1}</td><td class="text-white font-bold">\${h.symbol} <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td>\${h.maxLev}x</td><td>\${h.snapPrice.toFixed(4)}<br><b class="text-green-400">\${lp.toFixed(4)}</b></td><td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
        }).join('');

        document.getElementById('liveBody').innerHTML = d.live.slice(0, 12).map(l => \`<div class="bg-card p-1 rounded border border-zinc-800"><div>\${l.symbol}</div><div class="\${l.c1>=0?'up':'down'} font-bold">\${l.c1}%</div></div>\`).join('');
        document.getElementById('displayBal').innerText = (runningBal + unPnlTotal).toFixed(2);
        document.getElementById('displayAvail').innerText = Math.max(0, runningBal - usedMarginTotal + (unPnlTotal < 0 ? unPnlTotal : 0)).toFixed(2);
        document.getElementById('winCount').innerText = countWin; document.getElementById('loseCount').innerText = countLose;
        document.getElementById('unPnl').innerText = unPnlTotal.toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
        document.getElementById('historyBody').innerHTML = histHTML;
        document.getElementById('pendingBody').innerHTML = pendingHTML;
        if(myChart) { myChart.data.labels = chartLabels; myChart.data.datasets[0].data = chartData; myChart.update('none'); }
    }
    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    if(running) setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    await bootstrapData(); initWS(); fallbackAPI();
    console.log(`Luffy Pro Bot: http://localhost:${PORT}/gui`); 
});
