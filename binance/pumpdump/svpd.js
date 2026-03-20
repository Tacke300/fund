const TP_PERCENT = 0.5; 
const SL_PERCENT = 10.0;  
const MIN_VOLATILITY_TO_SAVE = 3; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import { Server } from 'socket.io'; // Thêm Socket.io
import http from 'http';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

// Format đúng 4 số có nghĩa sau dàn số 0
function fPrice(price) {
    if (!price || price === 0) return "0.0000";
    let s = price.toFixed(12);
    let match = s.match(/^-?\d+\.?0*[1-9]{1,4}/);
    return match ? match[0] : price.toFixed(4);
}

// --- LOGIC BINANCE WS ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        let updates = [];

        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();

            // Tính biến động
            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            updates.push({ s, p, c1, c5, c15 });

            // Xử lý lệnh đang mở
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'UP' ? diff >= TP_PERCENT : diff <= -TP_PERCENT; 
                const lose = pending.type === 'UP' ? diff <= -SL_PERCENT : diff >= SL_PERCENT; 
                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = win ? TP_PERCENT : -SL_PERCENT;
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            // Auto Entry (như cũ)
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending && !isCooldown) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, snapVol: { c1, c5, c15 }, tpTarget: TP_PERCENT, slTarget: SL_PERCENT
                });
            }
        });

        // ĐẨY DATA XUỐNG BROWSER NGAY LẬP TỨC
        io.emit('tick', {
            live: updates.sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,5),
            pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
            history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0,20)
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

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Ultra Realtime</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; }
        .text-gray-custom { color: #848e9c; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 shadow-xl border-b border-zinc-800">
        <div id="setup" class="flex gap-2 mb-4 bg-card p-3 rounded-lg border border-zinc-800">
            <input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            <input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            <button onclick="start()" class="bg-[#fcd535] text-black px-4 py-2 rounded font-bold uppercase text-xs">Start</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><h1 class="font-bold italic text-white tracking-tighter text-xl">BINANCE <span class="text-[#fcd535]">FUTURES</span></h1></div>
             <div id="user-id" class="text-[#fcd535] font-black italic text-lg" onclick="stop()">Monkey_D_Luffy</div>
        </div>
        <div class="text-gray-custom text-xs mb-1">Số dư ký quỹ hiện tại (USDT)</div>
        <div class="flex items-end gap-2 mb-2">
            <span id="displayBal" class="text-4xl font-bold tracking-tighter text-white">0.00</span>
            <span class="text-base font-medium text-white mb-1">USDT</span>
        </div>
        <div class="grid grid-cols-2 gap-2 bg-zinc-900/50 p-2 rounded border border-zinc-800">
            <div class="border-r border-zinc-800 pr-2">
                <div class="text-[10px] text-gray-custom uppercase font-bold">Total Win</div>
                <div id="winSum" class="text-sm font-bold up">+0.00</div>
            </div>
            <div class="pl-2">
                <div class="text-[10px] text-gray-custom uppercase font-bold">Total Lose</div>
                <div id="loseSum" class="text-sm font-bold down">-0.00</div>
            </div>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="bg-card rounded-lg p-3 border border-zinc-800">
            <div class="text-[10px] font-bold text-white mb-3 uppercase italic border-b border-green-500/50 pb-1">Vị thế đang mở (Live)</div>
            <table class="w-full text-[10px] text-left">
                <thead class="text-gray-custom border-b border-zinc-800">
                    <tr><th class="pb-2">Coin</th><th class="pb-2 text-center">Lev</th><th class="pb-2">Entry/Live</th><th class="pb-2 text-right">PnL (ROI%)</th></tr>
                </thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="bg-card rounded-lg p-3 border border-zinc-800">
             <div class="text-[10px] font-bold text-gray-custom mb-3 uppercase italic border-b border-zinc-800 pb-1">Biến động</div>
             <table class="w-full text-xs text-left">
                <tbody id="liveBody"></tbody>
             </table>
        </div>
    </div>

    <div class="px-4 mt-4 pb-20">
        <div class="bg-card rounded-lg p-3 border border-zinc-800">
            <div class="text-[10px] font-bold text-gray-custom mb-3 uppercase italic border-b border-zinc-800 pb-1">Lịch sử gần đây</div>
            <table class="w-full text-[9px] text-left" id="historyTable">
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
        const socket = io();
        let running = false, initialBal = 1000;

        function fPrice(p) {
            if (!p || p === 0) return "0.0000";
            let s = p.toFixed(12);
            let match = s.match(/^-?\\d+\\.?0*[1-9]{1,4}/);
            return match ? match[0] : p.toFixed(4);
        }

        function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
        function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').classList.add('hidden'); }

        socket.on('tick', (data) => {
            if(!running) return;
            
            let mVal = document.getElementById('marginInp').value;
            let mNum = parseFloat(mVal);
            let currentBal = initialBal;
            let winSum = 0, loseSum = 0;

            // Tính Balance từ lịch sử
            data.history.forEach(h => {
                let margin = mVal.includes('%') ? (currentBal * mNum / 100) : mNum;
                let pnl = margin * (h.maxLev || 20) * (h.pnlPercent/100);
                let netPnl = pnl - (margin * (h.maxLev || 20) * 0.001);
                currentBal += netPnl;
                if(netPnl >= 0) winSum += netPnl; else loseSum += netPnl;
            });

            // Render Biến động
            document.getElementById('liveBody').innerHTML = data.live.map(c => \`
                <tr class="border-b border-zinc-800/50">
                    <td class="py-2 font-bold">\${c.s}</td>
                    <td class="text-center \${c.c1>=0?'up':'down'}">\${c.c1}%</td>
                    <td class="text-right text-white font-bold">\${fPrice(c.p)}</td>
                </tr>\`).join('');

            // Render Vị thế đang mở (NHẢY TỪNG CHÚT MỘT)
            let unPnl = 0;
            document.getElementById('pendingBody').innerHTML = data.pending.map(h => {
                let coin = data.live.find(c => c.s === h.symbol);
                let liveP = coin ? coin.p : h.snapPrice;
                let margin = mVal.includes('%') ? (currentBal * mNum / 100) : mNum;
                let diff = ((liveP - h.snapPrice) / h.snapPrice) * 100;
                let roi = (h.type === 'UP' ? diff : -diff) * (h.maxLev || 20);
                let pnl = margin * roi / 100;
                unPnl += pnl;

                return \`<tr class="border-b border-zinc-800/50 bg-green-500/5">
                    <td class="py-3"><b>\${h.symbol}</b><br><span class="\${h.type==='UP'?'up':'down'}">\${h.type}</span></td>
                    <td class="text-center">\${h.maxLev}x</td>
                    <td>\${fPrice(h.snapPrice)}<br><b class="text-white">\${fPrice(liveP)}</b></td>
                    <td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td>
                </tr>\`;
            }).join('');

            document.getElementById('displayBal').innerText = (currentBal + unPnl).toFixed(2);
            document.getElementById('winSum').innerText = '+' + winSum.toFixed(2);
            document.getElementById('loseSum').innerText = loseSum.toFixed(2);
        });
    </script></body></html>`);
});

server.listen(PORT, '0.0.0.0', () => { initWS(); console.log('Luffy Ultra Realtime: Port 9000'); });
