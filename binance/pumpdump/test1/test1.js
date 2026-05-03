const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

// Cấu hình mặc định
let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW', maxDcaCount = 5;

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

async function bootstrapData() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 100); 
        for (let t of usdtPairs) {
            const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=30`);
            const kData = await kRes.json();
            if(!coinData[t.symbol]) coinData[t.symbol] = { symbol: t.symbol, prices: [] };
            coinData[t.symbol].prices = kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }));
        }
    } catch (e) { console.log("LOG: [BOOTSTRAP] Lỗi: " + e.message); }
}

async function fallbackAPI() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const data = await res.json();
        const now = Date.now();
        data.forEach(t => { 
            if(t.symbol.endsWith('USDT')) handlePriceUpdate(t.symbol, parseFloat(t.price), now);
        });
    } catch (e) {}
    setTimeout(fallbackAPI, 3000);
}

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

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function handlePriceUpdate(s, p, now) {
    if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
    coinData[s].prices.push({ p, t: now });
    if (coinData[s].prices.length > 1000) coinData[s].prices.shift(); 

    const c1 = calculateChange(coinData[s].prices, 1), 
          c5 = calculateChange(coinData[s].prices, 5), 
          c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };
    
    const pendingTrades = Array.from(historyMap.values()).filter(h => h.symbol === s && h.status === 'PENDING');
    
    pendingTrades.forEach(pending => {
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
        
        if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) { 
            pending.maxNegativeRoi = currentRoi;
            pending.maxNegativeTime = now;
        }

        const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
        const lose = pending.isHedge ? (pending.type === 'LONG' ? diffAvg <= -pending.slTarget : diffAvg >= pending.slTarget) : false;
        const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);

        if (win || lose || isTimeout) {
            pending.status = win ? 'WIN' : (lose ? 'LOSE' : 'TIMEOUT'); 
            pending.finalPrice = p; pending.endTime = now;
            pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
            lastTradeClosed[s] = now; 
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
            return;
        }

        // Logic DCA và Hedge
        if (!pending.isHedge && pending.dcaCount < maxDcaCount) {
            const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
            const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
            const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
            
            if (triggerDCA && !actionQueue.find(q => q.id === `${s}_dca`)) {
                actionQueue.push({ id: `${s}_dca`, priority: 1, action: () => {
                    pending.dcaCount++;
                    const newAvg = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1);
                    if(!pending.dcaHistory) pending.dcaHistory = [];
                    pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                    pending.avgPrice = newAvg;

                    // Nếu đây là lần DCA cuối cùng, mở lệnh Hedge ngược chiều x50 Margin
                    if (pending.dcaCount === maxDcaCount) {
                        const hedgeType = pending.type === 'LONG' ? 'SHORT' : 'LONG';
                        const hedgeId = `${s}_HEDGE_${now}`;
                        historyMap.set(hedgeId, {
                            symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: hedgeType, status: 'PENDING',
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: 10, slTarget: 10, // TP SL 10% cho lệnh Hedge
                            isHedge: true, hedgeMultiplier: 50,
                            snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0
                        });
                    }
                }});
            }
        }
    });

    // Mở vị thế mới
    if (pendingTrades.filter(t => !t.isHedge).length === 0 && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
        if (!actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 2, action: () => {
                const sumVol = c1 + c5 + c15;
                let type = (tradeMode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                if (tradeMode === 'LONG_ONLY') type = 'LONG';
                if (tradeMode === 'SHORT_ONLY') type = 'SHORT';
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, 
                    snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, maxNegativeTime: null, dcaCount: 0, dcaHistory: [{ t: now, p: p, avg: p }] 
                });
            }});
        }
    }
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => { if(t.s.endsWith('USDT')) handlePriceUpdate(t.s, parseFloat(t.c), now); });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); 
    tradeMode = req.query.mode || 'FOLLOW'; maxDcaCount = parseInt(req.query.maxDca) || 5;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([s,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
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
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-5 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="p-1 rounded w-full outline-none text-xs"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="p-1 rounded w-full outline-none text-xs"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Max DCA</label><input id="maxDcaInp" type="number" class="p-1 rounded w-full outline-none text-xs" value="5"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol</label><input id="volInp" type="number" step="0.1" class="p-1 rounded w-full outline-none text-xs"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Chế độ</label>
                    <select id="modeInp" class="p-1 rounded w-full outline-none text-[10px]">
                        <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option>
                    </select>
                </div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold text-xs mt-1">START BOT</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-[#fcd535] font-black text-xs border border-[#fcd535] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP</div>
        </div>

        <div class="flex justify-between items-end mb-2">
            <div>
                <div class="text-gray-custom text-[10px] uppercase font-bold">Equity</div>
                <span id="displayBal" class="text-3xl font-bold text-white tracking-tighter">0.00</span>
            </div>
            <div class="text-right"><div class="text-gray-custom text-[10px] uppercase font-bold">PnL Live</div><div id="unPnl" class="text-lg font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-2">
        <div class="bg-card rounded p-3 border border-zinc-800">
            <div class="text-[10px] font-bold text-yellow-500 mb-2 uppercase italic">⚡ Market Movement</div>
            <table class="w-full text-[10px] text-left">
                <thead class="text-gray-custom border-b border-zinc-800"><tr><th>Pair</th><th>Price</th><th>M1</th><th>M5</th><th>M15</th></tr></thead>
                <tbody id="liveBody"></tbody>
            </table>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded p-3">
        <div class="text-[10px] font-bold text-white mb-2 uppercase">Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left">
            <thead class="text-gray-custom border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Lev</th><th>Entry/Live</th><th class="text-right">PnL</th></tr></thead>
            <tbody id="pendingBody"></tbody>
        </table></div>
    </div></div>

    <div class="px-4 mt-4"><div class="bg-card rounded p-3">
        <div class="text-[10px] font-bold text-gray-custom mb-2 uppercase">Nhật ký</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left">
            <thead class="text-gray-custom border-b border-zinc-800"><tr><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Out</th><th class="text-right">Balance</th></tr></thead>
            <tbody id="historyBody"></tbody>
        </table></div>
    </div></div>

    <script>
    let running = false;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.initialBal) {
        document.getElementById('balanceInp').value = saved.initialBal;
        document.getElementById('marginInp').value = saved.marginVal;
        document.getElementById('tpInp').value = saved.tp;
        document.getElementById('slInp').value = saved.sl;
        document.getElementById('maxDcaInp').value = saved.maxDca || 5;
        document.getElementById('volInp').value = saved.vol;
        document.getElementById('modeInp').value = saved.mode;
        if(saved.running) {
            running = true;
            document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
            fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=\${saved.vol}&mode=\${saved.mode}&maxDca=\${saved.maxDca}\`);
        }
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value, maxDca: document.getElementById('maxDcaInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(state)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const state = JSON.parse(localStorage.getItem('luffy_state') || '{}');
            let mVal = state.marginVal || "10%", mNum = parseFloat(mVal);
            let runningBal = state.initialBal || 0, unPnlTotal = 0;

            document.getElementById('liveBody').innerHTML = d.live.slice(0, 8).map(i => \`
                <tr class="border-b border-zinc-800/30"><td class="py-1 text-white font-bold">\${i.symbol}</td><td>\${i.currentPrice}</td><td class="\${i.c1>=0?'up':'down'}">\${i.c1}%</td><td class="\${i.c5>=0?'up':'down'}">\${i.c5}%</td><td class="text-gray-600">\${i.c15}%</td></tr>\`).join('');

            let histHTML = [...d.history].reverse().map(h => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let actualMargin = h.isHedge ? (mBase * h.hedgeMultiplier) : (mBase * (h.dcaCount + 1));
                let pnl = (actualMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (actualMargin * (h.maxLev || 20) * 0.001);
                runningBal += pnl;
                return \`<tr><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b class="\${h.isHedge?'text-purple-400':'text-white'}">\${h.symbol}</b></td><td>\${h.dcaCount}</td><td>\${actualMargin.toFixed(1)}</td><td>\${h.snapPrice.toFixed(4)}/\${h.finalPrice.toFixed(4)}</td><td class="text-right text-white">\${runningBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');

            let pendingHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let totalM = h.isHedge ? (mBase * h.hedgeMultiplier) : (mBase * (h.dcaCount + 1));
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = totalM * roi / 100; unPnlTotal += pnl;
                return \`<tr class="\${h.isHedge?'bg-purple-900/20':''}"><td><b class="text-white">\${h.symbol}</b> <span class="text-[8px] \${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td>\${h.maxLev}x</td><td>\${h.avgPrice.toFixed(4)}/\${lp.toFixed(4)}</td><td class="text-right font-bold \${roi>=0?'up':'down'}">\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            document.getElementById('displayBal').innerText = (runningBal + unPnlTotal).toFixed(2);
            document.getElementById('unPnl').innerText = unPnlTotal.toFixed(2);
            document.getElementById('unPnl').className = 'text-lg font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
            document.getElementById('historyBody').innerHTML = histHTML;
            document.getElementById('pendingBody').innerHTML = pendingHTML;
        } catch(e) {}
    }
    if(running) setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    await bootstrapData(); initWS(); fallbackAPI();
    console.log(`Bot running: http://localhost:${PORT}/gui`); 
});
