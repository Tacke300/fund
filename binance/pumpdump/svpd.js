const MIN_VOLATILITY_TO_SAVE = 5; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

async function fetchActualLeverage() {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const options = { hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`, headers: { 'X-MBX-APIKEY': API_KEY } };
    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                if (Array.isArray(brackets)) {
                    brackets.forEach(item => { if (item.brackets?.[0]) symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage; });
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                }
            } catch (e) {}
        });
    });
}

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const start = pArr.find(i => i.t >= (pArr[pArr.length-1].t - min*60000));
    return start ? parseFloat(((pArr[pArr.length-1].p - start.p) / start.p * 100).toFixed(2)) : 0;
}

function initWS() {
    fetchActualLeverage();
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'DOWN' ? diff <= -5 : diff >= 5;
                const lose = pending.type === 'DOWN' ? diff >= 5 : diff <= -5;
                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; pending.endTime = now;
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending && !isCooldown) {
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20 });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,15),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0,100)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; padding: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-main { background: #0b0e11; } .bg-card { background: #1e2329; }
        .dot-under { border-bottom: 1px dotted #5e6673; cursor: help; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 8px 0; font-size: 13px; font-weight: 500; text-align: center; width: 100%; cursor: pointer; }
        #user-id { color: #fcd535; font-size: 1.2rem; font-weight: 900; font-style: italic; cursor: pointer; }
        .text-gray-custom { color: #848e9c; }
        .text-12 { font-size: 12px; } .text-14 { font-size: 14px; } .text-10 { font-size: 10px; }
        @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
        .warn-blink { animation: blink 0.8s infinite; color: #f6465d; font-weight: 900; }
        ::-webkit-scrollbar { width: 0px; }
    </style></head><body>
    
    <div class="p-4 bg-main sticky top-0 z-50">
        <div id="setup" class="flex gap-2 mb-4 bg-card p-3 rounded-lg border border-zinc-800">
            <input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            <input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm">
            <button onclick="start()" class="bg-[#fcd535] text-black px-4 py-2 rounded font-bold uppercase text-xs">Start</button>
            <button onclick="clearAllData()" class="bg-red-900/30 text-red-500 px-2 py-2 rounded font-bold uppercase text-[9px] border border-red-500/20">Xóa</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic text-white tracking-tighter">BINANCE <span class="text-[#fcd535]">FUTURES</span></h1></div>
             <div id="user-id" onclick="stop()">Monkey_D_Luffy</div>
        </div>

        <div class="text-gray-custom text-12 flex items-center gap-1 mb-1 font-medium"><span class="dot-under">Số dư ký quỹ</span> (USDT) <i class="far fa-eye text-10"></i></div>
        <div class="flex items-end gap-2 mb-4">
            <span id="displayBal" class="text-3xl font-bold tracking-tighter text-white">0.00</span>
            <span class="text-base font-medium text-white mb-1">USDT</span>
        </div>

        <div class="grid grid-cols-3 gap-2 mb-4 text-center">
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold mb-1">24h (7h)</div><div id="stat24" class="font-bold text-12">---</div></div>
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold mb-1">7 Ngày qua</div><div id="stat7" class="font-bold text-12">---</div></div>
            <div class="bg-card p-2 rounded"><div class="text-gray-custom text-10 uppercase font-bold mb-1">30 Ngày qua</div><div id="stat30" class="font-bold text-12">---</div></div>
        </div>

        <div class="grid grid-cols-2 gap-4 text-sm border-t border-zinc-800 pt-3">
            <div><div class="text-gray-custom text-10 mb-1">Số dư ví</div><div id="walletBal" class="font-bold text-white">0.00</div></div>
            <div class="text-right"><div class="text-gray-custom text-10 mb-1">PNL chưa thực hiện</div><div id="unPnl" class="font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 py-2 bg-main">
        <div style="height: 120px;"><canvas id="mainChart"></canvas></div>
    </div>

    <div class="px-4 mt-6">
        <div class="flex gap-6 mb-4 border-b border-zinc-800 text-sm font-bold text-gray-custom uppercase">
            <span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế</span>
            <span>Lệnh chờ(0)</span>
            <span>Lịch sử</span>
        </div>
        <div id="pendingContainer" class="space-y-8 pb-6"></div>
    </div>

    <div class="px-4 mb-4">
        <div class="bg-card rounded-lg p-3">
             <div class="text-10 font-bold text-gray-custom mb-3 uppercase italic border-b border-zinc-800 pb-1">Biến động (1m | 5m | 15m)</div>
             <table class="w-full text-12 text-left"><tbody id="liveBody"></tbody></table>
        </div>
    </div>

    <div class="px-4 pb-32">
        <div class="bg-card rounded-lg p-3">
            <div class="text-10 font-bold text-gray-custom mb-3 uppercase italic border-b border-zinc-800 pb-1">Lịch sử lệnh chi tiết</div>
            <div class="overflow-x-auto">
                <table class="w-full text-[9px] text-left">
                    <thead class="text-gray-custom uppercase border-b border-zinc-800">
                        <tr>
                            <th class="pb-2">Time</th>
                            <th class="pb-2">Coin</th>
                            <th class="pb-2">Lev</th>
                            <th class="pb-2">Entry</th>
                            <th class="pb-2">Margin</th>
                            <th class="pb-2 font-bold text-white">PnL</th>
                            <th class="pb-2 text-right">Total PnL</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody" class="text-zinc-300"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000, historyLog = [];
    
    if(localStorage.getItem('bot_v5_final')) {
        const saved = JSON.parse(localStorage.getItem('bot_v5_final'));
        running = saved.running; initialBal = saved.initialBal; historyLog = saved.historyLog || [];
        if(running) { document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    }
    function saveConfig() { localStorage.setItem('bot_v5_final', JSON.stringify({ running, initialBal, historyLog })); }
    function clearAllData() { if(confirm("Xóa lịch sử?")) { localStorage.removeItem('bot_v5_final'); location.reload(); } }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: historyLog.map((_,i)=>i), datasets: [{ data: historyLog.map(pt=>pt.b), borderColor: '#fcd535', borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1e2329' }, ticks: { color: '#5e6673', font: { size: 9 } } } } }
    });

    function getTradeDayStart() { var d = new Date(); if(d.getHours() < 7) d.setDate(d.getDate() - 1); d.setHours(7,0,0,0); return d.getTime(); }
    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); saveConfig(); }
    function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').classList.add('hidden'); saveConfig(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now(), dayStart = getTradeDayStart();
            
            document.getElementById('liveBody').innerHTML = d.live.map(c => 
                \`<tr class="border-b border-zinc-800/50"><td class="py-2 font-bold text-white uppercase">\${c.symbol}</td>
                <td class="\${c.c1>=0?'up':'down'} text-center">\${c.c1}%</td>
                <td class="\${c.c5>=0?'up':'down'} text-center">\${c.c5}%</td>
                <td class="\${c.c15>=0?'up':'down'} text-right">\${c.c15}%</td></tr>\`
            ).join('');

            let totalUnPnl = 0, totalClosedP = 0, wD=0, lD=0, pD=0, wW=0, lW=0, pW=0, wM=0, lM=0, pM=0;

            document.getElementById('pendingContainer').innerHTML = d.pending.map(function(h){
                var live = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                var mInp = document.getElementById('marginInp').value;
                var margin = mInp.includes('%') ? (initialBal * parseFloat(mInp)/100) : parseFloat(mInp);
                var roi = (h.type === 'UP' ? ((live - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - live)/h.snapPrice)*100) * (h.maxLev || 20);
                var pnl = margin * roi / 100; totalUnPnl += pnl;
                
                let excl = '<span class="text-gray-600 ml-1">!!!!</span>';
                if(roi > 0) excl = '<span class="up ml-1 font-bold">!!!!</span>';
                if(roi < -50) excl = '<span class="warn-blink ml-1">!!!!</span>';

                return '<div class="bg-main border-b border-zinc-800 pb-6">' +
                    '<div class="flex items-center gap-2 mb-3">' +
                        '<span class="px-1 rounded text-[10px] font-bold ' + (h.type==='UP'?'bg-[#0ecb81]/20 up':'bg-[#f6465d]/20 down') + '">' + (h.type==='UP'?'Long':'Short') + '</span>' +
                        '<span class="font-bold text-white text-base uppercase">' + h.symbol + '</span>' +
                        '<span class="text-gray-custom text-[11px]">Vĩnh cửu Cross ' + (h.maxLev || 20) + 'x</span>' + excl +
                    '</div>' +
                    '<div class="grid grid-cols-2 mb-4"><div><div class="text-gray-custom text-12 mb-1 dot-under">PnL (USDT)</div><div class="text-2xl font-bold ' + (pnl>=0?'up':'down') + '">' + pnl.toFixed(2) + '</div></div>' +
                    '<div class="text-right"><div class="text-gray-custom text-12 mb-1">ROI</div><div class="text-2xl font-bold ' + (roi>=0?'up':'down') + '">' + roi.toFixed(2) + '%</div></div></div>' +
                    '<div class="grid grid-cols-3 text-12 mb-3 text-gray-custom"><div><div class="dot-under">Kích thước</div><div class="text-white">' + (margin*(h.maxLev||20)).toFixed(1) + '</div></div>' +
                    '<div><div class="dot-under">Ký quỹ</div><div class="text-white">' + margin.toFixed(1) + '</div></div>' +
                    '<div class="text-right"><div class="dot-under">Tỉ lệ</div><div class="up">0.82%</div></div></div>' +
                    '<div class="grid grid-cols-3 text-12 mb-4 text-gray-custom"><div><div class="dot-under">Giá vào</div><div class="text-white">' + h.snapPrice.toFixed(4) + '</div></div>' +
                    '<div><div class="dot-under">Giá đánh dấu</div><div class="text-white">' + live.toFixed(4) + '</div></div>' +
                    '<div class="text-right"><div class="dot-under">Thanh lý</div><div class="text-orange-300">0.6081</div></div></div>' +
                    '<div class="text-11 mb-4 text-gray-custom italic">TP/SL: <span class="up">' + (h.snapPrice*1.05).toFixed(4) + '</span> / <span class="down">' + (h.snapPrice*0.95).toFixed(4) + '</span></div>' +
                    '<div class="flex gap-2"><div class="binance-btn">Điều chỉnh đòn bẩy</div><div class="binance-btn">Đóng vị thế</div></div></div>';
            }).join('');

            // Xử lý lịch sử và cột PnL
            let runningTotal = 0;
            let mInpGlobal = document.getElementById('marginInp').value;
            let marginVal = mInpGlobal.includes('%') ? (initialBal * parseFloat(mInpGlobal)/100) : parseFloat(mInpGlobal);
            
            // Tính toán tổng PnL lũy kế từ cũ tới mới
            let processedHistory = [...d.history].reverse().map(h => {
                let pnl = (h.status === 'WIN' ? 1 : -1) * (marginVal * (5 * (h.maxLev || 20)) / 100);
                runningTotal += pnl;
                return { ...h, pnl, cumulative: runningTotal, margin: marginVal };
            });

            // Sau khi tính xong thì đảo lại để hiện mới nhất ở trên
            document.getElementById('historyBody').innerHTML = [...processedHistory].reverse().map(function(h){
                totalClosedP += h.pnl;
                if(h.endTime >= dayStart) { h.status==='WIN'?wD++:lD++; pD+=h.pnl; }
                if(h.endTime >= (now - 7*24*3600000)) { h.status==='WIN'?wW++:lW++; pW+=h.pnl; }
                if(h.endTime >= (now - 30*24*3600000)) { h.status==='WIN'?wM++:lM++; pM+=h.pnl; }
                
                return '<tr class="border-b border-zinc-800/30">' +
                        '<td class="py-2 text-gray-custom">' + new Date(h.endTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) + '</td>' +
                        '<td class="font-bold text-white uppercase">' + h.symbol + '</td>' +
                        '<td class="text-gray-custom">' + h.maxLev + 'x</td>' +
                        '<td class="text-zinc-400">' + h.snapPrice.toFixed(3) + '</td>' +
                        '<td class="text-zinc-400">' + h.margin.toFixed(1) + '</td>' +
                        '<td class="font-bold ' + (h.pnl>=0?'up':'down') + '">' + (h.pnl>=0?'+':'') + h.pnl.toFixed(2) + '</td>' +
                        '<td class="text-right font-black ' + (h.cumulative>=0?'up':'down') + '">' + (h.cumulative>=0?'+':'') + h.cumulative.toFixed(2) + '</td></tr>';
            }).join('');

            if(running) {
                var currentBal = initialBal + totalClosedP + totalUnPnl;
                document.getElementById('displayBal').innerText = currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('walletBal').innerText = (initialBal + totalClosedP).toFixed(2);
                document.getElementById('unPnl').innerText = (totalUnPnl >= 0 ? '+' : '') + totalUnPnl.toFixed(2);
                document.getElementById('unPnl').className = 'font-bold ' + (totalUnPnl >= 0 ? 'up' : 'down');
                document.getElementById('stat24').innerHTML = '<span class="up">' + wD + 'W</span>-<span class="down">' + lD + 'L</span> <span class="' + (pD>=0?'up':'down') + ' ml-1">' + pD.toFixed(1) + '</span>';
                document.getElementById('stat7').innerHTML = '<span class="up">' + wW + 'W</span>-<span class="down">' + lW + 'L</span> <span class="' + (pW>=0?'up':'down') + ' ml-1">' + pW.toFixed(1) + '</span>';
                document.getElementById('stat30').innerHTML = '<span class="up">' + wM + 'W</span>-<span class="down">' + lM + 'L</span> <span class="' + (pM>=0?'up':'down') + ' ml-1">' + pM.toFixed(1) + '</span>';

                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) { 
                    historyLog.push({t: now, b: currentBal}); 
                    if(historyLog.length > 1440) historyLog.shift();
                    saveConfig(); 
                }
                chart.data.labels = historyLog.map((_,i)=>i); chart.data.datasets[0].data = historyLog.map(pt=>pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Server: http://localhost:${PORT}/gui`); });
