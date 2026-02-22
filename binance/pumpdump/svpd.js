import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

let coinData = {}; 
let historyMap = new Map(); 

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
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(dataToSave.slice(-1000))); 
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
            if (coinData[s].prices.length > 100) {
                coinData[s].prices = coinData[s].prices.slice(-100);
            }
            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                let hist = historyMap.get(s);
                if (!hist) {
                    hist = { symbol: s, startTime: now, lastUpdate: now, max1: c1, max5: c5, max15: c15 };
                } else {
                    if (Math.abs(c1) > Math.abs(hist.max1)) hist.max1 = c1;
                    if (Math.abs(c5) > Math.abs(hist.max5)) hist.max5 = c5;
                    if (Math.abs(c15) > Math.abs(hist.max15)) hist.max15 = c15;
                    hist.lastUpdate = now;
                }
                historyMap.set(s, hist);
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/live', (req, res) => {
    const live = Object.entries(coinData)
        .filter(([_, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live }))
        .sort((a, b) => {
            const maxA = Math.max(Math.abs(a.c1), Math.abs(a.c5), Math.abs(a.c15));
            const maxB = Math.max(Math.abs(b.c1), Math.abs(b.c5), Math.abs(b.c15));
            return maxB - maxA;
        }).slice(0, 50);
    res.json(live);
});

app.get('/api/data', (req, res) => {
    const live = Object.entries(coinData)
        .filter(([_, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live }))
        .sort((a, b) => {
            const maxA = Math.max(Math.abs(a.c1), Math.abs(a.c5), Math.abs(a.c15));
            const maxB = Math.max(Math.abs(b.c1), Math.abs(b.c5), Math.abs(b.c15));
            return maxB - maxA;
        }).slice(0, 50);
    const history = Array.from(historyMap.values()).sort((a, b) => b.startTime - a.startTime).slice(0, 50);
    res.json({ live, history });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>PIRATE ENGINE v4.2</title><script src="https://cdn.tailwindcss.com"></script><style>body { background: #050505; color: #d4d4d8; font-family: monospace; } .up { color: #22c55e; } .down { color: #ef4444; } .bg-live { background: rgba(30, 58, 138, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); } .bg-hist { background: rgba(127, 29, 29, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); }</style></head><body class="p-6"><div class="flex justify-between items-center mb-8 border-b border-zinc-800 pb-4"><h1 class="text-3xl font-black text-yellow-500 italic">PIRATE ENGINE v4.2</h1><div id="clock" class="text-xl font-bold">00:00:00</div></div><div class="grid grid-cols-12 gap-6"><div class="col-span-5"><h2 class="text-blue-400 font-bold mb-4 text-sm">🚀 LIVE VOLATILITY</h2><div class="bg-live rounded-xl p-2"><table class="w-full text-[11px] text-left"><thead><tr class="text-zinc-600 border-b border-zinc-800"><th class="p-2">SYMBOL</th><th class="p-2">1M</th><th class="p-2">5M</th><th class="p-2">15M</th></tr></thead><tbody id="liveBody"></tbody></table></div></div><div class="col-span-7"><h2 class="text-red-500 font-bold mb-4 text-sm">📊 RECENT HISTORY</h2><div class="bg-hist rounded-xl p-2"><table class="w-full text-[12px] text-left"><thead><tr class="text-zinc-600 border-b border-zinc-800"><th class="p-2">TIME</th><th class="p-2">SYMBOL</th><th class="p-2 text-center">MAX 1M</th><th class="p-2 text-center">MAX 5M</th><th class="p-2 text-center">MAX 15M</th></tr></thead><tbody id="historyBody"></tbody></table></div></div></div><script>function updateClock() { document.getElementById('clock').innerText = new Date().toLocaleTimeString(); } setInterval(updateClock, 1000); async function refresh() { try { const res = await fetch('/api/data'); const d = await res.json(); document.getElementById('liveBody').innerHTML = d.live.map(c => \`<tr class="border-b border-zinc-800/20"><td class="p-2 font-bold">\${c.symbol}</td><td class="\${c.c1 >= 0 ? 'up':'down'}">\${c.c1}%</td><td class="\${c.c5 >= 0 ? 'up':'down'} font-bold bg-white/5">\${c.c5}%</td><td class="\${c.c15 >= 0 ? 'up':'down'}">\${c.c15}%</td></tr>\`).join(''); document.getElementById('historyBody').innerHTML = d.history.map(h => \`<tr class="border-b border-zinc-800 hover:bg-white/5"><td class="p-2 text-zinc-500 text-[10px]">\${new Date(h.startTime).toLocaleTimeString()}</td><td class="p-2 font-black text-white">\${h.symbol}</td><td class="p-2 text-center \${h.max1 >= 0 ? 'up':'down'}">\${h.max1}%</td><td class="p-2 text-center \${h.max5 >= 0 ? 'up':'down'} font-bold">\${h.max5}%</td><td class="p-2 text-center \${h.max15 >= 0 ? 'up':'down'}">\${h.max15}%</td></tr>\`).join(''); } catch(e) {} } setInterval(refresh, 1000); refresh();</script></body></html>`);
});

async function start() {
    await fetchInitialHistory();
    initWS();
}

app.listen(port, '0.0.0.0', () => {
    start();
});
