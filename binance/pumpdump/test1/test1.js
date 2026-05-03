const PORT = 7001;
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
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

// --- HỆ THỐNG XỬ LÝ HÀNG ĐỢI ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- DỮ LIỆU MỒI ---
async function bootstrapData() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 80); 
        for (let t of usdtPairs) {
            const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=30`);
            const kData = await kRes.json();
            if(!coinData[t.symbol]) coinData[t.symbol] = { symbol: t.symbol, prices: [] };
            coinData[t.symbol].prices = kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }));
        }
    } catch (e) { console.log("LOG: [BOOTSTRAP] Error"); }
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

// --- LOGIC NHẬN BIẾN ĐỘNG & MỞ LỆNH ---
function handlePriceUpdate(s, p, now) {
    if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
    coinData[s].prices.push({ p, t: now });
    if (coinData[s].prices.length > 1000) coinData[s].prices.shift(); 

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
        }
    } else {
        // TRIGGER CHỈ DỰA TRÊN M1 VÀ M5
        const triggerValue = Math.max(Math.abs(c1), Math.abs(c5));
        if (triggerValue >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
            if (!actionQueue.find(q => q.id === s)) {
                actionQueue.push({ id: s, priority: 2, action: () => {
                    const sumDir = c1 + c5; 
                    let type = (tradeMode === 'REVERSE') ? (sumDir >= 0 ? 'SHORT' : 'LONG') : (sumDir >= 0 ? 'LONG' : 'SHORT');
                    if (tradeMode === 'LONG_ONLY') type = 'LONG';
                    if (tradeMode === 'SHORT_ONLY') type = 'SHORT';
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                        maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, 
                        snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0 
                    });
                }});
            }
        }
    }
}

// --- SERVER & GIAO DIỆN ---
if (fs.existsSync(HISTORY_FILE)) { try { JSON.parse(fs.readFileSync(HISTORY_FILE)).forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h)); } catch (e) {} }

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([s,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5))), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
    res.sendStatus(200);
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro v10</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
    body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
    .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
    .neon-glow { text-shadow: 0 0 10px #fcd535; } input, select { background: #0b0e11 !important; border: 1px solid #30363d !important; color: white; }</style></head>
    <body class="pb-10">
    <div class="p-4 sticky top-0 z-50 bg-[#0b0e11] border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-400 font-bold uppercase ml-1">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full outline-none text-sm text-yellow-500"></div>
            <div><label class="text-[10px] text-gray-400 font-bold uppercase ml-1">Margin (Ví dụ: 10% hoặc 5)</label><input id="marginInp" type="text" class="p-2 rounded w-full outline-none text-sm text-yellow-500"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 pt-1">
                <input id="tpInp" type="number" step="0.1" placeholder="TP%" class="p-2 rounded text-sm">
                <input id="slInp" type="number" step="0.1" placeholder="DCA%" class="p-2 rounded text-sm">
                <input id="volInp" type="number" step="0.1" placeholder="Vol%" class="p-2 rounded text-sm">
                <select id="modeInp" class="p-2 rounded text-sm"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold text-xs">KHỞI CHẠY BOT</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold text-xl neon-glow italic">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-right text-[10px] uppercase font-bold text-gray-400">W: <span id="winCount" class="text-green-500">0</span> | L: <span id="loseCount" class="text-red-500">0</span></div>
            <button onclick="stop()" class="text-[#fcd535] border border-[#fcd535] px-2 py-0.5 rounded text-[10px] font-bold">STOP</button>
        </div>
        <div class="flex justify-between items-end">
            <div><div class="text-gray-400 text-[10px] uppercase font-bold">Equity (Vốn + PnL)</div><span id="displayBal" class="text-3xl font-bold text-white tracking-tighter">0.00</span>
                 <div class="text-[11px] text-blue-400 font-bold uppercase mt-1">Khả dụng (Avail): <span id="displayAvail" class="text-white">0.00</span></div>
            </div>
            <div class="text-right"><div class="text-gray-400 text-[10px] uppercase font-bold">PnL Đang chạy</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="bg-card rounded-xl p-3">
            <div class="text-[10px] font-bold text-yellow-500 uppercase mb-2 flex justify-between"><span>⚡ Biến động Live</span><span class="text-gray-500">Top M1/M5</span></div>
            <table class="w-full text-[11px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800"><tr><th>Pair</th><th>Price</th><th>M1</th><th>M5</th><th>M15</th></tr></thead>
                <tbody id="liveBody"></tbody>
            </table>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-xl p-3 shadow-lg">
        <div class="text-[10px] font-bold text-white uppercase mb-2 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
        <table class="w-full text-[10px] text-left"><tbody id="pendingBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-4"><div class="bg-card rounded-xl p-3">
        <div class="text-[10px] font-bold text-gray-500 uppercase mb-2 italic">Lịch sử giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left">
            <thead class="text-gray-500 border-b border-zinc-800"><tr><th>Time</th><th>Pair</th><th>DCA</th><th>Vol(1/5/15)</th><th>PnL Net</th><th>Balance</th></tr></thead>
            <tbody id="historyBody"></tbody>
        </table></div>
    </div></div>

    <script>
    let running = false;
    const config = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(config.running) {
        running = true; document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
        fetch(\`/api/config?tp=\&{config.tp}&sl=\${config.sl}&vol=\${config.vol}&mode=\${config.mode}\`);
    }

    function start() {
        const s = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }
    function fPrice(p) { return parseFloat(p).toFixed(p < 1 ? 5 : 2); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const cfg = JSON.parse(localStorage.getItem('luffy_state'));
            let closedBal = cfg.initialBal, winC = 0, loseC = 0;

            // 1. Render HISTORY & TÍNH TOÁN SỐ DƯ SAU CHỐT
            let histHTML = [...d.history].reverse().map(h => {
                let mBaseH = cfg.marginVal.includes('%') ? (closedBal * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
                let pnl = (mBaseH * (h.dcaCount + 1) * (h.maxLev || 20) * (h.pnlPercent/100)) - (mBaseH * 0.04);
                closedBal += pnl; pnl > 0 ? winC++ : loseC++;
                return \`<tr class="border-b border-zinc-800/30">
                    <td class="py-1 text-gray-500">\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td class="font-bold">\${h.symbol}</td>
                    <td class="text-center">\${h.dcaCount}</td>
                    <td class="text-[8px] text-gray-400">\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</td>
                    <td class="\${pnl>0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td>
                    <td class="text-right text-white">\${closedBal.toFixed(2)}</td>
                </tr>\`;
            }).reverse().join('');

            // 2. TÍNH TOÁN LỆNH ĐANG CHẠY & MARGIN BỊ GIỮ
            let unPnlTotal = 0, lockedMargin = 0;
            let pendingHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBaseP = cfg.marginVal.includes('%') ? (closedBal * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
                let totalM = mBaseP * (h.dcaCount + 1);
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                unPnlTotal += (totalM * roi / 100); lockedMargin += totalM;
                return \`<tr class="border-b border-zinc-800">
                    <td class="py-2"><b>\${h.symbol}</b> <span class="px-1 \${h.type=='LONG'?'bg-green-600':'bg-red-600'} rounded text-[8px]">\${h.type}</span></td>
                    <td class="text-center text-yellow-500">DCA: \${h.dcaCount}</td>
                    <td class="text-[8px] text-gray-400">Vol: \${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</td>
                    <td class="text-right \${roi>=0?'up':'down'} font-bold">\${roi.toFixed(2)}%</td>
                </tr>\`;
            }).join('');

            // 3. HIỂN THỊ SỐ DƯ KHẢ DỤNG
            // Khả dụng = (Đã chốt) - (Margin bị giam) + (PnL âm nếu có)
            let available = closedBal - lockedMargin + (unPnlTotal < 0 ? unPnlTotal : 0);

            document.getElementById('displayBal').innerText = (closedBal + unPnlTotal).toFixed(2);
            document.getElementById('displayAvail').innerText = Math.max(0, available).toFixed(2);
            document.getElementById('unPnl').innerText = unPnlTotal.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
            document.getElementById('winCount').innerText = winC;
            document.getElementById('loseCount').innerText = loseC;
            document.getElementById('historyBody').innerHTML = histHTML;
            document.getElementById('pendingBody').innerHTML = pendingHTML;

            // Render BIẾN ĐỘNG LIVE
            document.getElementById('liveBody').innerHTML = d.live.slice(0, 8).map(i => \`
                <tr class="border-b border-zinc-800/50">
                    <td class="py-1 font-bold text-white">\${i.symbol}</td>
                    <td class="text-yellow-500">\${fPrice(i.currentPrice)}</td>
                    <td class="\${i.c1 >= 0 ? 'up' : 'down'}">\${i.c1}%</td>
                    <td class="\${i.c5 >= 0 ? 'up' : 'down'}">\${i.c5}%</td>
                    <td class="text-gray-500">\${i.c15}%</td>
                </tr>\`).join('');
        } catch(e){}
    }
    if(running) { setInterval(update, 1000); }
    </script></body></html>`);
});

// --- KHỞI CHẠY WS ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => { if(t.s.endsWith('USDT')) handlePriceUpdate(t.s, parseFloat(t.c), now); });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.listen(PORT, '0.0.0.0', async () => { 
    await bootstrapData(); 
    initWS(); 
    console.log(`Luffy Bot Ready: http://localhost:${PORT}/gui`); 
});
