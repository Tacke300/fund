import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 

// --- FIX ĐÒN BẨY (Thêm Header để tránh bị chặn) ---
async function fetchActualLeverage() {
    const options = {
        hostname: 'fapi.binance.com',
        path: '/fapi/v1/leverageBracket',
        headers: { 'User-Agent': 'Mozilla/5.0' }
    };
    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                brackets.forEach(item => {
                    if (item.brackets?.length > 0) {
                        symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                    }
                });
                console.log(`[SYSTEM] Đã lấy đòn bẩy cho \${Object.keys(symbolMaxLeverage).length} mã.`);
            } catch (e) { console.error("Lỗi parse Leverage"); }
        });
    }).on('error', (e) => { console.error("Lỗi API Binance Leverage"); });
}
fetchActualLeverage();
setInterval(fetchActualLeverage, 3600000);

// --- GIỮ NGUYÊN LOGIC LƯU TRỮ 30 NGÀY CỦA BẠN ---
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    return startPriceObj ? parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2)) : 0;
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastStatusTime: 0 };
            
            // KHUNG GỐC: Giữ nguyên mảng 100 điểm giá
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices = coinData[s].prices.slice(-100);

            const c1 = calculateChange(coinData[s].prices, 1), 
                  c5 = calculateChange(coinData[s].prices, 5), 
                  c15 = calculateChange(coinData[s].prices, 15);
            
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'DOWN' ? diff <= -5 : diff >= 5;
                const lose = pending.type === 'DOWN' ? diff >= 5 : diff <= -5;
                if (win || lose) {
                    pending.status = win ? 'WIN' : 'LOSE';
                    pending.finalPrice = p; pending.endTime = now; pending.needSound = pending.status;
                    coinData[s].lastStatusTime = now;
                }
            }

            // LOGIC VÀO LỆNH GỐC
            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                if (!pending && (now - coinData[s].lastStatusTime >= 900000)) {
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapVol: { c1, c5, c15 }, 
                        snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                        status: 'PENDING', 
                        maxLev: symbolMaxLeverage[s] || 20,
                        tp: (c1+c5+c15 >= 0) ? p * 1.05 : p * 0.95,
                        sl: (c1+c5+c15 >= 0) ? p * 0.95 : p * 1.05
                    });
                }
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})),
        history: Array.from(historyMap.values()).sort((a,b)=>b.startTime-a.startTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BINANCE V2.5</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #000; color: #eee; font-family: sans-serif; }
        .up { color: #22c55e; } .down { color: #f43f5e; }
        .bg-card { background: #0a0a0a; border: 1px solid #27272a; }
    </style></head><body class="p-4">
    <div class="flex justify-between items-center mb-4 border-b border-zinc-800 pb-2">
        <h1 class="text-xl font-bold text-yellow-500 italic">BINANCE PUMP & DUMP</h1>
        <div id="setup" class="flex gap-2">
            <input id="balanceInp" type="number" value="1000" class="bg-zinc-900 p-2 rounded w-24 border border-zinc-700">
            <input id="marginInp" type="text" value="10%" class="bg-zinc-900 p-2 rounded w-24 border border-zinc-700">
            <button onclick="start()" class="bg-yellow-500 text-black px-6 py-2 rounded font-bold">START</button>
        </div>
        <div id="active" class="hidden text-right">
            <div id="displayBal" class="text-3xl font-black text-white">$0.00</div>
        </div>
    </div>

    <div class="bg-card p-4 rounded mb-6">
        <div class="flex justify-between items-center mb-2">
            <div class="flex gap-1">
                <button onclick="setTF(24)" class="bg-zinc-800 text-[10px] px-3 py-1 rounded">24H</button>
                <button onclick="setTF(168)" class="bg-zinc-800 text-[10px] px-3 py-1 rounded">7D</button>
                <button onclick="setTF(720)" class="bg-zinc-800 text-[10px] px-3 py-1 rounded">30D</button>
            </div>
            <div id="stats" class="text-[10px] font-bold flex gap-4"></div>
        </div>
        <div style="height: 180px;"><canvas id="mainChart"></canvas></div>
    </div>

    <div class="mb-6">
        <div class="text-xs font-bold mb-2 flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span> 
            VỊ THẾ ĐANG MỞ: <span id="posCount" class="text-yellow-500">0</span>
        </div>
        <div class="bg-card rounded overflow-x-auto">
            <table class="w-full text-[11px] text-left">
                <thead class="bg-zinc-900 text-zinc-500 uppercase">
                    <tr><th class="p-3">Hợp đồng</th><th class="p-3">Vị thế</th><th class="p-3">Giá vào</th><th class="p-3">Giá hiện tại</th><th class="p-3">TP / SL</th><th class="p-3">Ký quỹ</th><th class="p-3 text-right">PNL (ROI%)</th></tr>
                </thead>
                <tbody id="posBody"></tbody>
            </table>
        </div>
    </div>

    <div class="grid grid-cols-12 gap-4">
        <div class="col-span-4 bg-card rounded h-[400px] overflow-hidden flex flex-col">
            <div class="p-2 bg-zinc-900 text-xs font-bold border-b border-zinc-800">BIẾN ĐỘNG</div>
            <div class="overflow-y-auto flex-1"><table class="w-full text-[11px] text-left"><tbody id="liveBody"></tbody></table></div>
        </div>
        <div class="col-span-8 bg-card rounded h-[400px] overflow-hidden flex flex-col">
            <div class="p-2 bg-zinc-900 text-xs font-bold border-b border-zinc-800 uppercase">Lịch sử giao dịch</div>
            <div class="overflow-y-auto flex-1">
                <table class="w-full text-[11px] text-left font-mono">
                    <thead class="sticky top-0 bg-black text-zinc-500">
                        <tr><th class="p-3">Thời gian (Vào/Ra)</th><th class="p-3">Coin</th><th class="p-3 text-right">PNL ($)</th><th class="p-3 text-right">Trạng thái</th></tr>
                    </thead>
                    <tbody id="historyBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let running = false, initialBal = 0, currentBal = 0, balHistory = [], tf = 24;
        const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

        const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
            type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#f0b90b', tension: 0.1, pointRadius: 0, fill: true, backgroundColor: 'rgba(240,185,11,0.05)' }]},
            options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1a1a1a' } } } }
        });

        function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
        function setTF(h) { tf = h; }

        async function update() {
            try {
                const res = await fetch('/api/data'); const d = await res.json();
                document.getElementById('liveBody').innerHTML = d.live.sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,30).map(c => \`
                    <tr class="border-b border-zinc-900"><td class="p-2 font-bold">\${c.symbol}</td><td class="\${c.c1>=0?'up':'down'} p-2">\${c.c1}%</td><td class="\${c.c5>=0?'up':'down'} p-2 text-right">\${c.c5}%</td></tr>
                \`).join('');

                let closedPnl = 0, openPnl = 0, pendingCount = 0;
                let posHtml = '', histHtml = '';
                
                d.history.forEach(h => {
                    const mVal = document.getElementById('marginInp').value;
                    const margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                    
                    if (h.status === 'PENDING') {
                        pendingCount++;
                        const coin = d.live.find(l => l.symbol === h.symbol);
                        const curP = coin ? coin.currentPrice : h.snapPrice;
                        const diff = ((curP - h.snapPrice) / h.snapPrice) * 100;
                        const roi = (h.type === 'UP' ? diff : -diff) * h.maxLev;
                        const pnl = margin * (roi / 100);
                        openPnl += pnl;

                        posHtml += \`<tr class="border-b border-zinc-900">
                            <td class="p-3 font-bold">\${h.symbol} <span class="text-zinc-500">Cross \${h.maxLev}x</span></td>
                            <td class="p-3 font-bold \${h.type==='UP'?'up':'down'}">\${h.type==='UP'?'LONG':'SHORT'}</td>
                            <td class="p-3 font-bold">\${h.snapPrice.toFixed(4)}</td>
                            <td class="p-3">\${cur
