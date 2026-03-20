const TP_PERCENT = 0.5; 
const SL_PERCENT = 10.0;  
const MIN_VOLATILITY_TO_SAVE = 5; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

function fPrice(price) {
    if (!price || price === 0) return "0.0000";
    let s = price.toFixed(12);
    let match = s.match(/^-?\d+\.?0*[1-9]{1,4}/);
    return match ? match[0] : price.toFixed(4);
}

// --- LOGIC BINANCE ---
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
            
            // Khớp lệnh TP/SL tại Backend
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'UP' ? diff >= TP_PERCENT : diff <= -TP_PERCENT; 
                const lose = pending.type === 'UP' ? diff <= -SL_PERCENT : diff >= SL_PERCENT; 
                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = win ? TP_PERCENT : -SL_PERCENT;
                    lastTradeClosed[s] = now; fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            // Tự mở lệnh
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending && !isCooldown) {
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: TP_PERCENT, slTarget: SL_PERCENT });
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = pArr[pArr.length - 1].t;
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

// API: Trả về Full Live Data để Frontend luôn có giá nhảy
app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])), // Full giá cho vị thế
        top5: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,5),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0, 50)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; }
        .text-gray-custom { color: #848e9c; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 shadow-xl border-b border-zinc-800">
        <div id="setup" class="flex gap-2 mb-4 bg-card p-2 rounded">
            <input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            <input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            <button onclick="start()" class="bg-[#fcd535] text-black px-4 py-2 rounded font-bold uppercase text-xs">Start</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><h1 class="font-bold italic text-white tracking-tighter">BINANCE <span class="text-[#fcd535]">FUTURES</span></h1></div>
             <div id="user-id" class="text-[#fcd535] font-black italic" onclick="stop()">Monkey_D_Luffy</div>
        </div>
        <div class="text-gray-custom text-[10px] mb-1 uppercase font-bold">Số dư ký quỹ hiện tại</div>
        <div class="flex items-end gap-2 mb-2"><span id="displayBal" class="text-3xl font-bold tracking-tighter text-white">0.00</span><span class="text-xs text-white mb-1">USDT</span></div>
        <div class="grid grid-cols-2 gap-2 mb-4 bg-zinc-900/50 p-2 rounded border border-zinc-800">
            <div class="border-r border-zinc-800"><div class="text-[9px] text-gray-custom uppercase">Total Win</div><div id="winSum" class="text-xs font-bold up">+0.00</div></div>
            <div class="pl-2"><div class="text-[9px] text-gray-custom uppercase">Total Lose</div><div id="loseSum" class="text-xs font-bold down">-0.00</div></div>
        </div>
        <div class="grid grid-cols-2 gap-4 text-[10px] border-t border-zinc-800 pt-2 uppercase">
            <div><div class="text-gray-custom">Số dư khả dụng</div><div id="walletBal" class="font-bold text-white">0.00</div></div>
            <div class="text-right"><div class="text-gray-custom">PnL chưa chốt</div><div id="unPnl" class="font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="bg-card rounded-lg p-3">
            <div class="text-[10px] font-bold text-white mb-2 uppercase italic border-b border-green-500/30 pb-1">Vị thế đang mở</div>
            <table class="w-full text-[9px] text-left">
                <thead class="text-gray-custom uppercase border-b border-zinc-800">
                    <tr><th>Time</th><th>Coin</th><th>Margin</th><th class="text-center">Lev/Target</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr>
                </thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="bg-card rounded-lg p-3">
             <div class="text-[10px] font-bold text-gray-custom mb-2 uppercase border-b border-zinc-800 pb-1">Biến động thị trường</div>
             <table class="w-full text-[10px] text-left">
                <thead><tr class="text-gray-custom"><th>COIN</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-right">15M</th></tr></thead>
                <tbody id="liveBody"></tbody>
             </table>
        </div>
    </div>

    <div class="px-4 mt-4 pb-20">
        <div class="bg-card rounded-lg p-3">
            <div class="text-[10px] font-bold text-gray-custom mb-2 uppercase border-b border-zinc-800 pb-1">Toàn bộ lịch sử</div>
            <table class="w-full text-[8px] text-left">
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000;
    function fPrice(p) {
        if (!p || p === 0) return "0.0000";
        let s = p.toFixed(12);
        let match = s.match(/^-?\\d+\\.?0*[1-9]{1,4}/);
        return match ? match[0] : p.toFixed(4);
    }
    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').classList.add('hidden'); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);

            // Bảng Biến Động
            document.getElementById('liveBody').innerHTML = (d.top5 || []).map(c => 
                \`<tr class="border-b border-zinc-800/50"><td class="py-2 font-bold">\${c.symbol}</td>
                <td class="\${c.c1>=0?'up':'down'} text-center">\${c.c1}%</td><td class="\${c.c5>=0?'up':'down'} text-center">\${c.c5}%</td>
                <td class="\${c.c15>=0?'up':'down'} text-right">\${c.c15}%</td></tr>\`).join('');

            let runningBal = initialBal, winSum = 0, loseSum = 0;
            // Tính toán History & Balance
            d.history.reverse().forEach(h => {
                let margin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let netPnl = (margin * (h.maxLev || 20) * (h.pnlPercent/100)) - (margin * (h.maxLev || 20) * 0.001);
                runningBal += netPnl;
                if(netPnl >= 0) winSum += netPnl; else loseSum += netPnl;
            });
            document.getElementById('historyBody').innerHTML = d.history.reverse().map(h => \`
                <tr class="border-b border-zinc-800/30"><td>\${h.symbol}</td><td>\${h.status}</td><td class="\${h.pnlPercent>=0?'up':'down'}">\${h.pnlPercent}%</td><td class="text-right">\${fPrice(h.finalPrice)}</td></tr>
            \`).join('');

            // Bảng Vị Thế (NHẢY REALTIME)
            let unPnl = 0, marginUsed = 0;
            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.snapPrice; // Lấy giá từ object allPrices mới
                let margin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                marginUsed += margin;
                let roi = (h.type === 'UP' ? (lp-h.snapPrice)/h.snapPrice : (h.snapPrice-lp)/h.snapPrice) * 100 * (h.maxLev || 20);
                let pnl = margin * roi / 100; unPnl += pnl;
                return \`<tr class="border-b border-zinc-800/50 bg-green-500/5">
                    <td class="py-2 text-zinc-500 text-[8px]">\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td class="font-bold">\${h.symbol}</td><td>\${margin.toFixed(1)}</td>
                    <td class="text-center">\${h.maxLev}x</td>
                    <td>\${fPrice(h.snapPrice)}<br><b class="text-white blink">\${fPrice(lp)}</b></td>
                    <td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            if(running) {
                document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
                document.getElementById('walletBal').innerText = (runningBal - marginUsed).toFixed(2);
                document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
                document.getElementById('unPnl').className = 'font-bold ' + (unPnl >= 0 ? 'up' : 'down');
                document.getElementById('winSum').innerText = '+' + winSum.toFixed(2);
                document.getElementById('loseSum').innerText = loseSum.toFixed(2);
            }
        } catch(e) {}
    }
    setInterval(update, 100);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log('Luffy Original Layout Fixed Price Running'); });
