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

// Tối ưu Queue: Xử lý nhanh hơn (50ms thay vì 350ms)
async function processQueue() {
    if (actionQueue.length === 0) return;
    const task = actionQueue.shift();
    task.action();
}
setInterval(processQueue, 50);

function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    return parseFloat(p).toFixed(4);
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
    const cutoff = now - min * 60000;
    // Tìm điểm giá cũ nhất trong khoảng thời gian
    let startIdx = 0;
    for (let i = pArr.length - 1; i >= 0; i--) {
        if (pArr[i].t <= cutoff) { startIdx = i; break; }
    }
    const start = pArr[startIdx];
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

async function bootstrapData() {
    console.log("LOG: Đang nạp dữ liệu mồi...");
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 80); // Lấy 80 con vol cao nhất
        for (let t of usdtPairs) {
            if(!coinData[t.symbol]) coinData[t.symbol] = { symbol: t.symbol, prices: [] };
        }
    } catch (e) { console.log("LOG: Bootstrap lỗi: " + e.message); }
}

function updatePriceLogic(s, p, now) {
    if (!coinData[s]) return;
    coinData[s].prices.push({ p, t: now });
    
    // Giới hạn bộ nhớ: Chỉ giữ nến trong 15p + 1 ít buffer
    if (coinData[s].prices.length > 500) coinData[s].prices.shift();

    const c1 = calculateChange(coinData[s].prices, 1);
    const c5 = calculateChange(coinData[s].prices, 5);
    const c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };

    const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
    if (pending) {
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
        
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
                    dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                });
            }});
        }
    }
}

// KHỞI TẠO WS ĐƠN LẺ ĐỂ TỐC ĐỘ NHANH (0.5s)
async function initWS() {
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    const tickers = await res.json();
    const symbols = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 100).map(t => t.symbol.toLowerCase());
    
    // Gộp các stream vào 1 kết nối (Mỗi kết nối tối đa 200 streams)
    const streamString = symbols.map(s => `${s}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streamString}`);

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.data) {
            updatePriceLogic(msg.data.s, parseFloat(msg.data.c), Date.now());
        }
    });

    ws.on('close', () => setTimeout(initWS, 1000));
    ws.on('error', (e) => console.log("WS Error: ", e.message));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const topData = Object.entries(coinData)
        .filter(([, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live }))
        .sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1))
        .slice(0, 15);
    res.json({
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        live: topData,
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`
    <html>
    <head>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #0b0e11; color: #ebebeb; font-family: sans-serif; }
            .up { color: #02c076; } .down { color: #f84960; }
            .bg-card { background: #1e2329; }
            .glow-yellow { box-shadow: 0 0 15px rgba(252, 213, 53, 0.1); }
        </style>
    </head>
    <body>
        <div class="p-4 border-b border-zinc-800 sticky top-0 bg-[#0b0e11] z-50">
            <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
                <input id="balanceInp" type="number" placeholder="Vốn" class="p-2 rounded bg-zinc-900 text-yellow-500">
                <input id="marginInp" type="text" placeholder="Margin (vd: 10%)" class="p-2 rounded bg-zinc-900 text-yellow-500">
                <div class="col-span-2 grid grid-cols-4 gap-2">
                    <input id="tpInp" type="number" placeholder="TP" class="p-2 rounded bg-zinc-800 text-xs">
                    <input id="slInp" type="number" placeholder="DCA/SL" class="p-2 rounded bg-zinc-800 text-xs">
                    <input id="volInp" type="number" placeholder="Vol" class="p-2 rounded bg-zinc-800 text-xs">
                    <select id="modeInp" class="p-2 rounded bg-zinc-800 text-xs">
                        <option value="FOLLOW">FOLLOW</option>
                        <option value="REVERSE">REVERSE</option>
                    </select>
                </div>
                <button onclick="start()" class="col-span-2 bg-yellow-500 text-black font-bold p-2 rounded">CHẠY ENGINE</button>
            </div>
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-black text-yellow-500 italic">LUFFY 0.5s SPEED</h1>
                <div id="unPnl" class="text-xl font-bold">0.00</div>
            </div>
        </div>

        <div class="p-4 grid gap-4">
            <div class="bg-card p-4 rounded-xl">
                <h2 class="text-xs font-bold text-gray-500 mb-3 uppercase">Biến động thời gian thực</h2>
                <table class="w-full text-[11px]">
                    <thead><tr class="text-gray-500 text-left"><th>Coin</th><th>Giá</th><th>1M</th><th>5M</th><th>15M</th></tr></thead>
                    <tbody id="marketBody"></tbody>
                </table>
            </div>
            <div class="bg-card p-4 rounded-xl">
                <h2 class="text-xs font-bold text-green-500 mb-3 uppercase">Vị thế đang mở</h2>
                <table class="w-full text-[11px]">
                    <tbody id="pendingBody"></tbody>
                </table>
            </div>
        </div>

        <script>
            let running = false;
            function start() {
                const config = { 
                    tp: document.getElementById('tpInp').value, 
                    sl: document.getElementById('slInp').value, 
                    vol: document.getElementById('volInp').value,
                    mode: document.getElementById('modeInp').value
                };
                fetch('/api/config?tp='+config.tp+'&sl='+config.sl+'&vol='+config.vol+'&mode='+config.mode);
                running = true;
                document.getElementById('setup').classList.add('hidden');
            }

            async function update() {
                try {
                    const res = await fetch('/api/data');
                    const d = await res.json();
                    
                    document.getElementById('marketBody').innerHTML = d.live.map(m => \`
                        <tr class="border-b border-zinc-800/50">
                            <td class="py-2 font-bold">\${m.symbol}</td>
                            <td class="text-yellow-500">\${m.currentPrice}</td>
                            <td class="\${m.c1>=0?'up':'down'} font-bold">\${m.c1}%</td>
                            <td class="\${m.c5>=0?'up':'down'} font-bold">\${m.c5}%</td>
                            <td class="\${m.c15>=0?'up':'down'} font-bold">\${m.c15}%</td>
                        </tr>
                    \`).join('');

                    document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                        let lp = d.allPrices[h.symbol] || h.avgPrice;
                        let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * 20;
                        return \`<tr class="border-b border-zinc-800">
                            <td class="py-2 font-bold">\${h.symbol} [\${h.type}]</td>
                            <td>Entry: \${h.avgPrice}</td>
                            <td class="text-right \${roi>=0?'up':'down'} font-black">\${roi.toFixed(2)}%</td>
                        </tr>\`;
                    }).join('');
                } catch(e){}
            }
            // Tốc độ render GUI 200ms
            setInterval(update, 200);
        </script>
    </body>
    </html>`);
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 ENGINE NHẢY SỐ 0.5s SẴN SÀNG: http://localhost:${PORT}/gui`);
    await bootstrapData();
    initWS();
});
