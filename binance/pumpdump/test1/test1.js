const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
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

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

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

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);

                if (pending.recoveryOrder) {
                    const r = pending.recoveryOrder;
                    const rDiff = ((p - r.entry) / r.entry) * 100;
                    const rRoi = (r.type === 'LONG' ? rDiff : -rDiff) * r.lev;
                    if (rRoi >= 10 || rRoi <= -10) { 
                        pending.status = rRoi >= 10 ? 'WIN_RECOVERY' : 'FAILED_RECOVERY';
                        pending.finalPrice = p; pending.endTime = now;
                        pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                        lastTradeClosed[s] = now;
                        fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                        return;
                    }
                }

                if (win || isTimeout) {
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
                    if (pending.dcaCount === 5) {
                        actionQueue.push({ id: s, priority: 1, action: () => {
                            let baseM = pending.initialMargin || 1; 
                            let revMargin = 0, lev = pending.maxLev || 20;
                            if (lev < 50) revMargin = baseM * 50;
                            else if (lev === 50) revMargin = baseM * 100;
                            else revMargin = baseM * 150;
                            pending.recoveryOrder = { type: pending.type === 'LONG' ? 'SHORT' : 'LONG', entry: p, margin: revMargin, lev: lev };
                            pending.dcaCount = 6; 
                        }});
                    } else if (pending.dcaCount < 5) {
                        actionQueue.push({ id: s, priority: 1, action: () => {
                            const newCount = pending.dcaCount + 1;
                            const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                            pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg, vol: {c1, c5, c15} });
                            pending.avgPrice = newAvg; pending.dcaCount = newCount;
                        }});
                    }
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = (tradeMode === 'REVERSE') ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                        if (tradeMode === 'LONG_ONLY') type = 'LONG';
                        if (tradeMode === 'SHORT_ONLY') type = 'SHORT';
                        historyMap.set(`${s}_${now}`, { symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 }, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p, vol: {c1, c5, c15} }] });
                    }});
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })), 
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING')
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .recovery-row { background-color: #4b0082 !important; color: #e0b0ff !important; font-weight: bold; }
        .bg-card { background: #1e2329; }
    </style></head><body>
    <div class="p-4">
        <div id="setup" class="grid grid-cols-4 gap-2 mb-4 bg-card p-4 rounded">
            <input id="balanceInp" type="number" placeholder="Vốn đầu" class="p-2 rounded bg-gray-800 text-white">
            <input id="marginInp" type="text" placeholder="Margin (10% / 10)" class="p-2 rounded bg-gray-800 text-white">
            <input id="tpInp" type="number" step="0.1" placeholder="TP %" class="p-2 rounded bg-gray-800 text-white">
            <input id="slInp" type="number" step="0.1" placeholder="DCA %" class="p-2 rounded bg-gray-800 text-white">
            <input id="volInp" type="number" step="0.1" placeholder="Min Vol" class="p-2 rounded bg-gray-800 text-white">
            <select id="modeInp" class="p-2 rounded bg-gray-800 text-white">
                <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option><option value="LONG_ONLY">LONG ONLY</option><option value="SHORT_ONLY">SHORT ONLY</option>
            </select>
            <button onclick="start()" class="col-span-2 bg-yellow-500 text-black font-bold p-2 rounded">START ENGINE</button>
        </div>
        <div class="grid grid-cols-4 gap-3 mb-4">
            <div class="bg-card p-4 rounded border-l-4 border-yellow-500">
                <div class="text-xs text-gray-400 uppercase">Số dư ví (Wallet)</div>
                <div id="displayWallet" class="text-xl font-bold text-white">0.00</div>
            </div>
            <div class="bg-card p-4 rounded border-l-4 border-blue-500">
                <div class="text-xs text-gray-400 uppercase">Khả dụng (Available)</div>
                <div id="displayAvail" class="text-xl font-bold text-blue-400">0.00</div>
            </div>
            <div class="bg-card p-4 rounded border-l-4 border-green-500">
                <div class="text-xs text-gray-400 uppercase">Tổng Win / PnL Win</div>
                <div class="text-xl font-bold text-green-400"><span id="winCount">0</span> / <span id="winPnl">0.00</span></div>
            </div>
            <div class="bg-card p-4 rounded border-l-4 border-red-500">
                <div class="text-xs text-gray-400 uppercase">UnPnL (Tạm tính)</div>
                <div id="unPnl" class="text-xl font-bold">0.00</div>
            </div>
        </div>
        <div class="grid grid-cols-1 gap-4">
            <div class="bg-card p-4 rounded">
                <h3 class="font-bold mb-2 uppercase text-purple-400">Vị thế đang mở</h3>
                <table class="w-full text-left text-sm">
                    <thead><tr class="border-b border-gray-700"><th>Pair</th><th>Type</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th>PnL Net</th></tr></thead>
                    <tbody id="pendingBody"></tbody>
                </table>
            </div>
            <div class="bg-card p-4 rounded">
                <h3 class="font-bold mb-2 uppercase text-gray-400">Nhật ký (History)</h3>
                <table class="w-full text-left text-xs">
                    <thead><tr class="border-b border-gray-700"><th>Pair</th><th>DCA</th><th>Margin</th><th>PnL</th><th>Balance</th></tr></thead>
                    <tbody id="historyBody"></tbody>
                </table>
            </div>
        </div>
    </div>
    <script>
    let running = false;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(saved.running) { 
        running = true;
        document.getElementById('balanceInp').value = saved.initialBal;
        document.getElementById('marginInp').value = saved.marginVal;
        document.getElementById('tpInp').value = saved.tp;
        document.getElementById('slInp').value = saved.sl;
        document.getElementById('volInp').value = saved.vol;
        document.getElementById('modeInp').value = saved.mode;
        fetch(\`/api/config?tp=\${saved.tp}&sl=\${saved.sl}&vol=\${saved.vol}&mode=\${saved.mode}\`); 
    }

    function start() {
        const state = { running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value };
        localStorage.setItem('luffy_state', JSON.stringify(state)); location.reload();
    }

    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        const state = JSON.parse(localStorage.getItem('luffy_state') || '{}');
        let walletBal = state.initialBal || 0, unPnlTotal = 0, usedMarginTotal = 0, countWin = 0, sumWinPnl = 0;

        let histHTML = [...d.history].reverse().map(h => {
            let mBase = state.marginVal.includes('%') ? (walletBal * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
            let totalM = mBase * (h.dcaCount >= 6 ? 6 : h.dcaCount + 1);
            let pnl = (totalM * (h.maxLev || 20) * (h.pnlPercent/100));
            walletBal += pnl;
            if (pnl > 0) { countWin++; sumWinPnl += pnl; }
            const isRec = h.dcaCount >= 6;
            return \`<tr class="\${isRec ? 'recovery-row' : ''}"><td>\${h.symbol}</td><td>\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td><td>\${walletBal.toFixed(1)}</td></tr>\`;
        }).reverse().join('');

        let pendingHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let mBase = state.marginVal.includes('%') ? (walletBal * parseFloat(state.marginVal)/100) : parseFloat(state.marginVal);
            let totalM = mBase * (h.dcaCount >= 6 ? 6 : h.dcaCount + 1);
            let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
            let pnl = totalM * roi / 100;
            if(h.recoveryOrder) {
                totalM += h.recoveryOrder.margin;
                let rDiff = ((lp - h.recoveryOrder.entry) / h.recoveryOrder.entry) * 100;
                pnl += (h.recoveryOrder.margin * (h.recoveryOrder.type === 'LONG' ? rDiff : -rDiff) / 100 * h.recoveryOrder.lev);
            }
            unPnlTotal += pnl; usedMarginTotal += totalM;
            const isRec = h.dcaCount >= 6;
            return \`<tr class="\${isRec ? 'recovery-row' : ''}"><td>\${h.symbol}</td><td>\${h.type}</td><td>\${h.dcaCount}</td><td>\${totalM.toFixed(1)}</td><td>\${h.avgPrice.toFixed(4)}/\${lp.toFixed(4)}</td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td></tr>\`;
        }).join('');

        document.getElementById('displayWallet').innerText = walletBal.toFixed(2);
        document.getElementById('displayAvail').innerText = (walletBal - usedMarginTotal + (unPnlTotal < 0 ? unPnlTotal : 0)).toFixed(2);
        document.getElementById('winCount').innerText = countWin;
        document.getElementById('winPnl').innerText = sumWinPnl.toFixed(2);
        document.getElementById('unPnl').innerText = (unPnlTotal >= 0 ? '+' : '') + unPnlTotal.toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnlTotal >= 0 ? 'up' : 'down');
        document.getElementById('historyBody').innerHTML = histHTML;
        document.getElementById('pendingBody').innerHTML = pendingHTML;
    }
    setInterval(update, 1000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Running on http://localhost:${PORT}/gui`); });
