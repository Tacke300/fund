// ==========================================
// CẤU HÌNH THÔNG SỐ (DỄ CHỈNH)
// ==========================================
const TP_ROI_BASE = 1;            // Chốt lời 100% ROI
const SL_ROI_BASE = 2;          // Cắt lỗ 50% ROI
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

// Hàm format giá linh hoạt: Nếu giá cực nhỏ thì lấy 8 số, nếu giá lớn lấy 4 số
function fP(price) {
    if (!price) return "0.00";
    return price < 1 ? price.toFixed(8) : price.toFixed(4);
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
            const pendingOrders = allHistory.filter(h => h.status === 'PENDING');
            const pending = pendingOrders.find(h => h.symbol === s);

            if (pending) {
                const lev = pending.maxLev || 20;
                const priceDiffPercent = ((p - pending.snapPrice) / pending.snapPrice);
                const currentROI = (pending.type === 'UP' ? priceDiffPercent : -priceDiffPercent) * lev;
                const targetROI = pending.dynamicROI_TP || TP_ROI_BASE;
                
                if (currentROI >= targetROI || currentROI <= -SL_ROI_BASE) { 
                    pending.status = currentROI >= targetROI ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercentROI = pending.status === 'WIN' ? targetROI : -SL_ROI_BASE;
                    lastTradeClosed[s] = now;

                    if (pending.status === 'LOSE') {
                        let step = (pending.revengeStep || 0) + 1;
                        if (step <= MAX_REVENGE_STEPS) {
                            historyMap.set(`${s}_${now + 1}`, {
                                symbol: s, startTime: now + 1, snapPrice: p,
                                type: pending.type === 'UP' ? 'DOWN' : 'UP', status: 'PENDING',
                                maxLev: lev, revengeStep: step,
                                dynamicROI_TP: TP_ROI_BASE * Math.pow(2, step),
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
                    revengeStep: 0, dynamicROI_TP: TP_ROI_BASE, snapVol: { c1, c5, c15 }
                });
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10),
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
        history: Array.from(historyMap.values()).filter(h => h.status !== 'PENDING').sort((a,b)=>a.endTime-b.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Bot - Multi Decimal</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'JetBrains Mono', monospace; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #2b3139; }
        input { background: #000 !important; border: 1px solid #333 !important; padding: 4px; border-radius: 4px; color: #f0b90b; outline: none; }
    </style></head><body class="p-2 sm:p-4">
    
    <div class="sticky top-0 bg-[#0b0e11] z-50 pb-4 border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-3 gap-2 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[9px] text-gray-400 uppercase">Vốn Gốc</label><input id="balanceInp" type="number" value="1000" class="w-full font-bold"></div>
            <div><label class="text-[9px] text-gray-400 uppercase">Margin %</label><input id="marginInp" type="text" value="10%" class="w-full font-bold"></div>
            <div><label class="text-[9px] text-gray-400 uppercase">Slots</label><input id="maxSlots" type="number" value="3" class="w-full text-white"></div>
            <button onclick="start()" class="col-span-3 bg-yellow-500 text-black py-2 rounded font-bold uppercase text-xs mt-1">Start Trading</button>
        </div>

        <div class="flex justify-between items-end">
            <div><div class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Equity</div><div id="displayBal" class="text-3xl font-bold text-white tracking-tighter">0.00</div></div>
            <div id="active" class="hidden flex items-center gap-2 bg-yellow-500/10 px-2 py-1 rounded border border-yellow-500/20">
                <div class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></div><span class="text-[10px] text-yellow-500 font-bold uppercase">Cross Active</span>
            </div>
        </div>
    </div>

    <div class="mt-6 space-y-6">
        <section>
            <div class="text-[10px] font-bold text-gray-500 uppercase mb-3 flex justify-between tracking-tighter"><span>Positions (<span id="slotCount">0</span> Slots)</span><span class="text-yellow-500">Auto-Scaling Decimals</span></div>
            <div id="pendingContainer" class="space-y-4"></div>
        </section>

        <section>
            <div class="text-[10px] font-bold text-gray-500 uppercase mb-3 italic">Position History (Full Details)</div>
            <div id="historyDetailed" class="space-y-3"></div>
        </section>
    </div>

    <script>
    let running = false, initialBal = 1000, slots = 3;
    const SL_ROI = ${SL_ROI_BASE};

    function f(n) { 
        if (!n) return "0.00";
        return n < 1 ? n.toFixed(8) : n.toFixed(4); 
    }

    function start() { 
        running = true; initialBal = parseFloat(document.getElementById('balanceInp').value);
        slots = parseInt(document.getElementById('maxSlots').value);
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('active').classList.remove('hidden');
    }

    async function update() {
        if(!running) return;
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            let mVal = document.getElementById('marginInp').value;
            let mNum = parseFloat(mVal);
            let runningBal = initialBal;

            // 1. Render Lịch sử (Cột TP/SL cài đặt)
            let historyHTML = (d.history || []).map((h) => {
                let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let mUsed = mBase * Math.pow(2, h.revengeStep || 0);
                if (mUsed > runningBal * 0.5) mUsed = runningBal * 0.5;
                let pnl = mUsed * (h.pnlPercentROI || 0);
                runningBal += pnl;

                // Tính toán TP/SL lúc đó
                let tROI = h.dynamicROI_TP || 1;
                let tP = h.type === 'UP' ? h.snapPrice*(1+(tROI/h.maxLev)) : h.snapPrice*(1-(tROI/h.maxLev));
                let sL = h.type === 'UP' ? h.snapPrice*(1-(SL_ROI/h.maxLev)) : h.snapPrice*(1+(SL_ROI/h.maxLev));

                return \`<div class="bg-card p-3 rounded-lg text-[10px] border border-zinc-800">
                    <div class="flex justify-between border-b border-zinc-800 pb-1 mb-2 text-gray-500">
                        <span>\${new Date(h.endTime).toLocaleString()}</span>
                        <span class="\${h.status==='WIN'?'up':'down'} font-bold">\${h.status}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-y-1">
                        <div class="text-white font-bold text-xs">\${h.symbol} <span class="text-gray-500 text-[8px]">\${h.maxLev}x CROSS</span></div>
                        <div class="text-right \${h.type==='UP'?'up':'down'} font-bold">\${h.type==='UP'?'LONG':'SHORT'}</div>
                        <div>Margin: \${mUsed.toFixed(2)}</div>
                        <div class="text-right">PnL: <b class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}</b></div>
                        <div>Entry: \${f(h.snapPrice)}</div>
                        <div class="text-right">Exit: \${f(h.finalPrice)}</div>
                        <div class="text-green-500">TP Target: \${f(tP)}</div>
                        <div class="text-red-500 text-right">SL Target: \${f(sL)}</div>
                    </div>
                </div>\`;
            });
            document.getElementById('historyDetailed').innerHTML = historyHTML.reverse().join('');

            // 2. Vị thế đang mở
            let totalUnPnl = 0, activeSlots = 0, pendingHTML = "";
            let displayOrders = d.pending.sort((a,b) => (b.revengeStep || 0) - (a.revengeStep || 0));

            displayOrders.forEach(h => {
                if (activeSlots < slots || h.revengeStep > 0) {
                    activeSlots++;
                    let mBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                    let mUsed = mBase * Math.pow(2, h.revengeStep || 0);
                    if (mUsed > runningBal * 0.5) mUsed = runningBal * 0.5;

                    let liveP = (d.live.find(c => c.symbol === h.symbol)?.currentPrice) || h.snapPrice;
                    let currentROI = (h.type === 'UP' ? (liveP - h.snapPrice)/h.snapPrice : (h.snapPrice - liveP)/h.snapPrice) * h.maxLev;
                    let pnl = mUsed * currentROI;
                    totalUnPnl += pnl;

                    let tpP = h.type === 'UP' ? h.snapPrice*(1+(h.dynamicROI_TP/h.maxLev)) : h.snapPrice*(1-(h.dynamicROI_TP/h.maxLev));
                    let slP = h.type === 'UP' ? h.snapPrice*(1-(SL_ROI/h.maxLev)) : h.snapPrice*(1+(SL_ROI/h.maxLev));

                    pendingHTML += \`<div class="bg-card p-4 rounded-xl border-t-2 \${h.type==='UP'?'border-green-500':'border-red-500'} shadow-xl">
                        <div class="flex justify-between items-start mb-2">
                            <div>
                                <div class="text-lg font-bold text-white tracking-tighter">\${h.symbol}</div>
                                <div class="text-[9px] font-bold uppercase text-gray-500">\${h.type === 'UP' ? 'Long' : 'Short'} \${h.revengeStep>0?'Revenge x'+Math.pow(2,h.revengeStep):'Base'}</div>
                            </div>
                            <div class="text-right">
                                <div class="text-xl font-bold \${pnl>=0?'up':'down'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}</div>
                                <div class="text-[10px] font-bold \${currentROI>=0?'up':'down'}">ROI \${(currentROI*100).toFixed(1)}%</div>
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-2 text-[10px] bg-black/40 p-2 rounded border border-zinc-800">
                            <div>ENTRY: <span class="text-white">\${f(h.snapPrice)}</span></div>
                            <div class="text-right">MARK: <span class="text-yellow-400 font-bold">\${f(liveP)}</span></div>
                            <div class="text-green-500 font-bold">TP: \${f(tpP)}</div>
                            <div class="text-red-500 font-bold text-right">SL: \${f(slP)}</div>
                        </div>
                    </div>\`;
                }
            });

            document.getElementById('pendingContainer').innerHTML = pendingHTML || '<div class="text-center py-10 text-gray-700 text-xs">Waiting for signals...</div>';
            document.getElementById('slotCount').innerText = activeSlots;
            document.getElementById('displayBal').innerText = (runningBal + totalUnPnl).toFixed(2);
        } catch(e) {}
    }
    setInterval(update, 2000);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Server: http://localhost:${PORT}/gui`); });
