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

// HÀM TÍNH TOÁN KHÔNG BAO GIỜ NAN
function calculateState() {
    let walletBal = Number(botConfig.initialBal) || 0;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    hist.forEach(h => {
        let base = Number(h.walletAtStart) || Number(botConfig.initialBal);
        let mVal = parseFloat(botConfig.marginVal) || 0;
        let m = botConfig.marginVal.toString().includes('%') ? (base * mVal / 100) : mVal;
        let dca = Number(h.dcaCount) || 0;
        let tM = m * (dca + 1);
        let pnlPct = parseFloat(h.pnlPercent) || 0;
        let lev = Number(h.maxLev) || 20;
        let pnl = (tM * lev * (pnlPct / 100)) - (tM * lev * 0.001);
        walletBal += pnl;
    });

    let usedMargin = 0, totalUnPnl = 0, unPnlNeg = 0;
    pending.forEach(h => {
        let lp = Number(coinData[h.symbol]?.live?.currentPrice) || Number(h.avgPrice) || 0;
        let avgP = Number(h.avgPrice) || 1;
        let mVal = parseFloat(botConfig.marginVal) || 0;
        let m = botConfig.marginVal.toString().includes('%') ? (Number(h.walletAtStart) * mVal / 100) : mVal;
        let dca = Number(h.dcaCount) || 0;
        let tM = m * (dca + 1);
        let lev = Number(h.maxLev) || 20;
        let roi = (h.type === 'LONG' ? (lp - avgP) / avgP : (avgP - lp) / avgP) * 100 * lev;
        let pnl = tM * roi / 100;
        usedMargin += tM;
        totalUnPnl += pnl;
        if (pnl < 0) unPnlNeg += Math.abs(pnl);
    });

    let avail = walletBal - usedMargin - unPnlNeg;
    return { 
        walletBal: Number(walletBal.toFixed(2)), 
        avail: Number(avail.toFixed(2)), 
        equity: Number((walletBal + totalUnPnl).toFixed(2)) 
    };
}

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    const task = actionQueue.shift();
    if (task && typeof task.action === 'function') task.action();
    setTimeout(processQueue, 300); 
}
setInterval(processQueue, 50);

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    let change = ((pArr[pArr.length - 1].p - start.p) / start.p) * 100;
    return isNaN(change) ? 0 : parseFloat(change.toFixed(2));
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
                const lp = p, avgP = Number(pending.avgPrice);
                const diffAvg = ((lp - avgP) / avgP) * 100;
                const roi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (Number(pending.maxLev) || 20);
                if (roi < (pending.maxNegativeRoi || 0)) pending.maxNegativeRoi = roi;

                if ((pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget) || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = 'WIN'; pending.finalPrice = lp; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= Number(botConfig.vol)) {
                const state = calculateState();
                // DÙNG AVAIL ĐỂ TÍNH TOÁN MỞ LỆNH
                if (state.avail > 1 && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                    if (!actionQueue.find(q => q.id === s)) {
                        actionQueue.push({ id: s, action: () => {
                            let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
                            if (botConfig.mode === 'REVERSE') type = type === 'LONG' ? 'SHORT' : 'LONG';
                            historyMap.set(`${s}_${now}`, { 
                                symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING',
                                maxLev: Number(symbolMaxLeverage[s]) || 20, tpTarget: Number(botConfig.tp), slTarget: Number(botConfig.sl),
                                snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0, 
                                walletAtStart: state.walletBal, availAtStart: state.avail // Lưu lại Avail lúc mở để GUI tính Margin
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
    botConfig = { 
        ...botConfig, 
        ...req.query, 
        running: req.query.running === 'true',
        initialBal: Number(req.query.initialBal) || botConfig.initialBal,
        tp: Number(req.query.tp) || botConfig.tp,
        sl: Number(req.query.sl) || botConfig.sl,
        vol: Number(req.query.vol) || botConfig.vol
    };
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
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; padding: 8px; border-radius: 4px; font-size: 13px; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <input id="balanceInp" type="number" placeholder="Vốn"><input id="marginInp" placeholder="Margin (VD: 10%)">
            <div class="col-span-2 grid grid-cols-4 gap-2">
                <input id="tpInp" step="0.1" placeholder="TP"><input id="slInp" step="0.1" placeholder="DCA"><input id="volInp" step="0.1" placeholder="Vol">
                <select id="modeInp"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold uppercase text-xs">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div>
                <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
                <div id="cfgLine" class="text-[10px] text-gray-500 font-bold uppercase mt-1"></div>
            </div>
            <button onclick="save(false)" class="text-[#fcd535] border border-[#fcd535] px-4 py-1 rounded text-xs font-bold uppercase">Stop Bot</button>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Equity (Balance + PnL Live)</div>
                <div id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</div>
                <div class="text-[11px] font-bold text-blue-400 mt-1 uppercase">Khả dụng (Avail): <span id="displayAvail">0.00</span> USDT</div>
            </div>
            <div class="text-right"><div class="text-[10px] text-gray-500 font-bold uppercase">PnL Tạm Tính</div><div id="unPnl" class="text-2xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-lg p-3 h-[180px] shadow-inner"><canvas id="mainChart"></canvas></div></div>

    <div class="p-4 space-y-6">
        <div class="bg-card p-4 rounded-xl shadow-lg overflow-x-auto">
            <div class="text-[11px] font-bold text-white uppercase mb-3 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
            <table class="w-full text-[11px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase text-[10px]"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Lev</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>

        <div class="bg-card p-4 rounded-xl shadow-lg overflow-x-auto">
            <div class="text-[11px] font-bold text-gray-500 uppercase mb-3 italic">Nhật ký giao dịch (Full History)</div>
            <table class="w-full text-[10px] text-left border-collapse">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>SnapVol</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Balance | Avail</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let chart, isFirst = true;
    function fP(p) { return p ? parseFloat(p).toFixed(4) : "0.0000"; }
    function save(s) { const q = new URLSearchParams({ running: s, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }); fetch('/api/config?'+q).then(()=>location.reload()); }

    async function update() {
        try {
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

            let rB = Number(cfg.initialBal), labels = ['Start'], dBal = [rB], dAvail = [rB];
            const hD = d.history.sort((a,b)=>a.endTime-b.endTime);
            
            document.getElementById('historyBody').innerHTML = hD.map((h, i) => {
                let m = cfg.marginVal.toString().includes('%') ? (Number(h.walletAtStart) * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
                let tM = m * (Number(h.dcaCount) + 1);
                let pnl = (tM * (Number(h.maxLev)||20) * (Number(h.pnlPercent)/100)) - (tM * (Number(h.maxLev)||20) * 0.001);
                rB += pnl; labels.push(""); dBal.push(rB); dAvail.push(st.avail); 
                let sv = h.snapVol || {c1:0,c5:0,c15:0};
                return \`<tr class="border-b border-zinc-800/30"><td>\${hD.length-i}</td><td class="text-[7px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td class="text-[7px] text-gray-500">\${sv.c1}/\${sv.c5}/\${sv.c15}</td><td class="down font-bold">\${(Number(h.maxNegativeRoi)||0).toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right font-bold">\${rB.toFixed(1)} | <span class="text-blue-400">\${(rB - tM).toFixed(1)}</span></td></tr>\`;
            }).reverse().join('');

            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = Number(d.allPrices[h.symbol]) || Number(h.avgPrice);
                let m = cfg.marginVal.toString().includes('%') ? (Number(h.walletAtStart) * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
                let tM = m * (Number(h.dcaCount) + 1);
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(Number(h.maxLev)||20);
                return \`<tr class="border-b border-zinc-800"><td><b>\${h.symbol}</b> <span class="px-1 \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded text-[9px]">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td>\${h.maxLev}x</td><td>\${fP(h.snapPrice)}<br><b class="text-white">\${fP(lp)}</b></td><td class="text-yellow-500 font-bold">\${fP(h.avgPrice)}</td><td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            if(chart) { chart.data.labels = labels; chart.data.datasets[0].data = dBal; chart.data.datasets[1].data = dAvail; chart.update('none'); }
        } catch(e) {}
    }

    const ctx = document.getElementById('mainChart').getContext('2d');
    chart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: 'Balance', data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }, { label: 'Avail', data: [], borderColor: '#3b82f6', borderWidth: 1, pointRadius: 0 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    
    setInterval(update, 1000);
    initWS();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Bot Luffy Pro Ready: http://localhost:${PORT}/gui`); });
