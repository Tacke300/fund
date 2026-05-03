const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

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

// --- LOGIC XỬ LÝ ---
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
        const loss = pending.type === 'LONG' ? diffAvg <= -pending.slTarget : diffAvg >= pending.slTarget;

        if (win || loss) {
            pending.status = win ? 'WIN' : 'LOSS'; 
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
                pending.isUltimate = true; // LỆNH TÍM
                pending.tpTarget = 10; 
                pending.slTarget = 10;
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
                maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, 
                dcaCount: 0, isUltimate: false
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
    maxDCA = parseInt(req.query.maxDca);
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live ? v.live.currentPrice : 0])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0, 30)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>LUFFY PRO - AUTOMATION</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&display=swap');
        body { background: #000; color: #fff; font-family: 'Orbitron', sans-serif; overflow-x: hidden; }
        .neon-text { text-shadow: 0 0 10px #fcd535, 0 0 20px #fcd535; color: #fcd535; }
        .neon-border { border: 1px solid #fcd535; box-shadow: 0 0 15px rgba(252, 213, 53, 0.3); }
        .bg-dark-card { background: rgba(20, 20, 20, 0.95); border: 1px solid #333; }
        .up { color: #0ecb81; text-shadow: 0 0 5px #0ecb81; }
        .down { color: #f6465d; text-shadow: 0 0 5px #f6465d; }
        
        /* HIỆU ỨNG LỆNH TÍM X50 */
        @keyframes purpleFlash {
            0% { box-shadow: 0 0 5px #a020f0; background: rgba(160, 32, 240, 0.1); }
            50% { box-shadow: 0 0 30px #a020f0; background: rgba(160, 32, 240, 0.5); }
            100% { box-shadow: 0 0 5px #a020f0; background: rgba(160, 32, 240, 0.1); }
        }
        .ultimate-active { animation: purpleFlash 0.8s infinite; border: 1px solid #a020f0 !important; color: #fff !important; }
        
        input, select { background: #111 !important; border: 1px solid #444 !important; color: #fcd535 !important; font-weight: bold; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-thumb { background: #fcd535; }
    </style></head><body class="p-4">
    
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-6">
            <h1 class="text-3xl font-black italic neon-text">LUFFY <span class="text-white">PRO</span></h1>
            <div class="text-right">
                <div class="text-[10px] text-gray-500 uppercase tracking-widest">Available Balance</div>
                <div id="displayAvail" class="text-2xl font-bold text-blue-400">0.00 USDT</div>
            </div>
        </div>

        <div id="setup" class="bg-dark-card p-6 rounded-xl neon-border mb-8 grid grid-cols-2 md:grid-cols-6 gap-4">
            <input id="balanceInp" type="number" placeholder="Vốn đầu" class="p-2 rounded outline-none">
            <input id="marginInp" type="text" placeholder="Margin (10%)" class="p-2 rounded outline-none">
            <input id="tpInp" type="number" step="0.1" placeholder="TP %" class="p-2 rounded outline-none">
            <input id="slInp" type="number" step="0.1" placeholder="SL %" class="p-2 rounded outline-none">
            <input id="maxDcaInp" type="number" placeholder="Max DCA" class="p-2 rounded outline-none">
            <select id="modeInp" class="p-2 rounded outline-none">
                <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option>
            </select>
            <button onclick="start()" class="col-span-2 md:col-span-6 bg-[#fcd535] text-black font-black py-3 rounded-lg hover:opacity-80 transition">KHỞI CHẠY HỆ THỐNG LUFFY</button>
        </div>

        <div id="active" class="hidden mb-8 flex justify-between items-center bg-zinc-900 p-4 rounded-lg border-l-4 border-yellow-500">
            <div class="flex items-center gap-4">
                <div class="w-3 h-3 bg-green-500 rounded-full animate-ping"></div>
                <div class="font-bold uppercase tracking-tighter">Hệ thống đang quét tín hiệu...</div>
            </div>
            <button onclick="stop()" class="text-red-500 font-bold border border-red-500 px-4 py-1 rounded hover:bg-red-500 hover:text-white transition">STOP</button>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div class="bg-dark-card p-4 rounded-xl">
                <div class="text-xs font-bold text-blue-400 mb-4 tracking-widest uppercase">● Vị thế đang mở</div>
                <div class="overflow-x-auto"><table class="w-full text-left text-[11px]">
                    <thead><tr class="text-gray-600 border-b border-zinc-800 uppercase"><th>Pair</th><th>Side</th><th>DCA</th><th>Margin</th><th>Roi%</th><th class="text-right">PnL($)</th></tr></thead>
                    <tbody id="pendingBody"></tbody>
                </table></div>
            </div>

            <div class="bg-dark-card p-4 rounded-xl">
                <div class="text-xs font-bold text-gray-500 mb-4 tracking-widest uppercase italic">● Nhật ký giao dịch</div>
                <div class="overflow-x-auto"><table class="w-full text-left text-[10px]">
                    <thead><tr class="text-gray-600 border-b border-zinc-800 uppercase"><th>Time Out</th><th>Pair</th><th>DCA</th><th>Margin</th><th>PnL($)</th><th class="text-right">Balance</th></tr></thead>
                    <tbody id="historyBody"></tbody>
                </table></div>
            </div>
        </div>
    </div>

    <script>
    let running = false;
    const saved = JSON.parse(localStorage.getItem('luffy_v2') || '{}');
    if(saved.running) {
        running = true;
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('active').classList.remove('hidden');
        fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=6.5&mode=\${saved.mode}&maxDca=\${saved.maxDca}\`);
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, mode: document.getElementById('modeInp').value, maxDca: document.getElementById('maxDcaInp').value };
        localStorage.setItem('luffy_v2', JSON.stringify(state)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_v2')); s.running = false; localStorage.setItem('luffy_v2', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const state = JSON.parse(localStorage.getItem('luffy_v2'));
            let currentBal = state.initialBal, usedM = 0, unPnl = 0;

            let histRows = d.history.map(h => {
                let mBase = state.marginVal.includes('%') ? (currentBal * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
                let totalM = h.isUltimate ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                let pnl = totalM * (h.pnlPercent/100) * 20;
                currentBal += pnl;
                return \`<tr class="border-b border-zinc-900/50 \${h.isUltimate ? 'ultimate-active' : ''}">
                    <td class="py-2 text-gray-500">\${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td class="font-bold text-white">\${h.symbol}</td>
                    <td>\${h.dcaCount}</td>
                    <td>\${totalM.toFixed(1)}</td>
                    <td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td>
                    <td class="text-right text-yellow-500 font-bold">\${currentBal.toFixed(1)}</td>
                </tr>\`;
            });

            let pendingRows = d.pending.map(h => {
                let mBase = state.marginVal.includes('%') ? ((currentBal - usedM) * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
                let totalM = h.isUltimate ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                usedM += totalM;
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*20;
                let pnl = totalM * roi / 100; unPnl += pnl;
                return \`<tr class="border-b border-zinc-900 \${h.isUltimate ? 'ultimate-active' : ''}">
                    <td class="py-3 font-black text-white">\${h.symbol}</td>
                    <td class="\${h.type==='LONG'?'up':'down'} font-bold">\${h.type}</td>
                    <td>\${h.dcaCount}</td>
                    <td>\${totalM.toFixed(1)}</td>
                    <td class="\${roi>=0?'up':'down'} font-bold">\${roi.toFixed(1)}%</td>
                    <td class="text-right font-black \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td>
                </tr>\`;
            });

            document.getElementById('displayAvail').innerText = Math.max(0, (currentBal - usedM + (unPnl < 0 ? unPnl : 0))).toFixed(2);
            document.getElementById('pendingBody').innerHTML = pendingRows.join('');
            document.getElementById('historyBody').innerHTML = histRows.join('');
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
