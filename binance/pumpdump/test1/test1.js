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
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 80); 
        for (let t of usdtPairs) {
            const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=30`);
            const kData = await kRes.json();
            if(!coinData[t.symbol]) coinData[t.symbol] = { symbol: t.symbol, prices: [] };
            coinData[t.symbol].prices = kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }));
        }
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
        }
    } else {
        // CHỈ MỞ LỆNH KHI M1 HOẶC M5 ĐẠT VOL (M15 CHỈ ĐỂ XEM)
        const triggerVol = Math.max(Math.abs(c1), Math.abs(c5));
        if (triggerVol >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
            if (!actionQueue.find(q => q.id === s)) {
                actionQueue.push({ id: s, priority: 2, action: () => {
                    const sumDirection = c1 + c5;
                    let type = (tradeMode === 'REVERSE') ? (sumDirection >= 0 ? 'SHORT' : 'LONG') : (sumDirection >= 0 ? 'LONG' : 'SHORT');
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                        maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, 
                        snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0 
                    });
                }});
            }
        }
    }
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([s,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5))), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap');
        body { background: #000; color: #eaecef; font-family: 'Orbitron', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #111; border: 1px solid #333; border-radius: 8px; }
        .glow { text-shadow: 0 0 10px #fcd535; }
        input, select { background: #000 !important; border: 1px solid #444 !important; color: #fcd535; }
    </style></head><body>
    
    <div class="p-4 sticky top-0 z-50 bg-black border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3">
            <div><label class="text-[10px] text-gray-400 uppercase">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 w-full outline-none"></div>
            <div><label class="text-[10px] text-gray-400 uppercase">Margin per Trade (%)</label><input id="marginInp" type="text" class="p-2 w-full outline-none"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 pt-2">
                <input id="tpInp" type="number" step="0.1" placeholder="TP">
                <input id="slInp" type="number" step="0.1" placeholder="DCA">
                <input id="volInp" type="number" step="0.1" placeholder="Vol">
                <select id="modeInp"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold mt-2">KHỞI CHẠY LUFFY</button>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-gray-500 text-[10px] uppercase font-bold glow">Equity (Balance + UnPnL)</div>
                <span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span>
                <div class="text-[11px] text-blue-400 font-bold uppercase mt-1">Khả dụng (Dùng mở lệnh): <span id="displayAvail" class="text-white">0.00</span></div>
            </div>
            <div class="text-right text-[#fcd535] italic font-bold" onclick="stop()" style="cursor:pointer">STOP ENGINE</div>
        </div>
    </div>

    <!-- BẢNG BIẾN ĐỘNG LIVE (ĐÃ THÊM) -->
    <div class="px-4 mt-4">
        <div class="bg-card p-4">
            <p class="text-[10px] text-yellow-500 font-bold mb-2 uppercase italic">⚡ Market Live (M1-M5-M15)</p>
            <table class="w-full text-[10px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800"><tr><th>Symbol</th><th>Price</th><th>M1</th><th>M5</th><th>M15</th></tr></thead>
                <tbody id="liveBody"></tbody>
            </table>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card p-4">
        <div class="text-[10px] font-bold text-green-500 mb-2 uppercase italic">🔥 Active Positions</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-500 border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Vol Snap</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-4"><div class="bg-card p-4">
        <div class="text-[10px] font-bold text-gray-500 mb-2 uppercase italic">History Log</div>
        <div id="historyBody" class="text-[9px] space-y-1 h-40 overflow-y-auto font-mono"></div>
    </div></div>

    <script>
    let running = false;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.initialBal) { 
        document.getElementById('balanceInp').value = saved.initialBal;
        document.getElementById('marginInp').value = saved.marginVal;
        document.getElementById('tpInp').value = saved.tp;
        document.getElementById('slInp').value = saved.sl;
        document.getElementById('volInp').value = saved.vol;
        if(saved.running) { document.getElementById('setup').classList.add('hidden'); running = true; }
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(state)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const state = JSON.parse(localStorage.getItem('luffy_state') || '{}');
            let mVal = state.marginVal || "10%";
            let runningBal = state.initialBal || 0, unPnlTotal = 0, usedMarginTotal = 0;

            // 1. Tính toán PnL đã chốt để có Balance hiện tại
            d.history.forEach(h => {
                let mBase = mVal.includes('%') ? (runningBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                runningBal += (mBase * (h.dcaCount + 1) * 20 * (h.pnlPercent/100)) - (mBase * 0.02);
            });

            // 2. Render Biến động Market
            document.getElementById('liveBody').innerHTML = d.live.slice(0, 10).map(i => \`
                <tr class="border-b border-zinc-900">
                    <td class="py-1 font-bold">\${i.symbol}</td>
                    <td class="text-yellow-500">\${i.currentPrice}</td>
                    <td class="\${i.c1>=0?'up':'down'}">\${i.c1}%</td>
                    <td class="\${i.c5>=0?'up':'down'}">\${i.c5}%</td>
                    <td class="text-gray-600">\${i.c15}%</td>
                </tr>\`).join('');

            // 3. Render Vị thế & Tính Khả Dụng (Avail)
            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * 20;
                let mBase = mVal.includes('%') ? (runningBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                let totalM = mBase * (h.dcaCount + 1);
                unPnlTotal += (totalM * roi / 100); usedMarginTotal += totalM;
                return \`<tr><td>\${h.symbol} <span class="\${h.type=='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td>\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</td><td class="text-right \${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</td></tr>\`;
            }).join('');

            // LOGIC QUAN TRỌNG: Avail = Balance chốt - Margin treo + PnL âm (nếu có)
            let avail = runningBal - usedMarginTotal + (unPnlTotal < 0 ? unPnlTotal : 0);

            document.getElementById('displayBal').innerText = (runningBal + unPnlTotal).toFixed(2);
            document.getElementById('displayAvail').innerText = Math.max(0, avail).toFixed(2);
            document.getElementById('historyBody').innerHTML = d.history.slice(-15).reverse().map(h => 
                \`<div>[\${new Date(h.endTime).toLocaleTimeString()}] \${h.symbol} \${h.type} \${h.pnlPercent.toFixed(2)}% (V:\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15})</div>\`
            ).join('');
        } catch(e) {}
    }
    if(running) setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    await bootstrapData(); initWS();
    console.log(`Bot running: http://localhost:${PORT}/gui`); 
});

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => { if(t.s.endsWith('USDT')) handlePriceUpdate(t.s, parseFloat(t.c), now); });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}
