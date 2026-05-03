const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const COOLDOWN_MINUTES = 15;

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

// --- LOGIC TÍNH BIẾN ĐỘNG ---
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

    const c1 = calculateChange(coinData[s].prices, 1);
    const c5 = calculateChange(coinData[s].prices, 5);
    const c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };
    
    const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
    
    if (pending) {
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
        if (win) {
            pending.status = 'WIN'; 
            pending.finalPrice = p; pending.endTime = now;
            pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
            lastTradeClosed[s] = now; 
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
        }
    } else {
        // CHỈ MỞ LỆNH THEO M1 VÀ M5
        const triggerValue = Math.max(Math.abs(c1), Math.abs(c5));
        if (triggerValue >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
            const type = (c1 + c5 >= 0) ? (tradeMode === 'REVERSE' ? 'SHORT' : 'LONG') : (tradeMode === 'REVERSE' ? 'LONG' : 'SHORT');
            historyMap.set(`${s}_${now}`, { 
                symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                tpTarget: currentTP, snapVol: { c1, c5, c15 }, dcaCount: 0 
            });
        }
    }
}

// --- API DATA ---
app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([_,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5))), 
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING')
    });
});

// --- GIAO DIỆN GỐC (GIỮ NGUYÊN STYLE CỦA BẠN) ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap');
        body { background-color: #000; color: #fff; font-family: 'Orbitron', sans-serif; }
        .glow { text-shadow: 0 0 10px #fcd535, 0 0 20px #fcd535; }
        .card { background: rgba(20, 20, 20, 0.9); border: 1px solid #333; border-radius: 8px; padding: 15px; box-shadow: 0 0 15px rgba(0,0,0,0.5); }
        .up { color: #00ff00; } .down { color: #ff0000; }
        input { background: #111 !important; border: 1px solid #444 !important; color: #fcd535 !important; padding: 4px 8px; border-radius: 4px; }
    </style></head>
    <body class="p-4">
    
    <div class="card mb-4 border-yellow-900/50">
        <h1 class="text-xl font-bold glow italic text-[#fcd535] mb-4">LUFFY PRO READY</h1>
        <div class="grid grid-cols-2 gap-4">
            <div>
                <p class="text-gray-500 text-[10px] uppercase">Equity (Vốn + PnL)</p>
                <p id="displayBal" class="text-2xl font-bold">0.00</p>
                <p class="text-[10px] text-blue-400 mt-1 uppercase font-bold">Available: <span id="displayAvail" class="text-white">0.00</span></p>
            </div>
            <div class="text-right">
                <p class="text-gray-500 text-[10px] uppercase">PnL Live</p>
                <p id="unPnl" class="text-xl font-bold">0.00</p>
            </div>
        </div>
    </div>

    <!-- BẢNG BIẾN ĐỘNG TRÊN HTML -->
    <div class="card mb-4 border-zinc-800">
        <p class="text-[10px] font-bold text-yellow-500 mb-3 uppercase tracking-widest italic">⚡ Market Movements (M1/M5)</p>
        <table class="w-full text-[11px] text-left">
            <thead><tr class="text-gray-600 border-b border-zinc-800"><th class="pb-2">Symbol</th><th class="pb-2">Price</th><th class="pb-2">M1</th><th class="pb-2">M5</th><th class="pb-2">M15</th></tr></thead>
            <tbody id="liveBody"></tbody>
        </table>
    </div>

    <div class="card mb-4 border-zinc-800">
        <p class="text-[10px] font-bold text-green-500 mb-3 uppercase tracking-widest">🔥 Active Positions</p>
        <div id="pendingBody" class="space-y-3"></div>
    </div>

    <div class="card border-zinc-800">
        <p class="text-[10px] font-bold text-gray-500 mb-2 uppercase italic">Recent History</p>
        <div id="historyBody" class="text-[9px] text-gray-400 space-y-1 h-32 overflow-y-auto"></div>
    </div>

    <script>
    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const cfg = JSON.parse(localStorage.getItem('luffy_state') || '{"initialBal":0,"marginVal":"0"}');
            
            let closedBal = parseFloat(cfg.initialBal);
            let unPnlTotal = 0, lockedMargin = 0;

            // 1. Tính toán PnL đã chốt
            d.history.forEach(h => {
                let mBaseH = cfg.marginVal.includes('%') ? (closedBal * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
                closedBal += (mBaseH * (h.dcaCount + 1) * 20 * (h.pnlPercent/100)) - (mBaseH * 0.04);
            });

            // 2. Render Biến động Live (3 khung)
            document.getElementById('liveBody').innerHTML = d.live.slice(0, 8).map(i => \`
                <tr class="border-b border-zinc-900">
                    <td class="py-2 font-bold">\${i.symbol}</td>
                    <td class="text-yellow-500 font-mono">\${i.currentPrice}</td>
                    <td class="\${i.c1 >= 0 ? 'up' : 'down'} font-bold">\${i.c1}%</td>
                    <td class="\${i.c5 >= 0 ? 'up' : 'down'} font-bold">\${i.c5}%</td>
                    <td class="text-gray-600">\${i.c15}%</td>
                </tr>\`).join('');

            // 3. Render Vị thế & Tính toán Khả dụng
            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * 20;
                let mBaseP = cfg.marginVal.includes('%') ? (closedBal * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
                let totalM = mBaseP * (h.dcaCount + 1);
                unPnlTotal += (totalM * roi / 100); 
                lockedMargin += totalM;

                return \`
                <div class="flex justify-between items-center border-b border-zinc-800 pb-2">
                    <div>
                        <div class="font-bold text-sm">\${h.symbol} <span class="text-[10px] \${h.type=='LONG'?'up':'down'}">\${h.type}</span></div>
                        <div class="text-[9px] text-gray-500 font-mono">Vol Snap: \${h.snapVol.c1}% | \${h.snapVol.c5}% | \${h.snapVol.c15}%</div>
                    </div>
                    <div class="text-right">
                        <div class="\${roi>=0?'up':'down'} font-bold text-lg">\${roi.toFixed(2)}%</div>
                        <div class="text-[10px] text-yellow-600 italic font-bold">DCA: \${h.dcaCount}</div>
                    </div>
                </div>\`;
            }).join('');

            // LOGIC KHẢ DỤNG: Lấy Balance thực trừ Margin treo và cộng PnL âm (nếu có)
            let available = closedBal - lockedMargin + (unPnlTotal < 0 ? unPnlTotal : 0);

            document.getElementById('displayBal').innerText = (closedBal + unPnlTotal).toFixed(2);
            document.getElementById('displayAvail').innerText = Math.max(0, available).toFixed(2);
            document.getElementById('unPnl').innerText = unPnlTotal.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
            document.getElementById('historyBody').innerHTML = d.history.slice(-15).reverse().map(h => 
                \`<div>[\${new Date(h.endTime).toLocaleTimeString()}] \${h.symbol} \${h.type} \${h.pnlPercent.toFixed(2)}%</div>\`
            ).join('');

        } catch(e) {}
    }
    setInterval(update, 1000);
    </script></body></html>`);
});

// --- KẾT NỐI BINANCE ---
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
    await bootstrapData(); initWS();
    console.log(`Luffy Ready: http://localhost:${PORT}/gui`); 
});
