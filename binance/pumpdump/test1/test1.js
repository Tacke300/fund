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

// Biến trạng thái cầu chì
let breakerStatus = { active: false, stopTime: null, resumeTime: null };

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

function calculateState() {
    let walletBal = parseFloat(botConfig.initialBal) || 0;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    hist.forEach(h => {
        let base = parseFloat(h.walletAtStart) || botConfig.initialBal;
        let mVal = parseFloat(botConfig.marginVal) || 0;
        let m = botConfig.marginVal.toString().includes('%') ? (base * mVal / 100) : mVal;
        let tM = m * ((h.dcaCount || 0) + 1);
        let pnl = (tM * (h.maxLev || 20) * ((h.pnlPercent || 0)/100)) - (tM * (h.maxLev || 20) * 0.001);
        walletBal += (pnl || 0);
    });

    let usedMargin = 0, unPnlAm = 0, totalUnPnl = 0;
    pending.forEach(h => {
        let lp = coinData[h.symbol]?.live?.currentPrice || h.avgPrice || 0;
        let mVal = parseFloat(botConfig.marginVal) || 0;
        let m = botConfig.marginVal.toString().includes('%') ? (h.walletAtStart * mVal / 100) : mVal;
        let tM = m * ((h.dcaCount || 0) + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / (h.avgPrice || 1) : (h.avgPrice - lp) / (h.avgPrice || 1)) * 100 * (h.maxLev || 20);
        let pnl = (tM * (roi || 0) / 100);
        usedMargin += tM;
        totalUnPnl += pnl;
        if (pnl < 0) unPnlAm += Math.abs(pnl);
    });

    const avail = walletBal - usedMargin - unPnlAm;
    const marginUsagePercent = walletBal > 0 ? (usedMargin / walletBal) * 100 : 0;

    // LOGIC CẦU CHÌ: Tự động ngắt/mở dựa trên % Margin sử dụng
    if (!breakerStatus.active && marginUsagePercent >= 50) {
        breakerStatus.active = true;
        breakerStatus.stopTime = new Date().toLocaleTimeString();
        breakerStatus.resumeTime = null;
    } else if (breakerStatus.active && marginUsagePercent <= 40) {
        breakerStatus.active = false;
        breakerStatus.resumeTime = new Date().toLocaleTimeString();
    }

    return { walletBal, avail, equity: (walletBal + totalUnPnl), marginUsagePercent };
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

                // VẪN CHO PHÉP DCA & ĐÓNG LỆNH KHI CẦU CHÌ ĐANG BẬT
                if ((pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget)) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol) {
                // CHỈ MỞ LỆNH MỚI NẾU CẦU CHÌ KHÔNG HOẠT ĐỘNG (Margin Usage < 50%)
                if (!breakerStatus.active && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000)) && state.avail > (state.walletBal * 0.02)) {
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
        botConfig, state: calculateState(), breaker: breakerStatus
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Pro - Breaker</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .breaker-active { border: 2px solid #f6465d !important; background: rgba(246, 70, 93, 0.1) !important; }
        input { background: #0b0e11; border: 1px solid #30363d; color: white; padding: 4px; border-radius: 4px; font-size: 11px; }
    </style></head><body>
    
    <div class="p-4 sticky top-0 bg-[#0b0e11] border-b border-zinc-800 z-50">
        <div id="breakerNotify" class="hidden mb-3 p-2 rounded text-[10px] font-bold flex justify-between items-center">
            <span id="breakerText">⚠️ TẠM DỪNG MỞ LỆNH MỚI (MARGIN > 50%)</span>
            <span id="breakerTime" class="opacity-70"></span>
        </div>

        <div id="setup" class="grid grid-cols-2 gap-2 mb-3 bg-card p-2 rounded">
            <input id="balanceInp" placeholder="Vốn"><input id="marginInp" placeholder="Margin%">
            <div class="col-span-2 grid grid-cols-4 gap-1">
                <input id="tpInp" step="0.1" placeholder="TP"><input id="slInp" step="0.1" placeholder="DCA">
                <input id="volInp" step="0.1" placeholder="Vol"><select id="modeInp" class="bg-[#0b0e11] text-white text-[11px]"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] text-black font-bold py-1 rounded text-[10px]">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-2">
            <div class="font-bold italic text-lg text-white tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <button onclick="save(false)" class="text-[#fcd535] border border-[#fcd535] px-2 rounded text-[10px] font-bold">STOP</button>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-[10px] text-gray-500 font-bold uppercase">Equity (Wallet+Live)</div>
                <div id="displayBal" class="text-3xl font-bold tracking-tighter">0.00</div>
                <div class="flex gap-3 mt-1">
                    <div class="text-blue-400 text-[10px] font-bold uppercase">AVAIL: <span id="displayAvail">0.00</span></div>
                    <div class="text-gray-500 text-[10px] font-bold uppercase">MARGIN: <span id="displayMarginUsage">0</span>%</div>
                </div>
            </div>
            <div class="text-right"><div class="text-[10px] text-gray-500 font-bold">PnL Live</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="p-4 space-y-4">
        <div class="bg-card p-3 rounded-lg shadow-lg overflow-x-auto">
            <div class="text-[10px] font-bold text-white uppercase mb-2 flex items-center">
                <span class="w-2 h-2 bg-green-500 rounded-full mr-2"></span> Vị thế đang mở
            </div>
            <table class="w-full text-[10px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Price</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                <tbody id="pendingBody"></tbody>
            </table>
        </div>

        <div class="bg-card p-3 rounded-lg shadow-lg overflow-x-auto">
            <div class="text-[10px] font-bold text-gray-500 uppercase mb-2 italic">Nhật ký giao dịch & Cầu chì</div>
            <table class="w-full text-[9px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Wallet | Avail</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let myChart = null, isFirst = true;
    function fP(p) { return parseFloat(p).toFixed(4); }
    function save(s) { const q = new URLSearchParams({ running: s, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }); fetch('/api/config?'+q).then(()=>location.reload()); }

    async function update() {
        const res = await fetch('/api/data'); const d = await res.json();
        const cfg = d.botConfig; const st = d.state; const brk = d.breaker;

        if(isFirst) {
            document.getElementById('balanceInp').value = cfg.initialBal; document.getElementById('marginInp').value = cfg.marginVal;
            document.getElementById('tpInp').value = cfg.tp; document.getElementById('slInp').value = cfg.sl;
            document.getElementById('volInp').value = cfg.vol; document.getElementById('modeInp').value = cfg.mode;
            if(cfg.running){ document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
            isFirst = false;
        }

        // Update UI Cầu chì
        const notify = document.getElementById('breakerNotify');
        if(brk.active) {
            notify.classList.remove('hidden', 'bg-blue-900'); notify.classList.add('breaker-active', 'text-red-500');
            document.getElementById('breakerText').innerText = "⚠️ CẦU CHÌ BẬT: NGỪNG MỞ LỆNH MỚI (MARGIN > 50%)";
            document.getElementById('breakerTime').innerText = "Dừng lúc: " + brk.stopTime;
        } else if(brk.resumeTime) {
            notify.classList.remove('hidden', 'breaker-active', 'text-red-500'); notify.classList.add('bg-blue-900/30', 'text-blue-400', 'border', 'border-blue-500');
            document.getElementById('breakerText').innerText = "✅ CẦU CHÌ TẮT: ĐÃ KHÔI PHỤC MỞ LỆNH (MARGIN < 40%)";
            document.getElementById('breakerTime').innerText = "Chạy lại lúc: " + brk.resumeTime;
        }

        document.getElementById('displayBal').innerText = st.equity.toFixed(2);
        document.getElementById('displayAvail').innerText = st.avail.toFixed(2);
        document.getElementById('displayMarginUsage').innerText = st.marginUsagePercent.toFixed(1);
        document.getElementById('unPnl').innerText = (st.equity - st.walletBal).toFixed(2);
        document.getElementById('unPnl').className = 'text-xl font-bold ' + (st.equity >= st.walletBal ? 'up':'down');

        let rB = cfg.initialBal;
        const histData = d.history.sort((a,b)=>a.endTime-b.endTime);
        document.getElementById('historyBody').innerHTML = histData.map((h, i) => {
            let m = cfg.marginVal.includes('%') ? (h.walletAtStart * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
            let tM = m * (h.dcaCount + 1);
            let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
            rB += pnl;
            return \`<tr class="border-b border-zinc-800/30"><td>\${i+1}</td><td class="text-[7px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td><td><b>\${h.symbol}</b> \${h.type}</td><td>\${h.dcaCount}</td><td class="down">\${(h.maxNegativeRoi||0).toFixed(1)}%</td><td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td><td class="text-right font-bold">\${rB.toFixed(1)} | <span class="text-blue-400">\${rB.toFixed(1)}</span></td></tr>\`;
        }).reverse().join('');

        document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
            let lp = d.allPrices[h.symbol] || h.avgPrice;
            let m = cfg.marginVal.includes('%') ? (h.walletAtStart * parseFloat(cfg.marginVal)/100) : parseFloat(cfg.marginVal);
            let tM = m * (h.dcaCount + 1);
            let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
            return \`<tr class="border-b border-zinc-800"><td><b>\${h.symbol}</b> \${h.type}</td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="text-yellow-500">\${fP(lp)}</td><td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
        }).join('');
    }

    setInterval(update, 1000);
    initWS();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Bot Breaker 50/40: http://localhost:${PORT}/gui`));
