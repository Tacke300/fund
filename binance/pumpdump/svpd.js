// ================= CONFIGURATION =================
const MIN_VOLATILITY_TO_SAVE = 0.5; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
// =================================================

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

// --- 1. LOGIC LẤY ĐÒN BẨY & RESET DỮ LIỆU (TỪ CODE GỐC) ---
async function fetchActualLeverage() {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const options = { 
        hostname: 'fapi.binance.com', 
        path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`, 
        headers: { 'X-MBX-APIKEY': API_KEY } 
    };
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

// Khởi tạo file lưu trữ
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
                    pending.finalPrice = p; 
                    pending.endTime = now; 
                    pending.needSound = true;
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapVol: { c1, c5, c15 }, 
                    snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                    status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20 
                });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,30),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.startTime-a.startTime).slice(0,50)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-main { background: #0b0e11; }
        .bg-card { background: #1e2329; }
        .dot-border { border-bottom: 1px dotted #5e6673; }
        .binance-btn { background: #2b3139; color: #eaecef; border-radius: 4px; padding: 6px 0; font-size: 13px; font-weight: 500; text-align: center; }
        #user-id { color: #fcd535; font-size: 1.5rem; font-weight: 900; font-style: italic; cursor: pointer; }
        ::-webkit-scrollbar { width: 0px; }
        .text-gray-custom { color: #848e9c; }
    </style></head><body>
    
    <div class="p-4 bg-main border-b border-zinc-800">
        <div id="setup" class="flex gap-2 mb-4">
            <input id="balanceInp" type="number" value="1000" class="bg-card border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none">
            <input id="marginInp" type="text" value="10%" class="bg-card border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none">
            <button onclick="start()" class="bg-[#fcd535] text-black px-6 py-2 rounded font-bold uppercase text-xs">Start</button>
        </div>
        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic">BINANCE <span class="text-[#fcd535]">PRO</span></h1></div>
             <div id="user-id" onclick="stop()">Moncey_D_Luffy</div>
        </div>

        <div class="text-gray-custom text-sm flex items-center gap-1 mb-1 italic font-medium">Số dư margin <i class="far fa-eye text-xs"></i></div>
        <div class="flex items-center gap-2 mb-4">
            <span id="displayBal" class="text-4xl font-bold tracking-tighter">0.00</span>
            <span class="text-lg font-medium">USDT</span>
        </div>
        
        <div class="grid grid-cols-3 gap-2 mb-6 text-center">
            <div class="bg-card p-2 rounded border border-zinc-800"><div class="text-gray-custom text-[10px]">HÔM NAY (7H)</div><div id="stat24" class="font-bold text-xs">---</div></div>
            <div class="bg-card p-2 rounded border border-zinc-800"><div class="text-gray-custom text-[10px]">7 NGÀY</div><div id="stat7" class="font-bold text-xs">---</div></div>
            <div class="bg-card p-2 rounded border border-zinc-800"><div class="text-gray-custom text-[10px]">30 NGÀY</div><div id="stat30" class="font-bold text-xs">---</div></div>
        </div>

        <div class="grid grid-cols-2 gap-4 mb-6 text-sm">
            <div><div class="text-gray-custom text-xs mb-1">Số dư ví (USDT)</div><div id="walletBal" class="font-bold text-base">0.00</div></div>
            <div class="text-right"><div class="text-gray-custom text-xs mb-1">PNL chưa ghi nhận</div><div id="unPnl" class="font-bold text-base">0.00</div></div>
        </div>
        <div class="flex gap-2"><div class="bg-[#fcd535] text-black py-2 flex-1 rounded text-center font-bold text-sm">Giao dịch</div><div class="bg-[#2b3139] py-2 flex-1 rounded text-center font-bold text-sm">Hoán đổi</div><div class="bg-[#2b3139] py-2 flex-1 rounded text-center font-bold text-sm text-gray-200">Chuyển</div></div>
    </div>

    <div class="px-4 py-2"><div style="height: 120px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mt-4">
        <div class="flex gap-6 mb-4 border-b border-zinc-800 text-sm font-bold text-gray-custom uppercase">
            <span class="text-white border-b-2 border-[#fcd535] pb-2">Vị thế</span>
            <span>Lệnh chờ(0)</span>
            <span>Lịch sử lệnh</span>
        </div>
        <div id="pendingContainer" class="space-y-8 pb-10"></div>
    </div>

    <div class="px-4 grid grid-cols-12 gap-4 pb-24">
        <div class="col-span-12 bg-card rounded p-3">
             <div class="text-[10px] font-bold text-gray-custom mb-2 uppercase italic tracking-widest border-b border-zinc-800 pb-1">Volatility (1m | 5m | 15m)</div>
             <div class="max-h-[200px] overflow-y-auto"><table class="w-full text-[11px] text-left"><tbody id="liveBody"></tbody></table></div>
        </div>
        <div class="col-span-12 bg-card rounded p-3">
            <div class="text-[10px] font-bold text-gray-custom mb-2 uppercase italic tracking-widest border-b border-zinc-800 pb-1">Real History Log</div>
            <div class="max-h-[300px] overflow-y-auto">
                <table class="w-full text-[10px] text-left">
                    <thead class="text-gray-custom sticky top-0 bg-[#1e2329]"><tr><th class="pb-2">TIME</th><th class="pb-2">COIN/LEV</th><th class="pb-2 text-right">PNL</th><th class="pb-2 text-right">STATUS</th></tr></thead>
                    <tbody id="historyBody" class="font-mono text-gray-200"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 0, historyLog = [];
    const winSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3');
    const loseSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2014/2014-preview.mp3');

    if(localStorage.getItem('bot_luffy_v3')) {
        const s = JSON.parse(localStorage.getItem('bot_luffy_v3'));
        running = s.running; initialBal = s.initialBal; historyLog = s.historyLog || [];
        if(running) { document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }]},
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function getTradeDayStart() {
        const d = new Date(); if(d.getHours() < 7) d.setDate(d.getDate() - 1);
        d.setHours(7,0,0,0); return d.getTime();
    }

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value); historyLog = [{t: Date.now(), b: initialBal}]; document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); save(); }
    function stop() { running = false; document.getElementById('setup').style.display='flex'; document.getElementById('active').classList.add('hidden'); save(); }
    function save() { localStorage.setItem('bot_luffy_v3', JSON.stringify({ running, initialBal, historyLog })); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now(); 
            const dayStart = getTradeDayStart();
            const weekStart = now - (7 * 24 * 3600 * 1000);
            const monthStart = now - (30 * 24 * 3600 * 1000);
            let totalUnPnl = 0, totalClosedP = 0;
            let wDay=0, lDay=0, pDay=0, wWeek=0, lWeek=0, pWeek=0, wMonth=0, lMonth=0, pMonth=0;

            // Update Volatility Table
            document.getElementById('liveBody').innerHTML = d.live.map(c => `
                <tr class="border-b border-zinc-800"><td class="py-2 font-bold text-zinc-200">${c.symbol}</td><td class="${c.c1>=0?'up':'down'}">${c.c1}%</td><td class="${c.c5>=0?'up':'down'} text-center">${c.c5}%</td><td class="${c.c15>=0?'up':'down'} text-right">${c.c15}%</td></tr>`).join('');

            // Update Positions Card (LAYOUT NHƯ ẢNH)
            document.getElementById('pendingContainer').innerHTML = d.pending.map(h => {
                const livePrice = d.live.find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                const marginVal = document.getElementById('marginInp').value;
                const margin = marginVal.includes('%') ? (initialBal * parseFloat(marginVal) / 100) : parseFloat(marginVal);
                const roi = (h.type === 'UP' ? ((livePrice - h.snapPrice)/h.snapPrice)*100 : ((h.snapPrice - livePrice)/h.snapPrice)*100) * (h.maxLev);
                const pnl = margin * roi / 100; totalUnPnl += pnl;

                return `<div>
                    <div class="flex items-center gap-2 mb-3">
                        <span class="w-5 h-5 flex items-center justify-center rounded text-[10px] font-black ${h.type==='UP'?'bg-[#0ecb81]/20 up':'bg-[#f6465d]/20 down'}">${h.type==='UP'?'L':'S'}</span>
                        <span class="font-bold text-base">${h.symbol}</span>
                        <span class="bg-[#2b3139] px-1 rounded text-gray-custom text-[10px] font-medium">Vĩnh cửu</span>
                        <span class="bg-[#2b3139] px-1 rounded text-gray-custom text-[10px] font-medium">Cross ${h.maxLev}X</span>
                    </div>
                    <div class="grid grid-cols-2 mb-3">
                        <div><div class="text-gray-custom text-xs dot-border inline-block mb-1">PNL (USDT)</div><div class="text-xl font-bold ${pnl>=0?'up':'down'}">${pnl.toFixed(2)}</div></div>
                        <div class="text-right"><div class="text-gray-custom text-xs inline-block mb-1">ROI</div><div class="text-xl font-bold ${roi>=0?'up':'down'}">${roi.toFixed(2)}%</div></div>
                    </div>
                    <div class="grid grid-cols-3 text-xs mb-2 text-gray-custom">
                        <div><div>Kích thước (USDT)</div><div class="text-white font-medium">${(margin*h.maxLev).toFixed(2)}</div></div>
                        <div class="text-left pl-4"><div>Margin (USDT)</div><div class="text-white font-medium">${margin.toFixed(2)}</div></div>
                        <div class="text-right"><div>Tỉ lệ ký quỹ</div><div class="up font-medium">6,51%</div></div>
                    </div>
                    <div class="grid grid-cols-3 text-xs mb-4 text-gray-custom border-b border-zinc-800 pb-4">
                        <div><div>Giá vào lệnh (USDT)</div><div class="text-white font-medium">${h.snapPrice.toFixed(4)}</div></div>
                        <div class="text-left pl-4"><div>Giá đánh dấu (USDT)</div><div class="text-white font-medium">${livePrice.toFixed(4)}</div></div>
                        <div class="text-right"><div>Giá thanh lý (USDT)</div><div class="text-orange-300 font-medium">--</div></div>
                    </div>
                    <div class="grid grid-cols-3 gap-2"><div class="binance-btn">Đòn bẩy</div><div class="binance-btn">TP/SL</div><div class="binance-btn">Đóng</div></div>
                </div>`;
            }).join('');

            // Update History Log & Stats
            document.getElementById('historyBody').innerHTML = d.history.map(h => {
                const marginVal = document.getElementById('marginInp').value;
                const margin = marginVal.includes('%') ? (initialBal * parseFloat(marginVal) / 100) : parseFloat(marginVal);
                let pnl = (h.status === 'WIN' ? 1 : -1) * (margin * (5 * h.maxLev) / 100);
                totalClosedP += pnl;

                if(h.startTime >= dayStart) { h.status === 'WIN' ? wDay++ : lDay++; pDay += pnl; }
                if(h.startTime >= weekStart) { h.status === 'WIN' ? wWeek++ : lWeek++; pWeek += pnl; }
                if(h.startTime >= monthStart) { h.status === 'WIN' ? wMonth++ : lMonth++; pMonth += pnl; }
                if(h.needSound) { (h.status === 'WIN' ? winSnd : loseSnd).play(); delete h.needSound; }

                return `<tr class="border-b border-zinc-800"><td class="py-2 text-gray-custom">${new Date(h.startTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td><td class="font-bold">${h.symbol} ${h.maxLev}x</td><td class="text-right font-bold ${pnl>=0?'up':'down'}">${pnl.toFixed(1)}$</td><td class="text-right font-black ${h.status==='WIN'?'up':'down'}">${h.status}</td></tr>`;
            }).join('');

            if(running) {
                const currentBal = initialBal + totalClosedP + totalUnPnl;
                document.getElementById('displayBal').innerText = currentBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('walletBal').innerText = (initialBal + totalClosedP).toFixed(2);
                document.getElementById('unPnl').innerText = totalUnPnl >= 0 ? '+' + totalUnPnl.toFixed(2) : totalUnPnl.toFixed(2);
                document.getElementById('unPnl').className = totalUnPnl >= 0 ? 'font-bold text-base up' : 'font-bold text-base down';
                
                // Update Stats
                document.getElementById('stat24').innerHTML = `<span class="up">${wDay}W</span>-<span class="down">${lDay}L</span> | <span class="${pDay>=0?'up':'down'}">${pDay.toFixed(1)}$</span>`;
                document.getElementById('stat7').innerHTML = `<span class="up">${wWeek}W</span>-<span class="down">${lWeek}L</span> | <span class="${pWeek>=0?'up':'down'}">${pWeek.toFixed(1)}$</span>`;
                document.getElementById('stat30').innerHTML = `<span class="up">${wMonth}W</span>-<span class="down">${lMonth}L</span> | <span class="${pMonth>=0?'up':'down'}">${pMonth.toFixed(1)}$</span>`;

                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) { 
                    historyLog.push({t: now, b: currentBal}); 
                    if(historyLog.length > 60) historyLog.shift(); 
                    save(); 
                }
                chart.data.labels = historyLog.map(pt => pt.t); chart.data.datasets[0].data = historyLog.map(pt => pt.b); chart.update('none');
            }
        } catch(e) {}
    }
    setInterval(update, 2000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); });
