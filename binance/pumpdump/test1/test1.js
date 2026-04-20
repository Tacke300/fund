const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let botConfig = {
    initialBal: 1000,
    marginVal: "10%",
    tp: 0.5,
    sl: 10.0,
    vol: 6.5,
    mode: 'FOLLOW',
    running: false
};

if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

// HÀM TÍNH SỐ DƯ KHẢ DỤNG THẬT SỰ (AVAIL) Ở BACKEND
function getRealAvail() {
    let currentBal = botConfig.initialBal;
    let usedMargin = 0;
    let unPnl = 0;

    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    // Tính balance từ lịch sử
    hist.forEach(h => {
        let mBase = botConfig.marginVal.includes('%') ? (currentBal * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = mBase * (h.dcaCount + 1);
        let pnl = (tM * (h.maxLev || 20) * (h.pnlPercent/100)) - (tM * (h.maxLev || 20) * 0.001);
        currentBal += pnl;
    });

    // Tính margin đang dùng và PnL âm của lệnh đang mở
    pending.forEach(h => {
        let lp = coinData[h.symbol]?.live?.currentPrice || h.avgPrice;
        let mBase = botConfig.marginVal.includes('%') ? (currentBal * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = mBase * (h.dcaCount + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / h.avgPrice : (h.avgPrice - lp) / h.avgPrice) * 100 * (h.maxLev || 20);
        let pnl = tM * roi / 100;
        usedMargin += tM;
        if (pnl < 0) unPnl += pnl;
    });

    return currentBal - usedMargin + unPnl;
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
        const allPositions = Array.from(historyMap.values()).filter(h => h.status === 'PENDING');

        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            const c1 = calculateChange(coinData[s].prices, 1), 
                  c5 = calculateChange(coinData[s].prices, 5), 
                  c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = allPositions.find(h => h.symbol === s);
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) { 
                    pending.maxNegativeRoi = currentRoi;
                    pending.maxNegativeTime = now;
                }
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }
                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        setTimeout(() => { pending.avgPrice = newAvg; pending.dcaCount = newCount; }, 200); 
                    }});
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    // KIỂM TRA AVAIL TRƯỚC KHI CHO VÀO QUEUE
                    const availNow = getRealAvail();
                    if (availNow > 0) {
                        actionQueue.push({ id: s, priority: 2, action: () => {
                            const sumVol = c1 + c5 + c15;
                            let type = (botConfig.mode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                            if (botConfig.mode === 'LONG_ONLY') type = 'LONG';
                            if (botConfig.mode === 'SHORT_ONLY') type = 'SHORT';
                            historyMap.set(`${s}_${now}`, { 
                                symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                                maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl, 
                                snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, maxNegativeTime: null, dcaCount: 0, 
                                dcaHistory: [{ t: Date.now(), p: p, avg: p }] 
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
    botConfig.tp = parseFloat(botConfig.tp); botConfig.sl = parseFloat(botConfig.sl); botConfig.vol = parseFloat(botConfig.vol); botConfig.initialBal = parseFloat(botConfig.initialBal);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig));
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime),
        botConfig
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
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade</label><input id="marginInp" type="text" class="w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Chế độ</label>
                    <select id="modeInp" class="w-full text-sm">
                        <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option><option value="LONG_ONLY">LONG ONLY</option><option value="SHORT_ONLY">SHORT ONLY</option>
                    </select>
                </div>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-right text-[10px] uppercase font-bold text-green-500">WIN: <span id="winCount">0</span> | PNL: <span id="winPnl">0.00</span></div>
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

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 border border-zinc-800">
        <div class="text-[11px] font-bold text-gray-custom uppercase tracking-widest italic mb-2">Growth Curve</div>
        <div style="height: 180px;"><canvas id="balanceChart"></canvas></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="flex justify-between items-center mb-3">
            <div class="text-[11px] font-bold text-white uppercase tracking-wider flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
            <div id="noAvailMsg" class="hidden text-red-500 font-bold text-[10px] animate-pulse italic">⚠️ HẾT KHẢ DỤNG LÚC: <span id="outTime"></span></div>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>STT</th><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th class="text-center">Lev/Target</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 mb-10"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>Margin</th><th class="text-center">Target</th><th>Entry/Out</th><th>Avg Price</th><th class="text-center">MaxDD</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let myChart = null, isFirst = true;
    function fPrice(p) { if (!p || p === 0) return "0.0000"; let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/); if (!match) return parseFloat(p).toFixed(4); let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3); }

    function save(status) {
        const q = new URLSearchParams({ 
            running: status, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, 
            tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value 
        });
        fetch('/api/config?' + q.toString()).then(() => location.reload());
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const config = d.botConfig;
            if(isFirst) {
                document.getElementById('balanceInp').value = config.initialBal; document.getElementById('marginInp').value = config.marginVal;
                document.getElementById('tpInp').value = config.tp; document.getElementById('slInp').value = config.sl;
                document.getElementById('volInp').value = config.vol; document.getElementById('modeInp').value = config.mode;
                if(config.running) { document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
                isFirst = false;
            }

            let rBal = config.initialBal, unPnl = 0, uMargin = 0, wCount = 0, wSum = 0;
            let cLab = ['Start'], cDat = [rBal];

            let hHTML = [...d.history].sort((a,b)=>a.endTime-b.endTime).map((h, i) => {
                let mB = config.marginVal.includes('%') ? (rBal * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
                let tM = mB * (h.dcaCount + 1);
                let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
                rBal += pnl; if(pnl>0){wCount++; wSum+=pnl;} cLab.push(""); cDat.push(rBal);
                let sv = h.snapVol || {c1:0,c5:0,c15:0};
                let maxNegPnl = (tM * (h.maxLev||20) * (h.maxNegativeRoi/100)) / (h.maxLev||20);
                return \`<tr class="border-b border-zinc-800/30 \${h.dcaCount>=5?'recovery-row':''}"><td>\${d.history.length - i}</td><td class="text-[7px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span><div class="text-[7px] text-gray-500">V: \${sv.c1}/\${sv.c5}/\${sv.c15}</div></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="text-center">\${h.maxLev}x</td><td>\${fPrice(h.snapPrice)}<br>\${fPrice(h.finalPrice)}</td><td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td><td class="text-center"><span class="down">\${h.maxNegativeRoi.toFixed(1)}%</span><br><span class="text-[7px]">\${maxNegPnl.toFixed(1)}$</span></td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right">\${rBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');

            let avTemp = rBal;
            let pHTML = d.pending.map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mB = config.marginVal.includes('%') ? (avTemp * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
                let tM = mB * (h.dcaCount + 1);
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
                let pnl = tM*roi/100; unPnl+=pnl; uMargin+=tM;
                let sv = h.snapVol || {c1:0,c5:0,c15:0};
                return \`<tr class="border-b border-zinc-800 \${h.dcaCount>=5?'recovery-row':''}"><td>\${idx+1}</td><td class="text-[8px]">\${new Date(h.startTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="px-1 \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded">\${h.type}</span><div class="text-[7px] text-gray-400">V: \${sv.c1}/\${sv.c5}/\${sv.c15}</div></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="text-center text-[7px]">\${h.maxLev}x</td><td>\${fPrice(h.snapPrice)}<br><b class="text-green-400">\${fPrice(lp)}</b></td><td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td><td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            let av = rBal - uMargin + (unPnl<0?unPnl:0);
            document.getElementById('displayBal').innerText = (rBal+unPnl).toFixed(2);
            document.getElementById('displayAvail').innerText = av.toFixed(2);
            document.getElementById('unPnl').innerText = unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl>=0?'up':'down');
            document.getElementById('winCount').innerText = wCount; document.getElementById('winPnl').innerText = wSum.toFixed(2);
            document.getElementById('historyBody').innerHTML = hHTML; document.getElementById('pendingBody').innerHTML = pHTML;
            const msg = document.getElementById('noAvailMsg');
            if(av <= 0 && d.pending.length > 0) { if(msg.classList.contains('hidden')) { msg.classList.remove('hidden'); document.getElementById('outTime').innerText = new Date().toLocaleTimeString(); } } else { msg.classList.add('hidden'); }
            if(myChart){ myChart.data.labels = cLab; myChart.data.datasets[0].data = cDat; myChart.update('none'); }
        } catch(e) {}
    }
    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Bot running: http://localhost:${PORT}/gui`); });
