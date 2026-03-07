// ==========================================
// CẤU HÌNH THÔNG SỐ (DỄ CHỈNH)
// ==========================================
const TP_ROI_BASE = 1;            
const SL_ROI_BASE = 0.5;          
const MIN_VOLATILITY = 5; 
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
const LEVERAGE_FILE = './leverage_cache.json';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

// Format 8 số cho coin rác, 4 số cho coin lớn
function fP(n) { 
    if (!n) return "0.00";
    return n < 1 ? n.toFixed(8) : n.toFixed(4); 
}

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
            const pending = allHistory.find(h => h.status === 'PENDING' && h.symbol === s);
            if (pending) {
                const lev = pending.maxLev || 20;
                const priceDiff = ((p - pending.snapPrice) / pending.snapPrice);
                const currentROI = (pending.type === 'UP' ? priceDiff : -priceDiff) * lev;
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
                            dynamicROI_TP: TP_ROI_BASE * Math.pow(2, (pending.revengeStep || 0) + 1)
                        });
                    }
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            if (!pending && (!lastTradeClosed[s] || now - lastTradeClosed[s] > COOLDOWN_MINUTES * 60000) && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY) {
                historyMap.set(`${s}_${now}`, { symbol: s, startTime: now, snapPrice: p, type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', maxLev: symbolMaxLeverage[s] || 20, revengeStep: 0, dynamicROI_TP: TP_ROI_BASE });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10),
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING')
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Revenge Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .bg-card { background: #1e2329; } .up { color: #0ecb81; } .down { color: #f6465d; }
        input { background: #000; border: 1px solid #333; color: #f0b90b; padding: 2px 5px; border-radius: 4px; outline: none; }
        th { color: #848e9c; font-weight: normal; font-size: 10px; text-transform: uppercase; padding: 8px 4px; }
        td { padding: 8px 4px; font-size: 11px; border-bottom: 1px solid #2b3139; }
    </style></head><body class="p-2">

    <div id="setup" class="bg-card p-3 rounded-lg mb-4 grid grid-cols-3 gap-2 border border-zinc-700">
        <div><label class="block text-[9px] text-gray-500">VỐN GỐC</label><input id="balanceInp" type="number" value="1000" class="w-full font-bold"></div>
        <div><label class="block text-[9px] text-gray-500">MARGIN %</label><input id="marginInp" type="text" value="10%" class="w-full font-bold"></div>
        <div><label class="block text-[9px] text-gray-500">MAX SLOTS</label><input id="maxSlots" type="number" value="3" class="w-full"></div>
        <button onclick="start()" class="col-span-3 bg-yellow-500 text-black font-bold py-2 rounded mt-1 uppercase text-xs">Kích hoạt Bot</button>
    </div>

    <div class="flex justify-between items-center mb-4 px-1">
        <div><div class="text-[10px] text-gray-500 font-bold uppercase">Equity</div><div id="displayBal" class="text-2xl font-bold">0.00</div></div>
        <div id="status" class="hidden text-[10px] font-bold text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded border border-yellow-500/20 animate-pulse">CROSS MODE ACTIVE</div>
    </div>

    <div class="mb-6">
        <div class="text-[10px] font-bold text-gray-500 mb-2 uppercase tracking-widest px-1">Vị thế đang mở (<span id="slotCount">0</span>)</div>
        <div id="pendingContainer" class="space-y-3"></div>
    </div>

    <div class="bg-card rounded-lg p-2 mb-6 border border-zinc-800">
        <div class="text-[10px] font-bold text-gray-400 mb-2 uppercase italic border-b border-zinc-800 pb-1 px-1">Biến động thị trường</div>
        <table class="w-full text-left">
            <thead><tr><th>Symbol</th><th class="text-right">1M</th><th class="text-right">5M</th><th class="text-right">15M</th></tr></thead>
            <tbody id="liveBody"></tbody>
        </table>
    </div>

    <div class="bg-card rounded-lg p-2 border border-zinc-800">
        <div class="text-[10px] font-bold text-gray-400 mb-2 uppercase italic border-b border-zinc-800 pb-1 px-1">Lịch sử vị thế</div>
        <div class="overflow-x-auto">
            <table class="w-full text-left min-w-[500px]">
                <thead><tr><th>Thời gian</th><th>Cặp Coin</th><th>Side</th><th>Margin</th><th>Giá Vào/Ra</th><th>TP/SL Cài</th><th>PnL/ROI</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000, slots = 3;
    const SL_ROI = ${SL_ROI_BASE};

    function f(n) { return (!n) ? "0.00" : (n < 1 ? n.toFixed(8) : n.toFixed(4)); }

    function start() { 
        running = true; initialBal = parseFloat(document.getElementById('balanceInp').value);
        slots = parseInt(document.getElementById('maxSlots').value);
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('status').classList.remove('hidden');
    }

    async function update() {
        if(!running) return;
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            let mVal = document.getElementById('marginInp').value;
            let mNum = parseFloat(mVal);
            let runningBal = initialBal;

            // Render Lịch sử dạng Bảng
            let hRows = d.history.sort((a,b)=>a.endTime-b.endTime).map(h => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let mUsed = Math.min(mBase * Math.pow(2, h.revengeStep || 0), runningBal * 0.5);
                let pnl = mUsed * (h.pnlPercentROI || 0);
                runningBal += pnl;

                let tpG = h.type === 'UP' ? h.snapPrice*(1+((h.dynamicROI_TP||1)/h.maxLev)) : h.snapPrice*(1-((h.dynamicROI_TP||1)/h.maxLev));
                let slG = h.type === 'UP' ? h.snapPrice*(1-(SL_ROI/h.maxLev)) : h.snapPrice*(1+(SL_ROI/h.maxLev));

                return \`<tr>
                    <td class="text-gray-500">\${new Date(h.endTime).toLocaleTimeString()}</td>
                    <td class="font-bold text-white">\${h.symbol} <span class="text-[8px] text-gray-500">\${h.maxLev}x</span></td>
                    <td class="\${h.type==='UP'?'up':'down'} font-bold">\${h.type==='UP'?'LONG':'SHORT'}</td>
                    <td class="text-yellow-500">\${mUsed.toFixed(2)}</td>
                    <td class="text-gray-400">\${f(h.snapPrice)}<br>\${f(h.finalPrice)}</td>
                    <td class="text-[9px] text-gray-500">TP: \${f(tpG)}<br>SL: \${f(slG)}</td>
                    <td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}<br>(\${((h.pnlPercentROI||0)*100).toFixed(0)}%)</td>
                </tr>\`;
            });
            document.getElementById('historyBody').innerHTML = hRows.reverse().join('');

            // Render Vị thế đang mở kèm Margin
            let totalUnPnl = 0, activeSlots = 0, pHTML = "";
            d.pending.sort((a,b)=>(b.revengeStep||0)-(a.revengeStep||0)).forEach(h => {
                if (activeSlots < slots || h.revengeStep > 0) {
                    activeSlots++;
                    let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                    let mUsed = Math.min(mBase * Math.pow(2, h.revengeStep || 0), runningBal * 0.5);
                    let liveP = (d.live.find(c => c.symbol === h.symbol)?.currentPrice) || h.snapPrice;
                    let roi = (h.type === 'UP' ? (liveP - h.snapPrice)/h.snapPrice : (h.snapPrice - liveP)/h.snapPrice) * h.maxLev;
                    let pnl = mUsed * roi; totalUnPnl += pnl;

                    let tpP = h.type === 'UP' ? h.snapPrice*(1+(h.dynamicROI_TP/h.maxLev)) : h.snapPrice*(1-(h.dynamicROI_TP/h.maxLev));
                    let slP = h.type === 'UP' ? h.snapPrice*(1-(SL_ROI/h.maxLev)) : h.snapPrice*(1+(SL_ROI/h.maxLev));

                    pHTML += \`<div class="bg-card p-3 rounded border-l-4 \${h.type==='UP'?'border-green-500':'border-red-500'}">
                        <div class="flex justify-between items-center mb-1">
                            <b class="text-white text-xs">\${h.symbol} \${h.revengeStep>0?'[GỠ X'+Math.pow(2,h.revengeStep)+']':''}</b>
                            <b class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)} USDT (\${(roi*100).toFixed(1)}%)</b>
                        </div>
                        <div class="grid grid-cols-2 gap-x-4 text-[10px]">
                            <div class="text-gray-400">Margin: <span class="text-yellow-500 font-bold">\${mUsed.toFixed(2)}</span> | Side: <span class="\${h.type==='UP'?'up':'down'} uppercase">\${h.type}</span></div>
                            <div class="text-right text-gray-500">Entry: \${f(h.snapPrice)} | Mark: \${f(liveP)}</div>
                            <div class="text-green-500">TP: \${f(tpP)}</div>
                            <div class="text-red-500 text-right">SL: \${f(slP)}</div>
                        </div>
                    </div>\`;
                }
            });
            document.getElementById('pendingContainer').innerHTML = pHTML || '<div class="text-center py-4 text-gray-600 text-[10px]">Scanning markets...</div>';
            document.getElementById('slotCount').innerText = activeSlots;
            document.getElementById('displayBal').innerText = (runningBal + totalUnPnl).toFixed(2);

            // Render Bảng Biến Động
            document.getElementById('liveBody').innerHTML = d.live.map(c => 
                \`<tr><td class="font-bold text-white py-1">\${c.symbol}</td>
                <td class="text-right \${c.c1>=0?'up':'down'}">\${c.c1}%</td>
                <td class="text-right \${c.c5>=0?'up':'down'}">\${c.c5}%</td>
                <td class="text-right \${c.c15>=0?'up':'down'}">\${c.c15}%</td></tr>\`
            ).join('');
        } catch(e) {}
    }
    setInterval(update, 2000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Server: http://localhost:${PORT}/gui`); });
