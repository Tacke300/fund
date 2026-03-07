// ==========================================
// CẤU HÌNH THÔNG SỐ CHIẾN THUẬT (DỄ CHỈNH)
// ==========================================
const TP_PERCENT = 0.1;           // Chốt lời 0.1% (giá chưa đòn bẩy)
const SL_PERCENT = 0.5;           // Cắt lỗ 0.5% (giá chưa đòn bẩy)
const MIN_VOLATILITY_TO_SAVE = 5; // Biến động tối thiểu để vào lệnh
const COOLDOWN_MINUTES = 15;      // Thời gian nghỉ giữa các lệnh cùng 1 coin

// --- LOGIC CHIẾN THUẬT LUFFY ---
const MAX_LOSE_STREAK = 5;        // Thua liên tiếp 5 lần thì Reset vốn
const MAX_EQUITY_PERCENT = 0.5;   // Lệnh chạm 50% tổng vốn thì Reset bảo toàn lãi
const PORT = 9000;
// ==========================================

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';

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
            
            const allHistory = Array.from(historyMap.values());
            const hasPendingOverall = allHistory.some(h => h.status === 'PENDING');

            const pending = allHistory.find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'UP' ? diff >= TP_PERCENT : diff <= -TP_PERCENT; 
                const lose = pending.type === 'UP' ? diff <= -SL_PERCENT : diff >= SL_PERCENT; 

                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = win ? TP_PERCENT : -SL_PERCENT;
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !hasPendingOverall && !isCooldown) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, 
                    type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20,
                    snapVol: { c1, c5, c15 },
                    tpTarget: TP_PERCENT,
                    slTarget: SL_PERCENT
                });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,15),
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>a.endTime-b.endTime),
        config: { tp: TP_PERCENT, sl: SL_PERCENT, maxLose: MAX_LOSE_STREAK, maxEquity: MAX_EQUITY_PERCENT }
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Binance Luffy Pro v2</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; padding: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-main { background: #0b0e11; } .bg-card { background: #1e2329; }
        #user-id { color: #fcd535; font-size: 1.2rem; font-weight: 900; font-style: italic; cursor: pointer; }
        .text-gray-custom { color: #848e9c; } .text-10 { font-size: 10px; } .text-12 { font-size: 12px; }
    </style></head><body>
    
    <div class="p-4 bg-main sticky top-0 z-50 shadow-xl border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-2 mb-4 bg-card p-3 rounded-lg border border-zinc-700">
            <input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm" placeholder="Vốn">
            <input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm" placeholder="Margin">
            <div class="flex items-center gap-2 bg-black border border-zinc-700 p-2 rounded w-full">
                <input id="luffyMode" type="checkbox" class="w-4 h-4 accent-yellow-500">
                <label class="text-[9px] font-bold text-gray-custom uppercase">Chiến thuật Luffy</label>
            </div>
            <button onclick="start()" class="bg-[#fcd535] text-black px-4 py-2 rounded font-bold uppercase text-xs">Kích hoạt Bot</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" class="w-5"><h1 class="font-bold italic text-white">BINANCE <span class="text-[#fcd535]">PRO</span></h1></div>
             <div id="user-id" onclick="stop()">Stop Bot</div>
        </div>

        <div class="flex justify-between items-end">
            <div>
                <div class="text-gray-custom text-10 uppercase font-bold">Vốn + Lãi dồn (Equity)</div>
                <div class="flex items-end gap-1">
                    <span id="displayBal" class="text-3xl font-bold tracking-tighter text-white">0.00</span>
                    <span class="text-xs font-medium text-gray-custom mb-1">USDT</span>
                </div>
            </div>
            <div class="text-right">
                <div class="text-gray-custom text-10 uppercase font-bold">PnL Phiên</div>
                <div id="unPnl" class="text-lg font-bold">0.00</div>
            </div>
        </div>
    </div>

    <div class="px-4 py-2 bg-main"><div style="height: 100px;"><canvas id="mainChart"></canvas></div></div>

    <div class="px-4 mt-4">
        <div class="text-xs font-bold text-white uppercase border-l-4 border-yellow-500 pl-2 mb-4">Vị thế đang chạy</div>
        <div id="pendingContainer" class="space-y-4"></div>
    </div>

    <div class="px-4 mt-6 pb-32">
        <div class="bg-card rounded-lg p-3 border border-zinc-800">
            <div class="text-10 font-bold text-gray-custom mb-3 uppercase italic border-b border-zinc-800 pb-1">Lịch sử dồn vốn</div>
            <div class="overflow-x-auto">
                <table class="w-full text-[9px] text-left">
                    <thead class="text-gray-custom uppercase border-b border-zinc-800">
                        <tr>
                            <th class="pb-2">Cặp</th>
                            <th class="pb-2 text-center">Đòn bẩy</th>
                            <th class="pb-2">Margin</th>
                            <th class="pb-2">PnL</th>
                            <th class="pb-2 text-right">Tổng Vốn</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody" class="text-zinc-300"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000, historyLog = [], luffyActive = false;
    
    if(localStorage.getItem('bot_v6')) {
        const saved = JSON.parse(localStorage.getItem('bot_v6'));
        running = !!saved.running; initialBal = parseFloat(saved.initialBal) || 1000; historyLog = saved.historyLog || [];
        luffyActive = !!saved.luffyActive;
        document.getElementById('luffyMode').checked = luffyActive;
        if(running) { document.getElementById('setup').style.display='none'; document.getElementById('active').classList.remove('hidden'); }
    }
    function saveConfig() { localStorage.setItem('bot_v6', JSON.stringify({ running, initialBal, historyLog, luffyActive })); }

    const chart = new Chart(document.getElementById('mainChart').getContext('2d'), {
        type: 'line', data: { labels: historyLog.map((_,i)=>i), datasets: [{ data: historyLog.map(pt=>pt.b), borderColor: '#fcd535', borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(252,213,53,0.05)' }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    function start() { 
        running = true; 
        initialBal = parseFloat(document.getElementById('balanceInp').value) || 1000; 
        luffyActive = document.getElementById('luffyMode').checked;
        document.getElementById('setup').style.display='none'; 
        document.getElementById('active').classList.remove('hidden'); 
        saveConfig(); 
    }
    function stop() { running = false; document.getElementById('setup').style.display='grid'; document.getElementById('active').classList.add('hidden'); saveConfig(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            const now = Date.now();
            let mVal = document.getElementById('marginInp').value;
            let mNum = parseFloat(mVal) || 0;

            let runningBal = initialBal;
            let loseStreak = 0;
            let lastMargin = 0;

            let historyRows = (d.history || []).map((h, index) => {
                let currentEquity = runningBal; 
                // Tính margin cho lệnh này
                if (index === 0 || lastMargin === 0) {
                    lastMargin = mVal.includes('%') ? (currentEquity * mNum / 100) : mNum;
                }

                let marginUsedThisTrade = lastMargin;
                let pnl = marginUsedThisTrade * (h.maxLev || 20) * ((h.pnlPercent || 0) / 100);
                runningBal += pnl;

                // Chuẩn bị cho lệnh tiếp theo
                if (luffyActive) {
                    if (h.status === 'WIN') {
                        loseStreak = 0;
                        lastMargin = marginUsedThisTrade * 2;
                    } else {
                        loseStreak++;
                        lastMargin = marginUsedThisTrade / 2;
                    }
                    // Reset nếu thua 5 lần hoặc lệnh vừa rồi đã ngốn >= 50% tổng vốn (Equity)
                    if (loseStreak >= d.config.maxLose || marginUsedThisTrade >= (currentEquity * d.config.maxEquity)) {
                        lastMargin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                        loseStreak = 0;
                    }
                } else {
                    lastMargin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                }

                return \`<tr class="border-b border-zinc-800/30">
                    <td class="py-2"><b class="text-white">\${h.symbol}</b><br><span class="text-zinc-500">\${new Date(h.endTime).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span></td>
                    <td class="text-center">\${h.maxLev}x</td>
                    <td class="font-bold text-yellow-500">\${marginUsedThisTrade.toFixed(1)}</td>
                    <td class="font-bold \${pnl>=0?'up':'down'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}</td>
                    <td class="text-right font-bold">\${runningBal.toFixed(1)}</td>
                </tr>\`;
            });

            document.getElementById('historyBody').innerHTML = historyRows.reverse().join('');

            let marginForPending = lastMargin || (mVal.includes('%') ? (runningBal * mNum / 100) : mNum);
            let totalUnPnl = 0;
            document.getElementById('pendingContainer').innerHTML = (d.pending || []).map(h => {
                let livePrice = (d.live || []).find(c => c.symbol === h.symbol)?.currentPrice || h.snapPrice;
                let diff = ((livePrice - h.snapPrice) / h.snapPrice) * 100;
                let roi = (h.type === 'UP' ? diff : -diff) * (h.maxLev || 20);
                let pnl = marginForPending * roi / 100;
                totalUnPnl += pnl;

                return \`<div class="bg-card p-3 rounded-md border-l-4 \${h.type==='UP'?'border-green-500':'border-red-500'}">
                    <div class="flex justify-between items-center">
                        <div><div class="text-lg font-bold text-white">\${h.symbol}</div><div class="text-[10px] \${h.type==='UP'?'up':'down'} font-bold">\${h.type} \${h.maxLev}x</div></div>
                        <div class="text-right"><div class="text-lg font-bold \${pnl>=0?'up':'down'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}</div><div class="text-[10px] font-medium text-gray-custom">ROI \${roi.toFixed(2)}%</div></div>
                    </div>
                    <div class="mt-2 text-[11px] flex justify-between border-t border-zinc-800 pt-2">
                        <span>Ký quỹ: <b class="text-yellow-500">\${marginForPending.toFixed(1)}</b></span>
                        <span>Giá vào: <b class="text-white">\${h.snapPrice.toFixed(4)}</b></span>
                    </div>
                </div>\`;
            }).join('');

            if(running) {
                let totalEquity = runningBal + totalUnPnl;
                document.getElementById('displayBal').innerText = totalEquity.toFixed(2);
                document.getElementById('walletBal').innerText = runningBal.toFixed(2);
                document.getElementById('unPnl').innerText = (totalUnPnl >= 0 ? '+' : '') + totalUnPnl.toFixed(2);
                document.getElementById('unPnl').className = 'text-lg font-bold ' + (totalUnPnl >= 0 ? 'up' : 'down');

                if (historyLog.length === 0 || now - historyLog[historyLog.length-1].t >= 60000) { 
                    historyLog.push({t: now, b: totalEquity}); 
                    if(historyLog.length > 100) historyLog.shift();
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
