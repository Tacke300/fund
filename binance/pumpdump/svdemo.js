// ==========================================
// CẤU HÌNH LOGIC (DỄ CHỈNH)
// ==========================================
const TP_ROI_BASE = 2;            
const SL_ROI_BASE = 2;          
const MIN_VOLATILITY = 4; 
const COOLDOWN_MINUTES = 10;      
const PORT = 9000;
const MAX_REVENGE_STEPS = 3;      
// ==========================================

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const HISTORY_FILE = './history_db.json';
const STATE_FILE = './bot_state.json';
const LEVERAGE_FILE = './leverage_cache.json';

const app = express();
app.use(express.json());

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let botState = { running: false, initialBal: 1000, marginStr: "10%", maxSlots: 3 };

if (fs.existsSync(STATE_FILE)) {
    try { botState = JSON.parse(fs.readFileSync(STATE_FILE)); } catch(e) {}
}

function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(botState)); }
function f(n) { return (!n) ? "0.00" : (n < 1 ? n.toFixed(8) : n.toFixed(4)); }

// Lấy Leverage tối đa từ Binance
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
        if (!botState.running) return;
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
            const pending = allHistory.find(h => h.status === 'PENDING' && h.symbol === s);
            
            if (pending) {
                const lev = pending.maxLev || 20;
                const currentROI = (pending.type === 'UP' ? (p - pending.snapPrice)/pending.snapPrice : (pending.snapPrice - p)/pending.snapPrice) * lev;
                const targetROI = pending.dynamicROI_TP || TP_ROI_BASE;
                
                if (currentROI >= targetROI || currentROI <= -SL_ROI_BASE) { 
                    pending.status = currentROI >= targetROI ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercentROI = pending.status === 'WIN' ? targetROI : -SL_ROI_BASE;
                    lastTradeClosed[s] = now;
                    if (pending.status === 'LOSE' && (pending.revengeStep || 0) < MAX_REVENGE_STEPS) {
                        historyMap.set(`${s}_${now + 1}`, {
                            symbol: s, startTime: now + 1, snapPrice: p, type: pending.type === 'UP' ? 'DOWN' : 'UP',
                            status: 'PENDING', maxLev: lev, revengeStep: (pending.revengeStep || 0) + 1,
                            dynamicROI_TP: TP_ROI_BASE * Math.pow(2, (pending.revengeStep || 0) + 1),
                            snapVol: { c1, c5, c15 }
                        });
                    }
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            const activeSlots = allHistory.filter(h => h.status === 'PENDING').length;
            if (!pending && activeSlots < botState.maxSlots && (!lastTradeClosed[s] || now - lastTradeClosed[s] > COOLDOWN_MINUTES * 60000) && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', 
                    status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, revengeStep: 0, 
                    dynamicROI_TP: TP_ROI_BASE, snapVol: { c1, c5, c15 } 
                });
            }
        });
    });
}

app.post('/api/control', (req, res) => { botState = { ...botState, ...req.body }; saveState(); res.json({ status: 'ok' }); });
app.get('/api/data', (req, res) => { res.json({ state: botState, live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10), pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'), history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING') }); });

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0">
    <title>Luffy Fixed Dashboard</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'JetBrains Mono', monospace; overflow-x: hidden; }
        .bg-card { background: #1e2329; border: 1px solid #2b3139; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        input { background: #000; border: 1px solid #333; color: #f0b90b; padding: 10px; border-radius: 4px; outline: none; font-size: 14px; width: 100%; }
        th { color: #848e9c; font-size: 9px; text-transform: uppercase; padding: 12px 8px; border-bottom: 1px solid #2b3139; white-space: nowrap; }
        td { padding: 10px 8px; font-size: 11px; border-bottom: 1px solid #2b3139; white-space: nowrap; }
        .sticky-header { position: sticky; top: 0; background: #0b0e11; z-index: 100; border-bottom: 1px solid #2b3139; }
        .btn-green { background: #0ecb81; color: #000; font-weight: bold; padding: 12px; border-radius: 4px; text-transform: uppercase; font-size: 12px; transition: 0.3s; }
        .btn-red { background: #f6465d; color: #fff; font-weight: bold; padding: 12px; border-radius: 4px; text-transform: uppercase; font-size: 12px; }
    </style></head><body>

    <div class="sticky-header p-3">
        <div class="grid grid-cols-3 gap-2 mb-3">
            <div><label class="block text-[9px] text-gray-500 uppercase mb-1">Balance</label><input id="balanceInp" type="number"></div>
            <div><label class="block text-[9px] text-gray-500 uppercase mb-1">Margin %</label><input id="marginInp" type="text"></div>
            <div><label class="block text-[9px] text-gray-500 uppercase mb-1">Max Slots</label><input id="maxSlotsInp" type="number"></div>
        </div>
        <div class="flex gap-2">
            <button id="btnStart" onclick="updateBot(true)" class="btn-green flex-1">Start Engine</button>
            <button id="btnStop" onclick="updateBot(false)" class="btn-red flex-1 hidden">Stop Engine</button>
        </div>
        <div class="flex justify-between items-end mt-4">
            <div><div id="displayBal" class="text-3xl font-bold text-white tracking-tighter">0.00</div><div class="text-[9px] text-gray-500 uppercase">Tài sản (Equity)</div></div>
            <div id="statusBadge" class="text-[9px] font-bold px-2 py-1 rounded border border-zinc-800 text-gray-500 uppercase tracking-widest">OFFLINE</div>
        </div>
    </div>

    <div class="p-3 space-y-6">
        <section>
            <div class="text-[10px] font-bold text-gray-500 uppercase mb-3 flex justify-between px-1 tracking-widest"><span>Vị thế đang mở</span> <span id="slotCount">0/0</span></div>
            <div id="pendingContainer" class="space-y-3"></div>
        </section>

        <section class="bg-card rounded-lg overflow-hidden">
            <div class="p-2 text-[10px] font-bold text-gray-400 uppercase bg-black/40">Market Heatmap</div>
            <table class="w-full text-left">
                <thead><tr><th class="pl-3">Symbol</th><th class="text-right">1M</th><th class="text-right">5M</th><th class="text-right pr-3">15M</th></tr></thead>
                <tbody id="liveBody"></tbody>
            </table>
        </section>

        <section class="bg-card rounded-lg overflow-hidden shadow-2xl">
            <div class="p-2 text-[10px] font-bold text-gray-400 uppercase bg-black/40">Chi tiết lịch sử vị thế</div>
            <div class="overflow-x-auto">
                <table class="w-full text-left">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Symbol</th>
                            <th>Side/Lev</th>
                            <th>Margin</th>
                            <th>Entry Price</th>
                            <th>Exit Price</th>
                            <th>TP/SL Cài</th>
                            <th>Biến Động</th>
                            <th>PnL/ROI</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody"></tbody>
                </table>
            </div>
        </section>
    </div>

    <script>
    let isEditing = false; // Biến kiểm tra nếu đang gõ thì không cập nhật input

    // Lắng nghe sự kiện người dùng bắt đầu gõ
    ['balanceInp', 'marginInp', 'maxSlotsInp'].forEach(id => {
        document.getElementById(id).addEventListener('focus', () => { isEditing = true; });
        document.getElementById(id).addEventListener('blur', () => { isEditing = false; });
    });

    async function updateBot(run) {
        const data = { 
            running: run, 
            initialBal: parseFloat(document.getElementById('balanceInp').value), 
            marginStr: document.getElementById('marginInp').value, 
            maxSlots: parseInt(document.getElementById('maxSlotsInp').value) 
        };
        await fetch('/api/control', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
        isEditing = false;
    }

    function f(n) { return (!n) ? "0.00" : (n < 1 ? n.toFixed(8) : n.toFixed(4)); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            
            // CHỈ CẬP NHẬT INPUT KHI NGƯỜI DÙNG KHÔNG ĐANG GÕ
            if (!isEditing) {
                document.getElementById('balanceInp').value = d.state.initialBal;
                document.getElementById('marginInp').value = d.state.marginStr;
                document.getElementById('maxSlotsInp').value = d.state.maxSlots;
            }
            
            if (d.state.running) {
                document.getElementById('btnStart').classList.add('hidden'); document.getElementById('btnStop').classList.remove('hidden');
                document.getElementById('statusBadge').className = "text-[9px] font-bold px-2 py-1 rounded border border-yellow-500/50 text-yellow-500 bg-yellow-500/10";
                document.getElementById('statusBadge').innerText = "LIVE ENGINE";
            } else {
                document.getElementById('btnStart').classList.remove('hidden'); document.getElementById('btnStop').classList.add('hidden');
                document.getElementById('statusBadge').className = "text-[9px] font-bold px-2 py-1 rounded border border-zinc-700 text-gray-500";
                document.getElementById('statusBadge').innerText = "STOPPED";
            }

            let runningBal = d.state.initialBal;
            let mVal = d.state.marginStr;
            let mNum = parseFloat(mVal);

            // Bảng Lịch Sử
            let hRows = d.history.sort((a,b)=>a.endTime-b.endTime).map(h => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let mUsed = Math.min(mBase * Math.pow(2, h.revengeStep || 0), runningBal * 0.5);
                let pnl = mUsed * (h.pnlPercentROI || 0); runningBal += pnl;
                let tpP = h.type === 'UP' ? h.snapPrice*(1+((h.dynamicROI_TP||1)/h.maxLev)) : h.snapPrice*(1-((h.dynamicROI_TP||1)/h.maxLev));
                let slP = h.type === 'UP' ? h.snapPrice*(1-(${SL_ROI_BASE}/h.maxLev)) : h.snapPrice*(1+(${SL_ROI_BASE}/h.maxLev));
                let vol = h.snapVol ? \`\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}\` : '--';

                return \`<tr>
                    <td class="text-gray-500 text-[10px] font-mono">\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td class="font-bold text-white">\${h.symbol}</td>
                    <td class="\${h.type==='UP'?'up':'down'} font-bold text-[9px] uppercase">\${h.type} \${h.maxLev}x</td>
                    <td class="text-yellow-500 font-bold">\${mUsed.toFixed(2)}</td>
                    <td class="text-gray-400 font-mono">\${f(h.snapPrice)}</td>
                    <td class="text-white font-bold font-mono">\${f(h.finalPrice)}</td>
                    <td class="text-[9px] text-gray-500 font-mono">T:\${f(tpP)}<br>S:\${f(slP)}</td>
                    <td class="text-gray-500 text-[9px]">\${vol}</td>
                    <td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}<br>\${((h.pnlPercentROI||0)*100).toFixed(0)}%</td>
                </tr>\`;
            });
            document.getElementById('historyBody').innerHTML = hRows.reverse().join('');

            // Vị Thế Đang Mở
            let totalUnPnl = 0, pHTML = "";
            d.pending.forEach(h => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let mUsed = Math.min(mBase * Math.pow(2, h.revengeStep || 0), runningBal * 0.5);
                let liveP = (d.live.find(c => c.symbol === h.symbol)?.currentPrice) || h.snapPrice;
                let roi = (h.type === 'UP' ? (liveP - h.snapPrice)/h.snapPrice : (h.snapPrice - liveP)/h.snapPrice) * h.maxLev;
                let pnl = mUsed * roi; totalUnPnl += pnl;
                let tpP = h.type === 'UP' ? h.snapPrice*(1+(h.dynamicROI_TP/h.maxLev)) : h.snapPrice*(1-(h.dynamicROI_TP/h.maxLev));
                let slP = h.type === 'UP' ? h.snapPrice*(1-(${SL_ROI_BASE}/h.maxLev)) : h.snapPrice*(1+(${SL_ROI_BASE}/h.maxLev));

                pHTML += \`<div class="bg-card p-4 rounded border-l-4 \${h.type==='UP'?'border-green-500':'border-red-500'}">
                    <div class="flex justify-between items-center mb-2"><b class="text-white">\${h.symbol} \${h.revengeStep>0?'[GỠ X'+Math.pow(2,h.revengeStep)+']':''}</b><b class="\${pnl>=0?'up':'down'} text-lg">\${pnl.toFixed(2)}</b></div>
                    <div class="grid grid-cols-2 text-[10px] gap-y-2 font-mono">
                        <div>Margin: <span class="text-yellow-500 font-bold">\${mUsed.toFixed(2)}</span></div><div class="text-right">ROI: <span class="\${roi>=0?'up':'down'}">\${(roi*100).toFixed(1)}%</span></div>
                        <div class="text-green-500">TP: \${f(tpP)}</div><div class="text-red-500 text-right">SL: \${f(slP)}</div>
                        <div class="text-gray-500">Entry: \${f(h.snapPrice)}</div><div class="text-right text-yellow-400">Mark: \${f(liveP)}</div>
                    </div>
                </div>\`;
            });
            document.getElementById('pendingContainer').innerHTML = pHTML || '<div class="text-center py-6 text-gray-700 italic text-[10px] border border-zinc-800 rounded">WAITING FOR SIGNAL...</div>';
            document.getElementById('slotCount').innerText = d.pending.length + ' / ' + d.state.maxSlots;
            document.getElementById('displayBal').innerText = (runningBal + totalUnPnl).toFixed(2);

            // Live Table
            document.getElementById('liveBody').innerHTML = d.live.map(c => 
                \`<tr><td class="font-bold py-2 pl-3 text-white">\${c.symbol}</td>
                <td class="text-right \${c.c1>=0?'up':'down'}">\${c.c1}%</td>
                <td class="text-right \${c.c5>=0?'up':'down'}">\${c.c5}%</td>
                <td class="text-right \${c.c15>=0?'up':'down'} pr-3">\${c.c15}%</td></tr>\`
            ).join('');
        } catch(e) {}
    }
    setInterval(update, 2000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Server: http://localhost:${PORT}/gui`); });
