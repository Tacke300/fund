// ==========================================
// CẤU HÌNH THÔNG SỐ (DỄ CHỈNH)
// ==========================================
const TP_BASE = 0.3;              // Chốt lời cơ bản (%)
const SL_BASE = 0.9;              // Cắt lỗ giữ nguyên (%)
const MIN_VOLATILITY = 5; 
const COOLDOWN_MINUTES = 10;      
const PORT = 9000;

// Cơ chế Gỡ (Revenge Trade)
const MAX_REVENGE_STEPS = 3;      // Tối đa 3 lần gỡ x2
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
            const pendingOrders = allHistory.filter(h => h.status === 'PENDING');
            
            const pending = pendingOrders.find(h => h.symbol === s);
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const currentTP = pending.dynamicTP || TP_BASE; // Lấy TP riêng của lệnh đó
                
                const win = pending.type === 'UP' ? diff >= currentTP : diff <= -currentTP; 
                const lose = pending.type === 'UP' ? diff <= -SL_BASE : diff >= SL_BASE; 

                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = win ? currentTP : -SL_BASE;
                    lastTradeClosed[s] = now;

                    if (pending.status === 'LOSE') {
                        let step = (pending.revengeStep || 0) + 1;
                        if (step <= MAX_REVENGE_STEPS) {
                            const revType = pending.type === 'UP' ? 'DOWN' : 'UP';
                            historyMap.set(`${s}_${now + 1}`, {
                                symbol: s, startTime: now + 1, snapPrice: p,
                                type: revType, status: 'PENDING',
                                maxLev: symbolMaxLeverage[s] || 20,
                                revengeStep: step,
                                dynamicTP: TP_BASE * Math.pow(2, step), // X2 TP theo mỗi lần x2 Margin
                                snapVol: { c1, c5, c15 }
                            });
                        }
                    }
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            const isOccupied = pendingOrders.some(h => h.symbol === s);
            
            if (!isOccupied && !isCooldown && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, 
                    type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20,
                    revengeStep: 0,
                    dynamicTP: TP_BASE, // Lệnh đầu tiên TP chuẩn
                    snapVol: { c1, c5, c15 }
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
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>a.endTime-b.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Revenge Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; }
    </style></head><body>
    
    <div class="p-4 sticky top-0 bg-[#0b0e11] z-50 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-3 gap-2 mb-4 bg-card p-3 rounded-lg border border-zinc-700">
            <div><label class="text-[10px] text-gray-400">VỐN</label><input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-1 rounded w-full text-yellow-500 font-bold"></div>
            <div><label class="text-[10px] text-gray-400">MARGIN %</label><input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-1 rounded w-full text-yellow-500 font-bold"></div>
            <div><label class="text-[10px] text-gray-400">MAX SLOTS</label><input id="maxSlots" type="number" value="3" class="bg-black border border-zinc-700 p-1 rounded w-full text-white font-bold"></div>
            <button onclick="start()" class="col-span-3 bg-yellow-500 text-black py-2 rounded font-bold uppercase text-xs mt-2">Kích hoạt</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
             <h1 class="font-bold italic text-white uppercase text-sm">BINANCE <span class="text-yellow-500">REVENGE</span></h1>
             <button onclick="stop()" class="text-xs bg-red-500/20 text-red-500 px-2 py-1 rounded">STOP</button>
        </div>

        <div class="flex justify-between items-end">
            <div><div class="text-[10px] text-gray-400 uppercase">Equity (Vốn + Lãi)</div><div id="displayBal" class="text-2xl font-bold text-white">0.00</div></div>
            <div class="text-right"><div class="text-[10px] text-gray-400 uppercase">PnL</div><div id="unPnl" class="font-bold text-lg">0.00</div></div>
        </div>
    </div>

    <div class="p-4">
        <div class="text-xs font-bold text-gray-400 uppercase mb-3 tracking-widest">Đang thực thi (<span id="slotCount">0</span> Slots)</div>
        <div id="pendingContainer" class="space-y-3 mb-6"></div>

        <div class="bg-card rounded-lg p-3 mb-6 border border-zinc-800">
            <div class="text-[10px] font-bold text-gray-400 mb-2 uppercase border-b border-zinc-800 pb-1">Thị trường</div>
            <table class="w-full text-[11px] text-left">
                <tbody id="liveBody"></tbody>
            </table>
        </div>

        <div class="bg-card rounded-lg p-3">
            <div class="text-[10px] font-bold text-gray-400 mb-2 uppercase border-b border-zinc-800 pb-1">Lịch sử dồn vốn</div>
            <div class="overflow-x-auto">
                <table class="w-full text-[9px] text-left">
                    <thead><tr class="text-gray-500 uppercase"><th>Coin</th><th>Gỡ</th><th>Margin</th><th>TP (%)</th><th>PnL</th><th>Equity</th></tr></thead>
                    <tbody id="historyBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000, slots = 3;
    
    function start() { 
        running = true; 
        initialBal = parseFloat(document.getElementById('balanceInp').value);
        slots = parseInt(document.getElementById('maxSlots').value);
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('active').classList.remove('hidden');
    }
    function stop() { running = false; document.getElementById('setup').classList.remove('hidden'); document.getElementById('active').classList.add('hidden'); }

    async function update() {
        if(!running) return;
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            let mVal = document.getElementById('marginInp').value;
            let mNum = parseFloat(mVal);
            let runningBal = initialBal;
            
            let historyRows = (d.history || []).map((h) => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let mUsed = mBase * Math.pow(2, h.revengeStep || 0);
                if (mUsed > runningBal * 0.5) mUsed = runningBal * 0.5;

                let pnl = mUsed * (h.maxLev || 20) * (h.pnlPercent / 100);
                runningBal += pnl;

                return \`<tr class="border-b border-zinc-800/50">
                    <td class="py-2 text-white font-bold">\${h.symbol}</td>
                    <td>\${h.revengeStep > 0 ? 'X'+Math.pow(2,h.revengeStep) : '-'}</td>
                    <td class="text-yellow-500">\${mUsed.toFixed(1)}</td>
                    <td class="text-zinc-400">\${(h.dynamicTP || 0).toFixed(2)}%</td>
                    <td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td>
                    <td class="text-right">\${runningBal.toFixed(1)}</td>
                </tr>\`;
            });
            document.getElementById('historyBody').innerHTML = historyRows.reverse().join('');

            let totalUnPnl = 0, activeSlots = 0, pendingHTML = "";
            let displayOrders = d.pending.sort((a,b) => (b.revengeStep || 0) - (a.revengeStep || 0));

            displayOrders.forEach(h => {
                if (activeSlots < slots || h.revengeStep > 0) {
                    activeSlots++;
                    let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                    let mUsed = mBase * Math.pow(2, h.revengeStep || 0);
                    if (mUsed > runningBal * 0.5) mUsed = runningBal * 0.5;

                    let liveP = (d.live.find(c => c.symbol === h.symbol)?.currentPrice) || h.snapPrice;
                    let roi = (h.type === 'UP' ? (liveP - h.snapPrice)/h.snapPrice : (h.snapPrice - liveP)/h.snapPrice) * (h.maxLev || 20) * 100;
                    let pnl = mUsed * roi / 100;
                    totalUnPnl += pnl;

                    pendingHTML += \`<div class="bg-card p-3 rounded border-l-4 \${h.revengeStep>0?'border-yellow-500':'border-zinc-500'}">
                        <div class="flex justify-between items-center">
                            <b class="text-white">\${h.symbol} \${h.revengeStep>0?'(GỠ '+h.revengeStep+')':''}</b>
                            <b class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</b>
                        </div>
                        <div class="grid grid-cols-2 text-[10px] mt-2 text-gray-400">
                            <div>Margin: <span class="text-yellow-500">\${mUsed.toFixed(1)}</span> (\${h.type})</div>
                            <div class="text-right">TP Target: <span class="text-green-500">\${(h.dynamicTP).toFixed(2)}%</span></div>
                            <div>ROI: <span class="\${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</span></div>
                            <div class="text-right">SL: <span class="text-red-500">\${SL_BASE}%</span></div>
                        </div>
                    </div>\`;
                }
            });

            document.getElementById('pendingContainer').innerHTML = pendingHTML;
            document.getElementById('slotCount').innerText = activeSlots;
            document.getElementById('displayBal').innerText = (runningBal + totalUnPnl).toFixed(2);
            document.getElementById('unPnl').innerText = (totalUnPnl >= 0 ? '+' : '') + totalUnPnl.toFixed(2);
            document.getElementById('unPnl').className = totalUnPnl >= 0 ? 'up font-bold' : 'down font-bold';

            document.getElementById('liveBody').innerHTML = d.live.slice(0,10).map(c => 
                \`<tr class="border-b border-zinc-800/30"><td class="py-1 font-bold">\${c.symbol}</td><td class="up text-center">\${c.c1}%</td><td class="down text-center">\${c.c5}%</td><td class="text-right">\${c.c15}%</td></tr>\`
            ).join('');

        } catch(e) {}
    }
    setInterval(update, 2000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Server: http://localhost:${PORT}/gui`); });
