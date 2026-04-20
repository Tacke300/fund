const PORT = 7001;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const CONFIG_FILE = './bot_config.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let botConfig = {
    initialBal: 1000,
    marginVal: "10%",
    tp: 0.5,
    sl: 10.0,
    vol: 6.5,
    mode: 'FOLLOW',
    running: false
};

if (fs.existsSync(CONFIG_FILE)) { try { botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) }; } catch(e){} }
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

// --- LOGIC TÍNH TOÁN CORE ---
function calculateState() {
    let walletBal = botConfig.initialBal;
    const all = Array.from(historyMap.values());
    const hist = all.filter(h => h.status !== 'PENDING').sort((a,b) => a.endTime - b.endTime);
    const pending = all.filter(h => h.status === 'PENDING');

    // 1. Tính Wallet Balance thực tế từ lịch sử
    hist.forEach(h => {
        let mBase = botConfig.marginVal.includes('%') ? (h.walletAtStart * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = mBase * (h.dcaCount + 1);
        let pnl = (tM * (h.maxLev || 20) * (h.pnlPercent/100)) - (tM * (h.maxLev || 20) * 0.001);
        walletBal += pnl;
    });

    // 2. Tính Margin và PnL đang treo
    let usedMargin = 0;
    let unPnlAm = 0;
    let totalUnPnl = 0;

    pending.forEach(h => {
        let lp = coinData[h.symbol]?.live?.currentPrice || h.avgPrice;
        let mBase = botConfig.marginVal.includes('%') ? (h.walletAtStart * parseFloat(botConfig.marginVal) / 100) : parseFloat(botConfig.marginVal);
        let tM = mBase * (h.dcaCount + 1);
        let roi = (h.type === 'LONG' ? (lp - h.avgPrice) / h.avgPrice : (h.avgPrice - lp) / h.avgPrice) * 100 * (h.maxLev || 20);
        let pnl = (tM * roi / 100);
        
        usedMargin += tM;
        totalUnPnl += pnl;
        if (pnl < 0) unPnlAm += Math.abs(pnl);
    });

    // Avail = Ví - Margin đang giữ - PnL đang lỗ
    let avail = walletBal - usedMargin - unPnlAm;
    return { walletBal, avail, equity: walletBal + totalUnPnl, usedMargin };
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        if (!botConfig.running) return;
        const tickers = JSON.parse(data);
        const now = Date.now();
        const allPositions = Array.from(historyMap.values()).filter(h => h.status === 'PENDING');

        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = allPositions.find(h => h.symbol === s);
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const roi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || roi < pending.maxNegativeRoi) pending.maxNegativeRoi = roi;

                if ((pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget) || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botConfig.vol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                const state = calculateState();
                // CHỈ MỞ LỆNH NẾU AVAIL > 0
                if (state.avail > (state.walletBal * 0.01)) { 
                    let type = (c1+c5+c15) >= 0 ? 'LONG' : 'SHORT';
                    if (botConfig.mode === 'REVERSE') type = type === 'LONG' ? 'SHORT' : 'LONG';
                    
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING',
                        maxLev: symbolMaxLeverage[s] || 20, tpTarget: botConfig.tp, slTarget: botConfig.sl,
                        snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0,
                        walletAtStart: state.walletBal, availAtStart: state.avail // Lưu lại để tính margin chính xác
                    });
                }
            }
        });
    });
}

app.get('/api/config', (req, res) => {
    botConfig = { ...botConfig, ...req.query, running: req.query.running === 'true' };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig));
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const state = calculateState();
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING'),
        botConfig, state
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans'; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; } .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input, select { background: #0b0e11; border: 1px solid #30363d; color: white; padding: 6px; border-radius: 4px; font-size: 12px; }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-500 font-bold">VỐN KHỞI TẠO ($)</label><input id="balanceInp" type="number" class="w-full text-yellow-500 font-bold outline-none"></div>
            <div><label class="text-[10px] text-gray-500 font-bold">MARGIN (DÙNG % AVAIL)</label><input id="marginInp" type="text" class="w-full text-yellow-500 font-bold outline-none"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-2 mt-1">
                <div><label class="text-[10px] text-gray-500">TP (%)</label><input id="tpInp" type="number" step="0.1" class="w-full"></div>
                <div><label class="text-[10px] text-gray-500">DCA (%)</label><input id="slInp" type="number" step="0.1" class="w-full"></div>
                <div><label class="text-[10px] text-gray-500">VOL (%)</label><input id="volInp" type="number" step="0.1" class="w-full"></div>
                <div><label class="text-[10px] text-gray-500">MODE</label><select id="modeInp" class="w-full"><option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option></select></div>
            </div>
            <button onclick="save(true)" class="col-span-2 bg-[#fcd535] text-black font-bold py-2 rounded uppercase text-xs mt-1">START ENGINE</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-2">
            <div>
                <div class="font-bold italic text-xl">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
                <div id="configDisplay" class="text-[10px] text-gray-400 font-bold mt-1 uppercase tracking-tighter"></div>
            </div>
            <button onclick="save(false)" class="text-[#fcd535] font-bold border border-[#fcd535] px-3 py-1 rounded text-[10px] uppercase">STOP ENGINE</button>
        </div>

        <div class="flex justify-between items-end mb-1">
            <div>
                <div class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Equity (Wallet + UnPnL)</div>
                <div id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</div>
                <div id="displayAvail" class="text-blue-400 text-[11px] font-bold uppercase mt-1 tracking-wider"></div>
            </div>
            <div class="text-right">
                <div class="text-[10px] text-gray-500 font-bold uppercase">PnL Live</div>
                <div id="unPnl" class="text-2xl font-bold">0.00</div>
            </div>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="bg-card p-4 rounded-xl h-[220px] border border-zinc-800 shadow-lg relative">
            <div class="absolute top-2 right-4 flex gap-4 text-[10px] font-bold uppercase">
                <span class="flex items-center"><span class="w-2 h-2 bg-[#fcd535] rounded-full mr-1"></span> Wallet</span>
                <span class="flex items-center"><span class="w-2 h-2 bg-blue-500 rounded-full mr-1"></span> Avail</span>
            </div>
            <canvas id="balanceChart"></canvas>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="bg-card p-4 rounded-xl border border-zinc-800 shadow-sm">
            <div class="text-[11px] font-bold mb-3 uppercase italic text-white flex items-center">
                <span class="w-1 h-3 bg-[#fcd535] mr-2"></span> Vị thế đang mở
            </div>
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase">
                    <tr><th>Pair/SnapVol</th><th>DCA</th><th>Margin</th><th>Snap/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr>
                </thead>
                <tbody id="pendingBody"></tbody>
            </table></div>
        </div>
    </div>

    <div class="px-4 mt-4 mb-10">
        <div class="bg-card p-4 rounded-xl border border-zinc-800 shadow-sm">
            <div class="text-[11px] font-bold mb-3 uppercase italic text-gray-400">Nhật ký giao dịch</div>
            <div class="overflow-x-auto"><table class="w-full text-[9px] text-left">
                <thead class="text-gray-500 border-b border-zinc-800 uppercase">
                    <tr><th>Time In-Out</th><th>Pair</th><th>DCA</th><th>Margin</th><th>MaxDD</th><th>PnL Net</th><th class="text-right">Wallet | Avail</th></tr>
                </thead>
                <tbody id="historyBody"></tbody>
            </table></div>
        </div>
    </div>

    <script>
    let myChart = null, isFirst = true;
    function fPrice(p) { if (!p || p === 0) return "0.0000"; let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/); if (!match) return parseFloat(p).toFixed(4); let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3); }
    
    function save(s) { const q = new URLSearchParams({ running: s, initialBal: document.getElementById('balanceInp').value, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }); fetch('/api/config?'+q).then(()=>location.reload()); }
    
    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const config = d.botConfig; const st = d.state;
            
            if(isFirst) {
                document.getElementById('balanceInp').value = config.initialBal; document.getElementById('marginInp').value = config.marginVal;
                document.getElementById('tpInp').value = config.tp; document.getElementById('slInp').value = config.sl;
                document.getElementById('volInp').value = config.vol; document.getElementById('modeInp').value = config.mode;
                document.getElementById('configDisplay').innerText = \`TP: \${config.tp}% | DCA: \${config.sl}% | VOL: \${config.vol}% | MODE: \${config.mode} | MARGIN: \${config.marginVal}\`;
                if(config.running){ document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
                isFirst = false;
            }

            document.getElementById('displayBal').innerText = st.equity.toFixed(2);
            document.getElementById('displayAvail').innerText = 'Số dư khả dụng (Avail): ' + st.avail.toFixed(2) + ' USDT';
            document.getElementById('unPnl').innerText = (st.equity - st.walletBal).toFixed(2);
            document.getElementById('unPnl').className = 'text-2xl font-bold ' + (st.equity >= st.walletBal ? 'up':'down');

            let rB = config.initialBal, cW = [rB], cA = [rB], cL = ['Start'];
            let histHTML = d.history.sort((a,b)=>a.endTime-b.endTime).map(h => {
                let m = config.marginVal.includes('%') ? (h.walletAtStart * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
                let tM = m * (h.dcaCount + 1);
                let pnl = (tM * (h.maxLev||20) * (h.pnlPercent/100)) - (tM * (h.maxLev||20) * 0.001);
                rB += pnl; 
                // Avail lịch sử: tạm tính = wallet (vì lúc đó ko có lệnh treo khác)
                cW.push(rB); cA.push(rB); cL.push("");
                return \`<tr class="border-b border-zinc-800/30">
                    <td class="text-[8px]">\${new Date(h.startTime).toLocaleTimeString()}<br>\${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td><b>\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'}">\${h.type}</span></td>
                    <td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td>
                    <td class="down font-bold">\${h.maxNegativeRoi?.toFixed(1) || 0}%</td>
                    <td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td>
                    <td class="text-right font-bold text-white">\${rB.toFixed(1)} | <span class="text-blue-400">\${rB.toFixed(1)}</span></td>
                </tr>\`;
            }).reverse().join('');
            document.getElementById('historyBody').innerHTML = histHTML;

            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let m = config.marginVal.includes('%') ? (h.walletAtStart * parseFloat(config.marginVal)/100) : parseFloat(config.marginVal);
                let tM = m * (h.dcaCount + 1);
                let roi = (h.type==='LONG'?(lp-h.avgPrice)/h.avgPrice:(h.avgPrice-lp)/h.avgPrice)*100*(h.maxLev||20);
                let sv = h.snapVol || {c1:0,c5:0,c15:0};
                return \`<tr class="border-b border-zinc-800 \${h.dcaCount >= 5 ? 'recovery-row' : ''}">
                    <td><b>\${h.symbol}</b> <span class="px-1 \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded text-[8px]">\${h.type}</span><div class="text-[8px] text-gray-500">\${sv.c1}/\${sv.c5}/\${sv.c15}</div></td>
                    <td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td>
                    <td>\${fPrice(h.snapPrice)}<br><b class="text-white">\${fPrice(lp)}</b></td>
                    <td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td>
                    <td class="text-right font-bold \${roi>=0?'up':'down'}">\${(tM*roi/100).toFixed(2)}<br>\${roi.toFixed(1)}%</td>
                </tr>\`;
            }).join('');

            if(myChart){ 
                // Điểm cuối cùng là realtime
                cW.push(st.walletBal); cA.push(st.avail); cL.push("Now");
                myChart.data.labels = cL; 
                myChart.data.datasets[0].data = cW; 
                myChart.data.datasets[1].data = cA; 
                myChart.update('none'); 
            }
        } catch(e) {}
    }

    const ctx = document.getElementById('balanceChart').getContext('2d');
    myChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [
        { label: 'Wallet', data: [], borderColor: '#fcd535', borderWidth: 2, pointRadius: 0, fill: false },
        { label: 'Avail', data: [], borderColor: '#3b82f6', borderWidth: 1.5, pointRadius: 0, fill: false, borderDash: [5,5] }
    ]}, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } } });
    
    setInterval(update, 1000);
    initWS();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Bot running: http://localhost:${PORT}/gui`));
