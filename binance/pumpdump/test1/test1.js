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

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW', currentMaxDCA = 5;

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
    } catch (e) {}
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

    const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };
    
    const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
    if (pending) {
        const diffFromSnap = ((p - pending.snapPrice) / pending.snapPrice) * 100;
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const originalType = pending.isRecovery ? (pending.type === 'LONG' ? 'SHORT' : 'LONG') : pending.type;

        // 1. LOGIC RECOVERY (TP/SL 10% GIÁ)
        if (pending.isRecovery) {
            const recoDiff = ((p - pending.recoPrice) / pending.recoPrice) * 100;
            const recoRoi = (pending.type === 'LONG' ? recoDiff : -recoDiff);
            if (recoRoi >= 10.0 || recoRoi <= -10.0) {
                pending.status = recoRoi >= 10.0 ? 'WIN_RECO' : 'SL_RECO';
                pending.finalPrice = p; pending.endTime = now;
                pending.pnlPercent = recoRoi;
                lastTradeClosed[s] = now;
                fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                return;
            }
        }

        // 2. LOGIC LỆNH CŨ (TP THEO SETUP / SL TUYỆT ĐỐI 55%)
        const originalRoi = (originalType === 'LONG' ? diffAvg : -diffAvg);
        const slThreshold = (currentMaxDCA * pending.slTarget) + 5;
        const isSlOriginal = (originalType === 'LONG' ? diffFromSnap <= -slThreshold : diffFromSnap >= slThreshold);

        if (originalRoi >= pending.tpTarget || isSlOriginal || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
            pending.status = isSlOriginal ? 'SL_MAX' : (originalRoi >= pending.tpTarget ? 'WIN' : 'TIMEOUT');
            pending.finalPrice = p; pending.endTime = now;
            pending.pnlPercent = originalRoi;
            lastTradeClosed[s] = now;
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
            return;
        }

        // 3. KÍCH HOẠT DCA HOẶC RECOVERY
        const nextDcaStep = pending.dcaCount + 1;
        const nextDcaPricePercent = nextDcaStep * pending.slTarget;
        const triggerAction = (originalType === 'LONG' ? diffFromSnap <= -nextDcaPricePercent : diffFromSnap >= nextDcaPricePercent);

        if (triggerAction && !actionQueue.find(q => q.id === s) && pending.dcaCount < currentMaxDCA) {
            actionQueue.push({ id: s, priority: 1, action: () => {
                if (pending.dcaCount === currentMaxDCA - 1) {
                    pending.isRecovery = true;
                    pending.recoPrice = p; 
                    pending.type = (originalType === 'LONG' ? 'SHORT' : 'LONG'); 
                    pending.dcaCount = currentMaxDCA;
                } else {
                    pending.avgPrice = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1);
                    pending.dcaCount++;
                }
            }});
        }
    } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
        if (!actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 2, action: () => {
                const sumVol = c1 + c5 + c15;
                let type = (tradeMode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, 
                    snapVol: { c1, c5, c15 }, dcaCount: 0, isRecovery: false
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
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); 
    currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
    currentMaxDCA = parseInt(req.query.maxdca) || 5;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([s,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Recovery Final</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=IBM+Plex+Sans:wght@400;600&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .font-orbitron { font-family: 'Orbitron', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .recovery-row { background-color: rgba(147, 51, 234, 0.25) !important; color: #d8b4fe !important; border-left: 4px solid #a855f7; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; outline: none; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-400 uppercase font-bold">Vốn</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold text-sm"></div>
            <div><label class="text-[10px] text-gray-400 uppercase font-bold">Margin</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold text-sm"></div>
            <div class="col-span-2 grid grid-cols-5 gap-1 pt-2 text-[10px]">
                <input id="tpInp" type="number" step="0.1" placeholder="TP%">
                <input id="slInp" type="number" step="0.1" placeholder="DCA%">
                <input id="volInp" type="number" step="0.1" placeholder="Vol%">
                <input id="maxdcaInp" type="number" placeholder="MaxDCA">
                <select id="modeInp"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold uppercase text-xs">RUN LUFFY</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-orbitron font-bold text-white tracking-widest text-lg">LUFFY <span class="text-[#fcd535]">READY</span></div>
            <button onclick="stop()" class="text-[#f6465d] text-[10px] border border-[#f6465d] px-2 py-1 rounded font-bold">STOP</button>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-gray-400 text-[10px] uppercase font-bold">Available Balance</div>
                <span id="displayAvail" class="text-4xl font-bold text-white tracking-tighter">0.00</span>
                <div class="text-[10px] text-gray-500 font-bold mt-1">Equity: <span id="displayBal">0.00</span></div>
            </div>
            <div class="text-right"><div class="text-gray-400 text-[10px] uppercase font-bold">Unrealized PnL</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-3">
        <div class="text-[10px] font-bold text-white mb-2 uppercase flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2"></span> Positions</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-500 border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">ROI%</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 mb-10"><div class="bg-card rounded-xl p-3">
        <div class="text-[10px] font-bold text-gray-400 mb-2 uppercase">Trade History</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-500 border-b border-zinc-800"><tr><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th>PnL Net</th><th class="text-right">Available</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.initialBal) {
        ['balanceInp','marginInp','tpInp','slInp','volInp','maxdcaInp','modeInp'].forEach(id => {
            let key = id.replace('Inp',''); if(saved[key]) document.getElementById(id).value = saved[key];
        });
        if(saved.running) {
            running = true; document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
            fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=\${saved.vol}&mode=\${saved.mode}&maxdca=\${saved.maxdca}\`);
        }
    }
    function start() {
        const s = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value, maxdca: document.getElementById('maxdcaInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }
    
    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const state = JSON.parse(localStorage.getItem('luffy_state') || '{}');
            let mVal = state.marginVal || "10%", mNum = parseFloat(mVal);
            let runningBal = state.initialBal || 0, unPnlTotal = 0, usedMarginTotal = 0;

            let historyTemp = [...d.history].reverse().map((h) => {
                let mBase = mVal.includes('%') ? ((runningBal - usedMarginTotal) * mNum / 100) : mNum;
                let totalM = h.isRecovery ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                let pnl = (totalM * (h.maxLev || 20) * (h.pnlPercent/100)) - (totalM * (h.maxLev || 20) * 0.001);
                runningBal += pnl;
                // Chụp số dư khả dụng: Tại thời điểm này là runningBal trừ đi ký quỹ (tạm tính usedMargin=0 khi ko có lệnh)
                return { ...h, totalM, pnlNet: pnl, availSnap: runningBal };
            });

            let pendingHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBase = mVal.includes('%') ? ((runningBal - usedMarginTotal) * mNum / 100) : mNum;
                let totalM = h.isRecovery ? (mBase * 50) : (mBase * (h.dcaCount + 1));
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = totalM * roi / 100; unPnlTotal += pnl; usedMarginTotal += totalM;
                return \`<tr class="border-b border-zinc-800 \${h.isRecovery?'recovery-row':''}"><td>\${h.symbol} <span class="px-1 \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded text-[8px]">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td>\${lp.toFixed(4)}</td><td class="text-right font-bold \${pnl>=0?'up':'down'}">\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            document.getElementById('historyBody').innerHTML = historyTemp.reverse().map(h => \`
                <tr class="border-b border-zinc-800/30 \${h.isRecovery ? 'recovery-row' : ''}">
                    <td>\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td><b>\${h.symbol}</b></td><td>\${h.dcaCount}</td><td>\${h.totalM.toFixed(1)}</td>
                    <td class="font-bold \${h.pnlNet>=0?'up':'down'}">\${h.pnlNet.toFixed(2)}</td>
                    <td class="text-right text-blue-400 font-bold">\${h.availSnap.toFixed(2)}</td>
                </tr>\`).join('');

            document.getElementById('displayBal').innerText = (runningBal + unPnlTotal).toFixed(2);
            document.getElementById('displayAvail').innerText = Math.max(0, (runningBal - usedMarginTotal + (unPnlTotal < 0 ? unPnlTotal : 0))).toFixed(2);
            document.getElementById('unPnl').innerText = unPnlTotal.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
            document.getElementById('pendingBody').innerHTML = pendingHTML;
        } catch(e) {}
    }
    if(running) setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    await bootstrapData(); initWS();
    console.log(`Luffy Engine Ready: http://localhost:${PORT}/gui`); 
});
