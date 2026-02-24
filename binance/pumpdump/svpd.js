import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let chartData = []; 

// --- LOGIC BACK-CHECK (KIỂM TRA NẾN CŨ) ---
async function backCheckPending(pending) {
    const symbol = pending.symbol;
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${pending.startTime}&limit=1000`;
    https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const klines = JSON.parse(data);
                for (let k of klines) {
                    const high = parseFloat(k[2]), low = parseFloat(k[3]), time = k[0];
                    const diffHigh = ((high - pending.snapPrice) / pending.snapPrice) * 100;
                    const diffLow = ((low - pending.snapPrice) / pending.snapPrice) * 100;
                    let isWin = pending.type === 'UP' ? diffHigh >= 5 : diffLow <= -5;
                    let isLose = pending.type === 'UP' ? diffLow <= -5 : diffHigh >= 5;
                    if (isWin || isLose) {
                        pending.status = isWin ? 'WIN' : 'LOSE';
                        pending.endTime = time;
                        pending.finalPrice = isWin ? (pending.type === 'UP' ? pending.snapPrice * 1.05 : pending.snapPrice * 0.95) : (pending.type === 'UP' ? pending.snapPrice * 0.95 : pending.snapPrice * 1.05);
                        pending.needSound = pending.status;
                        fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                        break; 
                    }
                }
            } catch (e) {}
        });
    });
}

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
                    brackets.forEach(item => { symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage; });
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                    historyMap.forEach((val) => { if (val.status === 'PENDING') { val.maxLev = symbolMaxLeverage[val.symbol] || null; backCheckPending(val); } });
                }
            } catch (e) {}
        });
    });
}

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) { try { const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE)); savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h)); } catch (e) {} }

function initWS() {
    fetchActualLeverage();
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastStatusTime: 0 };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 60) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'DOWN' ? diff <= -5 : diff >= 5;
                const lose = pending.type === 'DOWN' ? diff >= 5 : diff <= -5;
                if (win || lose) { pending.status = win ? 'WIN' : 'LOSE'; pending.finalPrice = p; pending.endTime = now; pending.needSound = pending.status; coinData[s].lastStatusTime = now; fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); }
            }
            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                if (!pending && (now - coinData[s].lastStatusTime >= 900000)) {
                    historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapVol: { c1, c5, c15 }, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', maxLev: symbolMaxLeverage[s] || null });
                }
            }
        });
    });
}

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const targetTime = priceArray[priceArray.length - 1].t - minutes * 60000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    return startPriceObj ? parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2)) : 0;
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,30),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.startTime-a.startTime).slice(0,50)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>LUFFY BINANCE MOBILE</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 8px 0; font-size: 12px; font-weight: 500; text-align: center; }
        input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    </style></head><body class="pb-20">
    
    <div class="sticky top-0 z-50 bg-[#0b0e11] p-3 border-b border-zinc-800">
        <div class="flex justify-between items-center mb-3">
            <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="text-md font-bold italic tracking-tighter">BINANCE <span class="text-[#fcd535]">PRO</span></h1></div>
            <div id="active" class="hidden text-[#fcd535] font-black italic text-xs">MONCEY_D_LUFFY</div>
        </div>
        <div id="setup" class="flex gap-2 bg-[#1e2329] p-2 rounded-lg border border-zinc-700">
            <div class="flex-1"><label class="block text-[8px] text-zinc-500 uppercase font-bold ml-1">Vốn (USDT)</label><input id="balanceInp" type="number" value="1000" class="bg-transparent text-white text-sm font-bold w-full outline-none px-1"></div>
            <div class="flex-1 border-l border-zinc-700 pl-2"><label class="block text-[8px] text-zinc-500 uppercase font-bold ml-1">Margin (%)</label><input id="marginInp" type="text" value="10%" class="bg-transparent text-white text-sm font-bold w-full outline-none px-1"></div>
            <button onclick="start()" class="bg-[#fcd535] text-black px-6 rounded font-black text-[10px] uppercase italic">Start</button>
        </div>
    </div>

    <div class="p-3">
        <div class="flex justify-between items-end mb-1">
            <div><div class="text-zinc-500 text-[10px] uppercase font-bold">Total Equity</div><div id="displayBal" class="text-3xl font-bold text-white italic tracking-tighter">$0.00</div></div>
            <div class="text-right"><div id="stat24" class="text-[10px] font-bold">---</div><div class="text-[9px] text-zinc-500 uppercase">Today PNL</div></div>
        </div>
        <div style="height: 140px;" class="mt-2"><canvas id="mainChart"></canvas></div>
    </div>

    <div class="bg-[#0b0e11] px-3 mb-4">
        <div class="flex items-center gap-2 mb-2 text-[10px] font-bold text-zinc-500 uppercase italic border-b border-zinc-800 pb-1"><span>Vị thế đang mở</span><span id="pCount" class="text-[#fcd535]">0</span></div>
        <div id="pendingContainer" class="space-y-3"></div>
    </div>

    <div class="px-3 grid grid-cols-2 gap-2 mb-4">
        <div class="bg-card rounded-lg p-2 h-[300px] flex flex-col overflow-hidden">
            <div class="text-[10px] font-bold mb-2 text-zinc-400 uppercase">Biến động</div>
            <div class="overflow-y-auto flex-1 text-[10px]"><table class="w-full text-left"><tbody id="liveBody"></tbody></table></div>
        </div>
        <div class="bg-card rounded-lg p-2 h-[300px] flex flex-col overflow-hidden">
            <div class="text-[10px] font-bold mb-2 text-[#fcd535] uppercase italic">Lịch sử</div>
            <div id="historyBody" class="overflow-y-auto flex-1 space-y-2"></div>
        </div>
    </div>

    <script>
    let running = false, currentBal = 0, initialBal = 0, historyLog = [];
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

    if(localStorage.getItem('bot_luffy_v3')) {
        const s = JSON.parse(localStorage.getItem('bot_luffy_v3'));
        running = s.running; initialBal = s.initialBal; currentBal = s.currentBal; historyLog = s.historyLog || [];
        if(running) { document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }]},
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1e2329' }, ticks: { font: { size: 9 } } } } }
    });

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); currentBal = initialBal; historyLog = [{t: Date.now(), b: initialBal}]; document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); save(); }
    function save() { localStorage.setItem('bot_luffy_v3', JSON.stringify({ running, initialBal, currentBal, historyLog })); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            
            document.getElementById('liveBody').innerHTML = d.live.map(c => \`
                <tr class="border-b border-[#2b3139]"><td class="py-1 font-bold text-white">\${c.symbol.replace('USDT','')}</td><td class="\${c.c1>=0?'up':'down'}">\${c.c1}%</td></tr>\`).join('');

            let totalUnPnl = 0;
            document.getElementById('pCount').innerText = d.pending.length;
            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                const livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                const mVal = document.getElementById('marginInp').value;
                const margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                const roi = (h.type === 'UP' ? ((livePrice - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - livePrice)/h.snapPrice)*100) * (h.maxLev||0);
                const pnl = margin * roi / 100;
                totalUnPnl += pnl;

                return \`
                <div class="bg-[#1e2329] p-3 rounded-lg">
                    <div class="flex items-center gap-2 mb-3">
                        <span class="px-1 rounded text-[10px] font-black \${h.type==='UP'?'bg-[#0ecb81]/20 up':'bg-[#f6465d]/20 down'}">\${h.type==='UP'?'LONG':'SHORT'}</span>
                        <span class="font-bold text-sm">\${h.symbol}</span>
                        <span class="bg-[#2b3139] px-1 rounded text-zinc-500 text-[10px]">Cross \${h.maxLev||'--'}X</span>
                    </div>
                    <div class="grid grid-cols-2 mb-3">
                        <div><div class="text-zinc-500 text-[11px]">PNL (USDT)</div><div class="text-xl font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</div></div>
                        <div class="text-right"><div class="text-zinc-500 text-[11px]">ROI</div><div class="text-xl font-bold \${pnl>=0?'up':'down'}">\${roi.toFixed(2)}%</div></div>
                    </div>
                    <div class="grid grid-cols-2 text-[11px] mb-1"><div class="text-zinc-500">Kích thước (USDT)</div><div class="text-right text-zinc-200">\${(margin*(h.maxLev||0)).toFixed(1)}</div></div>
                    <div class="grid grid-cols-2 text-[11px] mb-1"><div class="text-zinc-500">Ký quỹ (USDT)</div><div class="text-right text-zinc-200">\${margin.toFixed(2)}</div></div>
                    <div class="grid grid-cols-2 text-[11px] mb-4 border-t border-zinc-800 pt-2"><div class="text-zinc-500">Giá vào / Đánh dấu</div><div class="text-right text-zinc-200">\${h.snapPrice.toFixed(4)} / \${livePrice.toFixed(4)}</div></div>
                    <div class="grid grid-cols-3 gap-2">
                        <div class="binance-btn">Đòn bẩy</div><div class="binance-btn">TP/SL</div><div class="binance-btn">Đóng</div>
                    </div>
                </div>\`;
            }).join('');

            let totalClosedP = 0, p24=0;
            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                const margin = document.getElementById('marginInp').value.includes('%') ? (initialBal * parseFloat(document.getElementById('marginInp').value)/100) : parseFloat(document.getElementById('marginInp').value);
                const pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                if(running) { 
                    totalClosedP += pnl;
                    if(h.startTime >= now - 86400000) p24 += pnl;
                    if(h.needSound) { winSnd.play(); delete h.needSound; }
                }
                return \`<div class="border-b border-zinc-800 pb-1 text-[10px] flex justify-between italic">
                    <span class="text-zinc-500">\${h.symbol}</span>
                    <span class="\${pnl>=0?'up':'down'} font-bold">\${pnl>=0?'+':''}\${pnl.toFixed(1)}$ (\${h.status})</span>
                </div>\`;
            }).join('');

            if(running) {
                currentBal = initialBal + totalClosedP + totalUnPnl;
                document.getElementById('displayBal').innerText = '$' + currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('stat24').innerHTML = \`<span class="\${p24>=0?'up':'down'}">\${p24>=0?'+':''}\${p24.toFixed(1)}$</span>\`;
                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) {
                    historyLog.push({t: now, b: currentBal}); if(historyLog.length > 1440) historyLog.shift(); save();
                }
                chart.data.labels = historyLog.map(pt => pt.t); chart.data.datasets[0].data = historyLog.map(pt => pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(port, '0.0.0.0', () => { initWS(); });
