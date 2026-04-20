const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const STATUS_LOG_FILE = './status_logs.json';

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 
let statusLogs = []; 

let botConfig = {
    initialBal: 1000, marginVal: "10%", tp: 0.5, sl: 10.0, vol: 6.5, mode: 'FOLLOW', running: false,
    isPausedByMargin: false
};

if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(STATUS_LOG_FILE)) { try { statusLogs = JSON.parse(fs.readFileSync(STATUS_LOG_FILE)); } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

function saveStatusLog(type, msg) {
    statusLogs.unshift({ time: Date.now(), type, msg });
    if (statusLogs.length > 50) statusLogs.pop();
    fs.writeFileSync(STATUS_LOG_FILE, JSON.stringify(statusLogs));
}

function calculateCurrentState() {
    let walletBal = botConfig.initialBal;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    hist.forEach(h => {
        let mBase = botConfig.marginVal.includes('%') ? (walletBal * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = mBase * (h.dcaCount + 1);
        let pnl = (tM * (h.maxLev || 20) * (h.pnlPercent/100)) - (tM * (h.maxLev || 20) * 0.001);
        walletBal += pnl;
    });

    let usedMargin = 0; let unPnl = 0;
    pending.forEach(h => {
        let lp = coinData[h.symbol]?.live?.currentPrice || h.avgPrice;
        let mBase = botConfig.marginVal.includes('%') ? (walletBal * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = mBase * (h.dcaCount + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / h.avgPrice : (h.avgPrice - lp) / h.avgPrice) * 100 * (h.maxLev || 20);
        usedMargin += tM; unPnl += (tM * roi / 100);
    });

    let avail = walletBal - usedMargin + (unPnl < 0 ? unPnl : 0);
    let ratio = (usedMargin / (walletBal + (unPnl < 0 ? unPnl : 0))) * 100;

    if (!botConfig.isPausedByMargin && ratio > 50) {
        botConfig.isPausedByMargin = true;
        saveStatusLog('STOP', `Margin ${ratio.toFixed(1)}% > 50%. Tạm dừng mở lệnh.`);
    } else if (botConfig.isPausedByMargin && ratio < 40) {
        botConfig.isPausedByMargin = false;
        saveStatusLog('START', `Margin ${ratio.toFixed(1)}% < 40%. Tiếp tục mở lệnh.`);
    }
    return { walletBal, avail, equity: walletBal + unPnl, ratio, usedMargin };
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        if (!botConfig.running) return;
        const tickers = JSON.parse(data);
        const now = Date.now();
        const allPending = Array.from(historyMap.values()).filter(h => h.status === 'PENDING');

        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            const prices = coinData[s].prices;
            const c1 = calculateChange(prices, 1), c5 = calculateChange(prices, 5), c15 = calculateChange(prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = allPending.find(h => h.symbol === s);
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            } else if (!botConfig.isPausedByMargin && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol) {
                const state = calculateCurrentState();
                if (state.avail > 0 && !historyMap.has(`${s}_${now}`)) {
                    let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
                    if(botConfig.mode === 'REVERSE') type = type === 'LONG' ? 'SHORT' : 'LONG';
                    historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl, snapVol: {c1,c5,c15}, dcaCount: 0, maxNegativeRoi: 0 });
                }
            }
        });
    });
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

app.get('/api/config', (req, res) => {
    botConfig = { ...botConfig, ...req.query, running: req.query.running === 'true' };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig));
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const state = calculateCurrentState();
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING'),
        statusLogs, botConfig, state
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input, select { background: #0b0e11; border: 1px solid #30363d; color: white; padding: 6px; border-radius: 4px; font-size: 12px; }
        .recovery-row { background-color: rgba(75, 0, 130, 0.2) !important; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <input id="balanceInp" type="number" placeholder="Vốn khởi tạo ($)">
            <input id="marginInp" type="text" placeholder="Margin per Trade (%)">
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-2">
                <input id="tpInp" type="number" step="0.1" placeholder="TP (%)">
                <input id="slInp" type="number" step="0.1" placeholder="DCA (%)">
                <input id="volInp" type="number" step="0.1" placeholder="Min Vol (%)">
                <select id="modeInp"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] text-black font-bold py-2 rounded uppercase text-[10px]">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-2">
            <div class="font-bold italic text-lg">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div id="configInfo" class="text-[9px] bg-zinc-800 px-3 py-1 rounded-full text-gray-400 font-bold"></div>
            <button onclick="save(false)" class="text-[#fcd535] font-bold border border-[#fcd535] px-2 py-0.5 rounded text-[10px] uppercase">STOP</button>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-[10px] text-gray-400 font-bold uppercase mb-1">Equity (Balance + UnPnL)</div>
                <div id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</div>
                <div id="displayAvail" class="text-blue-400 text-[11px] font-bold uppercase mt-1"></div>
            </div>
            <div class="text-right">
                <div id="botStatus" class="text-[9px] font-bold px-2 py-0.5 rounded mb-1 inline-block">RUNNING</div>
                <div id="unPnl" class="text-xl font-bold">0.00</div>
            </div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card p-4 rounded-xl h-[180px]">
        <div class="flex justify-between text-[10px] font-bold text-gray-500 uppercase mb-2"><span>Growth Curve</span><span class="flex gap-4"><span>● Wallet</span><span class="text-blue-400">● Avail</span></span></div>
        <canvas id="balanceChart"></canvas>
    </div></div>

    <div class="p-4 grid grid-cols-1 gap-4">
        <div class="bg-card p-4 rounded-xl">
            <div class="text-[11px] font-bold mb-3 uppercase italic flex justify-between">
                <span>⚠️ Lịch sử dừng bot (Margin 50/40)</span>
                <span id="marginPercent" class="text-yellow-500">Margin: 0%</span>
            </div>
            <div id="logBody" class="text-[9px] space-y-1 h-20 overflow-y-auto"></div>
        </div>

        <div class="bg-card p-4 rounded-xl">
            <div class="text-[11px] font-bold mb-3 uppercase italic">🔥 Vị thế đang mở</div>
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-500 border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
        </div>

        <div class="bg-card p-4 rounded-xl">
            <div class="text-[11px] font-bold mb-3 uppercase italic">Nhật ký giao dịch</div>
            <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-500 border-b border-zinc-800"><tr><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Wallet | Avail</th></tr></thead><tbody id="historyBody"></tbody></table></div>
        </div>
    </div>

    <script>
    let myChart = null, isFirst = true;
    function fPrice(p) { return parseFloat(p).toFixed(p < 1 ? 5 : 2); }
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
        document.getElementById('displayAvail').innerText = 'Khả dụng (Avail): ' + st.avail.toFixed(2) + ' USDT';
        document.getElementById('unPnl').innerText = (st.equity - st.walletBal).toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold ' + (st.equity >= st.walletBal ? 'up':'down');
        document.getElementById('marginPercent').innerText = 'Margin: ' + st.ratio.toFixed(1) + '%';
        
        const bSt = document.getElementById('botStatus');
        if(config.isPausedByMargin){ bSt.innerText = 'PAUSED (MARGIN > 50%)'; bSt.className = 'text-[9px] font-bold px-2 py-0.5 rounded bg-red-900 text-red-200 animate-pulse'; }
        else { bSt.innerText = 'RUNNING'; bSt.className = 'text-[9px] font-bold px-2 py-0.5 rounded bg-green-900 text-green-200'; }

        document.getElementById('logBody').innerHTML = d.statusLogs.map(l => \`<div class="flex justify-between border-b border-zinc-800 pb-1"><span class="\${l.type==='STOP'?'text-red-400':'text-green-400'}">[\${l.type}] \${new Date(l.time).toLocaleTimeString()}</span><span class="text-gray-500">\${l.msg}</span></div>\`).join('');

        let rB = config.initialBal, cW = [rB], cA = [rB], cL = ['Start'];
        document.getElementById('historyBody').innerHTML = d.history.sort((a,b)=>a.endTime-b.endTime).map(h => {
            let m = config.marginVal.includes('%') ? (rB * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
            let tM = m * (h.dcaCount + 1);
            let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
            rB += pnl; cW.push(rB); cA.push(rB); cL.push("");
            return \`<tr class="border-b border-zinc-800/30 \${h.dcaCount >= 5 ? 'recovery-row' : ''}"><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="down">\${h.maxNegativeRoi?.toFixed(1) || 0}%</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right font-bold">\${rB.toFixed(1)} | <span class="text-blue-400">\${rB.toFixed(1)}</span></td></tr>\`;
        }).reverse().join('');

        document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let m = config.marginVal.includes('%') ? (st.walletBal * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
            let tM = m * (h.dcaCount + 1);
            let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
            return \`<tr class="border-b border-zinc-800 \${h.dcaCount >= 5 ? 'recovery-row' : ''}"><td><b>\${h.symbol}</b> <span class="px-1 \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded text-[8px]">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td>\${fPrice(h.snapPrice)}<br>\${fPrice(lp)}</td><td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td><td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
        }).join('');

        if(myChart){ myChart.data.labels = cL; myChart.data.datasets[0].data = cW; myChart.data.datasets[1].data = cA; myChart.update('none'); }
    }
    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: 'Wallet', data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0 }, { label: 'Avail', data: [], borderColor: '#3b82f6', borderWidth: 1, pointRadius: 0, borderDash: [5,5] }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    setInterval(update, 1000);
    </script></body></html>`);
});

initWS();
app.listen(PORT, '0.0.0.0', () => console.log(`http://localhost:${PORT}/gui`));
