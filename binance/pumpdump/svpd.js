const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 
let clients = []; // Luồng SSE cho Real-time

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

// --- LOGIC HÀNG ĐỢI GỐC ---
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

// Load Cache
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

// --- WEBSOCKET REAL-TIME ENGINE ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 500) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            // Logic Xử lý lệnh (PENDING & DCA)
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;

                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }

                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
                
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        pending.avgPrice = newAvg; pending.dcaCount = newCount;
                    }});
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = sumVol >= 0 ? 'LONG' : 'SHORT';
                        if (tradeMode === 'REVERSE') type = (type === 'LONG' ? 'SHORT' : 'LONG');
                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                            maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                        });
                    }});
                }
            }
        });

        // Bắn dữ liệu realtime xuống Client (SSE)
        if (clients.length > 0) {
            const all = Array.from(historyMap.values());
            const liveData = {
                allPrices: Object.fromEntries(Object.entries(coinData).filter(([_,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
                live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 12),
                pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
                history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0, 50)
            };
            clients.forEach(c => c.write(`data: ${JSON.stringify(liveData)}\n\n`));
        }
    });
    ws.on('close', () => setTimeout(initWS, 2000));
}

// Routes
app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
    res.sendStatus(200);
});

app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    clients.push(res);
    req.on('close', () => clients = clients.filter(c => c !== res));
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>body { background: #0b0e11; color: #eaecef; font-family: monospace; } .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }</style></head>
    <body class="p-4">
        <div id="setup" class="bg-card p-4 rounded mb-4">
            <div class="grid grid-cols-4 gap-2">
                <input id="tpInp" step="0.1" type="number" placeholder="TP%" class="bg-black p-2">
                <input id="slInp" step="0.1" type="number" placeholder="DCA%" class="bg-black p-2">
                <input id="volInp" step="0.1" type="number" placeholder="Vol%" class="bg-black p-2">
                <button onclick="save()" class="bg-yellow-500 text-black font-bold">START ENGINE</button>
            </div>
        </div>
        <div class="flex justify-between items-center mb-4"><h1 class="text-2xl font-black text-yellow-500 italic">LUFFY PRO REALTIME</h1><div id="pnl" class="text-2xl font-bold">0.00</div></div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="bg-card p-4 rounded">
                <h2 class="text-xs font-bold text-gray-500 mb-2 uppercase">Market Live</h2>
                <table class="w-full text-[10px]"><thead><tr class="text-left text-gray-600"><th>Pair</th><th>Price</th><th>1M</th><th>5M</th><th>15M</th></tr></thead><tbody id="marketBody"></tbody></table>
            </div>
            <div class="bg-card p-4 rounded">
                <h2 class="text-xs font-bold text-green-500 mb-2 uppercase">Positions Open</h2>
                <table class="w-full text-[10px]"><thead><tr class="text-left"><th>Pair</th><th>DCA</th><th>Entry</th><th>Avg</th><th>PnL</th></tr></thead><tbody id="pendingBody"></tbody></table>
            </div>
        </div>
        <script>
            let es = new EventSource('/stream');
            let lastP = {};
            function save() { fetch('/api/config?tp='+document.getElementById('tpInp').value+'&sl='+document.getElementById('slInp').value+'&vol='+document.getElementById('volInp').value); }
            es.onmessage = (e) => {
                const d = JSON.parse(e.data);
                document.getElementById('marketBody').innerHTML = d.live.map(m => {
                    const c = m.currentPrice > (lastP[m.symbol] || 0) ? 'text-green-400' : 'text-red-400';
                    lastP[m.symbol] = m.currentPrice;
                    return \`<tr><td>\${m.symbol}</td><td class="\${c}">\${m.currentPrice.toFixed(4)}</td><td class="\${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`;
                }).join('');
                let totalUnPnl = 0;
                document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                    let lp = d.allPrices[h.symbol] || h.avgPrice;
                    let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * h.maxLev;
                    totalUnPnl += roi;
                    return \`<tr><td class="font-bold \${h.type==='LONG'?'up':'down'}">\${h.symbol}</td><td>\${h.dcaCount}</td><td>\${h.snapPrice.toFixed(4)}</td><td>\${h.avgPrice.toFixed(4)}</td><td class="font-bold \${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</td></tr>\`;
                }).join('');
                document.getElementById('pnl').innerText = totalUnPnl.toFixed(2) + '%';
                document.getElementById('pnl').className = 'text-2xl font-bold ' + (totalUnPnl>=0?'up':'down');
            };
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`🚀 http://localhost:${PORT}/gui`); });
