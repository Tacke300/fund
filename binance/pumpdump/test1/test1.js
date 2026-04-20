const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const BREAKER_FILE = './breaker_logs.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 
let breakerLogs = [];
let breakerStatus = { active: false, stopTime: null, resumeTime: null };

let botConfig = {
    initialBal: 1000, marginVal: "10%", tp: 0.5, sl: 10.0, vol: 6.5, mode: 'FOLLOW', running: false
};

// Load Data
if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(BREAKER_FILE)) { try { breakerLogs = JSON.parse(fs.readFileSync(BREAKER_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

function calculateState() {
    let walletBal = parseFloat(botConfig.initialBal) || 0;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    hist.forEach(h => {
        let base = parseFloat(h.walletAtStart) || botConfig.initialBal;
        let mVal = parseFloat(botConfig.marginVal) || 0;
        let m = botConfig.marginVal.toString().includes('%') ? (base * mVal / 100) : mVal;
        let tM = m * ((parseInt(h.dcaCount) || 0) + 1);
        let pnl = (tM * (h.maxLev || 20) * ((parseFloat(h.pnlPercent) || 0)/100)) - (tM * (h.maxLev || 20) * 0.001);
        walletBal += (pnl || 0);
    });

    let usedMargin = 0, unPnlAm = 0, totalUnPnl = 0;
    pending.forEach(h => {
        let lp = coinData[h.symbol]?.live?.currentPrice || h.avgPrice || 0;
        let mVal = parseFloat(botConfig.marginVal) || 0;
        let m = botConfig.marginVal.toString().includes('%') ? ((parseFloat(h.walletAtStart) || walletBal) * mVal / 100) : mVal;
        let tM = m * ((parseInt(h.dcaCount) || 0) + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / (h.avgPrice || 1) : (h.avgPrice - lp) / (h.avgPrice || 1)) * 100 * (h.maxLev || 20);
        let pnl = (tM * (roi || 0) / 100);
        usedMargin += tM;
        totalUnPnl += pnl;
        if (pnl < 0) unPnlAm += Math.abs(pnl);
    });

    const avail = walletBal - usedMargin - unPnlAm;
    const usage = walletBal > 0 ? (usedMargin / walletBal) * 100 : 0;

    // Logic Cầu chì 50/40
    const nowStr = new Date().toLocaleTimeString('vi-VN');
    if (!breakerStatus.active && usage >= 50) {
        breakerStatus.active = true; breakerStatus.stopTime = nowStr; breakerStatus.resumeTime = null;
        breakerLogs.push({ event: 'STOP', time: new Date().toLocaleString('vi-VN'), usage: usage.toFixed(1) });
        fs.writeFileSync(BREAKER_FILE, JSON.stringify(breakerLogs.slice(-50)));
    } else if (breakerStatus.active && usage <= 40) {
        breakerStatus.active = false; breakerStatus.resumeTime = nowStr;
        breakerLogs.push({ event: 'START', time: new Date().toLocaleString('vi-VN'), usage: usage.toFixed(1) });
        fs.writeFileSync(BREAKER_FILE, JSON.stringify(breakerLogs.slice(-50)));
    }

    return { walletBal, avail, equity: (walletBal + totalUnPnl), usage };
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
        const state = calculateState();

        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const roi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (roi < (pending.maxNegativeRoi || 0)) pending.maxNegativeRoi = roi;
                if ((pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget)) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else if (!breakerStatus.active && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol) {
                if (!(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000)) && state.avail > (state.walletBal * 0.02)) {
                    let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
                    if (botConfig.mode === 'REVERSE') type = type === 'LONG' ? 'SHORT' : 'LONG';
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING',
                        maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl,
                        snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0, walletAtStart: state.walletBal
                    });
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    botConfig = { ...botConfig, ...req.query, running: req.query.running === 'true' };
    botConfig.initialBal = parseFloat(botConfig.initialBal);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig));
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING'),
        botConfig, state: calculateState(), breaker: breakerStatus, breakerLogs
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; padding: 8px; border-radius: 4px; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="brkNotify" class="hidden mb-3 p-2 rounded text-[10px] font-bold flex justify-between items-center border"></div>

        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade (%)</label><input id="marginInp" type="text" class="w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="w-full text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Chế độ</label><select id="modeInp" class="w-full text-sm"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select></div>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div><div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div><div id="configDisplay" class="text-[10px] text-gray-custom font-bold uppercase mt-1 tracking-tighter"></div></div>
            <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer uppercase" onclick="save(false)">STOP ENGINE</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div>
                <div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Vốn + PnL Live)</div>
                <span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span>
                <div class="flex gap-4 mt-1">
                    <div class="text-[11px] text-blue-400 font-bold uppercase">Avail: <span id="displayAvail">0.00</span></div>
                    <div class="text-[11px] text-gray-500 font-bold uppercase">Margin: <span id="displayUsage">0</span>%</div>
                </div>
            </div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg overflow-x-auto">
        <div class="text-[11px] font-bold text-white uppercase tracking-wider mb-3 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
        <table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>STT</th><th>Time</th><th>Pair</th><th>DCA</th><th>Margin</th><th class="text-center">Lev</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table>
    </div></div>

    <div class="px-4 mt-5 mb-10 grid grid-cols-1 md:grid-cols-3 gap-5">
        <div class="md:col-span-2 bg-card rounded-xl p-4 shadow-lg overflow-x-auto">
            <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch (Full History)</div>
            <table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>SnapVol</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Wallet | Avail</th></tr></thead><tbody id="historyBody"></tbody></table>
        </div>
        <div class="bg-card rounded-xl p-4 shadow-lg overflow-x-auto border-l-2 border-red-900/50">
            <div class="text-[11px] font-bold text-red-500 mb-3 uppercase tracking-wider italic">Nhật ký Cầu chì (Breaker Logs)</div>
            <table class="w-full text-[8px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>Event</th><th>Time</th><th>Usage</th></tr></thead><tbody id="breakerBody"></tbody></table>
        </div>
    </div>

    <script>
    let isFirst = true;
    function fPrice(p) { return p ? parseFloat(p).toFixed(4) : "0.0000"; }
    function save(status) { const q = new URLSearchParams({ running: status, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }); fetch('/api/config?' + q.toString()).then(() => location.reload()); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const config = d.botConfig; const st = d.state; const brk = d.breaker;

            if(isFirst) {
                document.getElementById('balanceInp').value = config.initialBal; document.getElementById('marginInp').value = config.marginVal;
                document.getElementById('tpInp').value = config.tp; document.getElementById('slInp').value = config.sl;
                document.getElementById('volInp').value = config.vol; document.getElementById('modeInp').value = config.mode;
                document.getElementById('configDisplay').innerText = \`TP: \${config.tp}% | DCA: \${config.sl}% | VOL: \${config.vol}% | MODE: \${config.mode}\`;
                if(config.running) { document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
                isFirst = false;
            }

            // Breaker Notify UI
            const notify = document.getElementById('brkNotify');
            if(brk.active) {
                notify.classList.remove('hidden'); notify.className = "mb-3 p-2 rounded text-[10px] font-bold flex justify-between items-center bg-red-900/20 text-red-500 border-red-500/50 border";
                notify.innerHTML = \`<span>⚠️ CẦU CHÌ BẬT: NGỪNG MỞ LỆNH MỚI (MARGIN > 50%)</span><span>\${brk.stopTime}</span>\`;
            } else if(brk.resumeTime) {
                notify.classList.remove('hidden'); notify.className = "mb-3 p-2 rounded text-[10px] font-bold flex justify-between items-center bg-green-900/20 text-green-500 border-green-500/50 border";
                notify.innerHTML = \`<span>✅ CẦU CHÌ TẮT: ĐÃ KHÔI PHỤC CHẠY (MARGIN < 40%)</span><span>\${brk.resumeTime}</span>\`;
            }

            document.getElementById('displayBal').innerText = (st.equity || 0).toFixed(2);
            document.getElementById('displayAvail').innerText = (st.avail || 0).toFixed(2);
            document.getElementById('displayUsage').innerText = (st.usage || 0).toFixed(1);
            let lpPnl = (st.equity - st.walletBal) || 0;
            document.getElementById('unPnl').innerText = lpPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (lpPnl >= 0 ? 'up':'down');

            let rB = config.initialBal;
            const hData = d.history.sort((a,b)=>a.endTime-b.endTime);
            document.getElementById('historyBody').innerHTML = hData.map((h, i) => {
                let m = config.marginVal.toString().includes('%') ? (h.walletAtStart * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
                let tM = m * ((h.dcaCount||0) + 1);
                let pnl = (tM * (h.maxLev||20) * ((h.pnlPercent||0)/100)) - (tM * (h.maxLev||20) * 0.001);
                rB += (pnl || 0);
                let sv = h.snapVol || {c1:0,c5:0,c15:0};
                return \`<tr class="border-b border-zinc-800/30"><td>\${i+1}</td><td class="text-[7px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="down font-bold">\${(h.maxNegativeRoi||0).toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right font-bold">\${rB.toFixed(1)} | <span class="text-blue-400">\${rB.toFixed(1)}</span></td></tr>\`;
            }).reverse().join('');

            document.getElementById('pendingBody').innerHTML = d.pending.map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice || 0;
                let m = config.marginVal.toString().includes('%') ? (h.walletAtStart * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
                let tM = m * ((h.dcaCount||0) + 1);
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/(h.avgPrice||1):(h.avgPrice-lp)/(h.avgPrice||1))*100*(h.maxLev||20);
                return \`<tr class="border-b border-zinc-800"><td>\${idx+1}</td><td class="text-[8px]">\${new Date(h.startTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="text-center">\${h.maxLev}x</td><td>\${fPrice(h.snapPrice)}<br><b class="text-white">\${fPrice(lp)}</b></td><td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td><td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            document.getElementById('breakerBody').innerHTML = d.breakerLogs.map(l => \`<tr class="border-b border-zinc-800/30"><td class="\${l.event==='STOP'?'down':'up'} font-bold">\${l.event}</td><td>\${l.time}</td><td>\${l.usage}%</td></tr>\`).reverse().join('');
        } catch(e) {}
    }
    setInterval(update, 1000);
    initWS();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Bot Luffy Original: http://localhost:${PORT}/gui`));
