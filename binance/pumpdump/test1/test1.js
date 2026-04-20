const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let botConfig = {
    initialBal: 1000, marginVal: "10%", tp: 0.5, sl: 10.0, vol: 6.5, mode: 'FOLLOW', running: false
};

// Load config
if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => {
            // Ép kiểu dữ liệu cũ để tránh NaN từ file
            h.startTime = Number(h.startTime) || Date.now();
            h.dcaCount = Number(h.dcaCount) || 0;
            h.pnlPercent = Number(h.pnlPercent) || 0;
            h.availAtStart = Number(h.availAtStart) || Number(botConfig.initialBal);
            historyMap.set(`${h.symbol}_${h.startTime}`, h);
        });
    } catch (e) {}
}

// --- HÀM TÍNH TOÁN DIỆT TẬN GỐC NaN ---
function calculateState() {
    let walletBal = Number(botConfig.initialBal) || 0;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    hist.forEach(h => {
        let availRef = Number(h.availAtStart) || Number(botConfig.initialBal);
        let mVal = parseFloat(h.marginVal) || 0;
        let mBase = String(h.marginVal).includes('%') ? (availRef * mVal / 100) : mVal;
        let tM = mBase * (Number(h.dcaCount || 0) + 1);
        let lev = Number(h.maxLev) || 20;
        let pnl = (tM * lev * (Number(h.pnlPercent || 0) / 100)) - (tM * lev * 0.001);
        walletBal += (Number(pnl) || 0);
    });

    let usedMargin = 0, totalUnPnl = 0, negUnPnl = 0;
    pending.forEach(h => {
        let lp = Number(coinData[h.symbol]?.live?.currentPrice) || Number(h.avgPrice) || 0;
        let avgP = Number(h.avgPrice) || 1;
        let availRef = Number(h.availAtStart) || walletBal;
        let mVal = parseFloat(h.marginVal) || 0;
        let mBase = String(h.marginVal).includes('%') ? (availRef * mVal / 100) : mVal;
        let tM = mBase * (Number(h.dcaCount || 0) + 1);
        let lev = Number(h.maxLev) || 20;
        let roi = (h.type === 'LONG' ? (lp - avgP) / avgP : (avgP - lp) / avgP) * 100 * lev;
        let pnl = tM * roi / 100;
        
        usedMargin += tM;
        totalUnPnl += pnl;
        if (pnl < 0) negUnPnl += Math.abs(pnl);
    });

    let avail = walletBal - usedMargin - negUnPnl;
    return { 
        walletBal: Number(walletBal.toFixed(2)) || 0, 
        avail: Number(avail.toFixed(2)) || 0, 
        equity: Number((walletBal + totalUnPnl).toFixed(2)) || 0
    };
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        if (!botConfig.running) return;
        const tickers = JSON.parse(data);
        const now = Date.now();

        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            // Logic Volume (Đơn giản hóa để ví dụ)
            let c1 = 0; // Giả sử tính được c1, c5...
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                // Check TP/SL... (giữ nguyên logic cũ)
            } else if (botConfig.running) {
                const st = calculateState();
                // CHỈ MỞ KHI AVAIL CÒN TIỀN
                if (st.avail > 5) { 
                    // Thêm logic filter volume của bạn ở đây
                    if (!lastTradeClosed[s] || (now - lastTradeClosed[s] > COOLDOWN_MINUTES * 60000)) {
                         // Thực hiện push vào queue và historyMap
                    }
                }
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    res.json({ 
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING'),
        botConfig, state: calculateState(),
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s,v]) => [s, v.live?.currentPrice || 0]))
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; margin:0; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input { background: #0b0e11; border: 1px solid #30363d; color: white; padding: 4px 8px; border-radius: 4px; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div class="flex justify-between items-center mb-4">
            <div>
                <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
                <div id="cfgLine" class="text-[10px] text-gray-500 font-bold uppercase mt-1"></div>
            </div>
            <button onclick="location.reload()" class="bg-zinc-800 px-3 py-1 rounded text-[10px] font-bold">RELOAD</button>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Equity (Total)</div>
                <div id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</div>
                <div class="text-[11px] font-bold text-blue-400 mt-1 uppercase">Khả dụng (Avail): <span id="displayAvail">0.00</span> USDT</div>
            </div>
            <div class="text-right"><div class="text-[10px] text-gray-500 font-bold">PnL Live</div><div id="unPnl" class="text-2xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-lg p-3 h-[160px]"><canvas id="mainChart"></canvas></div></div>

    <div class="p-4 space-y-6">
        <div class="bg-card p-4 rounded-xl shadow-lg overflow-x-auto">
            <div class="text-[11px] font-bold text-white uppercase mb-3 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2"></span> Vị thế đang mở</div>
            <table class="w-full text-[11px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase text-[10px]"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>

        <div class="bg-card p-4 rounded-xl shadow-lg overflow-x-auto">
            <div class="text-[11px] font-bold text-gray-500 uppercase mb-3 italic">Nhật ký giao dịch (Full History)</div>
            <table class="w-full text-[10px] text-left border-collapse">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>SnapVol</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Balance | Avail</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let chart;
    function fP(p) { return Number(p).toFixed(4); }
    
    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const st = d.state; const cfg = d.botConfig;

            document.getElementById('displayBal').innerText = Number(st.equity).toFixed(2);
            document.getElementById('displayAvail').innerText = Number(st.avail).toFixed(2);
            document.getElementById('cfgLine').innerText = \`TP: \${cfg.tp}% | DCA: \${cfg.sl}% | Vol: \${cfg.vol}% | Margin: \${cfg.marginVal}\`;
            
            let livePnl = st.equity - st.walletBal;
            document.getElementById('unPnl').innerText = livePnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-2xl font-bold ' + (livePnl >= 0 ? 'up' : 'down');

            let rB = Number(cfg.initialBal), labels = ['Start'], dBal = [rB], dAvail = [rB];
            const hD = d.history.sort((a,b)=>a.endTime-b.endTime);
            
            document.getElementById('historyBody').innerHTML = hD.map((h, i) => {
                let mVal = parseFloat(h.marginVal) || 0;
                let mBase = String(h.marginVal).includes('%') ? (Number(h.availAtStart) * mVal / 100) : mVal;
                let tM = mBase * (Number(h.dcaCount) + 1);
                let pnl = (tM * (h.maxLev||20) * (Number(h.pnlPercent)/100)) - (tM * (h.maxLev||20) * 0.001);
                rB += (Number(pnl) || 0);
                labels.push(""); dBal.push(rB); dAvail.push(st.avail); 
                return \`<tr class="border-b border-zinc-800/30">
                    <td>\${hD.length-i}</td>
                    <td class="text-[8px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td>
                    <td class="text-gray-500 text-[8px]">\${h.snapVol?.c1||0}/\${h.snapVol?.c5||0}</td>
                    <td class="down font-bold">\${Number(h.maxNegativeRoi||0).toFixed(1)}%</td>
                    <td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td>
                    <td class="text-right font-bold">\${rB.toFixed(1)} | <span class="text-blue-400">\${(rB - tM).toFixed(1)}</span></td>
                </tr>\`;
            }).reverse().join('');

            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = Number(d.allPrices[h.symbol]) || Number(h.avgPrice);
                let mVal = parseFloat(h.marginVal) || 0;
                let mBase = String(h.marginVal).includes('%') ? (Number(h.availAtStart) * mVal / 100) : mVal;
                let tM = mBase * (Number(h.dcaCount) + 1);
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
                return \`<tr class="border-b border-zinc-800">
                    <td><b>\${h.symbol}</b> <span class="px-1 \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded text-[9px]">\${h.type}</span></td>
                    <td>\${h.dcaCount}</td>
                    <td>\${tM.toFixed(1)}</td>
                    <td>\${fP(h.avgPrice)}<br><b class="text-white">\${fP(lp)}</b></td>
                    <td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)}<br>\${roi.toFixed(1)}%</td>
                </tr>\`;
            }).join('');

            if(!chart) {
                const ctx = document.getElementById('mainChart').getContext('2d');
                chart = new Chart(ctx, { type: 'line', data: { labels, datasets: [{ label: 'Bal', data: dBal, borderColor: '#fcd535', borderWidth: 2, pointRadius: 0 }, { label: 'Avail', data: dAvail, borderColor: '#3b82f6', borderWidth: 1, pointRadius: 0 }] }, options: { maintainAspectRatio: false, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } } });
            } else {
                chart.data.labels = labels; chart.data.datasets[0].data = dBal; chart.data.datasets[1].data = dAvail; chart.update('none');
            }
        } catch(e) { console.error(e); }
    }
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Bot Luffy Pro FIXED: http://localhost:${PORT}/gui`); });
