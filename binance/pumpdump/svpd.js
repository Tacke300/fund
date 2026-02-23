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

// --- FIX ĐÒN BẨY: LẤY ĐÚNG TỪ BINANCE ---
async function fetchActualLeverage() {
    https.get('https://fapi.binance.com/fapi/v1/leverageBracket', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                brackets.forEach(item => {
                    if (item.brackets && item.brackets.length > 0) {
                        symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                    }
                });
                console.log(`[SYSTEM] Đã đồng bộ đòn bẩy cho ${Object.keys(symbolMaxLeverage).length} mã.`);
            } catch (e) { console.error("Lỗi parse Leverage"); }
        });
    }).on('error', (e) => { console.error("Lỗi API Binance"); });
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
            
            // Lưu dữ liệu giá mỗi 5 phút cho biểu đồ 24h (288 điểm)
            if (!coinData[s].lastChartPush || now - coinData[s].lastChartPush > 300000) {
                coinData[s].prices.push({ p, t: now });
                coinData[s].lastChartPush = now;
                if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            } else {
                // Vẫn cập nhật giá mới nhất để tính c1, c5
                if (coinData[s].prices.length > 0) coinData[s].prices[coinData[s].prices.length-1] = {p, t: now};
                else coinData[s].prices.push({p, t: now});
            }

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

            // Logic vào lệnh gốc của bạn
            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                if (!pending && (now - coinData[s].lastStatusTime >= 900000)) {
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapVol: { c1, c5, c15 }, 
                        snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                        status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20 
                    });
                }
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,50),
        history: Array.from(historyMap.values()).sort((a,b)=>b.startTime-a.startTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BINANCE TERMINAL V2.5</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #000; color: #eee; font-family: sans-serif; }
        .up { color: #22c55e; } .down { color: #f43f5e; }
        .bg-card { background: #0a0a0a; border: 1px solid #27272a; }
    </style></head>
    <body class="p-4">
    <div class="flex justify-between items-center mb-4">
        <h1 class="text-2xl font-black italic text-yellow-500">BINANCE PRO <span class="text-white text-xs not-italic">V2.5.0</span></h1>
        <div id="setup" class="flex gap-2">
            <input id="balanceInp" type="number" value="1000" class="bg-zinc-900 p-2 rounded w-24 border border-zinc-700">
            <input id="marginInp" type="text" value="10%" class="bg-zinc-900 p-2 rounded w-24 border border-zinc-700">
            <button onclick="start()" class="bg-yellow-500 text-black px-6 py-2 rounded font-bold">START</button>
        </div>
        <div id="active" class="hidden text-right font-mono"><div id="displayBal" class="text-4xl font-bold">$0.00</div></div>
    </div>

    <div class="bg-card p-4 rounded mb-6">
        <div class="flex justify-between items-center mb-2">
            <div class="flex gap-2 text-[10px]">
                <button onclick="setTF(24)" class="bg-zinc-800 px-3 py-1 rounded hover:bg-yellow-500 hover:text-black">24H</button>
                <button onclick="setTF(168)" class="bg-zinc-800 px-3 py-1 rounded hover:bg-yellow-500 hover:text-black">7D</button>
                <button onclick="setTF(720)" class="bg-zinc-800 px-3 py-1 rounded hover:bg-yellow-500 hover:text-black">30D</button>
            </div>
            <div class="flex gap-4 text-[10px] font-bold">
                <div id="stat24">TODAY: --</div><div id="stat7">7 DAYS: --</div>
            </div>
        </div>
        <div style="height: 200px;"><canvas id="mainChart"></canvas></div>
    </div>

    <div class="mb-6">
        <div class="bg-zinc-900 p-2 text-xs font-bold border-l-4 border-yellow-500 mb-2 flex justify-between">
            <span>OPEN POSITIONS (<span id="posCount">0</span>)</span>
        </div>
        <div class="bg-card rounded overflow-hidden">
            <table class="w-full text-[11px] text-left">
                <thead class="bg-zinc-800 text-zinc-500">
                    <tr><th class="p-2">Symbol</th><th class="p-2">Size</th><th class="p-2">Entry/Mark</th><th class="p-2">Liq.Price</th><th class="p-2">Margin</th><th class="p-2 text-right">PNL (ROI%)</th></tr>
                </thead>
                <tbody id="posBody"></tbody>
            </table>
        </div>
    </div>

    <div class="grid grid-cols-12 gap-4">
        <div class="col-span-4 bg-card rounded h-[400px] overflow-hidden flex flex-col">
            <div class="p-2 bg-zinc-900 text-[10px] font-bold uppercase">Volatility Heatmap</div>
            <div class="overflow-y-auto flex-1"><table class="w-full text-[10px] text-left"><tbody id="liveBody"></tbody></table></div>
        </div>
        <div class="col-span-8 bg-card rounded h-[400px] overflow-hidden flex flex-col">
            <div class="p-2 bg-zinc-900 text-[10px] font-bold uppercase">Trade History</div>
            <div class="overflow-y-auto flex-1">
                <table class="w-full text-[11px] text-left">
                    <thead class="sticky top-0 bg-black text-zinc-500 border-b border-zinc-800">
                        <tr><th class="p-2">Time (Open/Close)</th><th class="p-2">Symbol</th><th class="p-2">Side</th><th class="p-2 text-right">Result</th></tr>
                    </thead>
                    <tbody id="historyBody" class="font-mono"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let running = false, initialBal = 0, currentBal = 0, historyLog = [], tf = 24;
        const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

        const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
            type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#F3BA2F', tension: 0.2, pointRadius: 2, pointBackgroundColor:'#F3BA2F', fill: true, backgroundColor: 'rgba(243,186,47,0.05)' }]},
            options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1a1a1a' } } } }
        });

        function start() { 
            running = true; 
            initialBal = parseFloat(document.getElementById('balanceInp').value); 
            currentBal = initialBal;
            document.getElementById('setup').style.display='none'; 
            document.getElementById('active').classList.remove('hidden'); 
        }

        function setTF(h) { tf = h; }

        async function update() {
            try {
                const res = await fetch('/api/data'); const d = await res.json();
                
                // 1. Cập nhật Volatility Heatmap
                document.getElementById('liveBody').innerHTML = d.live.map(c => `
                    <tr class="border-b border-zinc-900"><td class="p-2 font-bold">\${c.symbol}</td><td class="\${c.c1>=0?'up':'down'} p-2">\${c.c1}%</td><td class="\${c.c5>=0?'up':'down'} p-2">\${c.c5}%</td><td class="p-2 text-right font-mono">\${c.currentPrice.toFixed(4)}</td></tr>
                `).join('');

                let totalClosedPnl = 0, openPnl = 0, pendingCount = 0;
                let dayPnl = 0, weekPnl = 0;
                const now = Date.now();

                // 2. Xử lý Lịch sử & Vị thế
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

                        posHtml += `<tr class="border-b border-zinc-900">
                            <td class="p-2 font-bold \${h.type==='UP'?'up':'down'}">\${h.symbol} <span class="text-zinc-500 font-normal">Cross \${h.maxLev}x</span></td>
                            <td class="p-2 \${h.type==='UP'?'up':'down'} font-bold">\${h.type==='UP'?'LONG':'SHORT'}</td>
                            <td class="p-2 text-zinc-400">\${h.snapPrice.toFixed(4)} / \${curP.toFixed(4)}</td>
                            <td class="p-2 text-orange-400">\${(h.type==='UP'?h.snapPrice*0.8:h.snapPrice*1.2).toFixed(4)}</td>
                            <td class="p-2">\${margin.toFixed(2)}</td>
                            <td class="p-2 text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}$ (\${roi.toFixed(1)}%)</td>
                        </tr>`;
                    } else {
                        const pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                        totalClosedPnl += pnl;
                        if (now - h.startTime < 86400000) dayPnl += pnl;
                        if (now - h.startTime < 604800000) weekPnl += pnl;

                        histHtml += `<tr class="border-b border-zinc-900 opacity-60">
                            <td class="p-2 text-[10px] text-zinc-500">\${new Date(h.startTime).toLocaleTimeString()} / \${new Date(h.endTime).toLocaleTimeString()}</td>
                            <td class="p-2 font-bold \${h.type==='UP'?'up':'down'}">\${h.symbol}</td>
                            <td class="p-2 \${h.type==='UP'?'up':'down'}">\${h.type}</td>
                            <td class="p-2 text-right font-bold \${pnl>0?'up':'down'}">\${pnl.toFixed(2)}$ (\${h.status})</td>
                        </tr>`;
                        if(h.needSound) { winSnd.play(); delete h.needSound; }
                    }
                });

                document.getElementById('posBody').innerHTML = posHtml;
                document.getElementById('historyBody').innerHTML = histHtml;
                document.getElementById('posCount').innerText = pendingCount;

                if (running) {
                    currentBal = initialBal + totalClosedPnl + openPnl;
                    document.getElementById('displayBal').innerText = '$' + currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                    document.getElementById('stat24').innerText = 'TODAY: ' + dayPnl.toFixed(2) + '$';
                    document.getElementById('stat7').innerText = '7 DAYS: ' + weekPnl.toFixed(2) + '$';
                    
                    historyLog.push({t: now, v: currentBal});
                    const cutoff = now - (tf * 3600000);
                    const filtered = historyLog.filter(x => x.t >= cutoff);
                    
                    chart.data.labels = filtered.map(x => new Date(x.t).toLocaleTimeString());
                    chart.data.datasets[0].data = filtered.map(x => x.v);
                    chart.update('none');
                }
            } catch(e) {}
        }
        setInterval(update, 2000);
    </script></body></html>`);
});

app.listen(port, '0.0.0.0', () => { initWS(); });
