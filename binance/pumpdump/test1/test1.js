const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW', maxDCA = 5;

// --- DỮ LIỆU ---
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
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
        const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
        
        if (win || (now - pending.startTime >= MAX_HOLD_MINUTES * 60000)) {
            pending.status = win ? 'WIN' : 'TIMEOUT'; 
            pending.finalPrice = p; pending.endTime = now;
            pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
            lastTradeClosed[s] = now; 
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
            return;
        }

        const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
        const nextDcaThreshold = (pending.dcaCount + 1) * 2.0; 
        const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
        
        if (triggerDCA && pending.dcaCount < maxDCA) {
            pending.dcaCount++;
            if (pending.dcaCount === maxDCA) {
                pending.type = (pending.type === 'LONG' ? 'SHORT' : 'LONG');
                pending.avgPrice = p;
                pending.isUltimate = true;
                pending.tpTarget = 10;
            } else {
                pending.avgPrice = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1);
            }
        }
    } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol) {
        if (!(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
            const sumVol = c1 + c5 + c15;
            let type = (tradeMode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
            historyMap.set(`${s}_${now}`, { 
                symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                maxLev: 20, tpTarget: currentTP, slTarget: currentSL, dcaCount: 0, isUltimate: false
            });
        }
    }
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); 
    currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode;
    maxDCA = parseInt(req.query.maxDca) || 5;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([s,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0, 50)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>LUFFY PRO - TRADING</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .bg-long { background: rgba(14, 203, 129, 0.2); color: #0ecb81; }
        .bg-short { background: rgba(246, 70, 93, 0.2); color: #f6465d; }
        .row-win { border-left: 4px solid #0ecb81; background: rgba(14, 203, 129, 0.03); }
        .row-loss { border-left: 4px solid #f6465d; background: rgba(246, 70, 93, 0.03); }
        @keyframes purpleFlash { 0% { background: rgba(160, 32, 240, 0.1); } 50% { background: rgba(160, 32, 240, 0.4); } 100% { background: rgba(160, 32, 240, 0.1); } }
        .ultimate { animation: purpleFlash 1s infinite; border: 1px solid #a020f0 !important; color: #e0b0ff; }
        input, select { background: #0b0e11 !important; border: 1px solid #30363d !important; color: white !important; }
    </style></head><body class="p-4">
    
    <div class="max-w-6xl mx-auto">
        <div id="setup" class="bg-card p-4 rounded-lg mb-4 grid grid-cols-2 md:grid-cols-6 gap-3">
            <input id="balanceInp" type="number" placeholder="Vốn đầu ($)" class="p-2 rounded outline-none text-sm">
            <input id="marginInp" type="text" placeholder="Margin (vd: 10%)" class="p-2 rounded outline-none text-sm">
            <input id="tpInp" type="number" step="0.1" placeholder="TP %" class="p-2 rounded outline-none text-sm">
            <input id="slInp" type="number" step="0.1" placeholder="DCA %" class="p-2 rounded outline-none text-sm">
            <input id="maxDcaInp" type="number" placeholder="Max DCA" class="p-2 rounded outline-none text-sm text-blue-400">
            <select id="modeInp" class="p-2 rounded outline-none text-sm">
                <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option>
            </select>
            <button onclick="start()" class="col-span-2 md:col-span-6 bg-yellow-500 text-black font-bold py-2 rounded uppercase text-xs">Start Bot</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-6">
            <div class="text-xl font-black italic">LUFFY <span class="text-yellow-500">PRO</span></div>
            <button onclick="stop()" class="bg-red-600 px-4 py-1 rounded font-bold text-xs">STOP</button>
        </div>

        <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-card p-4 rounded-lg">
                <div class="text-gray-400 text-[10px] uppercase font-bold">Available (Sẵn sàng)</div>
                <div id="displayAvail" class="text-3xl font-bold text-blue-400">0.00</div>
            </div>
            <div class="bg-card p-4 rounded-lg text-right">
                <div class="text-gray-400 text-[10px] uppercase font-bold">PnL Live</div>
                <div id="unPnl" class="text-3xl font-bold">0.00</div>
            </div>
        </div>

        <div class="bg-card rounded-lg p-3 mb-6">
            <div class="text-xs font-bold text-yellow-500 mb-3 uppercase italic">● Vị thế đang mở</div>
            <table class="w-full text-[11px] text-left">
                <thead><tr class="text-gray-500 border-b border-zinc-800"><th>Pair</th><th>Side</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL ($/%)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>

        <div class="bg-card rounded-lg p-3">
            <div class="text-xs font-bold text-gray-500 mb-3 uppercase italic">● Nhật ký (Gần đây)</div>
            <table class="w-full text-[10px] text-left">
                <thead><tr class="text-gray-500 border-b border-zinc-800"><th>Time</th><th>Pair</th><th>Side</th><th>DCA</th><th>Margin</th><th>PnL ($)</th><th class="text-right">Available</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let running = false;
    const saved = JSON.parse(localStorage.getItem('luffy_v4') || '{}');
    if(saved.running) {
        running = true;
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('active').classList.remove('hidden');
        fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=6.5&mode=\${saved.mode}&maxDca=\${saved.maxDca}\`);
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, mode: document.getElementById('modeInp').value, maxDca: document.getElementById('maxDcaInp').value };
        localStorage.setItem('luffy_v4', JSON.stringify(state)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_v4')); s.running = false; localStorage.setItem('luffy_v4', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const state = JSON.parse(localStorage.getItem('luffy_v4'));
            let currentBal = state.initialBal, usedM = 0, unPnl = 0;

            // 1. Tính toán Nhật ký & Số dư
            let historyRows = d.history.reverse().map(h => {
                let mBase = state.marginVal.includes('%') ? (currentBal * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
                let totalM = h.isUltimate ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                let pnl = totalM * (h.pnlPercent/100) * 20;
                currentBal += pnl;
                return \`<tr class="border-b border-zinc-800/50 \${h.isUltimate ? 'ultimate' : (pnl>=0?'row-win':'row-loss')}">
                    <td class="py-2 opacity-50">\${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td class="font-bold text-white">\${h.symbol}</td>
                    <td><span class="px-2 py-0.5 rounded \${h.type==='LONG'?'bg-long':'bg-short'}">\${h.type}</span></td>
                    <td>\${h.dcaCount}</td>
                    <td>\${totalM.toFixed(1)}</td>
                    <td class="\${pnl>=0?'up':'down'} font-bold">\${pnl>=0?'+':''}\${pnl.toFixed(2)}</td>
                    <td class="text-right text-white font-bold opacity-80">\${currentBal.toFixed(2)}</td>
                </tr>\`;
            }).reverse();

            // 2. Tính toán Vị thế & Available
            let pendingRows = d.pending.map(h => {
                // QUAN TRỌNG: Lấy số dư Khả dụng hiện tại để tính Margin
                let availNow = currentBal - usedM + (unPnl < 0 ? unPnl : 0);
                let mBase = state.marginVal.includes('%') ? (availNow * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
                let totalM = h.isUltimate ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                usedM += totalM;
                
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*20;
                let pnlVal = totalM * roi / 100; unPnl += pnlVal;
                
                return \`<tr class="border-b border-zinc-800 \${h.isUltimate ? 'ultimate' : ''}">
                    <td class="py-3 font-bold text-white">\${h.symbol}</td>
                    <td><span class="px-2 py-1 rounded \${h.type==='LONG'?'bg-long':'bg-short'} font-black text-[9px]">\${h.type}</span></td>
                    <td>\${h.dcaCount}</td>
                    <td>\${totalM.toFixed(1)}</td>
                    <td>\${h.avgPrice.toFixed(4)} → \${lp.toFixed(4)}</td>
                    <td class="text-right font-black \${roi>=0?'up':'down'}">\${pnlVal.toFixed(2)} (\${roi.toFixed(1)}%)</td>
                </tr>\`;
            });

            const finalAvail = currentBal - usedM + (unPnl < 0 ? unPnl : 0);
            document.getElementById('displayAvail').innerText = finalAvail.toFixed(2);
            document.getElementById('unPnl').innerText = unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-3xl font-bold ' + (unPnl>=0?'up':'down');
            document.getElementById('pendingBody').innerHTML = pendingRows.join('');
            document.getElementById('historyBody').innerHTML = historyRows.join('');
        } catch(e) {}
    }
    if(running) setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => { if(t.s.endsWith('USDT')) handlePriceUpdate(t.s, parseFloat(t.c), now); });
    });
    console.log(`Luffy Engine Start: http://localhost:${PORT}/gui`); 
});
