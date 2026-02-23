import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; // CHỈ lấy từ API Binance

// --- HÀM LẤY ĐÒN BẨY THẬT TỪ SÀN (STRICT) ---
async function fetchActualLeverage() {
    try {
        // Sử dụng endpoint leverageBracket để lấy thông tin đòn bẩy chính xác nhất
        https.get('https://fapi.binance.com/fapi/v1/leverageBracket', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const brackets = JSON.parse(data);
                    // Reset lại để đảm bảo không có dữ liệu rác/cũ
                    const newLeverageMap = {};
                    brackets.forEach(item => {
                        // Lấy mức đòn bẩy cao nhất ở Bracket đầu tiên (thường là bracket 1 có Max Leverage cao nhất)
                        if (item.brackets && item.brackets.length > 0) {
                            newLeverageMap[item.symbol] = item.brackets[0].initialLeverage;
                        }
                    });
                    symbolMaxLeverage = newLeverageMap;
                    console.log(`[SYSTEM] Đã cập nhật đòn bẩy thực tế cho ${Object.keys(symbolMaxLeverage).length} mã.`);
                } catch (e) { console.error("Lỗi parse dữ liệu Leverage Bracket"); }
            });
        }).on('error', (e) => { console.error("Lỗi kết nối API Binance Leverage"); });
    } catch (e) { console.error("Lỗi hệ thống lấy đòn bẩy!"); }
}

fetchActualLeverage();
setInterval(fetchActualLeverage, 3600000); // Cập nhật lại mỗi giờ

// --- LOGIC LƯU TRỮ 30 NGÀY ---
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

setInterval(() => {
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const filteredHistory = Array.from(historyMap.values()).filter(h => (now - h.startTime) < thirtyDaysMs);
    historyMap.clear();
    filteredHistory.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(filteredHistory));
}, 60000);

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    return startPriceObj ? parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2)) : 0;
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [], lastStatusTime: 0 };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices = coinData[s].prices.slice(-100);

            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
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
                }
            }

            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                if (!pending && (now - coinData[s].lastStatusTime >= 900000)) {
                    // Nếu symbolMaxLeverage[s] không tồn tại, nó sẽ là undefined (kết quả hiển thị NaN)
                    historyMap.set(`${s}_${now}`, { 
                        symbol: s, startTime: now, snapVol: { c1, c5, c15 }, 
                        snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                        status: 'PENDING', maxLev: symbolMaxLeverage[s] || null 
                    });
                }
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,50),
        history: Array.from(historyMap.values()).sort((a,b)=>b.startTime-a.startTime).slice(0,100)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BINANCE PUMP & DUMP V2.4.4</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #000000; color: #e4e4e7; font-family: 'Inter', sans-serif; }
        .up { color: #22c55e; } .down { color: #f43f5e; }
        .bg-card { background: #0a0a0a; border: 1px solid #27272a; }
        #user-id { color: #F3BA2F; font-size: 2.5rem; font-weight: 900; }
    </style></head>
    <body class="p-6">
    <div class="flex justify-between items-center mb-4 border-b border-zinc-800 pb-4">
        <div class="flex items-center gap-3">
            <img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" width="40">
            <div><h1 class="text-3xl font-black text-white italic uppercase leading-none">BINANCE PUMP & DUMP <span class="text-yellow-500">V2.4.4</span></h1><p class="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Strict Exchange Data Mode</p></div>
        </div>
        <div id="setup" class="flex gap-3">
            <input id="balanceInp" type="number" value="1000" class="bg-zinc-900 border border-zinc-700 p-2 rounded w-28 text-yellow-500">
            <input id="marginInp" type="text" value="10%" class="bg-zinc-900 border border-zinc-700 p-2 rounded w-28 text-yellow-500">
            <button onclick="start()" class="bg-yellow-500 text-black px-8 py-2 rounded font-bold uppercase">Start</button>
        </div>
        <div id="active" class="hidden text-right"><div id="user-id">Moncey_D_Luffy</div><button onclick="stop()" class="text-red-500 text-[10px] font-bold uppercase">Stop</button></div>
    </div>

    <div class="mb-6 bg-card p-4 rounded">
        <div class="flex justify-between items-start mb-4">
            <div><div class="text-yellow-500 font-bold text-xs uppercase">Total Equity (07:00 AM Reset)</div><div id="displayBal" class="text-6xl font-black text-white">$0.00</div></div>
            <div class="grid grid-cols-3 gap-4 text-[10px] font-bold text-center">
                <div class="bg-zinc-900 p-3 rounded border border-zinc-800 w-32"><div>TODAY</div><div id="stat24" class="text-zinc-400 mt-1">---</div></div>
                <div class="bg-zinc-900 p-3 rounded border border-zinc-800 w-32"><div>7 DAYS</div><div id="stat7" class="text-zinc-400 mt-1">---</div></div>
                <div class="bg-zinc-900 p-3 rounded border border-zinc-800 w-32"><div>30 DAYS</div><div id="stat30" class="text-zinc-400 mt-1">---</div></div>
            </div>
        </div>
        <div style="height: 250px;"><canvas id="mainChart"></canvas></div>
    </div>

    <div class="grid grid-cols-12 gap-6">
        <div class="col-span-4 bg-card rounded flex flex-col h-[600px]">
            <div class="p-3 bg-zinc-900 font-bold text-xs border-b border-zinc-800">VOLATILITY (1m | 5m | 15m)</div>
            <div class="overflow-y-auto flex-1"><table class="w-full text-[11px] text-left"><tbody id="liveBody"></tbody></table></div>
        </div>
        <div class="col-span-8 bg-card rounded flex flex-col h-[600px]">
            <div class="p-3 bg-zinc-900 font-bold text-xs border-b border-zinc-800 uppercase italic">Real History Log</div>
            <div class="overflow-y-auto flex-1"><table class="w-full text-[11px] text-left"><thead class="text-zinc-500 sticky top-0 bg-black"><tr><th class="p-3">TIME</th><th class="p-3">COIN/MAXLEV</th><th class="p-3">SNAP VOL</th><th class="p-3 text-right">PNL ($)</th><th class="p-3 text-right">STATUS</th></tr></thead><tbody id="historyBody" class="font-mono"></tbody></table></div>
        </div>
    </div>

    <script>
    let running = false, currentBal = 0, initialBal = 0, historyLog = [];
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3'), loseSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2014/2014-preview.mp3');

    if(localStorage.getItem('bot_luffy_v3')) {
        const s = JSON.parse(localStorage.getItem('bot_luffy_v3'));
        running = s.running; initialBal = s.initialBal; currentBal = s.currentBal; historyLog = s.historyLog;
        if(running) { document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: historyLog.map((_,i)=>i), datasets: [{ data: historyLog, borderColor: '#F3BA2F', tension: 0.3, pointRadius: 0, fill: true, backgroundColor: 'rgba(243,186,47,0.05)' }]},
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1a1a1a' } } } }
    });

    function getTradeDayStart() {
        const d = new Date(); if(d.getHours() < 7) d.setDate(d.getDate() - 1);
        d.setHours(7,0,0,0); return d.getTime();
    }

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); currentBal = initialBal; historyLog = [initialBal]; document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); save(); }
    function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').classList.add('hidden'); save(); }
    function save() { localStorage.setItem('bot_luffy_v3', JSON.stringify({ running, initialBal, currentBal, historyLog })); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const dayStart = getTradeDayStart();
            const weekStart = Date.now() - (7 * 24 * 3600 * 1000);
            const monthStart = Date.now() - (30 * 24 * 3600 * 1000);
            
            document.getElementById('liveBody').innerHTML = d.live.map(c => \`
                <tr class="border-b border-zinc-900"><td class="p-3 font-bold text-white">\${c.symbol}</td><td class="\${c.c1>=0?'up':'down'} p-3">\${c.c1}%</td><td class="\${c.c5>=0?'up':'down'} p-3">\${c.c5}%</td><td class="\${c.c15>=0?'up':'down'} p-3 text-right">\${c.c15}%</td></tr>\`).join('');

            let totalPnl = 0, wDay=0, lDay=0, pDay=0, wWeek=0, lWeek=0, pWeek=0, wMonth=0, lMonth=0, pMonth=0;

            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                let pnl = NaN; 
                if(h.status !== 'PENDING' && h.maxLev !== null) {
                    let mVal = document.getElementById('marginInp').value;
                    let margin = mVal.includes('%') ? (initialBal * parseFloat(mVal) / 100) : parseFloat(mVal);
                    pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                    
                    if(running) { 
                        totalPnl += isNaN(pnl) ? 0 : pnl;
                        if(h.startTime >= dayStart) { h.status === 'WIN' ? wDay++ : lDay++; pDay += isNaN(pnl) ? 0 : pnl; }
                        if(h.startTime >= weekStart) { h.status === 'WIN' ? wWeek++ : lWeek++; pWeek += isNaN(pnl) ? 0 : pnl; }
                        if(h.startTime >= monthStart) { h.status === 'WIN' ? wMonth++ : lMonth++; pMonth += isNaN(pnl) ? 0 : pnl; }
                        if(h.needSound) { (h.status === 'WIN' ? winSnd : loseSnd).play(); delete h.needSound; }
                    }
                }
                return \`<tr class="border-b border-zinc-900"><td class="p-3 text-zinc-600 font-bold">\${new Date(h.startTime).toLocaleTimeString()}</td><td class="p-3 font-bold text-white">\${h.symbol} <span class="text-yellow-500">\${h.maxLev || 'NaN'}x</span></td><td class="p-3 text-zinc-500">[\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}]</td><td class="p-3 text-right font-bold \${pnl>=0?'up':'down'}">\${isNaN(pnl)?'NaN':(pnl>0?'+':'')+pnl.toFixed(2)+'$'}</td><td class="p-3 text-right font-black \${h.status==='WIN'?'up':(h.status==='LOSE'?'down':'text-zinc-700')}">\${h.status}</td></tr>\`;
            }).join('');

            if(running) {
                currentBal = initialBal + totalPnl;
                document.getElementById('displayBal').innerText = '$' + currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('stat24').innerHTML = \`<span class="text-green-500">\${wDay}W</span>-<span class="text-red-500">\${lDay}L</span><br>\${pDay.toFixed(1)}$\`;
                document.getElementById('stat7').innerHTML = \`<span class="text-green-500">\${wWeek}W</span>-<span class="text-red-500">\${lWeek}L</span><br>\${pWeek.toFixed(1)}$\`;
                document.getElementById('stat30').innerHTML = \`<span class="text-green-500">\${wMonth}W</span>-<span class="text-red-500">\${lMonth}L</span><br>\${pMonth.toFixed(1)}$\`;
                
                historyLog.push(currentBal); if(historyLog.length > 60) historyLog.shift();
                chart.data.labels = historyLog.map((_, i) => i); chart.data.datasets[0].data = historyLog; chart.update('none');
                save();
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(port, '0.0.0.0', () => { initWS(); });
