// ================= CONFIGURATION =================
const MIN_VOLATILITY_TO_SAVE = 0.5; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
// =================================================

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

async function fetchActualLeverage() {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const options = { hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`, headers: { 'X-MBX-APIKEY': API_KEY } };
    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                if (Array.isArray(brackets)) {
                    brackets.forEach(item => { if (item.brackets?.[0]) symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage; });
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                }
            } catch (e) {}
        });
    });
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
    const start = pArr.find(i => i.t >= (pArr[pArr.length-1].t - min*60000));
    return start ? parseFloat(((pArr[pArr.length-1].p - start.p) / start.p * 100).toFixed(2)) : 0;
}

function initWS() {
    fetchActualLeverage();
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'DOWN' ? diff <= -5 : diff >= 5;
                const lose = pending.type === 'DOWN' ? diff >= 5 : diff <= -5;
                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; pending.endTime = now; pending.needSound = true;
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending && !isCooldown) {
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20 });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0,50)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: "IBM Plex Sans", sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 6px 0; font-size: 12px; font-weight: 500; text-align: center; width: 100%; }
        #user-id { color: #fcd535; font-size: 1.4rem; font-weight: 900; font-style: italic; cursor: pointer; }
        .text-gray-custom { color: #848e9c; } .text-10 { font-size: 10px; } .text-12 { font-size: 12px; }
        ::-webkit-scrollbar { width: 0px; }
    </style></head><body>
    
    <div class="p-4">
        <div id="setup" class="flex gap-2 mb-4">
            <input id="balanceInp" type="number" value="1000" class="bg-card border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none">
            <input id="marginInp" type="text" value="10%" class="bg-card border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none">
            <button onclick="start()" class="bg-[#fcd535] text-black px-6 py-2 rounded font-bold uppercase text-xs">Start</button>
        </div>

        <div class="grid grid-cols-3 gap-2 mb-6 text-center">
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold">Hôm nay</div><div id="stat24" class="font-bold text-12 text-white">---</div></div>
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold">7 Ngày</div><div id="stat7" class="font-bold text-12 text-white">---</div></div>
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold">30 Ngày</div><div id="stat30" class="font-bold text-12 text-white">---</div></div>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic text-white text-sm">BINANCE <span class="text-[#fcd535]">FUTURES</span></h1></div>
             <div id="user-id" onclick="stop()">Moncey_D_Luffy</div>
        </div>

        <div class="text-gray-custom text-12 mb-1">Số dư ký quỹ <i class="far fa-eye text-10"></i></div>
        <div class="flex items-end gap-2 mb-4">
            <span id="displayBal" class="text-3xl font-bold text-white tracking-tighter">0.00</span>
            <span class="text-sm font-medium text-white mb-1">USDT</span>
        </div>
    </div>

    <div class="px-4 py-2"><div style="height: 140px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mb-4">
        <div class="bg-card rounded p-3">
            <div class="text-10 font-bold text-gray-custom mb-2 uppercase border-b border-zinc-800 pb-1 italic">Biến động thị trường</div>
            <table class="w-full text-[11px] text-left">
                <tbody id="liveTableBody"></tbody>
            </table>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="flex gap-6 mb-6 border-b border-zinc-800 text-sm font-bold text-gray-custom uppercase tracking-tighter">
            <span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế</span>
            <span>Lệnh chờ</span>
            <span>Lịch sử</span>
        </div>
        <div id="pendingContainer" class="space-y-10 pb-10"></div>
    </div>

    <div class="px-2 pb-24">
        <div class="bg-card rounded p-3 mx-2">
            <div class="text-10 font-bold text-gray-custom mb-3 uppercase border-b border-zinc-800 pb-1">Lịch sử chốt lệnh</div>
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left min-w-[550px]">
                <thead class="text-gray-custom uppercase"><tr><th class="pb-2">Time Close</th><th class="pb-2">Coin</th><th class="pb-2">Entry</th><th class="pb-2">TP/SL</th><th class="pb-2">Lev/Margin</th><th class="pb-2 text-right">PNL</th></tr></thead>
                <tbody id="historyBody" class="text-zinc-300 font-mono"></tbody>
            </table></div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000, historyLog = [];
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3'), loseSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2014/2014-preview.mp3');

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function fP(price) {
        let p = parseFloat(price);
        if (p < 0.001) return p.toFixed(8);
        if (p < 1) return p.toFixed(4);
        return p.toFixed(2);
    }

    function start() { 
        running = true; 
        initialBal = parseFloat(document.getElementById('balanceInp').value); 
        document.getElementById('setup').style.display='none'; 
        document.getElementById('active').classList.remove('hidden'); 
    }
    
    function stop() { 
        running = false; 
        document.getElementById('setup').style.display='flex'; 
        document.getElementById('active').classList.add('hidden'); 
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            
            // Render Biến động
            document.getElementById('liveTableBody').innerHTML = d.live.map(c => 
                \`<tr class="border-b border-zinc-800/50"><td class="py-1 font-bold text-white uppercase">\${c.symbol}</td>
                <td class="text-center \${c.c1>=0?'up':'down'}">\${c.c1}%</td>
                <td class="text-center \${c.c5>=0?'up':'down'}">\${c.c5}%</td>
                <td class="text-center \${c.c15>=0?'up':'down'}">\${c.c15}%</td></tr>\`
            ).join('');

            let totalUnPnl = 0, totalClosedP = 0;
            // Render Vị thế
            document.getElementById('pendingContainer').innerHTML = d.pending.map(function(h){
                var livePrice = d.live.find(function(c){return c.symbol === h.symbol})?.currentPrice || h.snapPrice;
                var mInp = document.getElementById('marginInp').value;
                var marginVal = mInp.includes('%') ? (initialBal * parseFloat(mInp)/100) : parseFloat(mInp);
                var roi = (h.type === 'UP' ? ((livePrice - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - livePrice)/h.snapPrice)*100) * (h.maxLev || 20);
                var pnl = marginVal * roi / 100; totalUnPnl += pnl;

                var dots = roi > 0 ? '<span class="up font-black text-sm ml-1">!!!!</span>' : '<span class="down font-black text-sm ml-1">!!!</span>';
                var tp = h.type === 'UP' ? h.snapPrice * 1.05 : h.snapPrice * 0.95;
                var sl = h.type === 'UP' ? h.snapPrice * 0.94 : h.snapPrice * 1.06;

                return '<div class="relative">' +
                    '<div class="flex items-center gap-1 mb-3">' +
                        '<span class="w-4 h-4 flex items-center justify-center rounded-sm text-[10px] font-bold ' + (h.type==='UP'?'bg-[#0ecb81] text-black':'bg-[#f6465d] text-black') + '">' + (h.type==='UP'?'L':'S') + '</span>' +
                        '<span class="font-bold text-white text-base">' + h.symbol + '</span>' +
                        '<span class="bg-[#2b3139] px-1 rounded text-gray-custom text-[10px] ml-1">Cross ' + (h.maxLev || 20) + 'X</span>' + dots +
                    '</div>' +
                    '<div class="grid grid-cols-2 mb-3"><div><div class="text-gray-custom text-12">PNL(USDT)</div><div class="text-2xl font-bold ' + (pnl>=0?'up':'down') + '">' + pnl.toFixed(2) + '</div></div>' +
                    '<div class="text-right"><div class="text-gray-custom text-12">ROI</div><div class="text-2xl font-bold ' + (pnl>=0?'up':'down') + '">' + roi.toFixed(2) + '%</div></div></div>' +
                    '<div class="grid grid-cols-3 text-12 text-gray-custom"><div>Kích thước<div class="text-white">' + (marginVal*20).toFixed(1) + '</div></div>' +
                    '<div class="text-center">Giá vào<div class="text-white">' + fP(h.snapPrice) + '</div></div>' +
                    '<div class="text-right">Giá dấu<div class="text-white">' + fP(livePrice) + '</div></div></div>' +
                    '<div class="flex gap-1 text-11 mt-3">TP/SL: <span class="up">' + fP(tp) + '</span> / <span class="down">' + fP(sl) + '</span></div>' +
                    '<div class="flex gap-2 mt-4"><div class="binance-btn">Đòn bẩy</div><div class="binance-btn">TP/SL</div><div class="binance-btn">Đóng</div></div></div>';
            }).join('');

            // Lịch sử & Thống kê
            document.getElementById('historyBody').innerHTML = d.history.map(function(h){
                var pnl = (h.status === 'WIN' ? 10 : -10); totalClosedP += pnl;
                if(h.needSound) { (h.status === 'WIN' ? winSnd : loseSnd).play(); delete h.needSound; }
                return '<tr><td>'+new Date(h.endTime).toLocaleTimeString()+'</td><td class="font-bold">'+h.symbol+'</td><td>'+fP(h.snapPrice)+'</td><td>--</td><td>'+h.maxLev+'x</td><td class="text-right '+(pnl>=0?'up':'down')+'">'+pnl+'</td></tr>';
            }).join('');

            if(running) {
                var currentBal = initialBal + totalClosedP + totalUnPnl;
                document.getElementById('displayBal').innerText = currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 30000) { historyLog.push({t: now, b: currentBal}); if(historyLog.length > 60) historyLog.shift(); }
                chart.data.labels = historyLog.map((_,i)=>i); chart.data.datasets[0].data = historyLog.map(pt=>pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); });
