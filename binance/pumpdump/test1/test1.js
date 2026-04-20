const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const STOP_LOGS_FILE = './stop_logs.json';
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
let stopLogs = [];

let botConfig = { 
    initialBal: 1000, marginVal: "10%", tp: 0.5, sl: 10.0, vol: 6.5, 
    mode: 'FOLLOW', running: false, isStoppedByMargin: false 
};

if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(STOP_LOGS_FILE)) { try { stopLogs = JSON.parse(fs.readFileSync(STOP_LOGS_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
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

let currentStopLog = null;

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        const pendingTrades = Array.from(historyMap.values()).filter(h => h.status === 'PENDING');
        
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            if (!botConfig.running) return;

            const pending = pendingTrades.find(h => h.symbol === s);
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
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
            } else {
                if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol && !botConfig.isStoppedByMargin) {
                    if (!(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                        if (!actionQueue.find(q => q.id === s)) {
                            actionQueue.push({ id: s, priority: 2, action: () => {
                                const sumVol = c1 + c5 + c15;
                                let type = (botConfig.mode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                                if (botConfig.mode === 'LONG_ONLY') type = 'LONG';
                                if (botConfig.mode === 'SHORT_ONLY') type = 'SHORT';
                                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl, snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: now, p: p, avg: p }] });
                            }});
                        }
                    }
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    botConfig = { ...botConfig, ...req.query };
    botConfig.tp = parseFloat(botConfig.tp); botConfig.sl = parseFloat(botConfig.sl);
    botConfig.vol = parseFloat(botConfig.vol); botConfig.initialBal = parseFloat(botConfig.initialBal);
    botConfig.running = req.query.running === 'true';
    
    const guiStopByMargin = req.query.isStoppedByMargin === 'true';
    if (guiStopByMargin && !botConfig.isStoppedByMargin) {
        botConfig.isStoppedByMargin = true;
        currentStopLog = { start: Date.now(), end: null, data: JSON.parse(req.query.stopData || '{}') };
    } else if (!guiStopByMargin && botConfig.isStoppedByMargin) {
        botConfig.isStoppedByMargin = false;
        if (currentStopLog) {
            currentStopLog.end = Date.now();
            stopLogs.unshift(currentStopLog);
            if (stopLogs.length > 50) stopLogs.pop();
            fs.writeFileSync(STOP_LOGS_FILE, JSON.stringify(stopLogs));
        }
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig));
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING'),
        stopLogs, botConfig
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; padding: 8px; border-radius: 4px; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setupPanel" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom uppercase font-bold">Margin per Trade (Số hoặc %)</label><input id="marginInp" type="text" class="w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom uppercase">Chế độ</label>
                    <select id="modeInp" class="w-full text-sm">
                        <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option><option value="LONG_ONLY">LONG ONLY</option><option value="SHORT_ONLY">SHORT ONLY</option>
                    </select>
                </div>
            </div>
            <button onclick="toggleBot(true)" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">START ENGINE</button>
        </div>

        <div class="flex justify-between items-start mb-4">
            <div>
                <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
                <div id="configSummary" class="text-[10px] text-gray-custom font-bold mt-1 uppercase tracking-tighter"></div>
            </div>
            <div class="text-right">
                <div id="btnStopContainer" class="hidden"><button onclick="toggleBot(false)" class="bg-red-600 px-3 py-1 text-[10px] font-bold rounded text-white uppercase italic">STOP ENGINE</button></div>
                <div id="botStatusBadge" class="mt-1 px-2 py-0.5 rounded inline-block text-black bg-gray-500 text-[10px] font-bold">STOPPED</div>
            </div>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Vốn + PnL Live)</div>
                <span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span>
                <div class="text-[11px] text-blue-400 font-bold uppercase mt-1">Avail: <span id="displayAvail">0.00</span> USDT</div>
            </div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Biến động (Real-time)</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Pair</th><th class="text-center">1m %</th><th class="text-center">5m %</th><th class="text-center">15m %</th><th class="text-right">Price</th></tr></thead><tbody id="liveBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="md:col-span-2 bg-card rounded-xl p-4"><div style="height: 180px;"><canvas id="balanceChart"></canvas></div></div>
        <div class="bg-card rounded-xl p-4 overflow-y-auto" style="max-height: 220px;">
             <div class="text-[11px] font-bold text-red-500 uppercase tracking-widest italic mb-2">Lịch sử Ngưng Mở Lệnh</div>
             <div id="stopLogBody" class="text-[9px] space-y-2"></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4">
        <div class="flex justify-between items-center mb-3">
            <div class="text-[11px] font-bold text-white uppercase tracking-wider">Vị thế đang mở</div>
            <div id="noAvailMsg" class="hidden text-red-500 font-bold text-[10px] animate-pulse uppercase italic">⚠️ Margin > 50% Avail - Ngưng quét lệnh</div>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>STT</th><th>Pair</th><th>DCA</th><th>Margin</th><th class="text-center">Lev/Target</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 mb-10"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Target</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let myChart = null, isStoppedByMarginLocal = false, isRunningLocal = false, firstLoad = true;
    
    function fPrice(p) { if (!p || p === 0) return "0.0000"; let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/); if (!match) return p.toFixed(4); let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3); }

    function toggleBot(status) {
        const query = new URLSearchParams({
            running: status,
            initialBal: document.getElementById('balanceInp').value,
            marginVal: document.getElementById('marginInp').value,
            tp: document.getElementById('tpInp').value,
            sl: document.getElementById('slInp').value,
            vol: document.getElementById('volInp').value,
            mode: document.getElementById('modeInp').value
        });
        fetch('/api/config?' + query.toString()).then(() => location.reload());
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            isRunningLocal = d.botConfig.running;
            
            // Ẩn hiện cấu hình và nút Stop
            const setup = document.getElementById('setupPanel');
            const btnStop = document.getElementById('btnStopContainer');
            const badge = document.getElementById('botStatusBadge');
            
            if(isRunningLocal) {
                setup.classList.add('hidden'); btnStop.classList.remove('hidden');
                badge.innerText = "RUNNING"; badge.className = "mt-1 px-2 py-0.5 rounded inline-block text-black bg-green-500 font-bold text-[10px]";
            } else {
                setup.classList.remove('hidden'); btnStop.classList.add('hidden');
                badge.innerText = "STOPPED"; badge.className = "mt-1 px-2 py-0.5 rounded inline-block text-black bg-gray-500 font-bold text-[10px]";
            }

            if(firstLoad) {
                document.getElementById('balanceInp').value = d.botConfig.initialBal;
                document.getElementById('marginInp').value = d.botConfig.marginVal;
                document.getElementById('tpInp').value = d.botConfig.tp;
                document.getElementById('slInp').value = d.botConfig.sl;
                document.getElementById('volInp').value = d.botConfig.vol;
                document.getElementById('modeInp').value = d.botConfig.mode;
                firstLoad = false;
            }

            document.getElementById('configSummary').innerText = \`Mode: \${d.botConfig.mode} | Margin: \${d.botConfig.marginVal} | TP: \${d.botConfig.tp}% | DCA: \${d.botConfig.sl}% | Vol: \${d.botConfig.vol}%\`;

            let runningBal = d.botConfig.initialBal, unPnlTotal = 0, usedMarginTotal = 0, countWin = 0, sumWinPnl = 0;
            let chartLabels = ['Start'], chartData = [runningBal];

            document.getElementById('liveBody').innerHTML = d.live.sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10).map(l => \`
                <tr class="border-b border-zinc-800/50"><td>\${l.symbol}</td><td class="text-center \${l.c1>=0?'up':'down'} font-bold">\${l.c1}%</td><td class="text-center \${l.c5>=0?'up':'down'}">\${l.c5}%</td><td class="text-center \${l.c15>=0?'up':'down'}">\${l.c15}%</td><td class="text-right text-gray-400">\${fPrice(l.currentPrice)}</td></tr>\`).join('');

            let histHTML = [...d.history].sort((a,b)=>a.endTime-b.endTime).map((h, idx) => {
                let mBase = d.botConfig.marginVal.includes('%') ? (runningBal * parseFloat(d.botConfig.marginVal) / 100) : parseFloat(d.botConfig.marginVal);
                let totalMargin = mBase * (h.dcaCount + 1);
                let pnl = (totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001);
                runningBal += pnl; if(pnl > 0) { countWin++; sumWinPnl += pnl; }
                chartLabels.push(""); chartData.push(runningBal);
                return \`<tr class="border-b border-zinc-800/30"><td>\${idx+1}</td><td>\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td><td><b class="text-white">\${h.symbol}</b></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${totalMargin.toFixed(1)}</td><td>\${h.maxLev}x</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right">\${runningBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');

            let avail = runningBal; // Khởi tạo Avail ban đầu từ Equity (Wallet)

            let pendingHTML = d.pending.map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                // QUAN TRỌNG: MỞ LỆNH THEO % CỦA SỐ DƯ KHẢ DỤNG (AVAIL)
                let mBase = d.botConfig.marginVal.includes('%') ? (avail * parseFloat(d.botConfig.marginVal) / 100) : parseFloat(d.botConfig.marginVal);
                let totalM = mBase * (h.dcaCount + 1);
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = totalM * roi / 100;
                unPnlTotal += pnl; usedMarginTotal += totalM;
                return \`<tr class="bg-white/5 border-b border-zinc-800"><td>\${idx+1}</td><td class="text-white font-bold">\${h.symbol} <span class="text-[8px] \${h.type==='LONG'?'bg-green-600':'bg-red-600'} px-1 rounded">\${h.type}</span></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td class="text-center">\${h.maxLev}x</td><td>\${fPrice(h.snapPrice)}<br><b class="text-green-400">\${fPrice(lp)}</b></td><td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            // Tính Avail thực tế: Wallet - Margin đã dùng + PnL đang có (nếu âm thì trừ vào khả dụng)
            avail = runningBal - usedMarginTotal + (unPnlTotal < 0 ? unPnlTotal : 0);
            
            let shouldStop = (usedMarginTotal / (runningBal + (unPnlTotal < 0 ? unPnlTotal : 0))) * 100 > 50;
            if(shouldStop !== isStoppedByMarginLocal && isRunningLocal) {
                isStoppedByMarginLocal = shouldStop;
                let stopData = { winPnl: sumWinPnl, unPnl: unPnlTotal, posCount: d.pending.length, totalMargin: usedMarginTotal, avail: avail, wallet: runningBal };
                fetch(\`/api/config?isStoppedByMargin=\${shouldStop}&stopData=\${JSON.stringify(stopData)}\`);
            }

            document.getElementById('displayBal').innerText = (runningBal + unPnlTotal).toFixed(2);
            document.getElementById('displayAvail').innerText = avail.toFixed(2);
            document.getElementById('unPnl').innerText = unPnlTotal.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
            document.getElementById('historyBody').innerHTML = histHTML;
            document.getElementById('pendingBody').innerHTML = pendingHTML;
            document.getElementById('stopLogBody').innerHTML = d.stopLogs.map(l => \`
                <div class="p-2 border-l-2 border-red-500 bg-red-500/5 mb-1">
                    <div class="font-bold">\${new Date(l.start).toLocaleTimeString()} - \${l.end ? new Date(l.end).toLocaleTimeString() : 'Đang ngưng'}</div>
                    Avail: \${l.data.avail.toFixed(1)} | Margin: \${l.data.totalMargin.toFixed(1)}
                </div>\`).join('');

            const msg = document.getElementById('noAvailMsg');
            if(shouldStop && isRunningLocal) msg.classList.remove('hidden'); else msg.classList.add('hidden');
            if(myChart) { myChart.data.labels = chartLabels; myChart.data.datasets[0].data = chartData; myChart.update('none'); }
        } catch(e) {}
    }

    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Bot running: http://localhost:${PORT}/gui`); });
