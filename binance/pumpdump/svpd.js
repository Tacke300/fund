import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

let coinData = {}; 
let historyMap = new Map(); 

if (fs.existsSync(HISTORY_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
        data.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

setInterval(() => {
    const dataToSave = Array.from(historyMap.values());
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(dataToSave.slice(-2000))); 
}, 30000);

async function callPublicAPI(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return new Promise((res, rej) => {
        https.get(`https://fapi.binance.com${path}${qs ? '?' + qs : ''}`, (r) => {
            let d = ''; r.on('data', chunk => d += chunk);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}

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
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastStatusTime: 0 };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices = coinData[s].prices.slice(-100);

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            const historyArr = Array.from(historyMap.values());
            let currentPending = historyArr.find(h => h.symbol === s && h.status === 'PENDING');

            if (currentPending) {
                const diff = ((p - currentPending.snapPrice) / currentPending.snapPrice) * 100;
                if (currentPending.type === 'DOWN') {
                    if (diff <= -5) { currentPending.status = 'WIN'; currentPending.finalPrice = p; currentPending.endTime = now; coinData[s].lastStatusTime = now; }
                    else if (diff >= 5) { currentPending.status = 'LOSE'; currentPending.finalPrice = p; currentPending.endTime = now; coinData[s].lastStatusTime = now; }
                } else {
                    if (diff >= 5) { currentPending.status = 'WIN'; currentPending.finalPrice = p; currentPending.endTime = now; coinData[s].lastStatusTime = now; }
                    else if (diff <= -5) { currentPending.status = 'LOSE'; currentPending.finalPrice = p; currentPending.endTime = now; coinData[s].lastStatusTime = now; }
                }
            }

            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                const cooldownMs = 15 * 60 * 1000;
                if (!currentPending && (now - coinData[s].lastStatusTime >= cooldownMs)) {
                    const key = `${s}_${now}`;
                    historyMap.set(key, { 
                        symbol: s, startTime: now, lastUpdate: now, 
                        max1: c1, max5: c5, max15: c15,
                        snapPrice: p, finalPrice: null,
                        type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN',
                        status: 'PENDING' 
                    });
                }
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/data', (req, res) => {
    const live = Object.entries(coinData)
        .filter(([_, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live }))
        .sort((a, b) => {
            const maxA = Math.max(Math.abs(a.c1), Math.abs(a.c5), Math.abs(a.c15));
            const maxB = Math.max(Math.abs(b.c1), Math.abs(b.c5), Math.abs(b.c15));
            return maxB - maxA;
        }).slice(0, 50);

    const now = Date.now();
    const historyArr = Array.from(historyMap.values());
    const getStats = (ms) => {
        const filtered = ms === 0 ? historyArr : historyArr.filter(h => h.startTime >= (now - ms));
        return { win: filtered.filter(h => h.status === 'WIN').length, lose: filtered.filter(h => h.status === 'LOSE').length };
    };

    res.json({ 
        live, 
        history: historyArr.sort((a, b) => b.startTime - a.startTime).slice(0, 50),
        stats: {
            d1: getStats(24 * 60 * 60 * 1000),
            d7: getStats(7 * 24 * 60 * 60 * 1000),
            d30: getStats(30 * 24 * 60 * 60 * 1000),
            all: getStats(0)
        }
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>PIRATE ENGINE v5.0</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #000000; color: #e4e4e7; font-family: 'Inter', 'Roboto Mono', monospace; -webkit-font-smoothing: antialiased; }
        .up { color: #22c55e; text-shadow: 0 0 10px rgba(34, 197, 94, 0.2); }
        .down { color: #f43f5e; text-shadow: 0 0 10px rgba(244, 63, 94, 0.2); }
        .bg-card { background: #0a0a0a; border: 1px solid #27272a; }
        th { color: #71717a; letter-spacing: 0.05em; font-weight: 700; }
        tr { border-bottom: 1px solid #18181b; }
        tr:hover { background: #111111; }
        .font-numeric { font-variant-numeric: tabular-nums; }
    </style></head>
    <body class="p-6">
    <div class="flex justify-between items-center mb-8 border-b border-zinc-800 pb-6">
        <div>
            <h1 class="text-4xl font-black text-yellow-500 tracking-tighter italic">PIRATE ENGINE <span class="text-white">v5.0</span></h1>
            <div class="flex items-center gap-2 mt-1">
                <span class="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                <p class="text-xs text-zinc-400 font-bold uppercase tracking-widest">System Live Monitoring</p>
            </div>
        </div>
        <div class="grid grid-cols-4 gap-4 text-xs font-bold text-center">
            <div class="bg-card px-4 py-2 rounded-lg border-yellow-500/20"><div>24H</div><div id="s1"></div></div>
            <div class="bg-card px-4 py-2 rounded-lg"><div>7D</div><div id="s7"></div></div>
            <div class="bg-card px-4 py-2 rounded-lg"><div>30D</div><div id="s30"></div></div>
            <div class="bg-card px-4 py-2 rounded-lg bg-yellow-500/10 border-yellow-500/30 text-yellow-500"><div>TOTAL</div><div id="sall"></div></div>
        </div>
    </div>
    <div class="grid grid-cols-12 gap-8">
        <div class="col-span-4">
            <h2 class="text-blue-500 font-black mb-4 text-sm uppercase flex items-center gap-2">
                <span class="w-1 h-4 bg-blue-500 inline-block"></span> 🚀 Live Volatility
            </h2>
            <div class="bg-card rounded-xl overflow-hidden shadow-2xl">
                <table class="w-full text-[13px] text-left">
                    <thead class="bg-zinc-900/50">
                        <tr><th class="p-4">SYMBOL</th><th class="p-4">1M</th><th class="p-4">5M</th><th class="p-4 text-right">15M</th></tr>
                    </thead>
                    <tbody id="liveBody" class="font-numeric"></tbody>
                </table>
            </div>
        </div>
        <div class="col-span-8">
            <h2 class="text-red-500 font-black mb-4 text-sm uppercase flex items-center gap-2">
                <span class="w-1 h-4 bg-red-500 inline-block"></span> 📊 Trading History
            </h2>
            <div class="bg-card rounded-xl overflow-hidden shadow-2xl">
                <table class="w-full text-[13px] text-left">
                    <thead class="bg-zinc-900/50">
                        <tr>
                            <th class="p-4">TIME</th><th class="p-4">SYMBOL</th><th class="p-4">SNAP</th>
                            <th class="p-4">FINAL</th><th class="p-4 text-center">MAX(1/5/15)</th><th class="p-4 text-right">RESULT</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody" class="font-numeric"></tbody>
                </table>
            </div>
        </div>
    </div>
    <script>
    async function refresh() {
        try {
            const res = await fetch('/api/data');
            const d = await res.json();
            const fmt = (s) => \`<span class="text-green-500">\${s.win}W</span> <span class="text-zinc-600">/</span> <span class="text-red-500">\${s.lose}L</span>\`;
            document.getElementById('s1').innerHTML = fmt(d.stats.d1);
            document.getElementById('s7').innerHTML = fmt(d.stats.d7);
            document.getElementById('s30').innerHTML = fmt(d.stats.d30);
            document.getElementById('sall').innerHTML = fmt(d.stats.all);
            
            document.getElementById('liveBody').innerHTML = d.live.map(c => \`
                <tr class="hover:bg-zinc-900/50">
                    <td class="p-4 font-bold text-white">\${c.symbol}</td>
                    <td class="p-4 \${c.c1>=0?'up':'down'}">\${c.c1 > 0 ? '+' : ''}\${c.c1}%</td>
                    <td class="p-4 \${c.c5>=0?'up':'down'}">\${c.c5 > 0 ? '+' : ''}\${c.c5}%</td>
                    <td class="p-4 text-right \${c.c15>=0?'up':'down'}">\${c.c15 > 0 ? '+' : ''}\${c.c15}%</td>
                </tr>\`).join('');
            
            document.getElementById('historyBody').innerHTML = d.history.map(h => \`
                <tr class="hover:bg-zinc-800/30">
                    <td class="p-4 text-zinc-500">\${new Date(h.startTime).toLocaleTimeString()}</td>
                    <td class="p-4 font-black \${h.type==='UP'?'up':'down'}">\${h.symbol}</td>
                    <td class="p-4 text-zinc-300 font-bold">\${h.snapPrice}</td>
                    <td class="p-4 font-bold \${h.status==='WIN'?'up':(h.status==='LOSE'?'down':'text-zinc-500')}">\${h.finalPrice||'---'}</td>
                    <td class="p-4 text-center text-zinc-400 font-medium">\${h.max1}/\${h.max5}/\${h.max15}</td>
                    <td class="p-4 text-right font-black \${h.status==='WIN'?'up':(h.status==='LOSE'?'down':'text-zinc-500')}">
                        <span class="px-2 py-1 rounded bg-black/50 border border-zinc-800">\${h.status}</span>
                    </td>
                </tr>\`).join('');
        } catch(e) {}
    }
    setInterval(refresh, 2000); refresh();
    </script></body></html>`);
});

app.listen(port, '0.0.0.0', () => { initWS(); });
