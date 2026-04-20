const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const STATUS_LOG_FILE = './status_logs.json'; // File lưu lịch sử dừng/chạy bot

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
    isPausedByMargin: false // Trạng thái tạm dừng do vượt margin
};

// Load data
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

    let usedMargin = 0;
    let unPnl = 0;
    pending.forEach(h => {
        let lp = coinData[h.symbol]?.live?.currentPrice || h.avgPrice;
        let mBase = botConfig.marginVal.includes('%') ? (walletBal * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = mBase * (h.dcaCount + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / h.avgPrice : (h.avgPrice - lp) / h.avgPrice) * 100 * (h.maxLev || 20);
        usedMargin += tM;
        unPnl += (tM * roi / 100);
    });

    let avail = walletBal - usedMargin + (unPnl < 0 ? unPnl : 0);
    let marginRatio = usedMargin > 0 ? (usedMargin / (avail + usedMargin)) * 100 : 0;

    // LOGIC DỪNG/CHẠY TỰ ĐỘNG
    if (!botConfig.isPausedByMargin && marginRatio > 50) {
        botConfig.isPausedByMargin = true;
        saveStatusLog('STOP', `Margin ${marginRatio.toFixed(1)}% > 50%. Tạm dừng mở lệnh.`);
    } else if (botConfig.isPausedByMargin && marginRatio < 40) {
        botConfig.isPausedByMargin = false;
        saveStatusLog('START', `Margin ${marginRatio.toFixed(1)}% < 40%. Tiếp tục hoạt động.`);
    }

    return { walletBal, avail, equity: walletBal + unPnl, marginRatio, usedMargin };
}

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

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
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            } else if (!botConfig.isPausedByMargin && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol) {
                const state = calculateCurrentState();
                if (state.avail > 0 && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = sumVol >= 0 ? 'LONG' : 'SHORT';
                        historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl, maxNegativeRoi: 0, dcaCount: 0 });
                    }});
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
    <style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
    body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; }
    .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
    input { background: #0b0e11; border: 1px solid #30363d; color: white; padding: 4px 8px; border-radius: 4px; }</style></head><body>
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <input id="balanceInp" type="number" placeholder="Vốn">
            <input id="marginInp" type="text" placeholder="Margin (Ví dụ: 10%)">
            <div class="col-span-2 grid grid-cols-4 gap-2">
                <input id="tpInp" type="number" placeholder="TP">
                <input id="slInp" type="number" placeholder="DCA">
                <input id="volInp" type="number" placeholder="Vol">
                <button onclick="save(true)" class="bg-[#fcd535] text-black font-bold rounded text-[10px]">START</button>
            </div>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-2">
            <div class="font-bold italic">LUFFY <span class="text-[#fcd535]">PRO</span></div>
            <div id="marginBar" class="h-2 w-32 bg-zinc-700 rounded-full overflow-hidden"><div id="marginFill" class="h-full bg-green-500"></div></div>
            <button onclick="save(false)" class="text-red-500 font-bold border border-red-500 px-2 py-0.5 rounded text-[10px]">STOP</button>
        </div>
        <div class="flex justify-between items-end">
            <div><div class="text-[10px] text-gray-400 font-bold">EQUITY / AVAIL</div><div id="displayBal" class="text-3xl font-bold">0.00</div><div id="displayAvail" class="text-blue-400 text-xs font-bold">0.00</div></div>
            <div class="text-right"><div id="botStatus" class="text-[10px] font-bold px-2 py-0.5 rounded">RUNNING</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>
    <div class="px-4 mt-4"><div class="bg-card p-4 rounded-xl h-[180px]"><canvas id="balanceChart"></canvas></div></div>
    <div class="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-card p-4 rounded-xl">
            <div class="text-xs font-bold mb-2 uppercase tracking-widest">⚠️ Lịch sử dừng bot (Margin Logic)</div>
            <div id="logBody" class="text-[9px] space-y-1 h-32 overflow-y-auto"></div>
        </div>
        <div class="bg-card p-4 rounded-xl">
            <div class="text-xs font-bold mb-2 uppercase tracking-widest">🔥 Vị thế đang mở</div>
            <table class="w-full text-[10px] text-left"><thead><tr class="text-gray-500"><th>Pair</th><th>DCA</th><th>Margin</th><th class="text-right">PnL</th></tr></thead><tbody id="pendingBody"></tbody></table>
        </div>
    </div>
    <div class="px-4 pb-10"><div class="bg-card p-4 rounded-xl text-[9px]">
        <div class="text-xs font-bold mb-2 uppercase tracking-widest"> Nhật ký giao dịch</div>
        <table class="w-full text-left"><thead><tr class="text-gray-500"><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>PnL</th><th class="text-right">Wallet | Avail</th></tr></thead><tbody id="historyBody"></tbody></table>
    </div></div>
    <script>
    let myChart = null;
    function save(s) { const q = new URLSearchParams({ running: s, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value }); fetch('/api/config?'+q).then(()=>location.reload()); }
    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        if(d.botConfig.running){ document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
        const st = d.state;
        document.getElementById('displayBal').innerText = st.equity.toFixed(2);
        document.getElementById('displayAvail').innerText = 'Avail: ' + st.avail.toFixed(2);
        document.getElementById('unPnl').innerText = (st.equity - st.walletBal).toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold ' + (st.equity >= st.walletBal ? 'up':'down');
        document.getElementById('marginFill').style.width = Math.min(st.marginRatio, 100) + '%';
        document.getElementById('marginFill').className = 'h-full ' + (st.marginRatio > 45 ? 'bg-red-500' : 'bg-green-500');
        const bSt = document.getElementById('botStatus');
        if(d.botConfig.isPausedByMargin){ bSt.innerText = 'PAUSED (MARGIN > 50%)'; bSt.className = 'text-[10px] font-bold px-2 py-0.5 rounded bg-red-900 text-red-200 animate-pulse'; } else { bSt.innerText = 'RUNNING'; bSt.className = 'text-[10px] font-bold px-2 py-0.5 rounded bg-green-900 text-green-200'; }
        document.getElementById('logBody').innerHTML = d.statusLogs.map(l => \`<div class="flex justify-between border-b border-zinc-800 pb-1"><span class="\${l.type==='STOP'?'text-red-400':'text-green-400'}">[\${l.type}] \${new Date(l.time).toLocaleTimeString()}</span><span class="text-gray-500">\${l.msg}</span></div>\`).join('');
        
        let rB = d.botConfig.initialBal, cW = [rB], cA = [rB], cL = ['Start'];
        document.getElementById('historyBody').innerHTML = d.history.sort((a,b)=>a.endTime-b.endTime).map(h => {
            let m = d.botConfig.marginVal.includes('%') ? (rB * parseFloat(d.botConfig.marginVal)/100) : parseFloat(d.botConfig.marginVal);
            let tM = m * (h.dcaCount + 1);
            let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
            rB += pnl; cW.push(rB); cA.push(rB); cL.push("");
            return \`<tr class="border-b border-zinc-800 pb-1"><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td>\${h.symbol}</td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td><td class="text-right font-bold">\${rB.toFixed(1)} | <span class="text-blue-400">\${rB.toFixed(1)}</span></td></tr>\`;
        }).reverse().join('');
        
        document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let m = d.botConfig.marginVal.includes('%') ? (st.walletBal * parseFloat(d.botConfig.marginVal)/100) : parseFloat(d.botConfig.marginVal);
            let tM = m * (h.dcaCount + 1);
            let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
            return \`<tr class="border-b border-zinc-800"><td>\${h.symbol}</td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="text-right \${roi>=0?'up':'down'}">\${roi.toFixed(1)}%</td></tr>\`;
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
