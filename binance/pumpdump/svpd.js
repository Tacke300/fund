import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

let coinData = {}; 
let historyMap = new Map(); 

// --- Helper: Lấy mốc 7h sáng UTC+7 gần nhất ---
function getPivotTime() {
    const now = new Date();
    let pivot = new Date(now);
    pivot.setHours(7, 0, 0, 0);
    if (now < pivot) {
        pivot.setDate(pivot.getDate() - 1);
    }
    return pivot.getTime();
}

async function callPublicAPI(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return new Promise((res, rej) => {
        https.get(`https://fapi.binance.com${path}${qs ? '?' + qs : ''}`, (r) => {
            let d = ''; r.on('data', chunk => d += chunk);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}

async function fetchInitialHistory() {
    try {
        const info = await callPublicAPI('/fapi/v1/exchangeInfo');
        const symbols = info.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol);

        for (const s of symbols.slice(0, 150)) {
            try {
                const klines = await callPublicAPI('/fapi/v1/klines', { symbol: s, interval: '1m', limit: 15 });
                const now = Date.now();
                if (Array.isArray(klines)) {
                    coinData[s] = {
                        symbol: s,
                        prices: klines.map((k, index) => ({
                            p: parseFloat(k[4]), 
                            t: now - (15 - index) * 60000 
                        }))
                    };
                }
            } catch (e) { continue; }
        }
    } catch (e) {}
}

if (fs.existsSync(HISTORY_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
        data.forEach(h => historyMap.set(h.symbol, h));
    } catch (e) {}
}

setInterval(() => {
    const dataToSave = Array.from(historyMap.values());
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(dataToSave.slice(-2000))); 
}, 30000);

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    if (!startPriceObj) return 0;
    return parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s; 
            const p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            
            if (coinData[s].prices.length > 150) coinData[s].prices = coinData[s].prices.slice(-150);

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            // Kiểm tra Win/Lose cho các lệnh cũ trong history
            let hist = historyMap.get(s);
            if (hist && hist.status === 'PENDING') {
                const diff = ((p - hist.snapPrice) / hist.snapPrice) * 100;
                // Nếu ban đầu giảm (-5)
                if (hist.triggerSide === 'DOWN') {
                    if (diff <= -5) hist.status = 'WIN';
                    else if (diff >= 5) hist.status = 'LOSE';
                } 
                // Nếu ban đầu tăng (+5)
                else if (hist.triggerSide === 'UP') {
                    if (diff >= 5) hist.status = 'WIN';
                    else if (diff <= -5) hist.status = 'LOSE';
                }
                if (hist.status !== 'PENDING') hist.resultTime = now;
            }

            // Kích hoạt ghi log mới
            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                if (!hist || hist.status !== 'PENDING') {
                    const side = (c1 >= 5 || c5 >= 5 || c15 >= 5) ? 'UP' : 'DOWN';
                    historyMap.set(s, {
                        symbol: s,
                        startTime: now,
                        snapPrice: p,
                        triggerSide: side,
                        status: 'PENDING',
                        max1: c1, max5: c5, max15: c15
                    });
                } else {
                    if (Math.abs(c1) > Math.abs(hist.max1)) hist.max1 = c1;
                    if (Math.abs(c5) > Math.abs(hist.max5)) hist.max5 = c5;
                    if (Math.abs(c15) > Math.abs(hist.max15)) hist.max15 = c15;
                }
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/data', (req, res) => {
    const pivot = getPivotTime();
    const live = Object.entries(coinData)
        .filter(([_, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live }))
        .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5), Math.abs(b.c15)) - Math.max(Math.abs(a.c1), Math.abs(a.c5), Math.abs(a.c15)))
        .slice(0, 40);

    const allHistory = Array.from(historyMap.values());
    const filteredHistory = allHistory.filter(h => h.startTime >= pivot);
    
    const winCount = filteredHistory.filter(h => h.status === 'WIN').length;
    const loseCount = filteredHistory.filter(h => h.status === 'LOSE').length;

    res.json({ 
        live, 
        history: allHistory.sort((a, b) => b.startTime - a.startTime).slice(0, 50),
        stats: { win: winCount, lose: loseCount }
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>PIRATE ENGINE v5.0</title><script src="https://cdn.tailwindcss.com"></script><style>
        body { background: #050505; color: #d4d4d8; font-family: monospace; }
        .up { color: #22c55e; } .down { color: #ef4444; }
        .bg-win { color: #22c55e; font-weight: bold; } .bg-lose { color: #ef4444; font-weight: bold; }
        .bg-live { background: rgba(30, 58, 138, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); }
        .bg-hist { background: rgba(20, 20, 20, 0.8); border: 1px solid #333; }
    </style></head><body class="p-4">
        <div class="flex justify-between items-center mb-4 border-b border-zinc-800 pb-2">
            <div>
                <h1 class="text-2xl font-black text-yellow-500 italic">PIRATE ENGINE v5.0</h1>
                <div id="stats" class="text-sm mt-1"></div>
            </div>
            <div id="clock" class="text-xl font-bold text-zinc-500">00:00:00</div>
        </div>
        <div class="grid grid-cols-12 gap-4">
            <div class="col-span-4">
                <h2 class="text-blue-400 font-bold mb-2 text-xs uppercase">🚀 Live Volatility</h2>
                <div class="bg-live rounded-lg p-2"><table class="w-full text-[10px] text-left">
                    <thead><tr class="text-zinc-600 border-b border-zinc-800"><th class="p-1">SYMBOL</th><th class="p-1">1M</th><th class="p-1">5M</th><th class="p-1">15M</th></tr></thead>
                    <tbody id="liveBody"></tbody>
                </table></div>
            </div>
            <div class="col-span-8">
                <h2 class="text-red-500 font-bold mb-2 text-xs uppercase">📊 History & Signals</h2>
                <div class="bg-hist rounded-lg p-2"><table class="w-full text-[11px] text-left">
                    <thead><tr class="text-zinc-600 border-b border-zinc-800">
                        <th class="p-2">TIME</th><th class="p-2">SYMBOL</th><th class="p-2">STRATEGY</th><th class="p-2">MAX VAR</th><th class="p-2">RESULT</th>
                    </tr></thead>
                    <tbody id="historyBody"></tbody>
                </table></div>
            </div>
        </div>
        <script>
            function updateClock() { document.getElementById('clock').innerText = new Date().toLocaleTimeString(); }
            setInterval(updateClock, 1000);
            async function refresh() {
                try {
                    const res = await fetch('/api/data');
                    const d = await res.json();
                    document.getElementById('stats').innerHTML = \`<span class="text-green-500">WIN: \${d.stats.win}</span> | <span class="text-red-500">LOSE: \${d.stats.lose}</span> <span class="text-zinc-600 ml-2">(Since 7:00 AM)</span>\`;
                    document.getElementById('liveBody').innerHTML = d.live.map(c => \`<tr>
                        <td class="p-1 font-bold">\${c.symbol}</td>
                        <td class="\${c.c1 >= 0 ? 'up':'down'}">\${c.c1}%</td>
                        <td class="\${c.c5 >= 0 ? 'up':'down'} font-bold">\${c.c5}%</td>
                        <td class="\${c.c15 >= 0 ? 'up':'down'}">\${c.c15}%</td>
                    </tr>\`).join('');
                    document.getElementById('historyBody').innerHTML = d.history.map(h => {
                        let resClass = h.status === 'WIN' ? 'bg-win' : (h.status === 'LOSE' ? 'bg-lose' : 'text-zinc-500');
                        let maxVar = Math.max(Math.abs(h.max1), Math.abs(h.max5), Math.abs(h.max15));
                        return \`<tr class="border-b border-zinc-800/50">
                            <td class="p-2 text-zinc-500">\${new Date(h.startTime).toLocaleTimeString()}</td>
                            <td class="p-2 font-bold text-white">\${h.symbol}</td>
                            <td class="p-2 \${h.triggerSide === 'UP' ? 'up' : 'down'}">\${h.triggerSide === 'UP' ? 'LONG' : 'SHORT'} @ \${h.snapPrice}</td>
                            <td class="p-2">\${maxVar}%</td>
                            <td class="p-2 \${resClass}">\${h.status}</td>
                        </tr>\`;
                    }).join('');
                } catch(e) {}
            }
            setInterval(refresh, 2000); refresh();
        </script>
    </body></html>`);
});

async function start() {
    await fetchInitialHistory();
    initWS();
}

app.listen(port, '0.0.0.0', () => {
    start();
});
