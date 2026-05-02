/**
 * BINANCE LUFFY PRO - VERSION 16.5 (FIX BIẾN ĐỘNG & LƯU CẤU HÌNH)
 */

const PORT = 7001; // Thay đổi 7001, 7002, 7003 cho từng folder
const HISTORY_FILE = './history_db.json';
const CONFIG_STATE_FILE = './bot_state_config.json'; // Lưu cấu hình khi restart bot
const LEVERAGE_FILE = '../leverage_cache.json';
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

// Cấu hình mặc định
let botConfig = {
    tp: 0.5,
    sl: 10.0,
    vol: 6.5,
    mode: 'FOLLOW',
    balance: 1000,
    margin: "10%"
};

// Load cấu hình đã lưu từ file (nếu có)
if (fs.existsSync(CONFIG_STATE_FILE)) {
    try {
        botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_STATE_FILE)) };
    } catch (e) { console.log("Lỗi load config file"); }
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

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

// --- LOGIC BIẾN ĐỘNG V16.5 ---
function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    const targetTime = now - min * 60000;
    let startPrice = pArr[0].p;
    for (let i = pArr.length - 1; i >= 0; i--) {
        if (pArr[i].t <= targetTime) {
            startPrice = pArr[i].p;
            break;
        }
    }
    const lastPrice = pArr[pArr.length - 1].p;
    return parseFloat((((lastPrice - startPrice) / startPrice) * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 600) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
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
            } else if ([c1, c5].some(v => Math.abs(v) >= botConfig.vol) && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = parseFloat(c1) + parseFloat(c5) + parseFloat(c15);
                        let type = (botConfig.mode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                        if (botConfig.mode === 'LONG_ONLY') type = 'LONG';
                        if (botConfig.mode === 'SHORT_ONLY') type = 'SHORT';

                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl, 
                            snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, maxNegativeTime: null, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }] 
                        });
                    }});
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// API Cập nhật & Lưu cấu hình
app.get('/api/config', (req, res) => {
    botConfig.tp = parseFloat(req.query.tp);
    botConfig.sl = parseFloat(req.query.sl);
    botConfig.vol = parseFloat(req.query.vol);
    botConfig.mode = req.query.mode;
    botConfig.balance = parseFloat(req.query.balance);
    botConfig.margin = req.query.margin;
    
    fs.writeFileSync(CONFIG_STATE_FILE, JSON.stringify(botConfig)); // Lưu vào file vĩnh viễn
    res.json(botConfig);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        config: botConfig,
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
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
    </style></head><body>
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setupBox" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Chế độ</label>
                    <select id="modeInp" class="p-2 rounded w-full outline-none text-sm">
                        <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option><option value="LONG_ONLY">LONG ONLY</option><option value="SHORT_ONLY">SHORT ONLY</option>
                    </select>
                </div>
            </div>
            <button id="startBtn" onclick="saveConfig(true)" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">KHỞI CHẠY HỆ THỐNG</button>
        </div>
        <div id="activeBox" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-right text-[10px] uppercase font-bold text-green-500">WIN: <span id="winCount">0</span> | PNL: <span id="winPnl">0.00</span></div>
            <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer" onclick="saveConfig(false)">STOP ENGINE</div>
        </div>
        <div class="flex justify-between items-end mb-3">
            <div><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">Equity</div><span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span></div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>
    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 border border-zinc-800"><div style="height: 150px;"><canvas id="balanceChart"></canvas></div></div></div>
    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider">Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>
    <div class="px-4 mt-5 mb-10"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Out</th><th class="text-right">PnL</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>
    <script>
    let myChart = null, isBotRunning = false;

    async function saveConfig(status) {
        const url = \`/api/config?tp=\${document.getElementById('tpInp').value}&sl=\${document.getElementById('slInp').value}&vol=\${document.getElementById('volInp').value}&mode=\${document.getElementById('modeInp').value}&balance=\${document.getElementById('balanceInp').value}&margin=\${document.getElementById('marginInp').value}\`;
        await fetch(url);
        localStorage.setItem('luffy_running', status);
        location.reload();
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const config = d.config;
            
            // Điền dữ liệu vào ô input nếu chưa có
            if (!document.activeElement || !['INPUT','SELECT'].includes(document.activeElement.tagName)) {
                document.getElementById('tpInp').value = config.tp;
                document.getElementById('slInp').value = config.sl;
                document.getElementById('volInp').value = config.vol;
                document.getElementById('modeInp').value = config.mode;
                document.getElementById('balanceInp').value = config.balance;
                document.getElementById('marginInp').value = config.margin;
            }

            isBotRunning = localStorage.getItem('luffy_running') === 'true';
            if (isBotRunning) {
                document.getElementById('setupBox').classList.add('hidden');
                document.getElementById('activeBox').classList.remove('hidden');
            }

            let runningBal = config.balance, unPnlTotal = 0, countWin = 0, sumWinPnl = 0;
            let chartLabels = ['Start'], chartData = [runningBal];

            let histHTML = [...d.history].reverse().map((h) => {
                let mBase = config.margin.includes('%') ? (config.balance * parseFloat(config.margin) / 100) : parseFloat(config.margin);
                let pnl = (mBase * (h.dcaCount + 1) * (h.maxLev || 20) * (h.pnlPercent/100)) - (mBase * (h.dcaCount + 1) * (h.maxLev || 20) * 0.001);
                runningBal += pnl; if(pnl > 0) { countWin++; sumWinPnl += pnl; }
                chartLabels.push(""); chartData.push(runningBal);
                return \`<tr class="border-b border-zinc-800/30"><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${(mBase*(h.dcaCount+1)).toFixed(1)}</td><td>\${h.snapPrice.toFixed(4)}->\${h.finalPrice.toFixed(4)}</td><td class="text-right \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td></tr>\`;
            }).reverse().join('');

            let pendingHTML = d.pending.map((h) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBase = config.margin.includes('%') ? (config.balance * parseFloat(config.margin) / 100) : parseFloat(config.margin);
                let tM = mBase * (h.dcaCount + 1);
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = tM * roi / 100; unPnlTotal += pnl;
                return \`<tr class="bg-white/5 border-b border-zinc-800"><td>\${h.symbol} <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td>\${h.avgPrice.toFixed(4)}<br><b class="text-yellow-400">\${lp.toFixed(4)}</b></td><td class="text-right \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
            }).join('');

            document.getElementById('displayBal').innerText = (runningBal + unPnlTotal).toFixed(2);
            document.getElementById('winCount').innerText = countWin; document.getElementById('winPnl').innerText = sumWinPnl.toFixed(2);
            document.getElementById('unPnl').innerText = unPnlTotal.toFixed(2); document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
            document.getElementById('historyBody').innerHTML = histHTML; document.getElementById('pendingBody').innerHTML = pendingHTML;
            if(myChart) { myChart.data.labels = chartLabels; myChart.data.datasets[0].data = chartData; myChart.update('none'); }
        } catch(e) {}
    }
    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Bot Luffy V16.5 running on http://localhost:${PORT}/gui`); });
