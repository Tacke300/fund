const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 1440; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 100.0, currentMinVol = 6.5;

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
    const now = pArr[pArr.length - 1].t;
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
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'UP' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) {
                    pending.maxNegativeRoi = currentRoi;
                }
                const lastPrice = pending.dcaHistory[pending.dcaHistory.length - 1].p;
                const triggerDCA = pending.type === 'UP' ? ((p - lastPrice) / lastPrice) * 100 <= -pending.slTarget : ((p - lastPrice) / lastPrice) * 100 >= pending.slTarget;
                if (triggerDCA) {
                    const newCount = pending.dcaCount + 1;
                    pending.avgPrice = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                    pending.dcaCount = newCount;
                    pending.dcaHistory.push({ t: now, p: p, avg: pending.avgPrice });
                }
                const win = pending.type === 'UP' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) { 
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'UP' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !pending && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                    maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: now, p: p, avg: p }]
                });
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp) || 0.5; currentSL = parseFloat(req.query.sl) || 10.0; currentMinVol = parseFloat(req.query.vol) || 5;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
    </style></head><body class="p-4">
    
    <div class="mb-4 bg-card p-4 rounded-lg">
        <div id="setup" class="grid grid-cols-2 gap-2">
            <input id="balanceInp" type="number" placeholder="Vốn" class="bg-black p-2 rounded text-yellow-500 font-bold outline-none">
            <input id="marginInp" type="text" placeholder="Margin (Ví dụ: 10%)" class="bg-black p-2 rounded text-yellow-500 font-bold outline-none">
            <button onclick="start()" class="col-span-2 bg-yellow-500 text-black py-2 rounded font-bold">CHẠY BOT</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center">
            <span class="font-bold text-xl text-yellow-500 italic">LUFFY PRO ACTIVE</span>
            <button onclick="stop()" class="bg-red-500 px-3 py-1 rounded text-xs font-bold">STOP</button>
        </div>
    </div>

    <div class="bg-card rounded-xl p-4 mb-4">
        <div class="text-[11px] font-bold text-yellow-500 mb-2 uppercase italic">Biến động tài sản thực tế</div>
        <div style="height: 180px;"><canvas id="balanceChart"></canvas></div>
    </div>

    <div class="bg-card rounded-xl p-4 mb-4">
        <div class="text-[11px] font-bold text-white mb-3 uppercase flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-400 border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div>

    <div id="historySection" class="bg-card rounded-xl p-4 mb-4">
        <div class="text-[11px] font-bold text-gray-400 mb-3 uppercase flex justify-between items-center">
            <span>Nhật ký giao dịch</span>
            <button id="clearFilterBtn" onclick="setFilter(null)" class="hidden bg-yellow-500 text-black px-2 py-0.5 rounded text-[10px] font-bold">XÓA LỌC X</button>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-500 border-b border-zinc-800"><tr><th>STT</th><th>Pair</th><th>DCA</th><th>Entry/Out</th><th>Avg</th><th class="text-center">MaxDD</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div>

    <div class="bg-card rounded-xl p-4 mb-32">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase">Hiệu suất Coin (Bấm tên để xem lịch sử)</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-400 border-b border-zinc-800"><tr><th>STT</th><th>Tên Coin</th><th>Lệnh</th><th>DCA</th><th>PnL Lãi</th><th>PnL Lỗ</th><th class="text-right">Tổng PnL</th></tr></thead><tbody id="statsBody"></tbody></table></div>
    </div>

    <script>
    let running = false, initialBal = 1000, lastData = null, myChart = null, filterCoin = null;
    const config = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(config.running) {
        running = true; initialBal = config.initialBal;
        document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
    }

    function setFilter(coin) {
        filterCoin = coin;
        const btn = document.getElementById('clearFilterBtn');
        if(coin) {
            btn.innerText = 'ĐANG LỌC: ' + coin + ' (BẤM ĐỂ HỦY)';
            btn.classList.remove('hidden');
            document.getElementById('historySection').scrollIntoView({behavior:'smooth'});
        } else {
            btn.classList.add('hidden');
        }
        update(); 
    }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line', data: { labels: [], datasets: [{ label: 'Balance', data: [], borderColor: '#fcd535', borderWidth: 2, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)', tension: 0.3, pointRadius: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
            scales: { x: { display: false }, y: { grid: { color: '#30363d' }, ticks: { color: '#848e9c', font: { size: 9 } } } } }
        });
    }

    function fPrice(p) { return p ? parseFloat(p).toFixed(4) : "0.0000"; }
    function start() {
        const bal = parseFloat(document.getElementById('balanceInp').value);
        localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal: bal, marginVal: document.getElementById('marginInp').value }));
        location.reload();
    }
    function stop() { localStorage.setItem('luffy_state', JSON.stringify({running:false})); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastData = d;
            let mVal = config.marginVal || "10%", mNum = parseFloat(mVal);

            let runBal = initialBal, winSum = 0, loseSum = 0, coinStats = {};
            let cLabels = ['Start'], cData = [initialBal];

            // Xử lý Lịch sử
            let hItems = [...d.history].reverse();
            let histHTML = hItems.map((h, i) => {
                let mBase = mVal.includes('%') ? (runBal * mNum / 100) : mNum;
                let totalM = mBase * (h.dcaCount + 1);
                let pnl = (totalM * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalM * (h.maxLev || 20) * 0.001);
                runBal += pnl;
                
                cLabels.push(new Date(h.endTime).toLocaleTimeString());
                cData.push(runBal);

                if(!coinStats[h.symbol]) coinStats[h.symbol] = { count: 0, dcas: 0, pnlW: 0, pnlL: 0 };
                coinStats[h.symbol].count++; coinStats[h.symbol].dcas += h.dcaCount;
                if(pnl >= 0) coinStats[h.symbol].pnlW += pnl; else coinStats[h.symbol].pnlL += pnl;

                // LOGIC LỌC TẠI ĐÂY
                if(filterCoin && h.symbol !== filterCoin) return null;

                return \`<tr class="border-b border-zinc-800/30">
                    <td>\${hItems.length - i}</td>
                    <td>\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td class="text-white font-bold">\${h.symbol}</td>
                    <td class="text-yellow-500 font-bold">\${h.dcaCount}</td>
                    <td>\${fPrice(h.snapPrice)}<br><b class="text-white">\${fPrice(h.finalPrice)}</b></td>
                    <td class="text-yellow-500">\${fPrice(h.avgPrice)}</td>
                    <td class="text-center down">\${h.maxNegativeRoi.toFixed(1)}%</td>
                    <td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td>
                    <td class="text-right text-white">\${runBal.toFixed(1)}</td></tr>\`;
            }).filter(x => x).reverse().join('');
            
            document.getElementById('historyBody').innerHTML = histHTML;
            if(myChart) { myChart.data.labels = cLabels; myChart.data.datasets[0].data = cData; myChart.update('none'); }

            // Xử lý Thống kê (Bấm vào tên để lọc)
            document.getElementById('statsBody').innerHTML = Object.entries(coinStats).map(([sym, s], i) => \`
                <tr class="border-b border-zinc-800/50">
                    <td>\${i+1}</td>
                    <td class="text-white font-bold cursor-pointer hover:text-yellow-500 underline" onclick="setFilter('\${sym}')">\${sym}</td>
                    <td>\${s.count}</td><td>\${s.dcas}</td>
                    <td class="up">\${s.pnlW.toFixed(2)}</td><td class="down">\${s.pnlL.toFixed(2)}</td>
                    <td class="text-right font-bold \${(s.pnlW+s.pnlL)>=0?'up':'down'}">\${(s.pnlW+s.pnlL).toFixed(2)}</td></tr>\`).join('');

            // Vị thế đang mở
            let unPnl = 0;
            document.getElementById('pendingBody').innerHTML = (d.pending || []).map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBase = mVal.includes('%') ? (runBal * mNum / 100) : mNum; 
                let totalM = mBase * (h.dcaCount + 1);
                let roi = (h.type === 'UP' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let p = totalM * roi / 100; unPnl += p;
                return \`<tr class="border-b border-zinc-800">
                    <td class="text-white font-bold">\${h.symbol} <small class="\${h.type==='UP'?'up':'down'}">\${h.type}</small></td>
                    <td class="text-yellow-500">\${h.dcaCount}</td>
                    <td>\${fPrice(h.snapPrice)}<br><b class="up">\${fPrice(lp)}</b></td>
                    <td class="text-yellow-500">\${fPrice(h.avgPrice)}</td>
                    <td class="text-right font-bold \${p>=0?'up':'down'}">\${p.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            document.getElementById('displayBal').innerText = (runBal + unPnl).toFixed(2);
            document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
        } catch(e) {}
    }
    initChart();
    setInterval(update, 500);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Luffy Pro Running on http://localhost:${PORT}/gui`); });
