const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 

// Cấu hình mặc định (Sẽ được ghi đè bởi giao diện)
let currentTP = 0.5, currentSL = 2.0, currentMinVol = 6.5;

// Khởi tạo dữ liệu
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

async function bootstrapData() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 50); 
        for (let t of usdtPairs) {
            if(!coinData[t.symbol]) coinData[t.symbol] = { symbol: t.symbol, prices: [] };
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
    if (!coinData[s]) return;
    coinData[s].prices.push({ p, t: now });
    if (coinData[s].prices.length > 500) coinData[s].prices.shift(); 

    const c1 = calculateChange(coinData[s].prices, 1), 
          c5 = calculateChange(coinData[s].prices, 5), 
          c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };
    
    const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
    
    if (pending) {
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * 20;
        
        if (currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;

        // Check Win/Loss
        const isWin = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget;
        const isLoss = pending.type === 'LONG' ? diffAvg <= -pending.slTarget : diffAvg >= pending.slTarget;

        if (isWin || (isLoss && pending.isRecovery)) {
            pending.status = isWin ? 'WIN' : 'LOSS';
            pending.finalPrice = p; pending.endTime = now;
            pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
            return;
        }

        // Logic DCA & RECOVERY (Mở ngược x50 Margin)
        const triggerDCA = pending.type === 'LONG' ? diffAvg <= -pending.slTarget : diffAvg >= pending.slTarget;
        if (triggerDCA && !pending.isRecovery) {
            if (pending.dcaCount < 3) {
                pending.dcaCount++;
                pending.avgPrice = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1);
            } else {
                // CHẠM MAX DCA -> MỞ NGƯỢC X50 MARGIN
                pending.status = 'HEDGED';
                pending.endTime = now;
                // Tạo lệnh mới ngược chiều
                const recoveryType = pending.type === 'LONG' ? 'SHORT' : 'LONG';
                historyMap.set(`${s}_${now}_REC`, {
                    symbol: s, startTime: now, snapPrice: p, avgPrice: p, 
                    type: recoveryType, status: 'PENDING', isRecovery: true, // Đánh dấu lệnh tím
                    dcaCount: 0, tpTarget: pending.tpTarget, slTarget: 1.0,
                    snapVol: { c1, c5, c15 }, maxNegativeRoi: 0
                });
            }
        }
    } else {
        if (Math.max(Math.abs(c1), Math.abs(c5)) >= currentMinVol) {
            historyMap.set(`${s}_${now}`, { 
                symbol: s, startTime: now, snapPrice: p, avgPrice: p, 
                type: c1 > 0 ? 'LONG' : 'SHORT', status: 'PENDING', isRecovery: false,
                dcaCount: 0, tpTarget: currentTP, slTarget: currentSL,
                snapVol: { c1, c5, c15 }, maxNegativeRoi: 0 
            });
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
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([s,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').slice(-50)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>LUFFY PRO x50</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700&display=swap');
        body { background: #0b0e11; color: #eaecef; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .recovery-row { background: rgba(160, 32, 240, 0.25) !important; border-left: 4px solid #a020f0 !important; }
        .recovery-text { color: #e0b0ff; font-weight: bold; }
        .orbitron { font-family: 'Orbitron', sans-serif; }
        input { background: #0b0e11 !important; border: 1px solid #474d57 !important; color: white; padding: 4px; border-radius: 4px; }
    </style></head><body class="p-4">
    
    <div id="setup" class="bg-card p-4 rounded-lg mb-6 grid grid-cols-2 md:grid-cols-5 gap-4">
        <div><label class="block text-[10px] text-gray-400">VỐN ($)</label><input id="initBal" type="number" class="w-full"></div>
        <div><label class="block text-[10px] text-gray-400">MARGIN (%)</label><input id="marginPct" type="text" class="w-full"></div>
        <div><label class="block text-[10px] text-gray-400">TP (%)</label><input id="tp" type="number" step="0.1" class="w-full"></div>
        <div><label class="block text-[10px] text-gray-400">VOL (%)</label><input id="vol" type="number" step="0.1" class="w-full"></div>
        <button onclick="run()" id="btn" class="bg-yellow-500 text-black font-bold rounded">START</button>
    </div>

    <div class="flex justify-between items-end mb-8">
        <div>
            <div class="text-gray-400 text-xs orbitron uppercase">Equity Balance</div>
            <div id="bal" class="text-5xl font-black orbitron text-white">0.00</div>
            <div class="text-blue-400 font-bold text-sm mt-1 italic">Available: <span id="avail" class="underline">0.00</span> USDT</div>
        </div>
        <div class="text-right">
            <div class="text-gray-400 text-[10px] uppercase font-bold">Unrealized PnL</div>
            <div id="pnl" class="text-2xl font-bold orbitron">0.00</div>
        </div>
    </div>

    <div class="bg-card p-4 rounded-xl mb-6">
        <div class="text-yellow-500 font-bold text-xs mb-3 italic">⚡ VỊ THẾ ĐANG CHẠY</div>
        <table class="w-full text-[11px]">
            <thead class="text-gray-500 border-b border-zinc-700 uppercase">
                <tr><th class="text-left">Pair</th><th>Side</th><th>Margin</th><th>Entry/Live</th><th>Vol Snap</th><th class="text-right">PnL (ROI%)</th></tr>
            </thead>
            <tbody id="pBody"></tbody>
        </table>
    </div>

    <div class="bg-card p-4 rounded-xl">
        <div class="text-gray-400 font-bold text-xs mb-3 italic">● NHẬT KÝ GIAO DỊCH</div>
        <table class="w-full text-[10px]">
            <thead class="text-gray-500 border-b border-zinc-700 uppercase">
                <tr><th class="text-left">Time</th><th>Pair</th><th>Side</th><th>DCA</th><th>Margin</th><th>Entry/Out</th><th>MaxDD</th><th class="text-right">Balance</th></tr>
            </thead>
            <tbody id="hBody"></tbody>
        </table>
    </div>

    <script>
        let running = false;
        const cfg = JSON.parse(localStorage.getItem('luffy_pro_v2') || '{}');
        if(cfg.active) {
            running = true; document.getElementById('btn').innerText = "STOP";
            ['initBal','marginPct','tp','vol'].forEach(k => document.getElementById(k).value = cfg[k]);
        }

        function run() {
            const newCfg = { 
                active: !running,
                initBal: document.getElementById('initBal').value,
                marginPct: document.getElementById('marginPct').value,
                tp: document.getElementById('tp').value,
                vol: document.getElementById('vol').value
            };
            localStorage.setItem('luffy_pro_v2', JSON.stringify(newCfg));
            location.reload();
        }

        async function update() {
            if(!running) return;
            const res = await fetch('/api/data'); const d = await res.json();
            const config = JSON.parse(localStorage.getItem('luffy_pro_v2'));
            
            let currentBal = parseFloat(config.initBal);
            let usedM = 0, unPnl = 0;

            // Xử lý lịch sử
            const hHtml = [...d.history].map(h => {
                let mBase = config.marginPct.includes('%') ? (currentBal * parseFloat(config.marginPct)/100) : parseFloat(config.marginPct);
                let finalM = h.isRecovery ? mBase * 50 : mBase * (h.dcaCount + 1);
                let pnl = (finalM * 20 * h.pnlPercent/100) - (finalM * 20 * 0.001);
                currentBal += pnl;
                return \`<tr class="border-b border-zinc-800/50 \${h.isRecovery?'recovery-row':''}">
                    <td class="py-2 opacity-50">\${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td class="font-bold">\${h.symbol}</td>
                    <td><span class="\${h.type==='LONG'?'up':'down'}">\${h.type} \${h.isRecovery?'(REC)':''}</span></td>
                    <td>\${h.dcaCount}</td>
                    <td>\${finalM.toFixed(1)}</td>
                    <td>\${h.snapPrice.toFixed(4)}/\${h.finalPrice.toFixed(4)}</td>
                    <td class="text-red-500">\${h.maxNegativeRoi.toFixed(1)}%</td>
                    <td class="text-right font-bold">\${currentBal.toFixed(2)}</td>
                </tr>\`;
            }).reverse().join('');

            // Xử lý vị thế đang mở
            const pHtml = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let curAvail = currentBal - usedM + (unPnl < 0 ? unPnl : 0);
                let mBase = config.marginPct.includes('%') ? (curAvail * parseFloat(config.marginPct)/100) : parseFloat(config.marginPct);
                let finalM = h.isRecovery ? mBase * 50 : mBase * (h.dcaCount + 1);
                
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * 20;
                let p = finalM * roi / 100;
                usedM += finalM; unPnl += p;

                return \`<tr class="border-b border-zinc-800 \${h.isRecovery?'recovery-row':''}">
                    <td class="py-3 font-bold">\${h.symbol}</td>
                    <td class="\${h.type==='LONG'?'up':'down'} font-bold">\${h.type}</td>
                    <td>\${finalM.toFixed(1)} \${h.isRecovery?'(x50 Margin)':''}</td>
                    <td>\${h.avgPrice.toFixed(4)} → \${lp.toFixed(4)}</td>
                    <td class="opacity-50">\${h.snapVol.c1}/\${h.snapVol.c5}</td>
                    <td class="text-right font-bold \${p>=0?'up':'down'}">\${p.toFixed(2)} (\${roi.toFixed(1)}%)</td>
                </tr>\`;
            }).join('');

            document.getElementById('bal').innerText = currentBal.toFixed(2);
            document.getElementById('avail').innerText = Math.max(0, currentBal - usedM + (unPnl < 0 ? unPnl : 0)).toFixed(2);
            document.getElementById('pnl').innerText = unPnl.toFixed(2);
            document.getElementById('pnl').className = 'text-2xl font-bold orbitron ' + (unPnl>=0?'up':'down');
            document.getElementById('hBody').innerHTML = hHtml;
            document.getElementById('pBody').innerHTML = pHtml;
        }
        setInterval(update, 1000);
    </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    await bootstrapData(); initWS();
    console.log(`Luffy Pro x50: http://localhost:${PORT}/gui`); 
});
