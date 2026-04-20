const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let botConfig = {
    initialBal: 1000, marginVal: "10%", tp: 0.5, sl: 10.0, vol: 6.5, mode: 'FOLLOW', running: false
};

if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

// --- LOGIC TÍNH TOÁN CHUẨN ---
function calculateState() {
    let walletBal = Number(botConfig.initialBal) || 0;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    // Tính Wallet Balance từ lịch sử
    hist.forEach(h => {
        let mBase = String(h.marginVal).includes('%') ? (Number(h.availAtStart || botConfig.initialBal) * parseFloat(h.marginVal) / 100) : parseFloat(h.marginVal);
        let tM = (mBase || 0) * (Number(h.dcaCount || 0) + 1);
        let pnl = (tM * (h.maxLev || 20) * (Number(h.pnlPercent || 0) / 100)) - (tM * (h.maxLev || 20) * 0.001);
        walletBal += (pnl || 0);
    });

    let usedMargin = 0, totalUnPnl = 0;
    pending.forEach(h => {
        let lp = Number(coinData[h.symbol]?.live?.currentPrice) || Number(h.avgPrice);
        let mBase = String(h.marginVal).includes('%') ? (Number(h.availAtStart || walletBal) * parseFloat(h.marginVal) / 100) : parseFloat(h.marginVal);
        let tM = (mBase || 0) * (Number(h.dcaCount || 0) + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / h.avgPrice : (h.avgPrice - lp) / h.avgPrice) * 100 * (h.maxLev || 20);
        usedMargin += tM;
        totalUnPnl += (tM * roi / 100);
    });

    // Avail = Ví - Ký quỹ + PnL tổng (âm hay dương đều tính vào)
    let avail = walletBal - usedMargin + totalUnPnl;

    return { 
        walletBal: Number(walletBal.toFixed(2)), 
        avail: Number(avail.toFixed(2)), 
        equity: Number((walletBal + totalUnPnl).toFixed(2)) 
    };
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2)) || 0;
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        if (!botConfig.running) return;
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
                const diff = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const roi = (pending.type === 'LONG' ? diff : -diff) * (pending.maxLev || 20);
                if (roi < (pending.maxNegativeRoi || 0)) pending.maxNegativeRoi = roi;
                if ((pending.type === 'LONG' ? diff >= pending.tpTarget : diff <= -pending.tpTarget)) {
                    pending.status = 'WIN'; pending.endTime = now; pending.pnlPercent = (pending.type === 'LONG' ? diff : -diff);
                    lastTradeClosed[s] = now; fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol) {
                const st = calculateState();
                // Chỉ mở lệnh khi Avail đủ để ký quỹ tối thiểu (VD: 1 USDT)
                if (st.avail > 1 && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                    let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
                    if (botConfig.mode === 'REVERSE') type = type === 'LONG' ? 'SHORT' : 'LONG';
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING',
                        maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl,
                        snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0, marginVal: botConfig.marginVal, availAtStart: st.avail
                    });
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    botConfig = { ...botConfig, ...req.query, running: req.query.running === 'true' };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig));
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    res.json({ pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'), history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING'), botConfig, state: calculateState(), allPrices: Object.fromEntries(Object.entries(coinData).map(([s,v]) => [s, v.live?.currentPrice || 0])) });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; padding: 6px; border-radius: 4px; font-size: 12px; width: 100%; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-2 mb-4 bg-card p-3 rounded-lg">
            <input id="balanceInp" placeholder="Vốn đầu (VD: 1000)"><input id="marginInp" placeholder="Margin (VD: 10%)">
            <input id="tpInp" placeholder="TP %"><input id="slInp" placeholder="DCA %"><input id="volInp" placeholder="Vol biến động"><select id="modeInp"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] text-black py-2 rounded font-bold text-xs uppercase">Start Engine</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-2">
            <div><div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div><div id="cfgLine" class="text-[10px] text-gray-500 font-bold uppercase"></div></div>
            <button onclick="save(false)" class="text-[#fcd535] border border-[#fcd535] px-4 py-1 rounded text-[10px] font-bold uppercase">Stop Bot</button>
        </div>
        <div class="flex justify-between items-end">
            <div><div class="text-[10px] text-gray-500 font-bold mb-1 uppercase tracking-widest">Equity (Balance + PnL)</div><div id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</div><div class="text-[11px] font-bold text-blue-400 mt-1 uppercase">Khả dụng (Avail): <span id="displayAvail">0.00</span> USDT</div></div>
            <div class="text-right"><div class="text-[10px] text-gray-500 font-bold uppercase">PnL Live</div><div id="unPnl" class="text-2xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-4"><div class="bg-card rounded-lg p-3 h-[180px] shadow-inner"><canvas id="mainChart"></canvas></div></div>

    <div class="p-4 space-y-4">
        <div class="bg-card p-4 rounded-xl shadow-lg overflow-x-auto">
            <div class="text-[11px] font-bold text-white uppercase mb-3 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
            <table class="w-full text-[11px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase text-[10px]"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>
        <div class="bg-card p-4 rounded-xl shadow-lg overflow-x-auto">
            <div class="text-[11px] font-bold text-gray-500 uppercase mb-3 italic">Nhật ký giao dịch</div>
            <table class="w-full text-[10px] text-left border-collapse">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>SnapVol</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Balance | Avail</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let chart, isFirst = true;
    function save(s) { const q = new URLSearchParams({ running: s, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }); fetch('/api/config?'+q).then(()=>location.reload()); }
    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); const st = d.state; const cfg = d.botConfig;
            if(isFirst){ 
                document.getElementById('balanceInp').value=cfg.initialBal; document.getElementById('marginInp').value=cfg.marginVal; 
                document.getElementById('tpInp').value=cfg.tp; document.getElementById('slInp').value=cfg.sl; 
                document.getElementById('volInp').value=cfg.vol; document.getElementById('modeInp').value=cfg.mode; 
                if(cfg.running){document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');} 
                isFirst=false; 
            }
            document.getElementById('displayBal').innerText = st.equity.toFixed(2); 
            document.getElementById('displayAvail').innerText = st.avail.toFixed(2);
            document.getElementById('cfgLine').innerText = \`TP: \${cfg.tp}% | DCA: \${cfg.sl}% | Vol: \${cfg.vol}% | Mode: \${cfg.mode} | Margin: \${cfg.marginVal}\`;
            let lpnl = st.equity - st.walletBal; document.getElementById('unPnl').innerText = lpnl.toFixed(2); document.getElementById('unPnl').className = 'text-2xl font-bold ' + (lpnl>=0?'up':'down');
            
            let rB = Number(cfg.initialBal), labels = ['Start'], dBal = [rB], dAvail = [rB];
            const hD = d.history.sort((a,b)=>a.endTime-b.endTime);
            
            document.getElementById('historyBody').innerHTML = hD.map((h, i) => {
                let m = String(h.marginVal).includes('%') ? (Number(h.availAtStart || cfg.initialBal)*parseFloat(h.marginVal)/100) : parseFloat(h.marginVal);
                let tM = m * (Number(h.dcaCount||0) + 1);
                let pnl = (tM * (h.maxLev||20) * (Number(h.pnlPercent||0)/100)) - (tM * (h.maxLev||20) * 0.001);
                rB += pnl; labels.push(""); dBal.push(rB); dAvail.push(st.avail);
                return \`<tr class="border-b border-zinc-800/30"><td>\${hD.length-i}</td><td class="text-[8px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.snapVol.c1}/\${h.snapVol.c5}</td><td class="down font-bold">\${Number(h.maxNegativeRoi||0).toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right font-bold">\${rB.toFixed(1)} | <span class="text-blue-400">\${(rB - tM).toFixed(1)}</span></td></tr>\`;
            }).reverse().join('');

            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let m = String(h.marginVal).includes('%') ? (Number(h.availAtStart || st.walletBal)*parseFloat(h.marginVal)/100) : parseFloat(h.marginVal);
                let tM = m * (h.dcaCount + 1);
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
                return \`<tr class="border-b border-zinc-800"><td><b>\${h.symbol}</b> <span class="px-1 \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded text-[9px]">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td>\${h.avgPrice.toFixed(4)}<br><b class="text-white">\${lp.toFixed(4)}</b></td><td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            if(!chart){ const ctx = document.getElementById('mainChart').getContext('2d'); chart = new Chart(ctx, { type: 'line', data: { labels, datasets: [{ label: 'Bal', data: dBal, borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }, { label: 'Avail', data: dAvail, borderColor: '#3b82f6', borderWidth: 1, pointRadius: 0 }] }, options: { maintainAspectRatio: false, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } } }); } else { chart.data.labels = labels; chart.data.datasets[0].data = dBal; chart.data.datasets[1].data = dAvail; chart.update('none'); }
        } catch(e) {}
    }
    setInterval(update, 1000);
    initWS();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Bot Luffy Pro Ready: http://localhost:${PORT}/gui`); });
