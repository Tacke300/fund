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

// Load Data
if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

// HÀM TÍNH TOÁN TRẠNG THÁI (BALANCE & AVAIL)
function calculateState() {
    let walletBal = parseFloat(botConfig.initialBal) || 0;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    hist.forEach(h => {
        let base = parseFloat(h.walletAtStart) || botConfig.initialBal;
        let mVal = parseFloat(botConfig.marginVal) || 0;
        let m = botConfig.marginVal.toString().includes('%') ? (base * mVal / 100) : mVal;
        let tM = m * (parseInt(h.dcaCount) + 1);
        let pnl = (tM * (h.maxLev || 20) * (parseFloat(h.pnlPercent)/100)) - (tM * (h.maxLev || 20) * 0.001);
        walletBal += pnl;
    });

    let usedMargin = 0, totalUnPnl = 0, negativeUnPnl = 0;
    pending.forEach(h => {
        let lp = coinData[h.symbol]?.live?.currentPrice || h.avgPrice;
        let mVal = parseFloat(botConfig.marginVal) || 0;
        // Logic quan trọng: Margin lệnh pending tính theo ví lúc mở
        let m = botConfig.marginVal.toString().includes('%') ? (parseFloat(h.walletAtStart) * mVal / 100) : mVal;
        let tM = m * (parseInt(h.dcaCount) + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / h.avgPrice : (h.avgPrice - lp) / h.avgPrice) * 100 * (h.maxLev || 20);
        let pnl = tM * roi / 100;
        usedMargin += tM;
        totalUnPnl += pnl;
        if (pnl < 0) negativeUnPnl += Math.abs(pnl);
    });

    const avail = walletBal - usedMargin - negativeUnPnl;
    return { walletBal, avail, equity: walletBal + totalUnPnl };
}

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
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
            
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (currentRoi < (pending.maxNegativeRoi || 0)) pending.maxNegativeRoi = currentRoi;

                if ((pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget) || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol) {
                const state = calculateState();
                // CHỈ MỞ LỆNH NẾU AVAIL > 0
                if (state.avail > 0 && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                    if (!actionQueue.find(q => q.id === s)) {
                        actionQueue.push({ id: s, priority: 2, action: () => {
                            let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
                            if (botConfig.mode === 'REVERSE') type = type === 'LONG' ? 'SHORT' : 'LONG';
                            historyMap.set(`${s}_${now}`, { 
                                symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type, status: 'PENDING',
                                maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl,
                                snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0, walletAtStart: state.walletBal, availAtStart: state.avail
                            });
                        }});
                    }
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    botConfig = { ...botConfig, ...req.query, running: req.query.running === 'true' };
    botConfig.initialBal = parseFloat(botConfig.initialBal);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig));
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
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
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; padding: 6px; border-radius: 4px; font-size: 12px; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <input id="balanceInp" placeholder="Vốn khởi tạo"><input id="marginInp" placeholder="Margin (VD: 10% hoặc 5)">
            <div class="col-span-2 grid grid-cols-4 gap-2">
                <input id="tpInp" step="0.1" placeholder="TP"><input id="slInp" step="0.1" placeholder="DCA">
                <input id="volInp" step="0.1" placeholder="Vol"><select id="modeInp"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold uppercase text-xs">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div>
                <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
                <div id="cfgLine" class="text-[10px] text-gray-400 font-bold uppercase tracking-tighter"></div>
            </div>
            <button onclick="save(false)" class="text-[#fcd535] border border-[#fcd535] px-3 py-1 rounded text-xs font-bold">STOP</button>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Equity (Balance + PnL Live)</div>
                <div id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</div>
                <div class="text-[11px] font-bold mt-1">
                    <span class="text-blue-400">AVAIL: <span id="displayAvail">0.00</span></span>
                </div>
            </div>
            <div class="text-right"><div class="text-[10px] text-gray-500 font-bold uppercase">PnL Live</div><div id="unPnl" class="text-2xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-lg p-3 h-[180px]"><canvas id="mainChart"></canvas></div></div>

    <div class="p-4 space-y-4">
        <div class="bg-card p-3 rounded-lg shadow-lg overflow-x-auto">
            <div class="text-[10px] font-bold text-white uppercase mb-2 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
            <table class="w-full text-[10px] text-left border-collapse">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Lev</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>

        <div class="bg-card p-3 rounded-lg shadow-lg overflow-x-auto">
            <div class="text-[10px] font-bold text-gray-500 uppercase mb-2 italic">Lịch sử giao dịch</div>
            <table class="w-full text-[9px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Balance | Avail</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let chart, isFirst = true;
    function fP(p) { return p ? parseFloat(p).toFixed(4) : "0.0000"; }
    function save(s) { const q = new URLSearchParams({ running: s, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }); fetch('/api/config?'+q).then(()=>location.reload()); }

    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        const cfg = d.botConfig; const st = d.state;

        if(isFirst) {
            document.getElementById('balanceInp').value = cfg.initialBal; document.getElementById('marginInp').value = cfg.marginVal;
            document.getElementById('tpInp').value = cfg.tp; document.getElementById('slInp').value = cfg.sl;
            document.getElementById('volInp').value = cfg.vol; document.getElementById('modeInp').value = cfg.mode;
            document.getElementById('cfgLine').innerText = \`TP: \${cfg.tp}% | DCA: \${cfg.sl}% | Vol: \${cfg.vol}% | Mode: \${cfg.mode} | Margin: \${cfg.marginVal}\`;
            if(cfg.running){ document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
            isFirst = false;
        }

        document.getElementById('displayBal').innerText = st.equity.toFixed(2);
        document.getElementById('displayAvail').innerText = st.avail.toFixed(2);
        let lpnl = st.equity - st.walletBal;
        document.getElementById('unPnl').innerText = lpnl.toFixed(2);
        document.getElementById('unPnl').className = 'text-2xl font-bold ' + (lpnl>=0?'up':'down');

        let rB = cfg.initialBal, labels = ['Start'], dBal = [rB], dAvail = [rB];
        const hD = d.history.sort((a,b)=>a.endTime-b.endTime);
        
        document.getElementById('historyBody').innerHTML = hD.map((h, i) => {
            let m = cfg.marginVal.toString().includes('%') ? (h.walletAtStart * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
            let tM = m * ((h.dcaCount||0) + 1);
            let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
            rB += pnl;
            labels.push(""); dBal.push(rB); dAvail.push(st.avail); 
            return \`<tr class="border-b border-zinc-800/30"><td>\${hD.length-i}</td><td class="text-[7px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td class="down">\${(h.maxNegativeRoi||0).toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right">\${rB.toFixed(1)} | <span class="text-blue-400">\${(rB - tM).toFixed(1)}</span></td></tr>\`;
        }).reverse().join('');

        document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let m = cfg.marginVal.toString().includes('%') ? (h.walletAtStart * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
            let tM = m * (h.dcaCount + 1);
            let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
            return \`<tr class="border-b border-zinc-800"><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td>\${h.maxLev}x</td><td>\${fP(h.snapPrice)}<br><b>\${fP(lp)}</b></td><td class="text-yellow-500">\${fP(h.avgPrice)}</td><td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
        }).join('');

        if(chart) { chart.data.labels = labels; chart.data.datasets[0].data = dBal; chart.data.datasets[1].data = dAvail; chart.update('none'); }
    }

    const ctx = document.getElementById('mainChart').getContext('2d');
    chart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: 'Balance', data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0 }, { label: 'Avail', data: [], borderColor: '#3b82f6', borderWidth: 1, pointRadius: 0 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    
    setInterval(update, 1000);
    initWS();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Luffy Original Restored: http://localhost:${PORT}/gui`); });
