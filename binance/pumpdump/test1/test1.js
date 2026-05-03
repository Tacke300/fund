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

// --- LOGIC XỬ LÝ DỮ LIỆU & BIẾN ĐỘNG ---
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
        
        // Check Win/Loss
        const isWin = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget;
        const isLoss = pending.type === 'LONG' ? diffAvg <= -pending.slTarget : diffAvg >= pending.slTarget;

        if (isWin || isLoss) {
            pending.status = isWin ? 'WIN' : 'LOSS';
            pending.finalPrice = p;
            pending.endTime = now;
            pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
            lastTradeClosed[s] = now;
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
        }
    } else {
        // CHỈ MỞ LỆNH KHI M1 HOẶC M5 ĐẠT VOL
        const triggerVol = Math.max(Math.abs(c1), Math.abs(c5));
        if (triggerVol >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
            const sumVol = c1 + c5;
            let type = (tradeMode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
            historyMap.set(`${s}_${now}`, { 
                symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, 
                snapVol: { c1, c5, c15 }, dcaCount: 0 
            });
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

// --- GIAO DIỆN CHÍNH ---
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
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade (%)</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <input id="tpInp" type="number" step="0.1" class="p-2 rounded w-full" placeholder="TP">
                <input id="slInp" type="number" step="0.1" class="p-2 rounded w-full" placeholder="DCA">
                <input id="volInp" type="number" step="0.1" class="p-2 rounded w-full" placeholder="Vol">
                <select id="modeInp" class="p-2 rounded w-full"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold uppercase text-xs mt-2">Lưu & Khởi chạy</button>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div>
                <div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Vốn + PnL Live)</div>
                <span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span>
                <div class="text-[11px] text-blue-400 font-bold uppercase mt-1 italic underline">Available (Sẵn sàng): <span id="displayAvail">0.00</span> USDT</div>
            </div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <!-- BẢNG BIẾN ĐỘNG GIỐNG BẢN GỐC -->
    <div class="px-4 mt-5">
        <div class="bg-card rounded-xl p-4 shadow-lg border border-zinc-800">
            <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase tracking-wider italic">⚡ Market Movement (M1-M5-M15)</div>
            <div class="overflow-x-auto">
                <table class="w-full text-[10px] text-left">
                    <thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>Pair</th><th>Price</th><th>M1</th><th>M5</th><th>M15</th></tr></thead>
                    <tbody id="liveBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <div class="px-4 mt-5">
        <div class="bg-card rounded-xl p-4 border border-zinc-800"><div style="height: 180px;"><canvas id="balanceChart"></canvas></div></div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
        <table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>STT</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th>Vol Snap</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg overflow-hidden">
         <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic ml-1">Nhật ký giao dịch</div>
         <div class="overflow-y-auto max-h-60">
            <table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase sticky top-0 bg-[#1e2329]"><tr><th>STT</th><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Out</th><th>Vol Snap</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table>
         </div>
    </div></div>

    <script>
    let myChart = null;
    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(state)); location.reload();
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const cfg = JSON.parse(localStorage.getItem('luffy_state') || '{}');
            if(!cfg.running) return;

            let runningBal = parseFloat(cfg.initialBal || 0);
            let unPnlTotal = 0, usedMarginTotal = 0;

            // 1. Biến động Market
            document.getElementById('liveBody').innerHTML = d.live.slice(0, 10).map(i => \`
                <tr class="border-b border-zinc-800/30">
                    <td class="py-2 text-white font-bold">\${i.symbol}</td>
                    <td class="text-yellow-500">\${i.currentPrice}</td>
                    <td class="\${i.c1>=0?'up':'down'} font-bold">\${i.c1}%</td>
                    <td class="\${i.c5>=0?'up':'down'} font-bold">\${i.c5}%</td>
                    <td class="text-gray-600">\${i.c15}%</td>
                </tr>\`).join('');

            // 2. Lịch sử & Balance
            d.history.forEach(h => {
                let mBase = cfg.marginVal.includes('%') ? (runningBal * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
                runningBal += (mBase * (h.dcaCount + 1) * 20 * (h.pnlPercent/100));
            });

            // 3. Vị thế & Available
            document.getElementById('pendingBody').innerHTML = d.pending.map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * 20;
                let mBase = cfg.marginVal.includes('%') ? (runningBal * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
                let totalM = mBase * (h.dcaCount + 1);
                unPnlTotal += (totalM * roi / 100); usedMarginTotal += totalM;
                return \`<tr class="border-b border-zinc-800/50"><td>\${idx+1}</td><td class="font-bold">\${h.symbol} <span class="\${h.type=='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td>\${h.avgPrice}/<span class="text-green-400">\${lp}</span></td><td>\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</td><td class="text-right \${roi>=0?'up':'down'} font-bold">\${roi.toFixed(2)}%</td></tr>\`;
            }).join('');

            let avail = runningBal - usedMarginTotal + (unPnlTotal < 0 ? unPnlTotal : 0);
            document.getElementById('displayBal').innerText = (runningBal + unPnlTotal).toFixed(2);
            document.getElementById('displayAvail').innerText = Math.max(0, avail).toFixed(2);
            document.getElementById('unPnl').innerText = (unPnlTotal >= 0 ? '+' : '') + unPnlTotal.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
            
            document.getElementById('historyBody').innerHTML = d.history.slice(-30).reverse().map((h, idx) => 
                \`<tr class="border-b border-zinc-800/30"><td>\${idx+1}</td><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td class="font-bold">\${h.symbol}</td><td>\${h.dcaCount}</td><td>Margin</td><td>\${h.avgPrice}</td><td>\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</td><td class="text-right">\${runningBal.toFixed(1)}</td></tr>\`
            ).join('');
        } catch(e) {}
    }

    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.initialBal) { 
        document.getElementById('balanceInp').value = saved.initialBal;
        document.getElementById('marginInp').value = saved.marginVal;
        document.getElementById('tpInp').value = saved.tp;
        document.getElementById('slInp').value = saved.sl;
        document.getElementById('volInp').value = saved.vol;
        if(saved.running) { document.getElementById('setup').classList.add('hidden'); setInterval(update, 1000); }
    }
    </script></body></html>`);
});

// --- KHOỞI TẠO SERVER ---
async function bootstrap() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 100);
        for (let t of usdtPairs) {
            const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=30`);
            const kData = await kRes.json();
            coinData[t.symbol] = { symbol: t.symbol, prices: kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) })) };
        }
    } catch (e) {}
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => { if(t.s.endsWith('USDT')) handlePriceUpdate(t.s, parseFloat(t.c), now); });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.listen(PORT, '0.0.0.0', async () => { 
    await bootstrap(); initWS();
    console.log(`Luffy Bot Ready: http://localhost:${PORT}/gui`); 
});
