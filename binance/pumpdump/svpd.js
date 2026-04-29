/**
 * LUFFY ENGINE ULTRA PRO - VERSION 100% REALTIME
 * Quét toàn sàn - Giá nhảy liên tục - Giao diện không rút gọn
 */

const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let pendingMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

// --- ACTION QUEUE ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    try { task.action(); } catch(e) {}
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- INIT FILES ---
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => {
            historyMap.set(`${h.symbol}_${h.startTime}`, h);
            if (h.status === 'PENDING') pendingMap.set(h.symbol, h);
        });
    } catch (e) {}
}

/**
 * 1. PRELOAD TOÀN SÀN
 */
async function preloadHistory(symbol) {
    try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=16`);
        const data = await res.json();
        if (!Array.isArray(data)) return;
        coinData[symbol] = {
            symbol,
            prices: data.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) })),
            tickCount: 0
        };
        process.stdout.write(`\r✅ Warm-up: ${symbol}           `);
    } catch (e) {}
}

async function preloadAll() {
    console.log('⏳ Đang quét danh sách Future...');
    const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const info = await res.json();
    const allFutures = info.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING').map(s => s.symbol);
    const batchSize = 30;
    for (let i = 0; i < allFutures.length; i += batchSize) {
        const batch = allFutures.slice(i, i + batchSize);
        await Promise.all(batch.map(sym => preloadHistory(sym)));
    }
    console.log('\n🚀 DONE!');
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    const targetTime = now - (min * 60000);
    let start = pArr[0];
    for (let i = pArr.length - 1; i >= 0; i--) {
        if (pArr[i].t <= targetTime) { start = pArr[i]; break; }
    }
    const latest = pArr[pArr.length - 1];
    return parseFloat((((latest.p - start.p) / start.p) * 100).toFixed(2));
}

/**
 * 2. WEBSOCKET
 */
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s; const p = parseFloat(t.c);
            if (!coinData[s]) return;
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 1000) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            const pending = pendingMap.get(s);
            if (pending && pending.status === 'PENDING') {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win) {
                    pending.status = 'WIN';
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    pending.endTime = now;
                    lastTradeClosed[s] = now; pendingMap.delete(s);
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol) {
                if (lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000)) return;
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = sumVol >= 0 ? 'LONG' : 'SHORT';
                        if (tradeMode === 'REVERSE') type = (type === 'LONG' ? 'SHORT' : 'LONG');
                        const newT = { 
                            symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                            maxLev: 20, tpTarget: currentTP, slTarget: currentSL,
                            dcaCount: 0, dcaHistory: [{ t: now, p, avg: p }]
                        };
                        historyMap.set(`${s}_${newT.startTime}`, newT);
                        pendingMap.set(s, newT);
                    }});
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// --- API ---
app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl);
    currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const coins = Object.values(coinData);
    res.json({ 
        allPrices: Object.fromEntries(coins.map(v => [v.symbol, v.live ? v.live.currentPrice : 0])),
        live: coins.filter(v => v.live).map(v => ({ symbol: v.symbol, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 15), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime),
        status: { total: coins.length, ready: coins.filter(c => c.prices.length >= 15).length }
    });
});

// --- GUI ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Engine Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; overflow-x: hidden; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; }
        .luffy-bg { position: fixed; bottom: -20px; right: -20px; opacity: 0.15; pointer-events: none; width: 300px; z-index: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: #30363d; }
    </style></head><body>
    <img src="https://i.pinimg.com/originals/85/33/c2/8533c24d45543ef688f2f2526e38600f.png" class="luffy-bg">
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom font-bold">VỐN ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom font-bold">MARGIN / LỆNH</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2">
                <input id="tpInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-xs" placeholder="TP%">
                <input id="slInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-xs" placeholder="DCA%">
                <input id="volInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-xs" placeholder="Vol%">
                <select id="modeInp" class="p-2 rounded w-full outline-none text-xs"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2 rounded-md font-bold text-xs uppercase">BẮT ĐẦU</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4"><div class="font-bold italic text-white text-xl">LUFFY <span class="text-[#fcd535]">ENGINE</span></div><div id="sysStatus" class="text-[9px] font-mono text-zinc-500"></div><div class="text-[#f6465d] font-bold text-xs border border-[#f6465d] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP</div></div>
        <div class="flex justify-between items-end"><div><div class="text-gray-custom text-[11px] font-bold">EQUITY</div><span id="displayBal" class="text-4xl font-bold text-white">0.00</span></div><div class="text-right"><div class="text-gray-custom text-[11px] font-bold">PNL LIVE</div><div id="unPnl" class="text-xl font-bold">0.00</div></div></div>
    </div>

    <div class="px-4 mt-4 relative z-10"><div class="bg-card rounded-lg p-3"><canvas id="balanceChart" style="height:120px"></canvas></div></div>

    <div class="px-4 mt-4 relative z-10"><div class="bg-card rounded-lg p-3">
        <div class="text-[10px] font-bold text-yellow-500 mb-2 uppercase italic">Market Flow (Top 15)</div>
        <table class="w-full text-[10px]"><thead class="text-gray-custom border-b border-zinc-800"><tr><th class="text-left">Symbol</th><th class="text-left">Price</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-center">15M</th></tr></thead><tbody id="marketBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-4 relative z-10"><div class="bg-card rounded-lg p-3 border-l-4 border-green-500">
        <div class="text-[10px] font-bold text-white mb-2 uppercase">Vị thế đang mở</div>
        <table class="w-full text-[10px]"><thead class="text-gray-custom border-b border-zinc-800"><tr><th class="text-left">Pair</th><th class="text-left">Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-4 pb-10 relative z-10"><div class="bg-card rounded-lg p-3">
        <div class="text-[10px] font-bold text-gray-custom mb-2 uppercase">Lịch sử giao dịch</div>
        <table class="w-full text-[9px]"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Time</th><th>Pair</th><th>PnL</th><th class="text-right">Equity</th></tr></thead><tbody id="historyBody"></tbody></table>
    </div></div>

    <script>
    let running = false, initialBal = 1000, myChart = null;
    const s = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    if(s.running){ running=true; initialBal=s.initialBal; document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
    document.getElementById('balanceInp').value = s.initialBal || 1000;
    document.getElementById('marginInp').value = s.marginVal || "10%";
    document.getElementById('tpInp').value = s.tp || 0.5; document.getElementById('slInp').value = s.sl || 10;
    document.getElementById('volInp').value = s.vol || 6.5; document.getElementById('modeInp').value = s.mode || 'FOLLOW';

    function start(){ localStorage.setItem('luffy_state', JSON.stringify({running:true, initialBal:parseFloat(document.getElementById('balanceInp').value), marginVal:document.getElementById('marginInp').value, tp:document.getElementById('tpInp').value, sl:document.getElementById('slInp').value, vol:document.getElementById('volInp').value, mode:document.getElementById('modeInp').value})); location.reload(); }
    function stop(){ let s=JSON.parse(localStorage.getItem('luffy_state')); s.running=false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }
    function syncConfig(){ fetch(\`/api/config?tp=\${document.getElementById('tpInp').value}&sl=\${document.getElementById('slInp').value}&vol=\${document.getElementById('volInp').value}&mode=\${document.getElementById('modeInp').value}\`); }
    
    function initChart(){ const ctx=document.getElementById('balanceChart').getContext('2d'); myChart=new Chart(ctx,{type:'line',data:{labels:[],datasets:[{data:[],borderColor:'#fcd535',borderWidth:2,fill:false,pointRadius:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{display:false}}}}}); }

    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        document.getElementById('sysStatus').innerText = \`TOTAL: \${d.status.total} | READY: \${d.status.ready}\`;
        
        // Market
        document.getElementById('marketBody').innerHTML = d.live.map(m => \`<tr class="border-b border-zinc-800/30"><td class="py-1 font-bold">\${m.symbol}</td><td class="text-yellow-500">\${m.currentPrice.toFixed(4)}</td><td class="text-center \${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="text-center \${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="text-center \${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('');

        let runningBal = initialBal, unPnl = 0, cData = [initialBal], cLabels = ['0'];
        let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);

        // History
        let hist = [...d.history].reverse();
        document.getElementById('historyBody').innerHTML = hist.map((h,i) => {
            let margin = mVal.includes('%') ? (runningBal * mNum/100) : mNum;
            let pnl = margin * 20 * (h.pnlPercent/100); runningBal += pnl;
            cData.push(runningBal); cLabels.push(i);
            return \`<tr class="border-b border-zinc-800/30"><td>\${new Date(h.endTime).toLocaleTimeString()}</td><td class="text-white">\${h.symbol}</td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</td><td class="text-right">\${runningBal.toFixed(1)}</td></tr>\`;
        }).reverse().join('');

        // Pending
        document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*20;
            let margin = mVal.includes('%') ? (runningBal * mNum/100) : mNum;
            let pnl = margin * (roi/100); unPnl += pnl;
            return \`<tr class="border-b border-zinc-800"><td>\${h.symbol} <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.avgPrice.toFixed(4)}<br><b class="up">\${lp.toFixed(4)}</b></td><td class="text-right \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
        }).join('');

        document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
        document.getElementById('unPnl').innerText = unPnl.toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl>=0?'up':'down');
        if(myChart){ myChart.data.labels=cLabels; myChart.data.datasets[0].data=cData; myChart.update('none'); }
    }
    if(running){ initChart(); syncConfig(); setInterval(update, 1000); }
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    await preloadAll(); 
    initWS(); 
    console.log(`🔥 Luffy Engine Online: http://localhost:${PORT}/gui`); 
});
