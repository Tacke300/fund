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

// Cấu hình mặc định
let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW', maxDCA = 5;

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- LOGIC XỬ LÝ GIÁ & DCA ---
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
        
        // Check chốt lời/lỗ
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

        // LOGIC DCA & REVERSE LẦN CUỐI
        const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
        const nextDcaThreshold = (pending.dcaCount + 1) * 2.0; // Khoảng cách DCA mỗi 2%
        const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
        
        if (triggerDCA && pending.dcaCount < maxDCA && !actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 1, action: () => {
                pending.dcaCount++;
                if (pending.dcaCount === maxDCA) {
                    // PHÁT LỆNH NGƯỢC X50 TẠI ĐÂY
                    pending.type = (pending.type === 'LONG' ? 'SHORT' : 'LONG');
                    pending.avgPrice = p;
                    pending.isUltimate = true; // Đánh dấu lệnh tím
                    pending.tpTarget = 10; // Chốt lời 10%
                    pending.slTarget = 10; // Cắt lỗ 10%
                    console.log(`[ULTIMATE] ${s} REVERSED x50!`);
                } else {
                    pending.avgPrice = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1);
                }
            }});
        }
    } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
        if (!actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 2, action: () => {
                const sumVol = c1 + c5 + c15;
                let type = (tradeMode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, 
                    dcaCount: 0, isUltimate: false
                });
            }});
        }
    }
}

// --- BOOTSTRAP & UTILS ---
function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

async function bootstrapData() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        for (let t of tickers.filter(x => x.symbol.endsWith('USDT')).slice(0, 50)) {
            coinData[t.symbol] = { symbol: t.symbol, prices: [{p: parseFloat(t.price), t: Date.now()}] };
        }
    } catch (e) {}
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); 
    currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode;
    maxDCA = parseInt(req.query.maxDca);
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live ? v.live.currentPrice : 0])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0, 50)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Binance Luffy Pro v2</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        @keyframes purpleGlow { 0% { box-shadow: 0 0 5px #8a2be2; background: rgba(138, 43, 226, 0.1); } 50% { box-shadow: 0 0 20px #8a2be2; background: rgba(138, 43, 226, 0.4); } 100% { box-shadow: 0 0 5px #8a2be2; background: rgba(138, 43, 226, 0.1); } }
        .ultimate-row { animation: purpleGlow 1s infinite; border: 1px solid #8a2be2 !important; color: #d8b4fe !important; font-family: 'Orbitron', sans-serif; }
    </style></head><body>
    
    <div class="p-4 sticky top-0 z-50 bg-[#0b0e11] border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-4 rounded-lg">
            <div class="col-span-2 grid grid-cols-5 gap-2">
                <input id="balanceInp" type="number" placeholder="Vốn $" class="bg-black p-2 rounded border border-zinc-700 outline-none text-yellow-500">
                <input id="marginInp" type="text" placeholder="Margin (10% hoặc 50)" class="bg-black p-2 rounded border border-zinc-700 outline-none">
                <input id="tpInp" type="number" step="0.1" placeholder="TP %" class="bg-black p-2 rounded border border-zinc-700 outline-none">
                <input id="slInp" type="number" step="0.1" placeholder="SL %" class="bg-black p-2 rounded border border-zinc-700 outline-none">
                <input id="maxDcaInp" type="number" placeholder="Max DCA (VD: 5)" class="bg-black p-2 rounded border border-zinc-700 outline-none text-blue-400">
            </div>
            <div class="col-span-2 grid grid-cols-2 gap-2 mt-2">
                <input id="volInp" type="number" step="0.1" placeholder="Min Vol %" class="bg-black p-2 rounded border border-zinc-700 outline-none">
                <select id="modeInp" class="bg-black p-2 rounded border border-zinc-700 outline-none">
                    <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option>
                </select>
            </div>
            <button onclick="start()" class="col-span-2 bg-yellow-500 text-black font-bold py-2 rounded">KHỞI CHẠY HỆ THỐNG</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center bg-card p-3 rounded-lg mb-4">
             <div class="font-bold text-yellow-500">LUFFY ENGINE RUNNING...</div>
             <div class="text-[10px]">AVAILABLE: <span id="displayAvail" class="text-blue-400 font-bold">0.00</span> | PENDING: <span id="pendingCount">0</span></div>
             <button onclick="stop()" class="bg-red-600 px-3 py-1 rounded text-xs">STOP</button>
        </div>
    </div>

    <div class="p-4 grid grid-cols-1 gap-6">
        <div class="bg-card rounded-lg p-4">
            <div class="text-xs font-bold text-gray-500 uppercase mb-3 italic">🔥 Vị thế đang mở</div>
            <table class="w-full text-left text-[11px]">
                <thead><tr class="text-gray-600 border-b border-zinc-800"><th>Pair</th><th>Type</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL($)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>

        <div class="bg-card rounded-lg p-4">
            <div class="text-xs font-bold text-gray-500 uppercase mb-3 italic">📜 Nhật ký giao dịch</div>
            <table class="w-full text-left text-[10px]">
                <thead><tr class="text-gray-600 border-b border-zinc-800"><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>PnL($)</th><th class="text-right">Balance</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let running = false;
    const saved = JSON.parse(localStorage.getItem('luffy_v2') || '{}');
    if(saved.running) {
        running = true;
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('active').classList.remove('hidden');
        fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=\${saved.vol}&mode=\${saved.mode}&maxDca=\${saved.maxDca}\`);
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value, maxDca: document.getElementById('maxDcaInp').value };
        localStorage.setItem('luffy_v2', JSON.stringify(state)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_v2')); s.running = false; localStorage.setItem('luffy_v2', JSON.stringify(s)); localStorage.setItem('luffy_v2', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const state = JSON.parse(localStorage.getItem('luffy_v2'));
            let runningBal = state.initialBal, usedMargin = 0, unPnl = 0;

            // Tính lịch sử để lấy Balance hiện tại
            let historyRows = d.history.map((h) => {
                let currentAvail = runningBal - usedMargin;
                let mBase = state.marginVal.includes('%') ? (currentAvail * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
                // Nếu là lệnh ultimate thì margin x50
                let totalMargin = h.isUltimate ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                let pnl = totalMargin * (h.pnlPercent/100) * 20; // x20 lev giả lập
                runningBal += pnl;
                return \`<tr class="border-b border-zinc-800/50 \${h.isUltimate ? 'ultimate-row' : ''}">
                    <td>\${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td class="font-bold">\${h.symbol}</td>
                    <td>\${h.dcaCount}</td>
                    <td>\${totalMargin.toFixed(1)}</td>
                    <td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td>
                    <td class="text-right">\${runningBal.toFixed(1)}</td>
                </tr>\`;
            });

            // Tính lệnh đang chạy
            let pendingRows = d.pending.map(h => {
                let currentAvail = runningBal - usedMargin;
                let mBase = state.marginVal.includes('%') ? (currentAvail * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
                let totalM = h.isUltimate ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                usedMargin += totalM;
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*20;
                let pnl = totalM * roi / 100; unPnl += pnl;
                return \`<tr class="border-b border-zinc-800 \${h.isUltimate ? 'ultimate-row' : ''}">
                    <td class="py-2 font-bold">\${h.symbol}</td>
                    <td class="\${h.type==='LONG'?'up':'down'}">\${h.type}</td>
                    <td>\${h.dcaCount}</td>
                    <td>\${totalM.toFixed(1)}</td>
                    <td>\${h.avgPrice.toFixed(4)}->\${lp.toFixed(4)}</td>
                    <td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td>
                </tr>\`;
            });

            document.getElementById('displayAvail').innerText = (runningBal - usedMargin + (unPnl < 0 ? unPnl : 0)).toFixed(2);
            document.getElementById('pendingBody').innerHTML = pendingRows.join('');
            document.getElementById('historyBody').innerHTML = historyRows.join('');
            document.getElementById('pendingCount').innerText = d.pending.length;
        } catch(e) {}
    }
    if(running) setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    await bootstrapData();
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => { if(t.s.endsWith('USDT') && coinData[t.s]) handlePriceUpdate(t.s, parseFloat(t.c), now); });
    });
    console.log(`Bot running: http://localhost:${PORT}/gui`); 
});
