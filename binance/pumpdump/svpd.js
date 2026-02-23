import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let systemLogs = [];

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    systemLogs.unshift(`[${time}] ${msg}`);
    if (systemLogs.length > 8) systemLogs.pop();
}

// --- HÀM LẤY MAX LEV (CÓ TIMEOUT & RETRY) ---
async function fetchActualLeverage() {
    addLog("Đang kết nối API Binance...");
    const options = {
        hostname: 'fapi.binance.com',
        path: '/fapi/v1/leverageBracket',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000 // 5 giây không phản hồi là ngắt để thử lại
    };

    const req = https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                if (Array.isArray(brackets)) {
                    const newMap = {};
                    brackets.forEach(item => {
                        if (item.symbol && item.brackets?.length > 0) {
                            newMap[item.symbol] = item.brackets[0].initialLeverage;
                        }
                    });
                    symbolMaxLeverage = newMap;
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(newMap));
                    addLog(`Nạp MaxLev thành công: ${Object.keys(newMap).length} mã.`);
                }
            } catch (e) { 
                addLog("Lỗi parse dữ liệu sàn. Thử lại sau 10s..."); 
                setTimeout(fetchActualLeverage, 10000);
            }
        });
    });

    req.on('error', (e) => {
        addLog(`Lỗi kết nối: ${e.message}. Đang thử lại...`);
        setTimeout(fetchActualLeverage, 5000);
    });
    req.on('timeout', () => { req.destroy(); });
}

// Khởi động
if (fs.existsSync(LEVERAGE_FILE)) {
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch (e) {}
}
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    return startPriceObj ? parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2)) : 0;
}

function initWS() {
    fetchActualLeverage();
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            const now = Date.now();
            tickers.forEach(t => {
                const s = t.s, p = parseFloat(t.c);
                if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastStatusTime: 0 };
                coinData[s].prices.push({ p, t: now });
                if (coinData[s].prices.length > 100) coinData[s].prices = coinData[s].prices.slice(-100);

                const c1 = calculateChange(coinData[s].prices, 1), 
                      c5 = calculateChange(coinData[s].prices, 5), 
                      c15 = calculateChange(coinData[s].prices, 15);
                coinData[s].live = { c1, c5, c15, currentPrice: p };

                const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
                if (pending) {
                    const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                    const win = pending.type === 'DOWN' ? diff <= -5 : diff >= 5;
                    const lose = pending.type === 'DOWN' ? diff >= 5 : diff <= -5;
                    if (win || lose) {
                        pending.status = win ? 'WIN' : 'LOSE';
                        pending.finalPrice = p; pending.endTime = now; pending.needSound = pending.status;
                        coinData[s].lastStatusTime = now;
                        fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                    }
                }

                if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                    if (!pending && (now - coinData[s].lastStatusTime >= 900000)) {
                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: now, snapVol: { c1, c5, c15 }, 
                            snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                            status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || NaN 
                        });
                    }
                }
            });
        } catch (e) {}
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,50),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.sort((a,b)=>b.startTime-a.startTime),
        logs: systemLogs
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BINANCE PRO V2.4.5</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #2b3139; }
        .btn-binance { background: #2b3139; color: #eaecef; font-size: 10px; padding: 6px; border-radius: 4px; text-align: center; }
        .filter-btn { background: #2b3139; padding: 2px 10px; border-radius: 4px; font-size: 10px; cursor: pointer; border: 1px solid transparent; }
        .filter-btn.active { border-color: #fcd535; color: #fcd535; }
    </style></head><body class="p-4">
    
    <div class="flex justify-between items-center mb-4">
        <div class="flex items-center gap-2">
            <img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-6 h-6">
            <h1 class="text-xl font-bold uppercase text-white tracking-tighter">BINANCE <span class="text-[#fcd535]">PRO</span></h1>
            <span class="text-[#fcd535] ml-4 font-black italic">Moncey_D_Luffy</span>
        </div>
        <div id="setup" class="flex gap-2">
            <input id="balanceInp" type="number" value="1000" class="bg-[#1e2329] border border-zinc-700 p-1 rounded w-24 text-[#fcd535] text-xs">
            <input id="marginInp" type="text" value="10%" class="bg-[#1e2329] border border-zinc-700 p-1 rounded w-20 text-[#fcd535] text-xs">
            <button onclick="start()" class="bg-[#fcd535] text-black px-4 py-1 rounded font-bold uppercase text-xs">Start</button>
        </div>
    </div>

    <div class="grid grid-cols-12 gap-4 mb-4">
        <div class="col-span-12 lg:col-span-9 bg-card p-4 rounded-lg">
            <div class="flex justify-between items-start mb-2">
                <div><div class="text-zinc-500 text-[10px] uppercase font-bold">Total Equity</div><div id="displayBal" class="text-4xl font-bold text-white italic">$0.00</div></div>
                <div class="flex flex-col items-end gap-2">
                    <div class="flex gap-1">
                        <div id="f24" class="filter-btn active" onclick="setFilter(24)">24H</div>
                        <div id="f7" class="filter-btn" onclick="setFilter(168)">7D</div>
                        <div id="f30" class="filter-btn" onclick="setFilter(720)">30D</div>
                    </div>
                    <div class="flex gap-2 text-[9px] font-bold text-center">
                        <div class="bg-[#2b3139] p-2 rounded w-20"><div>TODAY</div><div id="stat24" class="text-zinc-400 mt-1">---</div></div>
                        <div class="bg-[#2b3139] p-2 rounded w-20"><div>7 DAYS</div><div id="stat7" class="text-zinc-400 mt-1">---</div></div>
                    </div>
                </div>
            </div>
            <div style="height: 180px;"><canvas id="mainChart"></canvas></div>
        </div>
        <div class="col-span-12 lg:col-span-3 bg-card rounded-lg p-3">
            <div class="text-[10px] font-bold text-[#fcd535] mb-2 uppercase border-b border-zinc-800 pb-1">System Operation</div>
            <div id="logContainer" class="text-[9px] font-mono text-zinc-500 space-y-1"></div>
        </div>
    </div>

    <div class="mb-4"><div class="text-xs font-bold border-b border-zinc-800 pb-1 uppercase italic mb-3 text-zinc-500">Vị thế đang mở</div><div id="pendingContainer" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div></div>

    <div class="grid grid-cols-12 gap-4">
        <div class="col-span-4 bg-card rounded-lg h-[350px] flex flex-col">
            <div class="p-2 bg-[#2b3139] font-bold text-[10px] uppercase">Volatility (1|5|15)</div>
            <div class="overflow-y-auto flex-1 text-[10px]"><table class="w-full text-left"><tbody id="liveBody"></tbody></table></div>
        </div>
        <div class="col-span-8 bg-card rounded-lg h-[350px] flex flex-col italic">
            <div class="p-2 bg-[#2b3139] font-bold text-[10px] uppercase text-[#fcd535]">Real-time History Log</div>
            <div class="overflow-y-auto flex-1 font-mono text-[10px]"><table class="w-full text-left"><thead class="text-zinc-500 sticky top-0 bg-[#1e2329] border-b border-zinc-800"><tr><th class="p-2">TIME</th><th class="p-2">COIN/LEV</th><th class="p-2">VOL</th><th class="p-2 text-right">PNL</th><th class="p-2 text-right">STATUS</th></tr></thead><tbody id="historyBody"></tbody></table></div>
        </div>
    </div>

    <script>
    let running = false, currentBal = 0, initialBal = 0, historyLog = [], filterHours = 24;
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');

    if(localStorage.getItem('bot_luffy_v3')) {
        const s = JSON.parse(localStorage.getItem('bot_luffy_v3'));
        running = s.running; initialBal = s.initialBal; currentBal = s.currentBal; historyLog = s.historyLog || [];
        if(running) document.getElementById('setup').style.display='none';
    }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }]},
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#2b3139' } } } }
    });

    function setFilter(h) { 
        filterHours = h; 
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('f'+(h==24?'24':h==168?'7':'30')).classList.add('active');
    }

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); currentBal = initialBal; historyLog = [{t: Date.now(), b: initialBal}]; document.getElementById('setup').style.display='none'; save(); }
    function save() { localStorage.setItem('bot_luffy_v3', JSON.stringify({ running, initialBal, currentBal, historyLog })); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            
            document.getElementById('logContainer').innerHTML = d.logs.map(l => \`<div>\${l}</div>\`).join('');
            document.getElementById('liveBody').innerHTML = d.live.map(c => \`
                <tr class="border-b border-[#2b3139]"><td class="p-2 font-bold text-white">\${c.symbol}</td><td class="\${c.c1>=0?'up':'down'} p-2">\${c.c1}%</td><td class="\${c.c5>=0?'up':'down'} p-2">\${c.c5}%</td><td class="\${c.c15>=0?'up':'down'} p-2 text-right">\${c.c15}%</td></tr>\`).join('');

            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                const livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                const mVal = document.getElementById('marginInp').value;
                const margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                const roi = (h.type === 'UP' ? ((livePrice - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - livePrice)/h.snapPrice)*100) * h.maxLev;
                const pnl = margin * roi / 100;

                return \`
                <div class="bg-card p-3 rounded border-l-4 \${h.type==='UP'?'border-[#0ecb81]':'border-[#f6465d]'}">
                    <div class="flex justify-between items-center mb-1"><span class="font-bold text-[11px]">\${h.symbol} <span class="text-zinc-500 font-normal">Cross \${h.maxLev || 'NaN'}X</span></span></div>
                    <div class="flex justify-between text-xs font-bold \${pnl>=0?'up':'down'}"><span>\${pnl.toFixed(2)} USDT</span><span>\${roi.toFixed(2)}%</span></div>
                    <div class="grid grid-cols-2 text-[9px] text-zinc-500 mt-2"><div>Entry: \${h.snapPrice.toFixed(4)}</div><div class="text-right">Mark: \${livePrice.toFixed(4)}</div></div>
                    <div class="grid grid-cols-3 gap-1 mt-2 text-[8px] uppercase font-bold"><div class="btn-binance">TP/SL</div><div class="btn-binance">Đóng</div><div class="btn-binance">Share</div></div>
                </div>\`;
            }).join('');

            let totalP = 0, w24=0, l24=0, p24=0, w168=0, l168=0, p168=0;
            const historyRows = d.history.map(h => {
                const margin = document.getElementById('marginInp').value.includes('%') ? (initialBal * parseFloat(document.getElementById('marginInp').value)/100) : parseFloat(document.getElementById('marginInp').value);
                const pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                if(running) { 
                    totalP += isNaN(pnl)?0:pnl;
                    if(h.startTime >= now - 24*3600*1000) { h.status==='WIN'?w24++:l24++; p24+=pnl; }
                    if(h.startTime >= now - 168*3600*1000) { h.status==='WIN'?w168++:l168++; p168+=pnl; }
                    if(h.needSound) { winSnd.play(); delete h.needSound; }
                }
                return \`<tr class="border-b border-[#2b3139] text-zinc-400">
                    <td class="p-2">\${new Date(h.startTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td>
                    <td class="p-2 font-bold text-white">\${h.symbol} \${h.maxLev || 'NaN'}x</td>
                    <td class="p-2 text-[9px]">[\${h.snapVol.c1}/\${h.snapVol.c5}]</td>
                    <td class="p-2 text-right font-bold \${pnl>=0?'up':'down'}">\${isNaN(pnl)?'NaN':pnl.toFixed(1)+'$'}</td>
                    <td class="p-2 text-right font-black \${h.status==='WIN'?'up':'down'}">\${h.status}</td>
                </tr>\`;
            });
            document.getElementById('historyBody').innerHTML = historyRows.join('');

            if(running) {
                currentBal = initialBal + totalP;
                document.getElementById('displayBal').innerText = '$' + currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('stat24').innerHTML = \`<span class="text-[#0ecb81]">\${w24}W</span>-<span class="text-[#f6465d]">\${l24}L</span><br>\${p24.toFixed(1)}$\`;
                document.getElementById('stat7').innerHTML = \`<span class="text-[#0ecb81]">\${w168}W</span>-<span class="text-[#f6465d]">\${l168}L</span><br>\${p168.toFixed(1)}$\`;
                
                // Cập nhật biểu đồ theo bộ lọc
                const filterTime = now - (filterHours * 3600 * 1000);
                const filteredHistory = historyLog.filter(pt => pt.t >= filterTime);
                chart.data.labels = filteredHistory.map(pt => pt.t);
                chart.data.datasets[0].data = filteredHistory.map(pt => pt.b);
                chart.update('none');

                if (historyLog.length === 0 || historyLog[historyLog.length-1].b !== currentBal) {
                    historyLog.push({t: Date.now(), b: currentBal});
                    if(historyLog.length > 500) historyLog.shift();
                    save();
                }
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(port, '0.0.0.0', () => { initWS(); });
