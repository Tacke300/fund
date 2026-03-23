const PORT = 9055;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const FORCE_CLOSE_MS = 10 * 60000; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 100.0, currentMinVol = 6.8;

// Hàm fix giá thông minh (Hiện ít nhất 4 số sau dãy số 0)
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

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            const c1 = calculateChange(coinData[s].prices, 1), 
                  c5 = calculateChange(coinData[s].prices, 5), 
                  c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'UP' ? diff >= pending.tpTarget : diff <= -pending.tpTarget; 
                const lose = pending.type === 'UP' ? diff <= -pending.slTarget : diff >= pending.slTarget; 
                
                if (win || lose || (now - pending.startTime >= FORCE_CLOSE_MS)) { 
                    pending.status = win ? 'WIN' : (lose ? 'LOSE' : 'TIMEOUT'); 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'UP' ? (p - pending.snapPrice)/pending.snapPrice : (pending.snapPrice - p)/pending.snapPrice) * 100;
                    
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }

            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && 
                !pending && 
                !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 }
                });
            }
        });
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
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        top5: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b)=>Math.max(Math.abs(b.c1), Math.abs(b.c5), Math.abs(b.c15)) - Math.max(Math.abs(a.c1), Math.abs(a.c5), Math.abs(a.c15))).slice(0,5),
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #2b3139; }
        .text-gray-custom { color: #848e9c; }
        /* ĐÃ XÓA HIỆU ỨNG GLOW CỦA BINANCE */
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 shadow-2xl border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-2 mb-4 bg-card p-3 rounded-xl">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn ($)</label><input id="balanceInp" type="number" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-xs"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin (%)</label><input id="marginInp" type="text" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-xs"></div>
            <div class="col-span-2 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-2 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">TP (%)</label><input id="tpInp" type="number" step="0.1" class="bg-black border border-zinc-700 p-2 rounded w-full text-white outline-none text-xs"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">SL (%)</label><input id="slInp" type="number" step="0.1" class="bg-black border border-zinc-700 p-2 rounded w-full text-white outline-none text-xs"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vol (%)</label><input id="volInp" type="number" step="0.1" class="bg-black border border-zinc-700 p-2 rounded w-full text-white outline-none text-xs"></div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-black uppercase text-xs mt-2 transition-all hover:scale-[1.01]">Lưu & Chạy</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="flex items-center">
                <div class="font-bold italic text-white text-xl uppercase tracking-tighter leading-none">BINANCE</div>
            </div>
            <div id="user-id" class="text-[#fcd535] font-black italic text-xl cursor-pointer" onclick="stop()">Monkey_D_Luffy</div>
        </div>

        <div class="grid grid-cols-3 gap-2 mb-4 text-center">
            <div class="bg-card p-2 rounded-lg border border-zinc-800"><div class="text-[8px] text-gray-custom uppercase font-bold">Win / Lose</div><div class="text-xs font-black"><span class="up" id="totalWin">0</span> / <span class="down" id="totalLose">0</span></div></div>
            <div class="bg-card p-2 rounded-lg border border-zinc-800"><div class="text-[8px] text-gray-custom uppercase font-bold">Tổng PnL Win</div><div class="text-xs font-black up" id="pnlWinSum">+0.00</div></div>
            <div class="bg-card p-2 rounded-lg border border-zinc-800"><div class="text-[8px] text-gray-custom uppercase font-bold">Tổng PnL Lose</div><div class="text-xs font-black down" id="pnlLoseSum">-0.00</div></div>
        </div>

        <div class="flex justify-between items-center mb-2 px-1">
            <div class="flex gap-4">
                <div><div class="text-gray-custom text-[9px] uppercase font-bold mb-1">Số dư khả dụng</div><span id="displayBal" class="text-3xl font-black text-white tracking-tighter">0.00</span></div>
                <div><div class="text-gray-custom text-[9px] uppercase font-bold mb-1">Số dư ký quỹ</div><span id="marginUsed" class="text-xl font-bold text-yellow-500">0.00</span></div>
            </div>
            <div class="text-right">
                <div class="text-gray-custom text-[9px] uppercase font-bold mb-1">PnL Tạm tính</div>
                <div id="unPnl" class="text-xl font-black">0.00</div>
            </div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-xl p-3 shadow-lg border border-green-500/20">
        <div class="text-[11px] font-black text-white mb-2 uppercase italic border-l-4 border-green-500 pl-2">Vị thế đang mở (Live)</div>
        <table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800 text-[8px]">
            <tr><th>Time In</th><th>Coin/Vol/Lev</th><th>Entry/Live</th><th class="text-center">Target</th><th class="text-right">PnL (ROI%)</th></tr>
        </thead><tbody id="pendingBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-4"><div class="bg-card rounded-xl p-3 shadow-lg border border-[#fcd535]/10">
         <div class="text-[11px] font-black text-[#fcd535] mb-2 uppercase italic border-l-4 border-[#fcd535] pl-2">Biến động (Top 5)</div>
         <table class="w-full text-[10px] text-left"><thead><tr class="text-gray-custom text-[9px] uppercase font-bold"><th>COIN</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-right">15M</th></tr></thead><tbody id="liveBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-4 pb-32"><div class="bg-card rounded-xl p-3 shadow-lg">
        <div class="text-[11px] font-black text-gray-custom mb-2 uppercase italic border-l-4 border-zinc-600 pl-2">Lịch sử giao dịch</div>
        <table class="w-full text-[8px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase">
            <tr><th>In / Out</th><th>Coin/Vol/Lev</th><th>Entry/Exit</th><th class="text-center">Target</th><th>PnL Net</th><th class="text-right font-bold text-white">Balance</th></tr>
        </thead><tbody id="historyBody"></tbody></table>
    </div></div>

    <script>
    let running = false, initialBal = 1000;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.running) {
        running = true; initialBal = parseFloat(saved.initialBal);
        document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
        syncConfig();
    }
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;

    function fPrice(p) {
        if (!p || p === 0) return "0.0000";
        let s = p.toFixed(20);
        let match = s.match(/^-?\\d+\\.0*[1-9]/);
        if (!match) return p.toFixed(4);
        let index = match[0].length;
        return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
    }

    function syncConfig() {
        const tp = document.getElementById('tpInp').value, sl = document.getElementById('slInp').value, vol = document.getElementById('volInp').value;
        fetch(\`/api/config?tp=\${tp}&sl=\${sl}&vol=\${vol}\`);
    }

    function start() {
        localStorage.setItem('luffy_state', JSON.stringify({ 
            running: true, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, 
            tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value 
        }));
        syncConfig(); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);

            document.getElementById('liveBody').innerHTML = d.top5.map(c => \`<tr class="border-b border-zinc-800/50"><td class="py-2 font-bold text-white">\${c.symbol}</td><td class="text-center \${c.c1>=0?'up':'down'} font-bold">\${c.c1}%</td><td class="text-center \${c.c5>=0?'up':'down'} font-bold">\${c.c5}%</td><td class="text-right \${c.c15>=0?'up':'down'} font-bold">\${c.c15}%</td></tr>\`).join('');

            let currentBal = initialBal, winCount = 0, loseCount = 0, pnlWinSum = 0, pnlLoseSum = 0;
            let histHTML = [...d.history].reverse().map(h => {
                let margin = mVal.includes('%') ? (currentBal * mNum / 100) : mNum;
                let netPnl = (margin * (h.maxLev || 20) * (h.pnlPercent/100)) - (margin * (h.maxLev || 20) * 0.001);
                currentBal += netPnl;
                if (netPnl >= 0) { winCount++; pnlWinSum += netPnl; } else { loseCount++; pnlLoseSum += netPnl; }
                let tpP = h.type==='UP' ? h.snapPrice*(1+h.tpTarget/100) : h.snapPrice*(1-h.tpTarget/100);
                let slP = h.type==='UP' ? h.snapPrice*(1-h.slTarget/100) : h.snapPrice*(1+h.slTarget/100);
                return \`<tr class="border-b border-zinc-800/30 text-zinc-400">
                    <td class="py-1 text-[7px]">\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}<br>\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td><b class="text-white text-[10px]">\${h.symbol}</b><br><span class="text-[7px] text-[#fcd535] font-bold">\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</span><br><span class="text-[7px] text-zinc-500 italic">Lev: \${h.maxLev}x</span></td>
                    <td>\${fPrice(h.snapPrice)}<br>\${fPrice(h.finalPrice)}</td>
                    <td class="text-center text-[7px] font-bold">T: \${fPrice(tpP)}<br>S: \${fPrice(slP)}</td>
                    <td class="\${netPnl>=0?'up':'down'} font-black text-[10px]">\${netPnl.toFixed(2)}</td>
                    <td class="text-right text-white font-black">\${currentBal.toFixed(2)}</td></tr>\`;
            }).reverse().join('');
            document.getElementById('historyBody').innerHTML = histHTML;
            document.getElementById('totalWin').innerText = winCount; document.getElementById('totalLose').innerText = loseCount;
            document.getElementById('pnlWinSum').innerText = '+' + pnlWinSum.toFixed(2); document.getElementById('pnlLoseSum').innerText = pnlLoseSum.toFixed(2);

            let unPnl = 0, marginUsed = 0;
            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.snapPrice;
                let margin = mVal.includes('%') ? (currentBal * mNum / 100) : mNum; 
                marginUsed += margin;
                let roi = (h.type === 'UP' ? (lp-h.snapPrice)/h.snapPrice : (h.snapPrice-lp)/h.snapPrice) * 100 * (h.maxLev || 20);
                let pnl = margin * roi / 100; unPnl += pnl;
                let tpP = h.type==='UP' ? h.snapPrice*(1+h.tpTarget/100) : h.snapPrice*(1-h.tpTarget/100);
                let slP = h.type==='UP' ? h.snapPrice*(1-h.slTarget/100) : h.snapPrice*(1+h.slTarget/100);
                return \`<tr class="bg-white/5 border-b border-zinc-800">
                    <td class="py-2 text-[8px]">\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td><b class="text-white text-[10px]">\${h.symbol}</b><br><span class="text-[8px] text-[#fcd535] font-bold">\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</span><br><span class="text-[8px] text-zinc-500 italic">Lev: \${h.maxLev}x</span></td>
                    <td class="font-bold text-zinc-300">\${fPrice(h.snapPrice)}<br><span class="text-white font-black">\${fPrice(lp)}</span></td>
                    <td class="text-center text-[8px] font-bold text-zinc-400">T: <span class="text-green-500">\${fPrice(tpP)}</span><br>S: <span class="text-red-500">\${fPrice(slP)}</span></td>
                    <td class="text-right font-black \${pnl>=0?'up':'down'} text-[11px]">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td>
                </tr>\`;
            }).join('');

            if(running) {
                document.getElementById('displayBal').innerText = (currentBal - marginUsed).toFixed(2);
                document.getElementById('marginUsed').innerText = marginUsed.toFixed(2);
                document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
                document.getElementById('unPnl').className = 'text-xl font-black ' + (unPnl >= 0 ? 'up' : 'down');
            }
        } catch(e) {}
    }
    setInterval(update, 500);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
