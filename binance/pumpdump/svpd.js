const PORT = 9000;
const PORT_UI = 1997; // Cổng riêng để đẩy dữ liệu lên HTML
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15;
const MAX_HOLD_MINUTES = 555555;
import WebSocket, { WebSocketServer } from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
const app = express();

// Khởi tạo WebSocket Server cho Giao diện
const wssUI = new WebSocketServer({ port: PORT_UI });
let uiClient = null;
wssUI.on('connection', (ws) => { uiClient = ws; });

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

async function bootstrapData() {
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

// ĐẨY DỮ LIỆU THẲNG LÊN UI QUA WEBSOCKET (REAL-TIME 0.1s - 0.2s)
if (uiClient && uiClient.readyState === WebSocket.OPEN) {
    const all = Array.from(historyMap.values());
    const topData = Object.entries(coinData).filter(([, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 15);
    uiClient.send(JSON.stringify({
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        live: topData,
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime)
    }));
}

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

async function initWS() {
const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
const tickers = await res.json();
const symbols = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 50).map(t => t.symbol.toLowerCase());
const streamString = symbols.map(s => `${s}@ticker`).join('/');
const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streamString}`);
ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if(msg.data) updatePriceLogic(msg.data.s, parseFloat(msg.data.c), Date.now());
});
ws.on('close', () => setTimeout(initWS, 500));
}

app.get('/api/config', (req, res) => {
currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
res.sendStatus(200);
});

app.get('/gui', (req, res) => {
res.send(`
<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><style>.up{color:#02c076}.down{color:#f84960}.bg-card{background:#1e2329}</style></head>
<body class="bg-[#0b0e11] text-[#ebebeb] p-4">
    <div id="setup" class="bg-card p-4 rounded mb-4">
        <button onclick="start()" class="w-full bg-yellow-500 text-black font-bold p-2 rounded">BẬT WEBSOCKET UI (0.2s)</button>
    </div>
    <div class="flex justify-between items-end mb-4">
        <div><div class="text-xs uppercase text-gray-400">Equity</div><span id="displayBal" class="text-3xl font-bold">0.00</span></div>
        <div class="text-right"><div class="text-xs uppercase text-gray-400">Unrealized PnL</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
    </div>
    <div class="bg-card p-4 rounded mb-4">
        <table class="w-full text-[10px] text-left">
            <thead><tr class="text-gray-500"><th>Coin</th><th>Price</th><th>1M%</th><th>5M%</th><th>15M%</th></tr></thead>
            <tbody id="marketBody"></tbody>
        </table>
    </div>
    <div class="bg-card p-4 rounded">
        <table class="w-full text-[10px] text-left">
            <thead><tr class="text-gray-500"><th>Pair</th><th>DCA</th><th>Entry/Live</th><th>ROI%</th></tr></thead>
            <tbody id="pendingBody"></tbody>
        </table>
    </div>

<script>
let socket;
let initialBal = 1000;
let marginVal = "10%";

function start() {
    // KẾT NỐI WEBSOCKET UI ĐỂ NHẬN DỮ LIỆU PUSH TỪ SERVER
    socket = new WebSocket('ws://' + window.location.hostname + ':9001');
    socket.onmessage = (event) => {
        const d = JSON.parse(event.data);
        renderData(d);
    };
    document.getElementById('setup').style.display = 'none';
}

function renderData(d) {
    document.getElementById('marketBody').innerHTML = d.live.map(m => \`
        <tr class="border-b border-zinc-800"><td class="py-1 font-bold">\${m.symbol}</td><td class="text-yellow-500">\${m.currentPrice.toFixed(4)}</td><td class="\${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>
    \`).join('');

    let unPnl = 0;
    document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
        let lp = d.allPrices[h.symbol] || h.avgPrice;
        let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
        unPnl += (initialBal * 0.1) * roi / 100;
        return \`<tr class="border-b border-zinc-800"><td>\${h.symbol}</td><td>\${h.dcaCount}</td><td>\${h.avgPrice.toFixed(4)} / \${lp.toFixed(4)}</td><td class="\${roi>=0?'up':'down'} font-bold">\${roi.toFixed(2)}%</td></tr>\`;
    }).join('');

    document.getElementById('displayBal').innerText = (initialBal + unPnl).toFixed(2);
    document.getElementById('unPnl').innerText = unPnl.toFixed(2);
    document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
}
</script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => {
    await bootstrapData();
    initWS();
});
