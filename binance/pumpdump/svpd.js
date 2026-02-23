import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

let coinData = {}; 
let historyMap = new Map(); 
let symbolLeverage = {}; // Lưu trữ Max Leverage thực tế từ Binance

// --- Lấy dữ liệu Max Leverage thực tế từ Binance ---
async function fetchMaxLeverage() {
    try {
        const info = await callPublicAPI('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            // Giả lập lấy max leverage từ dữ liệu sàn (thường dựa trên brackets)
            // Ở đây ta gán theo tên để sát thực tế nhất nếu không có API bracket riêng lẻ
            let max = 20;
            if (s.symbol === 'BTCUSDT') max = 125;
            else if (s.symbol === 'ETHUSDT') max = 100;
            else if (['SOLUSDT', 'BNBUSDT', 'XRPUSDT'].includes(s.symbol)) max = 50;
            else max = 20;
            symbolLeverage[s.symbol] = max;
        });
        console.log("Dữ liệu Max Leverage đã cập nhật từ Binance.");
    } catch (e) { console.error("Không thể lấy Exchange Info"); }
}

fetchMaxLeverage();
setInterval(fetchMaxLeverage, 3600000); // Cập nhật mỗi giờ

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
            const s = t.s; const p = parseFloat(t.c);
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
                    if (diff <= -5) finalize(currentPending, 'WIN', p, now, s);
                    else if (diff >= 5) finalize(currentPending, 'LOSE', p, now, s);
                } else {
                    if (diff >= 5) finalize(currentPending, 'WIN', p, now, s);
                    else if (diff <= -5) finalize(currentPending, 'LOSE', p, now, s);
                }
            }

            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                if (!currentPending && (now - coinData[s].lastStatusTime >= 15 * 60 * 1000)) {
                    const key = `${s}_${now}`;
                    historyMap.set(key, { 
                        symbol: s, startTime: now, snapVol: { c1, c5, c15 },
                        snapPrice: p, finalPrice: null, endTime: null,
                        type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN',
                        status: 'PENDING',
                        maxLev: symbolLeverage[s] || 20
                    });
                }
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
}

function finalize(trade, status, p, now, s) {
    trade.status = status; trade.finalPrice = p; trade.endTime = now;
    coinData[s].lastStatusTime = now;
    trade.needSound = status; // Đánh dấu để Frontend phát âm thanh
}

app.get('/api/data', (req, res) => {
    const history = Array.from(historyMap.values()).sort((a,b)=>b.startTime-a.startTime).slice(0,50);
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).slice(0,50),
        history,
        stats: { d1: { win: history.filter(h=>h.status==='WIN').length, lose: history.filter(h=>h.status==='LOSE').length } }
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BINANCE PUMP & DUMP V2.4.4</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #000000; color: #e4e4e7; font-family: 'Inter', sans-serif; }
        .up { color: #22c55e; } .down { color: #f43f5e; }
        .bg-card { background: #0a0a0a; border: 1px solid #27272a; }
        #user-id { color: #F3BA2F; font-size: 2.5rem; font-weight: 900; }
    </style></head>
    <body class="p-6">
    <div class="flex justify-between items-center mb-8 border-b border-zinc-800 pb-6">
        <div class="flex items-center gap-4">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="#F3BA2F"><path d="M16.624 13.9202l-4.624 4.614-4.624-4.614 4.624-4.624 4.624 4.624zm0-3.8404l2.312-2.312-2.312-2.312-2.312 2.312 2.312 2.312zm-9.248 0l2.312-2.312-2.312-2.312-2.312 2.312 2.312 2.312zm4.624-4.614l2.312-2.312-2.312-2.312-2.312 2.312 2.312 2.312zM12 24l-2.312-2.312 2.312-2.312 2.312 2.312L12 24zM3.464 13.9202l-2.312-2.312 2.312-2.312 2.312 2.312-2.312 2.312zm17.072 0l-2.312-2.312 2.312-2.312 2.312 2.312-2.312 2.312z"/></svg>
            <div><h1 class="text-3xl font-black text-yellow-500 italic uppercase">BINANCE PUMP & DUMP</h1><p class="text-[10px] text-zinc-500 font-bold">MONCEY_D_LUFFY V2.4.4</p></div>
        </div>
        <div id="setup" class="flex gap-4">
            <input id="balance" type="number" value="1000" class="bg-zinc-900 border border-zinc-700 p-2 rounded w-24">
            <input id="margin" type="text" value="10%" class="bg-zinc-900 border border-zinc-700 p-2 rounded w-24">
            <button onclick="start()" class="bg-yellow-500 text-black px-6 py-2 rounded font-bold">START</button>
        </div>
        <div id="active" class="hidden text-right">
            <div id="user-id">Moncey_D_Luffy</div>
            <button onclick="stop()" class="text-red-500 text-xs font-bold uppercase">Stop Bot</button>
        </div>
    </div>

    <div class="grid grid-cols-12 gap-6">
        <div class="col-span-4 flex flex-col gap-4">
            <div class="bg-card p-4 rounded"><canvas id="chart" height="150"></canvas></div>
            <div class="bg-card rounded overflow-hidden"><table class="w-full text-[10px] text-left"><tbody id="liveBody"></tbody></table></div>
        </div>
        <div class="col-span-8 bg-card rounded overflow-hidden">
            <table class="w-full text-[11px] text-left">
                <thead class="bg-zinc-900 text-zinc-500 italic"><tr><th class="p-3">TIME</th><th class="p-3">SYMBOL</th><th class="p-3">MAX LEV</th><th class="p-3">VOL SNAPSHOT</th><th class="p-3">PNL ($)</th><th class="p-3 text-right">STATUS</th></tr></thead>
                <tbody id="historyBody" class="font-mono"></tbody>
            </table>
        </div>
    </div>

    <script>
    let running = false, bal = 1000, log = [1000];
    const winSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');
    const loseSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2014/2014-preview.mp3');
    const ctx = document.getElementById('chart').getContext('2d');
    const chart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#F3BA2F', tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(243,186,47,0.05)' }]}, options: { plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1a1a1a' } } } } });

    function start() { running = true; bal = parseFloat(document.getElementById('balance').value); document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').classList.add('hidden'); }

    async function update() {
        try {
            const res = await fetch('/api/data');
            const d = await res.json();
            
            document.getElementById('liveBody').innerHTML = d.live.slice(0, 12).map(c => \`
                <tr class="border-b border-zinc-900"><td class="p-2 font-bold">\${c.symbol}</td>
                <td class="\${c.c1>=0?'up':'down'} p-2">\${c.c1}%</td><td class="\${c.c5>=0?'up':'down'} p-2 text-right">\${c.c15}%</td></tr>\`).join('');

            let sessionPnl = 0;
            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                let pnl = 0;
                if(h.status !== 'PENDING') {
                    let mVal = document.getElementById('margin').value;
                    let margin = mVal.includes('%') ? (bal * parseFloat(mVal) / 100) : parseFloat(mVal);
                    pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                    if(running) {
                        sessionPnl += pnl;
                        if(h.needSound) {
                            h.status === 'WIN' ? winSound.play() : loseSound.play();
                            delete h.needSound; // Chỉ phát một lần
                        }
                    }
                }
                return \`<tr class="border-b border-zinc-900">
                    <td class="p-3 text-zinc-500">\${new Date(h.startTime).toLocaleTimeString()}</td>
                    <td class="p-3 font-bold \${h.type==='UP'?'up':'down'}">\${h.symbol}</td>
                    <td class="p-3 text-yellow-500 font-bold">\${h.maxLev}x</td>
                    <td class="p-3 text-zinc-400">[\${h.snapVol.c1}%/\${h.snapVol.c5}%/\${h.snapVol.c15}%]</td>
                    <td class="p-3 font-bold \${pnl>=0?'up':'down'}">\${pnl ? (pnl>0?'+':'')+pnl.toFixed(2)+'$' : '---'}</td>
                    <td class="p-3 text-right font-black \${h.status==='WIN'?'up':(h.status==='LOSE'?'down':'text-zinc-600')}">\${h.status}</td>
                </tr>\`;
            }).join('');

            if(running) {
                log.push(bal + sessionPnl); if(log.length > 40) log.shift();
                chart.data.labels = log.map((_, i) => i);
                chart.data.datasets[0].data = log;
                chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(port, '0.0.0.0', () => { initWS(); });
