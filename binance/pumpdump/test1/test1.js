const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

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

if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

// --- HÀM TÍNH TOÁN CORE (DIỆT NAN) ---
function calculateState() {
    let walletBal = Number(botConfig.initialBal) || 0;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    // 1. Tính Balance thực tế sau khi chốt các lệnh cũ
    hist.forEach(h => {
        let mBase = (String(h.marginVal).includes('%')) ? (Number(h.availAtStart) * parseFloat(h.marginVal) / 100) : parseFloat(h.marginVal);
        let tM = (Number(mBase) || 0) * (Number(h.dcaCount || 0) + 1);
        let pnl = (tM * (Number(h.maxLev) || 20) * (Number(h.pnlPercent) / 100)) - (tM * (Number(h.maxLev) || 20) * 0.001);
        walletBal += (Number(pnl) || 0);
    });

    let usedMargin = 0, totalUnPnl = 0, negativeUnPnl = 0;
    
    // 2. Tính Margin đang giữ và PnL của lệnh đang chạy
    pending.forEach(h => {
        let lp = Number(coinData[h.symbol]?.live?.currentPrice) || Number(h.avgPrice) || 0;
        let avgP = Number(h.avgPrice) || 1;
        let mBase = (String(h.marginVal).includes('%')) ? (Number(h.availAtStart) * parseFloat(h.marginVal) / 100) : parseFloat(h.marginVal);
        let tM = (Number(mBase) || 0) * (Number(h.dcaCount || 0) + 1);
        let lev = Number(h.maxLev) || 20;
        let roi = (h.type === 'LONG' ? (lp - avgP) / avgP : (avgP - lp) / avgP) * 100 * lev;
        let pnl = tM * roi / 100;
        
        usedMargin += tM;
        totalUnPnl += pnl;
        if (pnl < 0) negativeUnPnl += Math.abs(pnl);
    });

    let avail = walletBal - usedMargin - negativeUnPnl;
    return { 
        walletBal: Number(walletBal.toFixed(2)) || 0, 
        avail: Number(avail.toFixed(2)) || 0, 
        equity: Number((walletBal + totalUnPnl).toFixed(2)) || 0
    };
}

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    const task = actionQueue.shift();
    if (task && task.action) task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

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
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                if ((pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget)) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else {
                // CHỈ MỞ LỆNH KHI CÓ BIẾN ĐỘNG VÀ AVAIL > 0
                const st = calculateState();
                if (st.avail > 1 && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, action: () => {
                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: now, snapPrice: p, avgPrice: p, status: 'PENDING',
                            type: (Math.random() > 0.5 ? 'LONG' : 'SHORT'), // Logic trade của bạn ở đây
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl,
                            dcaCount: 0, pnlPercent: 0, marginVal: botConfig.marginVal, availAtStart: st.avail
                        });
                    }});
                }
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    res.json({ 
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING'),
        botConfig, state: calculateState()
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div class="flex justify-between items-center mb-4">
            <div>
                <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
                <div id="cfgLine" class="text-[10px] text-gray-500 font-bold uppercase"></div>
            </div>
        </div>
        <div class="flex justify-between items-end">
            <div>
                <div class="text-[10px] text-gray-500 font-bold mb-1">Equity (Balance + PnL Live)</div>
                <div id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</div>
                <div class="text-[11px] font-bold text-blue-400 mt-1 uppercase">Khả dụng (Avail): <span id="displayAvail">0.00</span> USDT</div>
            </div>
            <div class="text-right text-2xl font-bold" id="unPnl">0.00</div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-lg p-3 h-[180px]"><canvas id="mainChart"></canvas></div></div>

    <div class="p-4 space-y-6">
        <div class="bg-card p-4 rounded-xl shadow-lg">
            <div class="text-[11px] font-bold text-white uppercase mb-3">Vị thế đang mở</div>
            <table class="w-full text-[11px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>

        <div class="bg-card p-4 rounded-xl shadow-lg">
            <div class="text-[11px] font-bold text-gray-500 uppercase mb-3">Nhật ký giao dịch</div>
            <table class="w-full text-[10px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800"><tr><th>STT</th><th>Time</th><th>Pair</th><th>PnL Net</th><th class="text-right">Balance | Avail</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let chart;
    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        const st = d.state; const cfg = d.botConfig;

        document.getElementById('displayBal').innerText = st.equity.toFixed(2);
        document.getElementById('displayAvail').innerText = st.avail.toFixed(2);
        document.getElementById('cfgLine').innerText = \`TP: \${cfg.tp}% | DCA: \${cfg.sl}% | Mode: \${cfg.mode} | Margin: \${cfg.marginVal}\`;

        let rB = Number(cfg.initialBal), labels = ['Start'], dBal = [rB], dAvail = [rB];
        const hD = d.history.sort((a,b)=>a.endTime-b.endTime);
        
        document.getElementById('historyBody').innerHTML = hD.map((h, i) => {
            let m = String(h.marginVal).includes('%') ? (Number(h.availAtStart) * parseFloat(h.marginVal)/100) : parseFloat(h.marginVal);
            let tM = m * (Number(h.dcaCount) + 1);
            let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
            rB += (Number(pnl) || 0);
            labels.push(""); dBal.push(rB); dAvail.push(st.avail); 
            return \`<tr class="border-b border-zinc-800/30"><td>\${hD.length-i}</td><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b></td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td><td class="text-right">\${rB.toFixed(1)} | <span class="text-blue-400">\${(rB - tM).toFixed(1)}</span></td></tr>\`;
        }).reverse().join('');

        document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
            return \`<tr class="border-b border-zinc-800"><td><b>\${h.symbol}</b></td><td>\${h.dcaCount}</td><td>\${h.marginVal}</td><td>\${h.avgPrice}</td><td class="text-right">RUNNING</td></tr>\`;
        }).join('');

        if(!chart) {
            const ctx = document.getElementById('mainChart').getContext('2d');
            chart = new Chart(ctx, { type: 'line', data: { labels, datasets: [{ label: 'Bal', data: dBal, borderColor: '#fcd535', borderWidth: 2, pointRadius: 0 }, { label: 'Avail', data: dAvail, borderColor: '#3b82f6', borderWidth: 1, pointRadius: 0 }] }, options: { maintainAspectRatio: false, scales: { x: { display: false } } } });
        } else {
            chart.data.labels = labels; chart.data.datasets[0].data = dBal; chart.data.datasets[1].data = dAvail; chart.update('none');
        }
    }
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(\`Bot Luffy Pro Zin: http://localhost:\${PORT}/gui\`); });
