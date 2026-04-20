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

if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

// --- LOGIC TÍNH TOÁN AVAIL ---
function calculateState() {
    let walletBal = botConfig.initialBal;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    // Tính Wallet thực tế từ lịch sử
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

                if ((pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget)) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol) {
                if (!(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000)) && state.avail > (state.walletBal * 0.05)) {
                    let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
                    if (botConfig.mode === 'REVERSE') type = type === 'LONG' ? 'SHORT' : 'LONG';
                    
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING',
                        maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl,
                        snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0,
                        walletAtStart: state.walletBal
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
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input { background: #0b0e11; border: 1px solid #30363d; color: white; padding: 4px; border-radius: 4px; font-size: 12px; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] border-b border-zinc-800 sticky top-0 z-50">
        <div id="setup" class="grid grid-cols-2 gap-2 mb-4 bg-card p-3 rounded shadow-lg">
            <div><label class="text-[10px] text-gray-500 font-bold uppercase">Vốn ($)</label><input id="balanceInp" class="w-full text-yellow-500 font-bold"></div>
            <div><label class="text-[10px] text-gray-500 font-bold uppercase">Margin (%)</label><input id="marginInp" class="w-full text-yellow-500 font-bold"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-2 mt-1">
                <input id="tpInp" placeholder="TP" type="number" step="0.1"><input id="slInp" placeholder="DCA" type="number" step="0.1">
                <input id="volInp" placeholder="VOL" type="number" step="0.1">
                <select id="modeInp" class="bg-[#0b0e11] text-[12px] border border-zinc-700 text-white"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] text-black font-bold py-2 rounded text-xs mt-1">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-start mb-2">
            <div>
                <div class="font-bold italic text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
                <div id="configInfo" class="text-[10px] text-gray-400 font-bold"></div>
            </div>
            <button onclick="save(false)" class="text-[#fcd535] border border-[#fcd535] px-2 py-1 rounded text-[10px] font-bold">STOP</button>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-[10px] text-gray-500 font-bold uppercase">Equity (Wallet + Live)</div>
                <div id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</div>
                <div id="displayAvail" class="text-blue-400 text-[11px] font-bold mt-1"></div>
            </div>
            <div class="text-right">
                <div class="text-[10px] text-gray-500 font-bold uppercase">PnL Live</div>
                <div id="unPnl" class="text-2xl font-bold">0.00</div>
            </div>
        </div>
    </div>

    <div class="p-4 space-y-4">
        <div class="bg-card p-4 rounded-xl h-[200px] border border-zinc-800 relative">
            <div class="absolute top-2 right-4 flex gap-4 text-[9px] font-bold uppercase">
                <span class="flex items-center"><span class="w-2 h-2 bg-[#fcd535] rounded-full mr-1"></span> Wallet</span>
                <span class="flex items-center"><span class="w-2 h-2 bg-blue-500 rounded-full mr-1"></span> Avail</span>
            </div>
            <canvas id="balanceChart"></canvas>
        </div>

        <div class="bg-card p-4 rounded-xl border border-zinc-800">
            <div class="text-[11px] font-bold mb-3 uppercase italic"><span class="w-1 h-3 bg-[#fcd535] inline-block mr-2"></span> Vị thế đang mở</div>
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>Symbol</th><th>DCA</th><th>Margin</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table></div>
        </div>

        <div class="bg-card p-4 rounded-xl border border-zinc-800">
            <div class="text-[11px] font-bold mb-3 uppercase italic text-gray-400">Nhật ký giao dịch</div>
            <div class="overflow-x-auto"><table class="w-full text-[9px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>Time</th><th>Symbol</th><th>DCA</th><th>PnL Net</th><th class="text-right">Wallet | Avail</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table></div>
        </div>
    </div>

    <script>
    let myChart = null, isFirst = true;
    function fPrice(p) { return parseFloat(p).toFixed(4); }
    function save(s) { const q = new URLSearchParams({ running: s, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }); fetch('/api/config?'+q).then(()=>location.reload()); }
    
    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        const config = d.botConfig; const st = d.state;
        
        if(isFirst) {
            document.getElementById('balanceInp').value = config.initialBal; document.getElementById('marginInp').value = config.marginVal;
            document.getElementById('tpInp').value = config.tp; document.getElementById('slInp').value = config.sl;
            document.getElementById('volInp').value = config.vol; document.getElementById('modeInp').value = config.mode;
            document.getElementById('configInfo').innerText = \`TP: \${config.tp}% | DCA: \${config.sl}% | VOL: \${config.vol}% | MODE: \${config.mode}\`;
            if(config.running){ document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
            isFirst = false;
        }

        document.getElementById('displayBal').innerText = st.equity.toFixed(2);
        document.getElementById('displayAvail').innerText = 'AVAIL: ' + st.avail.toFixed(2) + ' USDT';
        document.getElementById('unPnl').innerText = (st.equity - st.walletBal).toFixed(2);
        document.getElementById('unPnl').className = 'text-2xl font-bold ' + (st.equity >= st.walletBal ? 'up':'down');

        let rB = config.initialBal, cW = [rB], cA = [rB], cL = ['Start'];
        document.getElementById('historyBody').innerHTML = d.history.sort((a,b)=>a.endTime-b.endTime).map(h => {
            let m = config.marginVal.includes('%') ? (h.walletAtStart * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
            let tM = m * (h.dcaCount + 1);
            let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
            rB += pnl; cW.push(rB); cA.push(rB); cL.push("");
            return \`<tr class="border-b border-zinc-800/30"><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> \${h.type}</td><td>\${h.dcaCount}</td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td><td class="text-right">\${rB.toFixed(1)} | <span class="text-blue-400">\${rB.toFixed(1)}</span></td></tr>\`;
        }).reverse().join('');

        document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let m = config.marginVal.includes('%') ? (st.walletBal * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
            let tM = m * (h.dcaCount + 1);
            let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
            return \`<tr class="border-b border-zinc-800"><td><b>\${h.symbol}</b> \${h.type}</td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td><td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
        }).join('');

        if(myChart){ cW.push(st.walletBal); cA.push(st.avail); cL.push("Now"); myChart.data.labels = cL; myChart.data.datasets[0].data = cW; myChart.data.datasets[1].data = cA; myChart.update('none'); }
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

app.listen(PORT, '0.0.0.0', () => console.log(`Bot fix: http://localhost:${PORT}/gui`));
