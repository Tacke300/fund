const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let lastTradeClosed = {}; 
let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, currentMaxDCA = 5;

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
    const start = pArr.find(i => i.t >= (Date.now() - min * 60000)) || pArr[0]; 
    return Number((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2)) || 0;
}

function handlePriceUpdate(s, p, now) {
    if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
    coinData[s].prices.push({ p: Number(p), t: now });
    if (coinData[s].prices.length > 500) coinData[s].prices.shift(); 
    
    const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };
    
    const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
    if (pending) {
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
        if (win) {
            pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
            pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
            lastTradeClosed[s] = now; 
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
            return;
        }
        const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
        const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
        if ((pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold) && !actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 1, action: () => {
                pending.dcaCount++;
                // Chạm Max DCA thì đảo chiều và x50 margin (Logic Recovery)
                if (pending.dcaCount >= currentMaxDCA) pending.type = (pending.type === 'LONG' ? 'SHORT' : 'LONG');
                pending.avgPrice = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1);
            }});
        }
    } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
        if (!actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 2, action: () => {
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT', status: 'PENDING', tpTarget: currentTP, slTarget: currentSL, dcaCount: 0 });
            }});
        }
    }
}

if (fs.existsSync(HISTORY_FILE)) { try { JSON.parse(fs.readFileSync(HISTORY_FILE)).forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h)); } catch (e) {} }

app.get('/api/config', (req, res) => {
    currentTP = Number(req.query.tp); currentSL = Number(req.query.sl); 
    currentMinVol = Number(req.query.vol); currentMaxDCA = Number(req.query.maxdca);
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s,v]) => [s, v.live?.currentPrice || 0])),
        live: Object.entries(coinData).filter(([_,v]) => v.live).map(([s,v]) => ({symbol:s, ...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)),
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=IBM+Plex+Sans:wght@400;600&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .font-ui { font-family: 'Orbitron', sans-serif; } .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .recovery-row { background-color: rgba(147, 51, 234, 0.25) !important; color: #d8b4fe !important; }
        input { background: #0b0e11; border: 1px solid #30363d; color: white; padding: 4px 8px; border-radius: 4px; outline: none; font-size: 12px; }
    </style></head><body>
    <div class="p-4 sticky top-0 bg-[#0b0e11] z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-2 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-400 uppercase">Vốn ($)</label><input id="balanceInp" type="number" class="w-full text-yellow-500 font-bold"></div>
            <div><label class="text-[10px] text-gray-400 uppercase">Margin % Avail</label><input id="marginInp" type="text" class="w-full text-yellow-500 font-bold"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2">
                <input id="tpInp" type="number" step="0.1" placeholder="TP">
                <input id="slInp" type="number" step="0.1" placeholder="DCA">
                <input id="volInp" type="number" step="0.1" placeholder="Vol">
                <input id="maxdcaInp" type="number" placeholder="MaxDCA">
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold font-ui uppercase text-[10px]">Lưu & Chạy Bot</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4 font-ui">
            <div class="text-white italic">LUFFY <span class="text-[#fcd535]">PRO</span></div>
            <div class="text-[#fcd535] border border-[#fcd535] px-2 py-1 rounded text-[10px] cursor-pointer" onclick="stop()">STOP ENGINE</div>
        </div>
        <div class="flex justify-between items-end">
            <div><div class="text-gray-400 text-[10px] uppercase font-bold">Equity</div><div id="displayBal" class="text-3xl font-bold font-ui">0.00</div></div>
            <div class="text-right"><div class="text-gray-400 text-[10px] uppercase font-bold">PnL Live</div><div id="unPnl" class="text-xl font-bold font-ui">0.00</div></div>
        </div>
        <div class="text-[10px] text-blue-400 font-bold uppercase mt-1">Available: <span id="displayAvail">0.00</span> USDT</div>
    </div>
    <div class="px-4 mt-4"><div class="bg-card rounded-xl p-3">
        <div class="text-[11px] font-bold text-white mb-2 uppercase italic tracking-wider">⚡ Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px]"><thead class="text-gray-400 uppercase border-b border-zinc-800 text-left"><tr><th>STT</th><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>
    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-3">
        <div class="text-[11px] font-bold text-gray-400 mb-2 uppercase italic">Biến động (1|5|15m)</div>
        <div id="liveBody" class="grid grid-cols-2 gap-2"></div>
    </div></div>
    <div class="px-4 mt-5 mb-10"><div class="bg-card rounded-xl p-3">
        <div class="text-[11px] font-bold text-gray-400 mb-2 uppercase italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-400 border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Pair</th><th>DCA</th><th>Margin</th><th>PnL Net</th><th class="text-right">Available</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>
    <script>
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.running) { 
        document.getElementById('setup').classList.add('hidden'); 
        document.getElementById('active').classList.remove('hidden'); 
        fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=\${saved.vol}&maxdca=\${saved.maxdca}\`);
    }
    ['balanceInp','marginInp','tpInp','slInp','volInp','maxdcaInp'].forEach(id => { 
        const key = id.replace('Inp','');
        if(saved[key]) document.getElementById(id).value = saved[key]; 
    });

    function start() {
        const s = { running: true, initialBal: Number(document.getElementById('balanceInp').value)||0, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, maxdca: document.getElementById('maxdcaInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        const state = JSON.parse(localStorage.getItem('luffy_state') || '{}');
        let curAvail = Number(state.initialBal) || 0, unPnl = 0, usedM = 0;
        let mVal = state.marginVal || "10%", mNum = parseFloat(mVal), maxDCA = Number(state.maxdca) || 5;

        let histHTML = [...d.history].reverse().map((h, i) => {
            let mb = mVal.includes('%') ? (curAvail * mNum / 100) : mNum;
            let tm = (h.dcaCount >= maxDCA ? mb * 50 : mb * (h.dcaCount + 1)) || 0;
            let pnl = (tm * 20 * (h.pnlPercent/100)) - (tm * 20 * 0.001);
            curAvail += pnl;
            return \`<tr class="border-b border-zinc-800/30 \${h.dcaCount >= maxDCA ? 'recovery-row' : ''}"><td>\${d.history.length-i}</td><td>\${h.symbol} <span class="\${h.pnlPercent>=0?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tm.toFixed(1)}</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right text-white">\${curAvail.toFixed(1)}</td></tr>\`;
        }).reverse().join('');

        let pendingHTML = d.pending.map((h, i) => {
            let lp = Number(d.allPrices[h.symbol]) || h.avgPrice;
            let mb = mVal.includes('%') ? (curAvail * mNum / 100) : mNum;
            let tm = h.dcaCount >= maxDCA ? mb * 50 : mb * (h.dcaCount + 1);
            let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 2000;
            let p = tm * roi / 100; unPnl += p; usedM += tm;
            return \`<tr class="border-b border-zinc-800 \${h.dcaCount >= maxDCA ? 'recovery-row' : ''}"><td>\${i+1}</td><td>\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}</td><td>\${h.symbol} <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tm.toFixed(1)}</td><td>\${lp.toFixed(4)}</td><td class="text-right \${p>=0?'up':'down'} font-bold">\${p.toFixed(2)}</td></tr>\`;
        }).join('');

        document.getElementById('displayBal').innerText = (curAvail + unPnl).toFixed(2);
        document.getElementById('displayAvail').innerText = (curAvail - usedM + (unPnl < 0 ? unPnl : 0)).toFixed(2);
        document.getElementById('unPnl').innerText = unPnl.toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold font-ui ' + (unPnl >= 0 ? 'up' : 'down');
        document.getElementById('liveBody').innerHTML = d.live.slice(0, 8).map(l => \`<div class="bg-card p-2 rounded flex justify-between items-center"><span class="text-[10px] font-bold">\${l.symbol}</span><span class="text-[9px] \${l.c1>=0?'up':'down'}">\${l.c1}|\${l.c5}|\${l.c15}</span></div>\`).join('');
        document.getElementById('historyBody').innerHTML = histHTML;
        document.getElementById('pendingBody').innerHTML = pendingHTML;
    }
    if(saved.running) setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr'); 
    ws.on('message', d => { 
        const ts = JSON.parse(d); const now = Date.now(); 
        ts.forEach(t => handlePriceUpdate(t.s, parseFloat(t.c), now)); 
    }); 
    console.log("Luffy Pro Ready at port " + PORT);
});
