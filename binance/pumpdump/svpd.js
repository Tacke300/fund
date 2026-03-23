const PORT = 9000;
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

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 5;

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
            
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'UP' ? diff >= pending.tpTarget : diff <= -pending.tpTarget; 
                const lose = pending.type === 'UP' ? diff <= -pending.slTarget : diff >= pending.slTarget; 
                const timeout = (now - pending.startTime) >= FORCE_CLOSE_MS;

                if (win || lose || timeout) { 
                    pending.status = win ? 'WIN' : (lose ? 'LOSE' : 'TIMEOUT'); 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'UP' ? (p - pending.snapPrice)/pending.snapPrice : (pending.snapPrice - p)/pending.snapPrice) * 100;
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !pending && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
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
        top5: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,5),
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; } .text-gray-custom { color: #848e9c; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 shadow-xl border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-2 mb-4 bg-card p-2 rounded">
            <div><label class="text-[9px] text-gray-custom uppercase">Vốn ($)</label><input id="balanceInp" type="number" class="bg-black border border-zinc-700 p-1.5 rounded w-full text-yellow-500 font-bold text-xs"></div>
            <div><label class="text-[9px] text-gray-custom uppercase">Margin (%)</label><input id="marginInp" type="text" class="bg-black border border-zinc-700 p-1.5 rounded w-full text-yellow-500 font-bold text-xs"></div>
            <div class="col-span-2 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-2 mt-1">
                <div><label class="text-[9px] text-gray-custom uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="bg-black border border-zinc-700 p-1.5 rounded w-full text-white text-xs"></div>
                <div><label class="text-[9px] text-gray-custom uppercase">SL (%)</label><input id="slInp" type="number" step="0.1" class="bg-black border border-zinc-700 p-1.5 rounded w-full text-white text-xs"></div>
                <div><label class="text-[9px] text-gray-custom uppercase">Vol (%)</label><input id="volInp" type="number" step="0.1" class="bg-black border border-zinc-700 p-1.5 rounded w-full text-white text-xs"></div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold uppercase text-xs mt-1">Lưu & Chạy</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-lg">BINANCE <span class="text-[#fcd535]">LUFFY</span></div>
            <button onclick="stop()" class="text-[#fcd535] font-black italic text-xl">STOP</button>
        </div>

        <div class="flex justify-between items-end mb-2">
            <div><div class="text-gray-custom text-[10px] uppercase font-bold tracking-widest leading-none">Số dư ký quỹ</div><span id="displayBal" class="text-3xl font-bold text-white tracking-tighter">0.00</span></div>
            <div class="text-right"><div class="text-gray-custom text-[10px] uppercase font-bold leading-none">PnL chưa chốt</div><div id="unPnl" class="text-lg font-bold">0.00</div></div>
        </div>

        <div class="grid grid-cols-2 gap-4 text-[10px] border-t border-zinc-800 pt-2 mb-2 uppercase font-bold">
            <div><span class="text-gray-custom">Khả dụng: </span><span id="walletBal" class="text-white">0.00</span></div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-lg p-3">
        <div class="text-[10px] font-bold text-white mb-2 uppercase italic border-b border-green-500/30 pb-1">Vị thế đang mở</div>
        <table class="w-full text-[9px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800">
            <tr><th>Time</th><th>Coin</th><th>Margin</th><th class="text-center">Lev/Target</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr>
        </thead><tbody id="pendingBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-4"><div class="bg-card rounded-lg p-3">
         <div class="text-[10px] font-bold text-gray-custom mb-2 uppercase border-b border-zinc-800 pb-1">Biến động thị trường</div>
         <table class="w-full text-[10px] text-left"><thead><tr class="text-gray-custom text-[9px]"><th>COIN</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-right">15M</th></tr></thead><tbody id="liveBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-4 pb-32"><div class="bg-card rounded-lg p-3">
        <div class="text-[10px] font-bold text-gray-custom mb-2 uppercase italic border-b border-zinc-800 pb-1">Lịch sử (Chụp biến động)</div>
        <table class="w-full text-[8px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase">
            <tr><th>Time In-Out</th><th>Coin/Vol</th><th>Margin</th><th class="text-center">Lev/Target</th><th>Entry/Exit</th><th>PnL Net</th><th class="text-right">Balance</th></tr>
        </thead><tbody id="historyBody"></tbody></table>
    </div></div>

    <script>
    let running = false, initialBal = 1000;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;

    if(saved.running) {
        running = true; initialBal = parseFloat(saved.initialBal);
        document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
        syncConfig();
    }

    function fPrice(p) {
        if (!p || p === 0) return "0.0000";
        let s = p.toFixed(10); let match = s.match(/^-?\\d+\\.0*[1-9]/);
        if (!match) return p.toFixed(4);
        let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
    }

    function syncConfig() {
        const tp = document.getElementById('tpInp').value, sl = document.getElementById('slInp').value, vol = document.getElementById('volInp').value;
        fetch(\`/api/config?tp=\${tp}&sl=\${sl}&vol=\${vol}\`);
    }

    function start() {
        localStorage.setItem('luffy_state', JSON.stringify({ 
            running: true, initialBal: document.getElementById('balanceInp').value, 
            marginVal: document.getElementById('marginInp').value, 
            tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value 
        }));
        syncConfig(); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);

            // CẬP NHẬT BẢNG BIẾN ĐỘNG (FIX LỖI MẤT BẢNG)
            document.getElementById('liveBody').innerHTML = d.top5.map(c => \`<tr class="border-b border-zinc-800/50"><td class="py-2 font-bold">\${c.symbol}</td><td class="text-center \${c.c1>=0?'up':'down'}">\${c.c1}%</td><td class="text-center \${c.c5>=0?'up':'down'}">\${c.c5}%</td><td class="text-right \${c.c15>=0?'up':'down'}">\${c.c15}%</td></tr>\`).join('');

            let currentBal = initialBal;
            
            // LỊCH SỬ (THÊM LẠI VOL VÀ TARGET)
            let histHTML = [...d.history].reverse().map(h => {
                let margin = mVal.includes('%') ? (currentBal * mNum / 100) : mNum;
                let netPnl = (margin * (h.maxLev || 20) * (h.pnlPercent/100)) - (margin * (h.maxLev || 20) * 0.001);
                currentBal += netPnl;
                let tpP = h.type==='UP' ? h.snapPrice*(1+h.tpTarget/100) : h.snapPrice*(1-h.tpTarget/100);
                let slP = h.type==='UP' ? h.snapPrice*(1-h.slTarget/100) : h.snapPrice*(1+h.slTarget/100);
                let v = h.snapVol || {c1:0,c5:0,c15:0};

                return \`<tr class="border-b border-zinc-800/30 text-zinc-400">
                    <td class="py-2 text-[7px]">\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}<br>\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td><b class="text-white">\${h.symbol}</b><br><span class="text-[7px]">\${v.c1}/\${v.c5}/\${v.c15}</span></td>
                    <td>\${margin.toFixed(1)}</td>
                    <td class="text-center text-[7px] font-bold">\${h.maxLev}x<br>T: \${fPrice(tpP)}<br>S: \${fPrice(slP)}</td>
                    <td>\${fPrice(h.snapPrice)}<br>\${fPrice(h.finalPrice)}</td>
                    <td class="\${netPnl>=0?'up':'down'} font-bold">\${netPnl.toFixed(2)}</td>
                    <td class="text-right text-white font-medium">\${currentBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');
            document.getElementById('historyBody').innerHTML = histHTML;

            // VỊ THẾ ĐANG MỞ (THÊM LẠI TARGET VÀ VOL)
            let unPnl = 0, marginUsed = 0;
            let availableAtOpen = currentBal; 

            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.snapPrice;
                let margin = mVal.includes('%') ? (availableAtOpen * mNum / 100) : mNum; 
                marginUsed += margin;
                let roi = (h.type === 'UP' ? (lp-h.snapPrice)/h.snapPrice : (h.snapPrice-lp)/h.snapPrice) * 100 * (h.maxLev || 20);
                let pnl = margin * roi / 100; unPnl += pnl;
                let tpP = h.type==='UP' ? h.snapPrice*(1+h.tpTarget/100) : h.snapPrice*(1-h.tpTarget/100);
                let slP = h.type==='UP' ? h.snapPrice*(1-h.slTarget/100) : h.snapPrice*(1+h.slTarget/100);

                return \`<tr class="bg-green-500/5">
                    <td>\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td class="text-white font-bold">\${h.symbol}</td>
                    <td>\${margin.toFixed(1)}</td>
                    <td class="text-center text-[7px] font-bold">\${h.maxLev}x<br>T: \${fPrice(tpP)}<br>S: \${fPrice(slP)}</td>
                    <td>\${fPrice(h.snapPrice)}<br><b class="text-white">\${fPrice(lp)}</b></td>
                    <td class="text-right font-bold \${pnl>=0?'up':'down'} text-[10px]">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td>
                </tr>\`;
            }).join('');

            if(running) {
                document.getElementById('displayBal').innerText = (currentBal + unPnl).toFixed(2);
                document.getElementById('walletBal').innerText = (currentBal - marginUsed).toFixed(2);
                document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
                document.getElementById('unPnl').className = 'text-lg font-bold ' + (unPnl >= 0 ? 'up' : 'down');
            }
        } catch(e) {}
    }
    setInterval(update, 500);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
