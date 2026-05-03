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
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW', maxDCA = 5;

// --- LOGIC GIỮ NGUYÊN BẢN GỐC ---
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
    <title>Binance Square Squad Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'Orbitron', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; box-shadow: 0 0 15px rgba(0,0,0,0.5); }
        .ultimate-row { background: rgba(160, 32, 240, 0.2) !important; color: #e0b0ff !important; border: 1px solid #a020f0 !important; animation: pulse 1s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }
        .long-text { color: #0ecb81; font-weight: bold; }
        .short-text { color: #f6465d; font-weight: bold; }
    </style></head><body class="p-4">
    
    <div id="setup" class="bg-card p-6 rounded-lg mb-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        <input id="balanceInp" type="number" placeholder="Vốn khởi tạo ($)" class="bg-[#0b0e11] p-3 rounded border border-zinc-700 outline-none">
        <input id="marginInp" type="text" placeholder="Margin (vd: 5%)" class="bg-[#0b0e11] p-3 rounded border border-zinc-700 outline-none">
        <input id="tpInp" type="number" step="0.1" placeholder="TP %" class="bg-[#0b0e11] p-3 rounded border border-zinc-700 outline-none">
        <input id="slInp" type="number" step="0.1" placeholder="DCA Gap %" class="bg-[#0b0e11] p-3 rounded border border-zinc-700 outline-none">
        <input id="maxDcaInp" type="number" placeholder="Max DCA" class="bg-[#0b0e11] p-3 rounded border border-zinc-700 outline-none text-blue-400">
        <select id="modeInp" class="bg-[#0b0e11] p-3 rounded border border-zinc-700 outline-none">
            <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option>
        </select>
        <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black font-bold py-3 rounded-lg uppercase shadow-[0_0_10px_#fcd535]">Kích Hoạt Bot</button>
    </div>

    <div id="active" class="hidden flex justify-between items-center mb-6 px-2">
        <div class="text-2xl font-bold tracking-tighter">BINANCE <span class="text-[#fcd535]">SQUAD BOT</span></div>
        <button onclick="stop()" class="text-red-500 border border-red-500 px-4 py-1 rounded text-xs font-bold">DỪNG BOT</button>
    </div>

    <div class="grid grid-cols-2 gap-4 mb-6">
        <div class="bg-card p-4 rounded-lg border-l-4 border-blue-500">
            <div class="text-gray-500 text-[10px] uppercase font-bold">Số dư Khả dụng (Available)</div>
            <div id="displayAvail" class="text-3xl font-bold text-blue-400">0.00</div>
        </div>
        <div class="bg-card p-4 rounded-lg border-r-4 border-yellow-500 text-right">
            <div class="text-gray-500 text-[10px] uppercase font-bold">PnL Đang Chạy</div>
            <div id="unPnl" class="text-3xl font-bold">0.00</div>
        </div>
    </div>

    <div class="bg-card rounded-lg overflow-hidden mb-6">
        <div class="bg-[#2b3139] px-4 py-2 text-xs font-bold uppercase italic">Vị thế đang mở</div>
        <table class="w-full text-sm text-left">
            <thead class="text-gray-500 border-b border-zinc-800"><tr class="text-[10px]">
                <th class="p-3">Cặp tiền</th><th class="p-3">Side</th><th class="p-3">DCA</th><th class="p-3">Margin</th><th class="p-3">Giá vào/Hiện tại</th><th class="p-3 text-right">PnL (%)</th>
            </tr></thead>
            <tbody id="pendingBody"></tbody>
        </table>
    </div>

    <div class="bg-card rounded-lg overflow-hidden">
        <div class="bg-[#2b3139] px-4 py-2 text-xs font-bold uppercase italic">Nhật ký giao dịch</div>
        <table class="w-full text-[11px] text-left">
            <thead class="text-gray-500 border-b border-zinc-800"><tr class="text-[10px]">
                <th class="p-3">Thời gian</th><th class="p-3">Cặp tiền</th><th class="p-3">Side</th><th class="p-3">DCA</th><th class="p-3">Margin</th><th class="p-3">Lãi/Lỗ ($)</th><th class="p-3 text-right">Available</th>
            </tr></thead>
            <tbody id="historyBody"></tbody>
        </table>
    </div>

    <script>
    let running = false;
    const saved = JSON.parse(localStorage.getItem('luffy_final') || '{}');
    if(saved.running) {
        running = true;
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('active').classList.remove('hidden');
        fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=6.5&mode=\${saved.mode}&maxDca=\${saved.maxDca}\`);
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, mode: document.getElementById('modeInp').value, maxDca: document.getElementById('maxDcaInp').value };
        localStorage.setItem('luffy_final', JSON.stringify(state)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_final')); s.running = false; localStorage.setItem('luffy_final', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const state = JSON.parse(localStorage.getItem('luffy_final'));
            let currentBal = state.initialBal, usedM = 0, unPnl = 0;

            // Xử lý History & Tính Balance khả dụng (Available)
            let historyRows = d.history.reverse().map(h => {
                let mBase = state.marginVal.includes('%') ? (currentBal * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
                let totalM = h.isUltimate ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                let pnl = totalM * (h.pnlPercent/100) * 20;
                currentBal += pnl; // Balance chỉ cộng lãi lỗ thực tế
                return \`<tr class="border-b border-zinc-800/50 \${h.isUltimate ? 'ultimate-row' : ''}">
                    <td class="p-3 opacity-50">\${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td class="p-3 font-bold">\${h.symbol}</td>
                    <td class="p-3 \${h.type==='LONG'?'long-text':'short-text'}">\${h.type}</td>
                    <td class="p-3">\${h.dcaCount}</td>
                    <td class="p-3">\${totalM.toFixed(1)}</td>
                    <td class="p-3 font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td>
                    <td class="p-3 text-right font-bold text-gray-400">\${currentBal.toFixed(2)}</td>
                </tr>\`;
            }).reverse();

            // Xử lý Pending & Trừ Margin từ Available
            let pendingRows = d.pending.map(h => {
                // Tính Margin lệnh này dựa trên balance KHẢ DỤNG ngay tại thời điểm đó
                let availAtThisMoment = currentBal - usedM + (unPnl < 0 ? unPnl : 0);
                let mBase = state.marginVal.includes('%') ? (availAtThisMoment * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
                let totalM = h.isUltimate ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                
                usedM += totalM; // Đánh dấu tiền đang bị giữ
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*20;
                let pnlVal = totalM * roi / 100; unPnl += pnlVal;

                return \`<tr class="border-b border-zinc-800 \${h.isUltimate ? 'ultimate-row' : ''}">
                    <td class="p-3 font-bold">\${h.symbol}</td>
                    <td class="p-3 \${h.type==='LONG'?'long-text':'short-text'}">\${h.type}</td>
                    <td class="p-3">\${h.dcaCount}</td>
                    <td class="p-3">\${totalM.toFixed(1)}</td>
                    <td class="p-3 opacity-60">\${h.avgPrice.toFixed(4)} / \${lp.toFixed(4)}</td>
                    <td class="p-3 text-right font-bold \${roi>=0?'up':'down'}">\${pnlVal.toFixed(2)} (\${roi.toFixed(1)}%)</td>
                </tr>\`;
            });

            // Hiển thị số dư khả dụng cuối cùng (Tiền túi - Tiền đang giữ - Lỗ tạm tính)
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

app.listen(PORT, '0.0.0.0', () => { 
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => { if(t.s.endsWith('USDT')) handlePriceUpdate(t.s, parseFloat(t.c), now); });
    });
});
