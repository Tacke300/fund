/**
 * LUFFY ENGINE PRO - FULL PRODUCTION VERSION
 * Features: 
 * 1. Warm-up 15m data from REST API on startup.
 * 2. 1s Sampling data normalization.
 * 3. Accurate reverse-loop time calculation.
 * 4. Full GUI with Luffy Baby aesthetic & Real-time Status.
 */

const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let pendingMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

// --- HỆ THỐNG XỬ LÝ LỆNH (ACTION QUEUE) ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    try { task.action(); } catch(e) { console.error("Queue Error:", e.message); }
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- HELPER FUNCTIONS ---
function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    let s = p.toFixed(20);
    let match = s.match(/^-?\d+\.0*[1-9]/);
    if (!match) return p.toFixed(4);
    let index = match[0].length;
    return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
}

// --- FILE SYSTEM INIT ---
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => {
            historyMap.set(`${h.symbol}_${h.startTime}`, h);
            if (h.status === 'PENDING') pendingMap.set(h.symbol, h);
        });
    } catch (e) {}
}

/**
 * MODULE 1: PRELOAD DATA (REST API)
 * Mục tiêu: Có biến động 1m/5m/15m ngay khi restart bot
 */
async function preloadData() {
    console.log('⏳ [WARM-UP] Đang nạp dữ liệu 15m từ Binance REST API...');
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const symbols = await res.json();
        const targetSymbols = symbols.slice(0, 100); // Lấy top 100 coin để tối ưu tốc độ load

        for (let s of targetSymbols) {
            const sym = s.symbol;
            try {
                const klineRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1m&limit=16`);
                const klines = await klineRes.json();
                
                coinData[sym] = {
                    symbol: sym,
                    prices: klines.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) })),
                    lastUpdateSecond: 0,
                    live: { c1: 0, c5: 0, c15: 0, currentPrice: parseFloat(s.price) }
                };
            } catch (err) {}
        }
        console.log(`✅ [WARM-UP] Hoàn tất. Đã nạp dữ liệu cho ${Object.keys(coinData).length} coins.`);
    } catch (e) {
        console.error('❌ [WARM-UP] Lỗi preload:', e.message);
    }
}

/**
 * MODULE 2: CALCULATION LOGIC
 * Mục tiêu: Tìm mốc giá chuẩn xác trong quá khứ bằng vòng lặp ngược
 */
function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    const targetTime = now - min * 60000;

    if (now - pArr[0].t < (min * 60000) - 5000) return 0;

    let start = pArr[0];
    for (let i = pArr.length - 1; i >= 0; i--) {
        if (pArr[i].t <= targetTime) {
            start = pArr[i];
            break;
        }
    }
    const latest = pArr[pArr.length - 1];
    let change = ((latest.p - start.p) / start.p) * 100;
    return parseFloat(change.toFixed(2));
}

/**
 * MODULE 3: WEBSOCKET SAMPLING 1S
 */
function initWS() {
    console.log('🚀 [WS] Khởi động Stream miniTicker@arr...');
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr', { family: 4 });
    let lastMessageTime = Date.now();

    const watchdog = setInterval(() => {
        if (Date.now() - lastMessageTime > 120000) {
            console.log('⚠️ [WATCHDOG] Không nhận được data > 120s, tiến hành reconnect...');
            ws.terminate();
        }
    }, 10000);

    ws.on('open', () => { console.log('✅ [WS] Connected thành công.'); lastMessageTime = Date.now(); });
    ws.on('message', (data) => {
        lastMessageTime = Date.now();
        let tickers;
        try { tickers = JSON.parse(data); } catch (e) { return; }

        const now = Date.now();
        const currentSecond = Math.floor(now / 1000);

        tickers.forEach(t => {
            const s = t.s;
            const p = parseFloat(t.c);
            
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastUpdateSecond: 0 };
            
            // CHUẨN HÓA DỮ LIỆU: Chỉ lưu 1 điểm/giây
            if (coinData[s].lastUpdateSecond !== currentSecond) {
                coinData[s].lastUpdateSecond = currentSecond;
                coinData[s].prices.push({ p, t: now });
                if (coinData[s].prices.length > 1200) coinData[s].prices.shift();
            }
            
            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = pendingMap.get(s);
            if (pending && pending.status === 'PENDING') {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = win ? 'WIN' : 'TIMEOUT';
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    pending.endTime = now;
                    console.log(`💰 [TRADE FINISHED] ${s} | ROI: ${currentRoi.toFixed(2)}% | Status: ${pending.status}`);
                    lastTradeClosed[s] = now; pendingMap.delete(s);
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }

                // Logic DCA (tối giản cho server log)
                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
                
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        pending.avgPrice = newAvg; pending.dcaCount = newCount;
                        console.log(`⚠️ [DCA] ${s} lần \${newCount} | Entry mới: \${newAvg}`);
                    }});
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol) {
                if (lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000)) return;
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = sumVol >= 0 ? 'LONG' : 'SHORT';
                        if (tradeMode === 'REVERSE') type = (type === 'LONG' ? 'SHORT' : 'LONG');
                        
                        console.log(`🚀 [ENTRY] \${s} | Type: \${type} | c1:\${c1}% c5:\${c5}% c15:\${c15}%`);
                        
                        const newT = { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL,
                            dcaCount: 0, dcaHistory: [{ t: now, p, avg: p }]
                        };
                        historyMap.set(`${s}_${newT.startTime}`, newT);
                        pendingMap.set(s, newT);
                    }});
                }
            }
        });
    });
    ws.on('close', () => { clearInterval(watchdog); console.log('❌ [WS] Closed. Reconnecting...'); setTimeout(initWS, 5000); });
}

// LOG HỆ THỐNG ĐỊNH KỲ
setInterval(() => {
    const coins = Object.values(coinData);
    if (coins.length === 0) return;
    const ready15m = coins.filter(c => c.prices.length >= 900).length;
    console.log(`📊 [MONITOR] Coins: \${coins.length} | Ready 15m: \${ready15m} | Pending: \${pendingMap.size}`);
}, 15000);

// --- API ROUTES ---
app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp) || currentTP;
    currentSL = parseFloat(req.query.sl) || currentSL;
    currentMinVol = parseFloat(req.query.vol) || currentMinVol;
    tradeMode = req.query.mode || 'FOLLOW';
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const coins = Object.values(coinData);
    res.json({ 
        allPrices: Object.fromEntries(coins.map(v => [v.symbol, v.live ? v.live.currentPrice : 0])),
        live: coins.filter(v => v.live).map(v => ({ symbol: v.symbol, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime),
        status: {
            total: coins.length,
            ready1m: coins.filter(c => c.prices.length >= 60).length,
            ready5m: coins.filter(c => c.prices.length >= 300).length,
            ready15m: coins.filter(c => c.prices.length >= 900).length
        }
    });
});

// --- GUI: LUFFY BABY THEME ---
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
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.8); align-items:center; justify-content:center; }
        .luffy-bg { position: fixed; bottom: -20px; right: -20px; opacity: 0.15; pointer-events: none; width: 300px; z-index: 0; }
    </style></head><body>
    
    <img src="https://i.pinimg.com/originals/85/33/c2/8533c24d45543ef688f2f2526e38600f.png" class="luffy-bg">

    <div id="detailModal" class="modal">
        <div class="bg-card p-6 rounded-lg w-11/12 max-w-2xl border border-zinc-700 relative">
            <button onclick="closeModal('detailModal')" class="absolute top-2 right-4 text-2xl text-gray-custom hover:text-white">&times;</button>
            <h2 id="modalTitle" class="text-yellow-500 font-bold mb-4 uppercase"></h2>
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Lần</th><th>Thời gian</th><th>Giá DCA</th><th>Giá TB</th><th>Lev</th><th>TP sau DCA</th></tr></thead><tbody id="modalBody"></tbody></table></div>
        </div>
    </div>

    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Chế độ</label><select id="modeInp" class="p-2 rounded w-full outline-none text-sm"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select></div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">Lưu & Khởi chạy</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div id="sysStatus" class="text-[9px] font-mono text-zinc-500"></div>
            <div class="text-[#f6465d] font-black italic text-sm border border-[#f6465d] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div><div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Balance + PnL)</div><span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span><span class="text-sm text-gray-custom ml-1">USDT</span></div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Live</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-5 relative z-10"><div class="bg-card rounded-xl p-4 border border-zinc-800"><div style="height: 180px;"><canvas id="balanceChart"></canvas></div></div></div>

    <div class="px-4 mt-5 relative z-10"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase italic">Market Flow (3 Timeframes)</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>Symbol</th><th>Price</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-center">15M</th></tr></thead><tbody id="marketBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 relative z-10"><div class="bg-card rounded-xl p-4 shadow-lg border-l-4 border-green-500">
        <div class="text-[11px] font-bold text-white mb-3 uppercase flex items-center">Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 pb-32 relative z-10"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase italic">Trade History</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>Time</th><th>Pair</th><th>DCA</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, initialBal = 1000, lastRawData = null, myChart = null;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;
    document.getElementById('modeInp').value = saved.mode || "FOLLOW";

    if(saved.running) {
        running = true; initialBal = saved.initialBal;
        document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
        syncConfig();
    }

    function fPrice(p) { return p ? p.toFixed(4) : "0.0000"; }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }
    function showDetail(symbol, startTime) {
        const item = [...lastRawData.pending, ...lastRawData.history].find(h => h.symbol === symbol && h.startTime == startTime);
        if(!item) return;
        document.getElementById('modalTitle').innerText = \`DCA: \${symbol}\`;
        document.getElementById('modalBody').innerHTML = item.dcaHistory.map((d, i) => \`
            <tr class="border-b border-zinc-800/50"><td class="py-2">\${i}</td><td>\${new Date(d.t).toLocaleTimeString()}</td><td>\${fPrice(d.p)}</td><td>\${fPrice(d.avg)}</td><td>--</td><td>\${item.maxLev}x</td><td class="up font-bold">\${fPrice(item.type==='LONG'? d.avg*(1+item.tpTarget/100) : d.avg*(1-item.tpTarget/100))}</td></tr>\`).join('');
        document.getElementById('detailModal').style.display = 'flex';
    }

    function start() {
        running = true; initialBal = parseFloat(document.getElementById('balanceInp').value);
        localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }));
        syncConfig(); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }
    function syncConfig() {
        fetch(\`/api/config?tp=\${document.getElementById('tpInp').value}&sl=\${document.getElementById('slInp').value}&vol=\${document.getElementById('volInp').value}&mode=\${document.getElementById('modeInp').value}\`);
    }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line', data: { labels: [], datasets: [{ label: 'Equity', data: [], borderColor: '#fcd535', backgroundColor: 'rgba(252, 213, 53, 0.05)', fill: true, tension: 0.2, pointRadius: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.02)' } } }, animation: { duration: 0 } }
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastRawData = d;
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let runningBal = initialBal, unPnl = 0;
            let chartLabels = ['Start'], chartData = [initialBal];

            document.getElementById('sysStatus').innerHTML = \`SAMPLING: \${d.status.total} | 1M: \${d.status.ready1m} | 5M: \${d.status.ready5m} | 15M: \${d.status.ready15m}\`;

            document.getElementById('marketBody').innerHTML = (d.live || []).slice(0, 10).map(m => \`
                <tr class="border-b border-zinc-800/30 text-[11px]"><td class="font-bold text-white py-2">\${m.symbol}</td><td class="text-yellow-500">\${fPrice(m.currentPrice)}</td><td class="text-center font-bold \${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="text-center font-bold \${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="text-center font-bold \${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('');

            let histItems = [...d.history].reverse();
            document.getElementById('historyBody').innerHTML = histItems.map((h, index) => {
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let netPnl = (marginBase * (h.dcaCount + 1) * (h.maxLev || 20) * (h.pnlPercent/100));
                runningBal += netPnl;
                chartLabels.push(index); chartData.push(runningBal);
                return \`<tr class="border-b border-zinc-800/30 text-zinc-400"><td class="py-2 text-[7px]">\${new Date(h.endTime).toLocaleTimeString()}</td><td><b class="text-white underline cursor-pointer" onclick="showDetail('\${h.symbol}', \${h.startTime})">\${h.symbol}</b></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td class="\${netPnl>=0?'up':'down'} font-bold">\${netPnl.toFixed(2)}</td><td class="text-right text-white">\${runningBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');

            document.getElementById('pendingBody').innerHTML = (d.pending || []).map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum; 
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = (marginBase * (h.dcaCount + 1)) * roi / 100; unPnl += pnl;
                return \`<tr class="bg-white/5 border-b border-zinc-800"><td><b class="underline cursor-pointer" onclick="showDetail('\${h.symbol}', \${h.startTime})">\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${(marginBase*(h.dcaCount+1)).toFixed(1)}</td><td>\${fPrice(h.avgPrice)}<br><b class="text-green-400">\${fPrice(lp)}</b></td><td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            let currentEquity = runningBal + unPnl;
            if(myChart) { myChart.data.labels = chartLabels; myChart.data.datasets[0].data = chartData; myChart.update('none'); }
            document.getElementById('displayBal').innerText = currentEquity.toFixed(2);
            document.getElementById('unPnl').innerText = unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
        } catch(e) {}
    }
    initChart();
    setInterval(update, 1000);
    </script></body></html>`);
});

// KHỞI CHẠY HỆ THỐNG
app.listen(PORT, '0.0.0.0', async () => { 
    await preloadData(); 
    initWS(); 
    console.log(`🚀 [SYSTEM] Luffy Engine Online at http://localhost:${PORT}/gui`); 
});
