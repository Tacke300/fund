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

// --- FETCH LEVERAGE FIX ---
async function fetchActualLeverage() {
    https.get('https://fapi.binance.com/fapi/v1/leverageBracket', (res) => {
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
                console.log(`[SYSTEM] Live Leverage Synced: ${Object.keys(symbolMaxLeverage).length} symbols.`);
            } catch (e) { console.error("Leverage Parse Error"); }
        });
    }).on('error', (e) => { console.error("Binance API Conn Error"); });
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
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastStatusTime: 0 };
            coinData[s].prices.push({ p, t: now });
            
            // Giữ lại 24h data (mỗi 5 phút 1 điểm => 288 điểm)
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1), 
                  c5 = calculateChange(coinData[s].prices, 5), 
                  c15 = calculateChange(coinData[s].prices, 15);
            
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            const active = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (active) {
                const diff = ((p - active.snapPrice) / active.snapPrice) * 100;
                const win = active.type === 'DOWN' ? diff <= -5 : diff >= 5;
                const lose = active.type === 'DOWN' ? diff >= 5 : diff <= -5;
                
                if (win || lose) {
                    active.status = win ? 'WIN' : 'LOSE';
                    active.finalPrice = p; 
                    active.endTime = now; 
                    active.needSound = active.status;
                    coinData[s].lastStatusTime = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            }

            if ((Math.abs(c1) >= 5 || Math.abs(c5) >= 5) && !active) {
                if (now - coinData[s].lastStatusTime >= 600000) {
                    const lev = symbolMaxLeverage[s] || 20;
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapVol: { c1, c5, c15 }, 
                        snapPrice: p, type: (c1+c5 >= 0) ? 'UP' : 'DOWN', 
                        status: 'PENDING', maxLev: lev,
                        sl: (c1+c5 >= 0) ? p * 0.95 : p * 1.05,
                        tp: (c1+c5 >= 0) ? p * 1.05 : p * 0.95
                    });
                }
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    res.json({ 
        live: Object.entries(coinData).map(([s,v])=>({symbol:s,...v.live})).filter(x=>x.currentPrice).slice(0,20),
        history: Array.from(historyMap.values()).sort((a,b)=>b.startTime-a.startTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>BINANCE PRO DASHBOARD</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .up { color: #02c076; } .down { color: #f84960; }
        .bg-card { background: #161a1e; }
        .border-gray { border-color: #2b3139; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #474d57; }
    </style></head>
    <body class="p-4">
        <div class="flex justify-between items-center mb-4">
            <div class="flex items-center gap-4">
                <img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" width="32">
                <h1 class="text-xl font-bold tracking-tight">FUTURES REAL-TIME <span class="text-yellow-400">V2.5</span></h1>
            </div>
            <div id="setup" class="flex gap-2">
                <input id="balanceInp" type="number" value="1000" class="bg-zinc-800 border border-zinc-700 p-1 rounded w-24 text-sm">
                <button onclick="start()" class="bg-yellow-400 text-black px-4 py-1 rounded font-bold text-sm">CONNECT</button>
            </div>
            <div id="active" class="hidden flex gap-6 items-center">
                <div class="text-right">
                    <p class="text-xs text-zinc-500 uppercase">Wallet Balance</p>
                    <p id="displayBal" class="text-2xl font-bold text-yellow-400 leading-none">$0.00</p>
                </div>
                <button onclick="stop()" class="text-zinc-500 hover:text-red-500 text-xs">DISCONNECT</button>
            </div>
        </div>

        <div class="bg-card p-4 rounded-lg border border-gray mb-4">
            <div class="flex justify-between mb-4">
                <div class="flex gap-2" id="timeframes">
                    <button onclick="setTimeframe(24)" class="px-3 py-1 bg-zinc-800 rounded text-xs hover:bg-zinc-700">24H</button>
                    <button onclick="setTimeframe(168)" class="px-3 py-1 bg-zinc-800 rounded text-xs hover:bg-zinc-700">7D</button>
                    <button onclick="setTimeframe(720)" class="px-3 py-1 bg-zinc-800 rounded text-xs hover:bg-zinc-700">30D</button>
                </div>
                <div class="flex gap-8 text-xs font-bold">
                    <div id="stat24">24h PNL: --</div>
                    <div id="stat7">7d PNL: --</div>
                </div>
            </div>
            <div style="height: 180px;"><canvas id="mainChart"></canvas></div>
        </div>

        <div class="mb-4">
            <div class="flex items-center gap-2 mb-2">
                <span class="bg-yellow-400 text-black px-2 py-0.5 rounded text-[10px] font-bold">POSITIONS</span>
                <span id="posCount" class="text-xs text-zinc-400">(0)</span>
            </div>
            <div class="bg-card rounded border border-gray overflow-hidden">
                <table class="w-full text-left text-[11px]">
                    <thead class="bg-zinc-800 text-zinc-400">
                        <tr>
                            <th class="p-2">Symbol</th><th class="p-2">Size</th><th class="p-2">Entry/Mark</th>
                            <th class="p-2">Liq. Price</th><th class="p-2">Margin</th><th class="p-2">PNL (ROI%)</th>
                        </tr>
                    </thead>
                    <tbody id="posBody"></tbody>
                </table>
            </div>
        </div>

        <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 bg-card rounded border border-gray">
                <div class="p-2 border-b border-gray text-xs font-bold text-zinc-500 uppercase">Trade History</div>
                <div class="max-h-60 overflow-y-auto">
                    <table class="w-full text-[11px] text-left">
                        <thead class="sticky top-0 bg-zinc-900">
                            <tr><th class="p-2">Time (Start/End)</th><th class="p-2">Symbol</th><th class="p-2">Side</th><th class="p-2 text-right">Final PNL</th></tr>
                        </thead>
                        <tbody id="historyBody"></tbody>
                    </table>
                </div>
            </div>
        </div>

    <script>
        let running = false, initialBal = 1000, currentBal = 1000, balanceHistory = [];
        let timeframeHours = 24;
        const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

        const ctx = document.getElementById('mainChart').getContext('2d');
        const chart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [{ data: [], borderColor: '#f0b90b', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(240,185,11,0.05)', tension: 0.1 }]},
            options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#2b3139' }, ticks: { font: { size: 10 } } } } }
        });

        function start() { 
            running = true; 
            initialBal = parseFloat(document.getElementById('balanceInp').value);
            document.getElementById('setup').classList.add('hidden');
            document.getElementById('active').classList.remove('hidden');
        }

        async function update() {
            const res = await fetch('/api/data');
            const d = await res.json();
            
            // 1. Xử lý Vị thế & History
            let openPos = d.history.filter(h => h.status === 'PENDING');
            let closedPos = d.history.filter(h => h.status !== 'PENDING');
            
            document.getElementById('posCount').innerText = \`(\${openPos.length})\`;
            
            let totalPnl = 0;
            let posHtml = '';
            
            openPos.forEach(p => {
                const coin = d.live.find(l => l.symbol === p.symbol);
                const markPrice = coin ? coin.currentPrice : p.snapPrice;
                const diff = ((markPrice - p.snapPrice) / p.snapPrice) * 100;
                const roi = (p.type === 'UP' ? diff : -diff) * p.maxLev;
                const margin = initialBal * 0.1; // Giả định margin 10%
                const pnl = margin * (roi / 100);
                const liq = p.type === 'UP' ? p.snapPrice * (1 - 0.8/p.maxLev) : p.snapPrice * (1 + 0.8/p.maxLev);

                posHtml += \`<tr class="border-b border-gray">
                    <td class="p-2"><span class="font-bold">\${p.symbol}</span> <span class="bg-zinc-700 px-1 rounded text-yellow-500">\${p.maxLev}x</span></td>
                    <td class="p-2 \${p.type==='UP'?'up':'down'}">\${p.type==='UP'?'LONG':'SHORT'}</td>
                    <td class="p-2">\${p.snapPrice.toFixed(4)} / <span class="text-zinc-400">\${markPrice.toFixed(4)}</span></td>
                    <td class="p-2 text-orange-400">\${liq.toFixed(4)}</td>
                    <td class="p-2">\${margin.toFixed(2)}</td>
                    <td class="p-2 \${roi>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}$ (\${roi.toFixed(2)}%)</td>
                </tr>\`;
                totalPnl += pnl;
            });
            document.getElementById('posBody').innerHTML = posHtml;

            // 2. Lịch sử giao dịch
            let histHtml = '';
            let histPnlSum = 0;
            closedPos.forEach(h => {
                const margin = initialBal * 0.1;
                const pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                histPnlSum += pnl;
                histHtml += \`<tr class="border-b border-zinc-900 opacity-70">
                    <td class="p-2 text-zinc-500">\${new Date(h.startTime).toLocaleTimeString()} -> \${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td class="p-2 font-bold \${h.type==='UP'?'up':'down'}">\${h.symbol}</td>
                    <td class="p-2">\${h.type}</td>
                    <td class="p-2 text-right font-bold \${pnl>0?'up':'down'}">\${pnl.toFixed(2)}$</td>
                </tr>\`;
            });
            document.getElementById('historyBody').innerHTML = histHtml;

            // 3. Cập nhật Balance & Chart
            if(running) {
                currentBal = initialBal + histPnlSum + totalPnl;
                document.getElementById('displayBal').innerText = '$' + currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                
                balanceHistory.push({t: Date.now(), v: currentBal});
                const cutoff = Date.now() - (timeframeHours * 3600000);
                const filteredHistory = balanceHistory.filter(h => h.t >= cutoff);
                
                chart.data.labels = filteredHistory.map(h => '');
                chart.data.datasets[0].data = filteredHistory.map(h => h.v);
                chart.update('none');
            }
        }

        function setTimeframe(h) { timeframeHours = h; }
        setInterval(update, 1000);
    </script>
    </body></html>`);
});

app.listen(port, '0.0.0.0', () => { initWS(); });
