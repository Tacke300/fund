// ================= CONFIGURATION =================
const MIN_VOLATILITY_TO_SAVE = 0.5; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
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
                if (win || lose) { pending.status = win ? 'WIN' : 'LOSE'; pending.finalPrice = p; pending.endTime = now; pending.needSound = pending.status; fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); }
            }
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending) {
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapVol: { c1, c5, c15 }, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20 });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.startTime-a.startTime).slice(0,30)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Clone Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: -apple-system, system-ui, sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .dot-border { border-bottom: 1px dotted #5e6673; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 10px 0; font-size: 13px; font-weight: 500; text-align: center; }
        .action-btn { background: #2b3139; color: #eaecef; padding: 10px; border-radius: 6px; font-size: 14px; font-weight: 600; flex: 1; text-align: center; }
        .yellow-btn { background: #fcd535; color: #000; }
    </style></head><body>
    
    <div class="p-4 border-b border-zinc-800 bg-[#161a1e]">
        <div class="flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic">BINANCE <span class="text-[#fcd535]">CONTROL</span></h1></div>
             <button id="btnAction" onclick="toggleBot()" class="px-6 py-2 rounded font-bold uppercase text-xs bg-green-600">Start</button>
        </div>
        <div id="setupArea" class="grid grid-cols-2 gap-2">
            <div class="bg-[#1e2329] p-2 rounded border border-zinc-700">
                <label class="block text-[8px] text-zinc-500 font-bold">VỐN GỐC</label>
                <input id="balanceInp" type="number" value="1000" class="bg-transparent w-full font-bold outline-none text-yellow-500">
            </div>
            <div class="bg-[#1e2329] p-2 rounded border border-zinc-700">
                <label class="block text-[8px] text-zinc-500 font-bold">MARGIN %</label>
                <input id="marginInp" type="text" value="10%" class="bg-transparent w-full font-bold outline-none text-yellow-500">
            </div>
        </div>
    </div>

    <div class="p-4 bg-[#0b0e11]">
        <div class="text-zinc-400 text-sm flex items-center gap-1 mb-1">Số dư margin <i class="far fa-eye text-xs"></i></div>
        <div class="flex items-center gap-2 mb-4">
            <span id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</span>
            <span class="text-lg font-medium">USDT</span>
            <i class="fas fa-caret-down text-zinc-500"></i>
        </div>
        <div class="flex justify-between items-center mb-6 text-sm">
            <span class="text-zinc-400">Lãi lỗ đã ghi nhận hôm nay</span>
            <span id="todayPnl" class="text-[#0ecb81] font-medium">$0.00(0.00%) <i class="fas fa-chevron-right text-[10px]"></i></span>
        </div>
        <div class="grid grid-cols-2 gap-4 mb-6">
            <div><div class="text-zinc-500 text-xs mb-1">Số dư ví (USDT)</div><div id="walletBal" class="font-bold">0.00</div></div>
            <div><div class="text-zinc-500 text-xs mb-1">PNL chưa ghi nhận</div><div id="unPnl" class="font-bold">0.00</div></div>
        </div>
        <div class="flex gap-2"><div class="action-btn yellow-btn">Giao dịch</div><div class="action-btn">Hoán đổi</div><div class="action-btn">Chuyển</div></div>
    </div>

    <div class="px-4 py-2"><div style="height: 100px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mt-4">
        <div class="flex gap-4 mb-6 border-b border-zinc-800 pb-2 text-sm font-bold">
            <span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế</span>
            <span class="text-zinc-500">Tài sản</span>
        </div>
        <div id="pendingContainer" class="space-y-10 pb-24"></div>
    </div>

    <script>
    let running = false, initialBal = 0, historyLog = [];
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

    if(localStorage.getItem('bot_luffy_v3')) {
        const s = JSON.parse(localStorage.getItem('bot_luffy_v3'));
        running = s.running; initialBal = s.initialBal; historyLog = s.historyLog || [];
        updateUIState();
    }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }]},
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function toggleBot() {
        running = !running;
        if(running) {
            initialBal = parseFloat(document.getElementById('balanceInp').value);
            historyLog = [{t: Date.now(), b: initialBal}];
        }
        updateUIState();
        save();
    }

    function updateUIState() {
        const btn = document.getElementById('btnAction');
        btn.innerText = running ? 'Stop' : 'Start';
        btn.className = running ? 'px-6 py-2 rounded font-bold uppercase text-xs bg-red-600' : 'px-6 py-2 rounded font-bold uppercase text-xs bg-green-600';
    }

    function save() { localStorage.setItem('bot_luffy_v3', JSON.stringify({ running, initialBal, historyLog })); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now(); let totalUnPnl = 0;

            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                const livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                const mVal = document.getElementById('marginInp').value;
                const margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                const roi = (h.type === 'UP' ? ((livePrice - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - livePrice)/h.snapPrice)*100) * (h.maxLev);
                const pnl = margin * roi / 100;
                totalUnPnl += pnl;

                return \`
                <div>
                    <div class="flex items-center justify-between mb-4">
                        <div class="flex items-center gap-2">
                            <span class="w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold \${h.type==='UP'?'bg-[#0ecb81]/20 up':'bg-[#f6465d]/20 down'}">\${h.type==='UP'?'L':'S'}</span>
                            <span class="font-bold text-lg">\${h.symbol}</span>
                            <span class="text-zinc-500 text-xs">Vĩnh cửu</span>
                            <span class="bg-[#2b3139] px-1 rounded text-zinc-400 text-[10px] font-medium">Cross \${h.maxLev}X</span>
                        </div>
                        <i class="fas fa-share-alt text-zinc-500"></i>
                    </div>
                    <div class="grid grid-cols-2 mb-4">
                        <div><div class="text-zinc-500 text-xs dot-border inline-block mb-1">PNL (USDT)</div><div class="text-2xl font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</div></div>
                        <div class="text-right"><div class="text-zinc-500 text-xs inline-block mb-1">ROI</div><div class="text-2xl font-bold \${pnl>=0?'up':'down'}">\${roi>=0?'+':''}\${roi.toFixed(2)}%</div></div>
                    </div>
                    <div class="grid grid-cols-3 text-xs mb-3">
                        <div><div class="text-zinc-500 mb-1">Kích thước (USDT)</div><div class="font-medium">\${(margin*h.maxLev).toFixed(2)}</div></div>
                        <div class="text-center"><div class="text-zinc-500 dot-border inline-block mb-1">Margin (USDT)</div><div class="font-medium">\${margin.toFixed(2)}</div></div>
                        <div class="text-right"><div class="text-zinc-500 dot-border inline-block mb-1">Tỉ lệ ký quỹ</div><div class="text-[#0ecb81] font-medium">6.51%</div></div>
                    </div>
                    <div class="grid grid-cols-3 text-xs mb-5">
                        <div><div class="text-zinc-500 dot-border inline-block mb-1">Giá vào lệnh</div><div class="font-medium">\${h.snapPrice.toFixed(4)}</div></div>
                        <div class="text-center"><div class="text-zinc-500 dot-border inline-block mb-1">Giá đánh dấu</div><div class="font-medium text-zinc-300">\${livePrice.toFixed(4)}</div></div>
                        <div class="text-right"><div class="text-zinc-500 dot-border inline-block mb-1">Giá thanh lý</div><div class="font-medium text-orange-200">--</div></div>
                    </div>
                    <div class="grid grid-cols-3 gap-2"><div class="binance-btn">Đòn bẩy</div><div class="binance-btn">TP/SL</div><div class="binance-btn">Đóng</div></div>
                </div>\`;
            }).join('');

            let totalClosedP = 0;
            d.history.forEach(h => {
                const margin = document.getElementById('marginInp').value.includes('%') ? (initialBal * parseFloat(document.getElementById('marginInp').value)/100) : parseFloat(document.getElementById('marginInp').value);
                totalClosedP += (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
            });

            if(running) {
                const currentBal = initialBal + totalClosedP + totalUnPnl;
                document.getElementById('displayBal').innerText = currentBal.toFixed(2);
                document.getElementById('walletBal').innerText = (initialBal + totalClosedP).toFixed(2);
                document.getElementById('unPnl').innerText = totalUnPnl.toFixed(2);
                document.getElementById('unPnl').className = totalUnPnl >= 0 ? 'font-bold up' : 'font-bold down';
                document.getElementById('todayPnl').innerText = \`$\${totalClosedP.toFixed(2)}(\${((totalClosedP/initialBal)*100).toFixed(2)}%)\`;

                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) {
                    historyLog.push({t: now, b: currentBal}); if(historyLog.length > 100) historyLog.shift(); save();
                }
                chart.data.labels = historyLog.map(pt => pt.t); chart.data.datasets[0].data = historyLog.map(pt => pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); });
