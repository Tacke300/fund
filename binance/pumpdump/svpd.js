const PORT = 9000;
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
function fPrice(p) {
if (!p || p === 0) return "0.0000";
let s = p.toFixed(20);
let match = s.match(/^-?\d+.0*[1-9]/);
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
// --- 3 PHƯƠNG PHÁP DỰ PHÒNG ---
async function bootstrapData() {
console.log("LOG: [PP3] Đang kéo nến lịch sử...");
try {
const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
const tickers = await res.json();
const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 50);
for (let t of usdtPairs) {
const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=20`);
const kData = await kRes.json();
if(!coinData[t.symbol]) coinData[t.symbol] = { symbol: t.symbol, prices: [] };
coinData[t.symbol].prices = kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }));
}
console.log("LOG: [PP3] Hoàn tất.");
} catch (e) { console.log("LOG: [PP3] Lỗi: " + e.message); }
}
function updatePriceLogic(s, p, now) {
if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
coinData[s].prices.push({ p, t: now });
if (coinData[s].prices.length > 1200) coinData[s].prices.shift();
const c1 = calculateChange(coinData[s].prices, 1);  
const c5 = calculateChange(coinData[s].prices, 5);  
const c15 = calculateChange(coinData[s].prices, 15);  
coinData[s].live = { c1, c5, c15, currentPrice: p };  

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
        return;  
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
}

// Sửa PP1: Gọi stream lẻ để update nhảy liên tục 0.2s
async function initWS() {
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    const tickers = await res.json();
    const symbols = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 80).map(t => t.symbol.toLowerCase());
    const streamString = symbols.map(s => `${s}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streamString}`);
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if(msg.data) updatePriceLogic(msg.data.s, parseFloat(msg.data.c), Date.now());
    });
    ws.on('close', () => setTimeout(initWS, 500));
}

async function fallbackAPI() {
try {
const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
const data = await res.json();
const now = Date.now();
data.forEach(t => { if(t.symbol.endsWith('USDT')) updatePriceLogic(t.symbol, parseFloat(t.price), now); });
} catch (e) {}
setTimeout(fallbackAPI, 1000);
}

app.get('/api/config', (req, res) => {
currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
res.sendStatus(200);
});
app.get('/api/data', (req, res) => {
const all = Array.from(historyMap.values());
const topData = Object.entries(coinData).filter(([, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 15);
res.json({
allPrices: Object.fromEntries(Object.entries(coinData).filter(([,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
live: topData,
pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime)
});
});

app.get('/gui', (req, res) => {
res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><style>.up{color:#02c076}.down{color:#f84960}.bg-card{background:#1e2329}</style></head>
<body class="bg-[#0b0e11] text-[#ebebeb]"><div class="p-4 sticky top-0 bg-[#0b0e11] border-b border-zinc-800">
<div id="setup" class="grid grid-cols-2 gap-2 mb-4 bg-card p-3 rounded">
<input id="balanceInp" type="number" value="1000" class="p-2 bg-zinc-900 rounded">
<input id="marginInp" type="text" value="10%" class="p-2 bg-zinc-900 rounded">
<button onclick="start()" class="col-span-2 bg-yellow-500 text-black font-bold p-2 rounded">START 0.2s SPEED</button></div>
<div class="flex justify-between"><div><div class="text-xs text-gray-400">Equity</div><span id="displayBal" class="text-3xl font-bold">0.00</span></div>
<div class="text-right"><div class="text-xs text-gray-400">PnL</div><div id="unPnl" class="text-xl font-bold">0.00</div></div></div></div>
<div class="p-4"><div class="bg-card p-4 rounded mb-4"><table class="w-full text-[11px] text-left"><thead><tr class="text-gray-500"><th>Coin</th><th>Price</th><th>1M%</th><th>5M%</th><th>15M%</th></tr></thead><tbody id="marketBody"></tbody></table></div>
<div class="bg-card p-4 rounded"><table class="w-full text-[11px] text-left"><thead><tr class="text-gray-500"><th>Pair</th><th>Entry/Live</th><th>ROI%</th></tr></thead><tbody id="pendingBody"></tbody></table></div></div>
<script>
let running=false, initialBal=1000;
function start(){ running=true; document.getElementById('setup').classList.add('hidden'); }
async function update(){
    if(!running) return;
    try {
        const res = await fetch('/api/data'); const d = await res.json();
        document.getElementById('marketBody').innerHTML = d.live.map(m => \`<tr class="border-b border-zinc-800"><td class="py-2 font-bold">\${m.symbol}</td><td class="text-yellow-500">\${m.currentPrice.toFixed(4)}</td><td class="\${m.c1>=0?'up':'down'} font-bold">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'} font-bold">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'} font-bold">\${m.c15}%</td></tr>\`).join('');
        let unPnl = 0;
        document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
            unPnl += (initialBal * 0.1) * roi / 100;
            return \`<tr class="border-b border-zinc-800"><td class="py-2 font-bold">\${h.symbol}</td><td>\${h.avgPrice.toFixed(4)} / \${lp.toFixed(4)}</td><td class="\${roi>=0?'up':'down'} font-bold">\${roi.toFixed(2)}%</td></tr>\`;
        }).join('');
        document.getElementById('displayBal').innerText = (initialBal + unPnl).toFixed(2);
        document.getElementById('unPnl').innerText = unPnl.toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
    } catch(e){}
}
setInterval(update, 200); // FIX: ÉP NHẢY 0.2S TẠI ĐÂY
</script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => {
console.log(`🚀 LUFFY ENGINE READY: http://localhost:${PORT}/gui`);
await bootstrapData();
initWS();
fallbackAPI();
});
