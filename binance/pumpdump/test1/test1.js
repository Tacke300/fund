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

// Load Cấu hình từ file để không bị mất khi restart server
let botConfig = { tp: 0.5, sl: 10.0, vol: 6.5, mode: 'FOLLOW', isStoppedByMargin: false };
if (fs.existsSync(CONFIG_FILE)) { try { botConfig = JSON.parse(fs.readFileSync(CONFIG_FILE)); } catch(e){} }
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

function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    let s = p.toFixed(20);
    let match = s.match(/^-?\d+\.0*[1-9]/);
    if (!match) return p.toFixed(4);
    let index = match[0].length;
    return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
}

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
            
            const pending = pendingTrades.find(h => h.symbol === s);
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

                // DCA & MỞ NGƯỢC (Luôn chạy, không bị chặn bởi 50% margin)
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
                // MỞ LỆNH MỚI (Bị chặn nếu botConfig.isStoppedByMargin = true)
                if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol && !botConfig.isStoppedByMargin) {
                    if (!(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                        if (!actionQueue.find(q => q.id === s)) {
                            actionQueue.push({ id: s, priority: 2, action: () => {
                                const sumVol = c1 + c5 + c15;
                                let type = (botConfig.mode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                                if (botConfig.mode === 'LONG_ONLY') type = 'LONG';
                                if (botConfig.mode === 'SHORT_ONLY') type = 'SHORT';
                                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl, snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, maxNegativeTime: null, dcaCount: 0, dcaHistory: [{ t: now, p: p, avg: p }] });
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
    botConfig.tp = parseFloat(req.query.tp);
    botConfig.sl = parseFloat(req.query.sl);
    botConfig.vol = parseFloat(req.query.vol);
    botConfig.mode = req.query.mode || 'FOLLOW';
    
    const guiStop = req.query.isStopped === 'true';
    if (guiStop && !botConfig.isStoppedByMargin) {
        botConfig.isStoppedByMargin = true;
        currentStopLog = { start: Date.now(), end: null, data: JSON.parse(req.query.stopData || '{}') };
    } else if (!guiStop && botConfig.isStoppedByMargin) {
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
        stopLogs: stopLogs,
        botConfig: botConfig
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
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; }
        .recovery-row { background-color: rgba(75, 0, 130, 0.3) !important; color: #e0b0ff !important; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin (Ví dụ: 20 hoặc 5%)</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Chế độ</label>
                    <select id="modeInp" class="p-2 rounded w-full outline-none text-sm">
                        <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option><option value="LONG_ONLY">CHỈ LONG</option><option value="SHORT_ONLY">CHỈ SHORT</option>
                    </select>
                </div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">Lưu & Khởi chạy</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-right text-[10px] uppercase font-bold text-green-500">WIN: <span id="winCount">0</span> | PNL: <span id="winPnl">0.00</span></div>
            <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP ENGINE</div>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Vốn + PnL Live)</div>
                <span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span>
                <div class="text-[11px] text-blue-400 font-bold uppercase mt-1">Khả dụng (Avail): <span id="displayAvail">0.00</span> USDT</div>
            </div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Biến động thị trường (Real-time)</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>Pair</th><th class="text-center">1m %</th><th class="text-center">5m %</th><th class="text-center">15m %</th><th class="text-right">Price</th></tr></thead><tbody id="liveBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="md:col-span-2 bg-card rounded-xl p-4 border border-zinc-800">
             <div style="height: 180px;"><canvas id="balanceChart"></canvas></div>
        </div>
        <div class="bg-card rounded-xl p-4 border border-zinc-800 overflow-y-auto" style="max-height: 220px;">
             <div class="text-[11px] font-bold text-red-500 uppercase tracking-widest italic mb-2">Lịch sử Ngưng Mở Lệnh</div>
             <div id="stopLogBody" class="text-[9px] space-y-2"></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="flex justify-between items-center mb-3">
            <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
            <div id="noAvailMsg" class="hidden text-red-500 font-bold text-[10px] animate-pulse italic uppercase">⚠️ Margin > 50% Avail - Đã ngưng quét lệnh mới</div>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr class="pb-2"><th>STT</th><th>Pair</th><th>DCA</th><th>Margin</th><th class="text-center">Lev/Target</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 mb-10"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Target</th><th>Entry/Out</th><th class="text-center">MaxDD</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, myChart = null, isCurrentlyStopped = false;
    
    // Khởi tạo/Lưu trạng thái UI
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.running) {
        running = true;
        document.getElementById('balanceInp').value = saved.initialBal;
        document.getElementById('marginInp').value = saved.marginVal;
        document.getElementById('setup').classList.add('hidden'); 
        document.getElementById('active').classList.remove('hidden');
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(state)); 
        fetch(\`/api/config?tp=\${state.tp}&sl=\${state.sl}&vol=\${state.vol}&mode=\${state.mode}\`).then(()=>location.reload());
    }
    function stop() { 
        let s = JSON.parse(localStorage.getItem('luffy_state') || '{}'); s.running = false; 
        localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); 
    }
    function fPrice(p) { if (!p || p === 0) return "0.0000"; let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/); if (!match) return p.toFixed(4); let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3); }

    async function update() {
        if(!running) return;
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const state = JSON.parse(localStorage.getItem('luffy_state') || '{}');
            
            // Sync config từ backend xuống UI (Yêu cầu 3)
            if(!document.getElementById('tpInp').value) {
                document.getElementById('tpInp').value = d.botConfig.tp;
                document.getElementById('slInp').value = d.botConfig.sl;
                document.getElementById('volInp').value = d.botConfig.vol;
                document.getElementById('modeInp').value = d.botConfig.mode;
            }

            let mVal = state.marginVal || "10%", mNum = parseFloat(mVal);
            let runningBal = state.initialBal || 0, unPnlTotal = 0, usedMarginTotal = 0, countWin = 0, sumWinPnl = 0;
            let chartLabels = ['Start'], chartData = [runningBal];

            // Render Live Tickers
            document.getElementById('liveBody').innerHTML = d.live.sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10).map(l => \`
                <tr class="border-b border-zinc-800/50">
                    <td class="py-1 font-bold">\${l.symbol}</td>
                    <td class="text-center \${l.c1>=0?'up':'down'} font-bold">\${l.c1}%</td>
                    <td class="text-center \${l.c5>=0?'up':'down'}">\${l.c5}%</td>
                    <td class="text-center \${l.c15>=0?'up':'down'}">\${l.c15}%</td>
                    <td class="text-right text-gray-400">\${fPrice(l.currentPrice)}</td>
                </tr>\`).join('');

            // Lịch sử
            let histHTML = [...d.history].sort((a,b)=>a.endTime-b.endTime).map((h, idx) => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let totalMargin = mBase * (h.dcaCount + 1);
                let pnl = (totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalMargin * (h.maxLev || 20) * 0.001);
                runningBal += pnl; if(pnl > 0) { countWin++; sumWinPnl += pnl; }
                chartLabels.push(""); chartData.push(runningBal);
                let sv = h.snapVol || {c1:0, c5:0, c15:0};
                return \`<tr class="border-b border-zinc-800/30 \${h.dcaCount >= 5 ? 'recovery-row' : ''}"><td>\${idx+1}</td><td class="text-[7px]">\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td><td><b class="text-white">\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span><div class="text-[7px] text-gray-500">V: \${sv.c1}/\${sv.c5}/\${sv.c15}</div></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${totalMargin.toFixed(1)}</td><td class="text-[7px]">\${h.maxLev}x</td><td>\${fPrice(h.snapPrice)}<br>\${fPrice(h.finalPrice)}</td><td class="text-center"><span class="down">\${h.maxNegativeRoi.toFixed(1)}%</span></td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right">\${runningBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');

            let avail = runningBal; // Khởi tạo Avail để tính margin cho các lệnh đang mở

            // Đang mở
            let pendingHTML = d.pending.map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBase = mVal.includes('%') ? (avail * mNum / 100) : mNum;
                let totalM = mBase * (h.dcaCount + 1);
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = totalM * roi / 100;
                unPnlTotal += pnl; usedMarginTotal += totalM;
                let sv = h.snapVol || {c1:0, c5:0, c15:0};
                return \`<tr class="bg-white/5 border-b border-zinc-800"><td>\${idx+1}</td><td class="text-white font-bold">\${h.symbol} <span class="text-[8px] px-1 \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded">\${h.type}</span><div class="text-[7px] text-gray-400">V: \${sv.c1}/\${sv.c5}/\${sv.c15}</div></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td class="text-center text-[7px]">\${h.maxLev}x</td><td>\${fPrice(h.snapPrice)}<br><b class="text-green-400">\${fPrice(lp)}</b></td><td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td><td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            avail = runningBal - usedMarginTotal + (unPnlTotal < 0 ? unPnlTotal : 0);
            
            // Logic 50% Margin
            let shouldStop = (usedMarginTotal / (runningBal + (unPnlTotal < 0 ? unPnlTotal : 0))) * 100 > 50;
            if(shouldStop !== isCurrentlyStopped) {
                isCurrentlyStopped = shouldStop;
                let stopData = { winPnl: sumWinPnl, unPnl: unPnlTotal, posCount: d.pending.length, totalMargin: usedMarginTotal, avail: avail, wallet: runningBal };
                fetch(\`/api/config?tp=\${d.botConfig.tp}&sl=\${d.botConfig.sl}&vol=\${d.botConfig.vol}&mode=\${d.botConfig.mode}&isStopped=\${shouldStop}&stopData=\${JSON.stringify(stopData)}\`);
            }

            document.getElementById('displayBal').innerText = (runningBal + unPnlTotal).toFixed(2);
            document.getElementById('displayAvail').innerText = avail.toFixed(2);
            document.getElementById('winCount').innerText = countWin;
            document.getElementById('winPnl').innerText = sumWinPnl.toFixed(2);
            document.getElementById('unPnl').innerText = unPnlTotal.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
            document.getElementById('historyBody').innerHTML = histHTML;
            document.getElementById('pendingBody').innerHTML = pendingHTML;
            
            document.getElementById('stopLogBody').innerHTML = d.stopLogs.map(l => \`
                <div class="p-2 border-l-2 border-red-500 bg-red-500/5 mb-1">
                    <div class="font-bold">\${new Date(l.start).toLocaleTimeString()} - \${l.end ? new Date(l.end).toLocaleTimeString() : 'Đang ngưng'}</div>
                    W: \${l.data.winPnl.toFixed(1)} | Un: \${l.data.unPnl.toFixed(1)} | Margin: \${l.data.totalMargin.toFixed(1)}<br>
                    Avail: \${l.data.avail.toFixed(1)} | Wallet: \${l.data.wallet.toFixed(1)}
                </div>\`).join('');

            const msg = document.getElementById('noAvailMsg');
            if(shouldStop) msg.classList.remove('hidden'); else msg.classList.add('hidden');
            if(myChart) { myChart.data.labels = chartLabels; myChart.data.datasets[0].data = chartData; myChart.update('none'); }
        } catch(e) { console.error(e); }
    }

    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Bot running: http://localhost:${PORT}/gui`); });
