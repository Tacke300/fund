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

// --- LOGIC TÍNH TOÁN CORE (WALLET & AVAIL) ---
function calculateState() {
    let walletBal = botConfig.initialBal;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    hist.forEach(h => {
        let base = h.walletAtStart || botConfig.initialBal;
        let m = botConfig.marginVal.includes('%') ? (base * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = m * (h.dcaCount + 1);
        let pnl = (tM * (h.maxLev || 20) * (h.pnlPercent/100)) - (tM * (h.maxLev || 20) * 0.001);
        walletBal += pnl;
    });

    let usedMargin = 0, unPnlAm = 0, totalUnPnl = 0;
    pending.forEach(h => {
        let lp = coinData[h.symbol]?.live?.currentPrice || h.avgPrice;
        let base = h.walletAtStart || walletBal;
        let m = botConfig.marginVal.includes('%') ? (base * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = m * (h.dcaCount + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / h.avgPrice : (h.avgPrice - lp) / h.avgPrice) * 100 * (h.maxLev || 20);
        let pnl = (tM * roi / 100);
        usedMargin += tM;
        totalUnPnl += pnl;
        if (pnl < 0) unPnlAm += Math.abs(pnl);
    });

    return { walletBal, avail: walletBal - usedMargin - unPnlAm, equity: walletBal + totalUnPnl };
}

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
        const state = calculateState();

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
                const roi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (roi < pending.maxNegativeRoi) pending.maxNegativeRoi = roi;

                if ((pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget) || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol) {
                if (!(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000)) && state.avail > (state.walletBal * 0.02)) {
                    let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
                    if (botConfig.mode === 'REVERSE') type = type === 'LONG' ? 'SHORT' : 'LONG';
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING',
                        maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl,
                        snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0, walletAtStart: state.walletBal
                    });
                }
            }
        });
    });
}

app.get('/api/config', (req, res) => {
    botConfig = { ...botConfig, ...req.query, running: req.query.running === 'true' };
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
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; padding: 8px; border-radius: 4px; }
        .recovery-row { background-color: rgba(75, 0, 130, 0.3) !important; color: #e0b0ff !important; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade (%)</label><input id="marginInp" type="text" class="w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Chế độ</label>
                    <select id="modeInp" class="w-full text-sm">
                        <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option>
                    </select>
                </div>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div>
                <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
                <div id="configDisplay" class="text-[10px] text-gray-custom font-bold uppercase mt-1 tracking-tighter"></div>
            </div>
            <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer uppercase" onclick="save(false)">STOP ENGINE</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div>
                <div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Vốn + PnL Live)</div>
                <span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span>
                <div class="text-[11px] text-blue-400 font-bold uppercase mt-1">Khả dụng (Avail): <span id="displayAvail">0.00</span> USDT</div>
            </div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 border border-zinc-800 relative">
        <div class="text-[11px] font-bold text-gray-custom uppercase tracking-widest italic mb-2">Growth Curve</div>
        <div class="absolute top-4 right-4 flex gap-4 text-[9px] font-bold uppercase">
            <span class="flex items-center"><span class="w-2 h-2 bg-[#fcd535] rounded-full mr-1"></span> Wallet</span>
            <span class="flex items-center"><span class="w-2 h-2 bg-blue-500 rounded-full mr-1"></span> Avail</span>
        </div>
        <div style="height: 180px;"><canvas id="balanceChart"></canvas></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-white uppercase tracking-wider mb-3 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>STT</th><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th class="text-center">Lev</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 mb-10"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>Margin</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Balance | Avail</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let myChart = null, isFirst = true;
    function fPrice(p) { return parseFloat(p).toFixed(4); }
    function save(status) { const q = new URLSearchParams({ running: status, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }); fetch('/api/config?' + q.toString()).then(() => location.reload()); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const config = d.botConfig; const st = d.state;
            if(isFirst) {
                document.getElementById('balanceInp').value = config.initialBal; document.getElementById('marginInp').value = config.marginVal;
                document.getElementById('tpInp').value = config.tp; document.getElementById('slInp').value = config.sl;
                document.getElementById('volInp').value = config.vol; document.getElementById('modeInp').value = config.mode;
                document.getElementById('configDisplay').innerText = \`TP: \${config.tp}% | DCA: \${config.sl}% | VOL: \${config.vol}% | MODE: \${config.mode} | MG: \${config.marginVal}\`;
                if(config.running) { document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
                isFirst = false;
            }

            document.getElementById('displayBal').innerText = st.equity.toFixed(2);
            document.getElementById('displayAvail').innerText = st.avail.toFixed(2);
            document.getElementById('unPnl').innerText = (st.equity - st.walletBal).toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (st.equity >= st.walletBal ? 'up':'down');

            let rBal = config.initialBal, cW = [rBal], cA = [rBal], cLab = ['Start'];
            let hHTML = [...d.history].sort((a,b)=>a.endTime-b.endTime).map((h, i) => {
                let mB = config.marginVal.includes('%') ? (h.walletAtStart * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
                let tM = mB * (h.dcaCount + 1);
                let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
                rBal += pnl; cW.push(rBal); cA.push(rBal); cLab.push("");
                let sv = h.snapVol || {c1:0,c5:0,c15:0};
                return \`<tr class="border-b border-zinc-800/30"><td>\${d.history.length - i}</td><td class="text-[7px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span><div class="text-[7px] text-gray-500">V: \${sv.c1}/\${sv.c5}/\${sv.c15}</div></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="text-center down font-bold">\${h.maxNegativeRoi.toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right font-bold">\${rBal.toFixed(1)} | <span class="text-blue-400">\${rBal.toFixed(1)}</span></td></tr>\`;
            }).reverse().join('');
            document.getElementById('historyBody').innerHTML = hHTML;

            document.getElementById('pendingBody').innerHTML = d.pending.map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mB = config.marginVal.includes('%') ? (h.walletAtStart * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
                let tM = mB * (h.dcaCount + 1);
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
                let pnl = tM*roi/100;
                let sv = h.snapVol || {c1:0,c5:0,c15:0};
                return \`<tr class="border-b border-zinc-800"><td>\${idx+1}</td><td class="text-[8px]">\${new Date(h.startTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span><div class="text-[7px] text-gray-400">V: \${sv.c1}/\${sv.c5}/\${sv.c15}</div></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="text-center text-[7px]">\${h.maxLev}x</td><td>\${fPrice(h.snapPrice)}<br><b class="text-white">\${fPrice(lp)}</b></td><td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td><td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            if(myChart){ cW.push(st.walletBal); cA.push(st.avail); cLab.push("Now"); myChart.data.labels = cLab; myChart.data.datasets[0].data = cW; myChart.data.datasets[1].data = cA; myChart.update('none'); }
        } catch(e) {}
    }
    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [
        { label: 'Wallet', data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: false },
        { label: 'Avail', data: [], borderColor: '#3b82f6', borderWidth: 1.5, pointRadius: 0, fill: false, borderDash: [5,5] }
    ]}, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    setInterval(update, 1000);
    initWS();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Bot running: http://localhost:${PORT}/gui`));
