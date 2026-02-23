import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 

// --- KHÔI PHỤC LOGIC LẤY ĐÒN BẨY THỰC TẾ ---
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
                const newMap = {};
                if (Array.isArray(brackets)) {
                    brackets.forEach(item => {
                        if (item.symbol && item.brackets?.length > 0) {
                            newMap[item.symbol] = item.brackets[0].initialLeverage;
                        }
                    });
                    symbolMaxLeverage = newMap;
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(newMap));
                }
            } catch (e) {}
        });
    });
}

if (fs.existsSync(LEVERAGE_FILE)) {
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch (e) {}
}
fetchActualLeverage();
setInterval(fetchActualLeverage, 3600000);

// --- LOGIC LƯU TRỮ ---
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
        try {
            const tickers = JSON.parse(data);
            const now = Date.now();
            tickers.forEach(t => {
                const s = t.s, p = parseFloat(t.c);
                if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastStatusTime: 0 };
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

                if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                    if (!pending && (now - coinData[s].lastStatusTime >= 900000)) {
                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: now, snapVol: { c1, c5, c15 }, 
                            snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                            status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || NaN 
                        });
                    }
                }
            });
        } catch (e) {}
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,50),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.startTime-a.startTime).slice(0,100)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BINANCE PRO V2.4.4</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #181a20; color: #eaecef; font-family: 'Inter', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #2b3139; }
        .btn-binance { background: #2b3139; color: #eaecef; font-size: 11px; padding: 8px; border-radius: 4px; text-align: center; font-weight: 600; }
        .tab-active { border-bottom: 2px solid #fcd535; color: #fcd535; }
    </style></head><body class="p-4">
    <div class="flex justify-between items-center mb-4">
        <div class="flex items-center gap-2">
            <img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" width="24">
            <h1 class="text-xl font-bold uppercase tracking-tight text-white">BINANCE <span class="text-[#fcd535]">PRO</span></h1>
            <span class="ml-4 text-sm font-semibold text-zinc-400">Moncey_D_Luffy</span>
        </div>
        <div id="setup" class="flex gap-2">
            <input id="balanceInp" type="number" value="1000" class="bg-[#2b3139] p-1 rounded w-24 text-[#fcd535] outline-none">
            <input id="marginInp" type="text" value="10%" class="bg-[#2b3139] p-1 rounded w-20 text-[#fcd535] outline-none">
            <button onclick="start()" class="bg-[#fcd535] text-black px-4 py-1 rounded font-bold uppercase text-xs">Start</button>
        </div>
    </div>

    <div class="grid grid-cols-12 gap-4 mb-4">
        <div class="col-span-8 bg-card p-4 rounded-lg">
            <div class="flex justify-between mb-4">
                <div><div class="text-zinc-500 text-xs">Equity (07:00 AM Reset)</div><div id="displayBal" class="text-4xl font-bold text-white leading-tight">$0.00</div></div>
                <div class="flex gap-4 text-xs font-bold text-center">
                    <div class="bg-[#2b3139] p-3 rounded-md w-28"><div>TODAY</div><div id="stat24" class="mt-1 text-zinc-400">---</div></div>
                    <div class="bg-[#2b3139] p-3 rounded-md w-28"><div>7 DAYS</div><div id="stat7" class="mt-1 text-zinc-400">---</div></div>
                </div>
            </div>
            <div style="height: 200px;"><canvas id="mainChart"></canvas></div>
        </div>
        <div class="col-span-4 bg-card rounded-lg flex flex-col h-[320px]">
            <div class="p-3 font-bold text-xs border-b border-[#2b3139] uppercase">Volatility (1m | 5m | 15m)</div>
            <div class="overflow-y-auto flex-1"><table class="w-full text-xs"><tbody id="liveBody"></tbody></table></div>
        </div>
    </div>

    <div class="mb-6">
        <div class="flex gap-6 mb-2 text-sm font-bold border-b border-[#2b3139] pb-2">
            <div class="tab-active cursor-pointer">Vị thế (<span id="posCount">0</span>)</div>
            <div class="text-zinc-500 cursor-pointer">Lệnh chờ (0)</div>
        </div>
        <div id="pendingContainer" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
    </div>

    <div class="bg-card rounded-lg flex flex-col h-[400px]">
        <div class="p-3 font-bold text-xs border-b border-[#2b3139] uppercase italic text-[#fcd535]">History Log (WIN/LOSE ONLY)</div>
        <div class="overflow-y-auto flex-1 font-mono text-[11px]"><table class="w-full text-left"><thead class="text-zinc-500 sticky top-0 bg-[#1e2329] border-b border-[#2b3139]"><tr><th class="p-3">TIME</th><th class="p-3">COIN/MAXLEV</th><th class="p-3">SNAP VOL</th><th class="p-3 text-right">PNL ($)</th><th class="p-3 text-right">STATUS</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div>

    <script>
    let running = false, currentBal = 0, initialBal = 0, historyLog = [];
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

    if(localStorage.getItem('bot_luffy_v3')) {
        const s = JSON.parse(localStorage.getItem('bot_luffy_v3'));
        running = s.running; initialBal = s.initialBal; currentBal = s.currentBal; historyLog = s.historyLog;
        if(running) { document.getElementById('setup').style.display='none'; }
    }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: historyLog.map((_,i)=>i), datasets: [{ data: historyLog, borderColor: '#fcd535', tension: 0.3, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }]},
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#2b3139' } } } }
    });

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); currentBal = initialBal; historyLog = [initialBal]; document.getElementById('setup').style.display='none'; save(); }
    function save() { localStorage.setItem('bot_luffy_v3', JSON.stringify({ running, initialBal, currentBal, historyLog })); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const dayStart = new Date().setHours(7,0,0,0);
            
            document.getElementById('liveBody').innerHTML = d.live.map(c => \`
                <tr class="border-b border-[#2b3139]"><td class="p-2 font-bold">\${c.symbol}</td><td class="\${c.c1>=0?'up':'down'} p-2">\${c.c1}%</td><td class="\${c.c5>=0?'up':'down'} p-2">\${c.c5}%</td><td class="\${c.c15>=0?'up':'down'} p-2 text-right">\${c.c15}%</td></tr>\`).join('');

            document.getElementById('posCount').innerText = d.pending.length;
            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                const livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                const mVal = document.getElementById('marginInp').value;
                const margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                const diff = ((livePrice - h.snapPrice) / h.snapPrice) * 100;
                const roi = (h.type === 'UP' ? diff : -diff) * h.maxLev;
                const pnl = margin * roi / 100;
                const size = margin * h.maxLev;

                return \`
                <div class="bg-card p-4 rounded-lg">
                    <div class="flex justify-between items-center mb-3">
                        <div class="flex items-center gap-1 font-bold text-sm"><span class="\${h.type==='UP'?'up':'down'}">\${h.type==='UP'?'L':'S'}</span> \${h.symbol} <span class="text-[11px] font-normal text-zinc-500">Vĩnh cửu Cross \${h.maxLev || 'NaN'}X</span></div>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="text-zinc-500"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
                    </div>
                    <div class="flex justify-between mb-4">
                        <div><div class="text-[11px] text-zinc-500">PNL (USDT)</div><div class="text-xl font-bold \${pnl>=0?'up':'down'}">\${isNaN(pnl)?'NaN':pnl.toFixed(2)}</div></div>
                        <div class="text-right"><div class="text-[11px] text-zinc-500 text-right">ROI</div><div class="text-xl font-bold \${roi>=0?'up':'down'}">\${isNaN(roi)?'NaN':roi.toFixed(2)}%</div></div>
                    </div>
                    <div class="grid grid-cols-2 gap-4 text-[11px] mb-4">
                        <div class="flex justify-between"><span class="text-zinc-500">Kích thước (USDT)</span> <span class="text-white font-medium">\${size.toFixed(2)}</span></div>
                        <div class="flex justify-between"><span class="text-zinc-500 pl-4">Margin (USDT)</span> <span class="text-white font-medium">\${margin.toFixed(2)}</span></div>
                        <div class="flex justify-between"><span class="text-zinc-500">Giá vào lệnh</span> <span class="text-white font-medium">\${h.snapPrice.toFixed(4)}</span></div>
                        <div class="flex justify-between"><span class="text-zinc-500 pl-4">Giá đánh dấu</span> <span class="text-white font-medium">\${livePrice.toFixed(4)}</span></div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 mt-4">
                        <div class="btn-binance">Đòn bẩy</div><div class="btn-binance">TP/SL</div><div class="btn-binance">Đóng</div>
                    </div>
                </div>\`;
            }).join('');

            let totalPnl = 0, wDay=0, lDay=0, pDay=0;
            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                const mVal = document.getElementById('marginInp').value;
                const margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                const pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                if(running) { 
                    totalPnl += isNaN(pnl)?0:pnl;
                    if(h.startTime >= dayStart) { h.status === 'WIN' ? wDay++ : lDay++; pDay += isNaN(pnl)?0:pnl; }
                    if(h.needSound) { winSnd.play(); delete h.needSound; }
                }
                return \`<tr class="border-b border-[#2b3139] text-zinc-400">
                    <td class="p-3">\${new Date(h.startTime).toLocaleTimeString()}</td>
                    <td class="p-3 font-bold text-white">\${h.symbol} \${h.maxLev || 'NaN'}x</td>
                    <td class="p-3">[\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}]</td>
                    <td class="p-3 text-right font-bold \${pnl>=0?'up':'down'}">\${isNaN(pnl)?'NaN':pnl.toFixed(1)+'$'}</td>
                    <td class="p-3 text-right font-black \${h.status==='WIN'?'up':'down'}">\${h.status}</td>
                </tr>\`;
            }).join('');

            if(running) {
                currentBal = initialBal + totalPnl;
                document.getElementById('displayBal').innerText = '$' + currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('stat24').innerHTML = \`<span class="text-[#0ecb81]">\${wDay}W</span>-<span class="text-[#f6465d]">\${lDay}L</span><br>\${pDay.toFixed(1)}$\`;
                historyLog.push(currentBal); if(historyLog.length > 60) historyLog.shift();
                chart.update('none'); save();
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(port, '0.0.0.0', () => { initWS(); });
