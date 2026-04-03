const PORT = 9060;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 1440; // <--- SỬA SỐ PHÚT CHỐT LỆNH TẠI ĐÂY

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

let currentTP = 0.5, currentSL = 100.0, currentMinVol = 6.5;

function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    let s = p.toFixed(20);
    let match = s.match(/^-?\d+\.0*[1-9]/);
    if (!match) return p.toFixed(4);
    let index = match[0].length;
    return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
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
    const now = pArr[pArr.length - 1].t;
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                
                // --- Cập nhật ROI âm nhất & Thời điểm âm nhất ---
                const currentRoi = (pending.type === 'UP' ? diff : -diff) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) {
                    pending.maxNegativeRoi = currentRoi;
                    pending.maxNegativeTime = now; // Lưu lại thời điểm âm nhất
                }
                // -------------------------------------------------

                const win = pending.type === 'UP' ? diff >= pending.tpTarget : diff <= -pending.tpTarget; 
                const lose = pending.type === 'UP' ? diff <= -pending.slTarget : diff >= pending.slTarget; 
                
                const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);

                if (win || lose || isTimeout) { 
                    pending.status = win ? 'WIN' : (lose ? 'LOSE' : 'TIMEOUT'); 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'UP' ? diff : -diff);
                    
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !pending && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, 
                    // SỬA TẠI ĐÂY: Đảo ngược logic UP/DOWN
                    type: (c1 + c5 + c15 >= 0) ? 'DOWN' : 'UP', 
                    status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                    maxNegativeRoi: 0,
                    maxNegativeTime: now
                });
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp) || 0.5; currentSL = parseFloat(req.query.sl) || 10.0; currentMinVol = parseFloat(req.query.vol) || 5;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const topData = Object.entries(coinData)
        .filter(([_, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live }))
        .sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1));

    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        top5: topData.slice(0, 5),
        live: topData, 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        input { border: 1px solid #30363d !important; }
        .btn-glow { box-shadow: 0 0 10px rgba(252, 213, 53, 0.2); transition: all 0.3s; }
        .btn-glow:hover { box-shadow: 0 0 20px rgba(252, 213, 53, 0.4); transform: translateY(-1px); }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 shadow-2xl border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="bg-[#0b0e11] p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade</label><input id="marginInp" type="text" class="bg-[#0b0e11] p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">SL (%)</label><input id="slInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2 btn-glow">Lưu cấu hình & Khởi chạy hệ thống</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div id="user-id" class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer hover:bg-[#fcd535] hover:text-black transition-all" onclick="stop()">STOP ENGINE</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div><div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest leading-none mb-1">Tổng tài sản ước tính</div><span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span><span class="text-sm text-gray-custom ml-1">USDT</span></div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold leading-none mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>

        <div class="grid grid-cols-2 gap-4 text-[11px] border-t border-zinc-800 pt-3 mb-3 uppercase font-bold">
            <div><span class="text-gray-custom">Ký quỹ khả dụng: </span><span id="walletBal" class="text-white">0.00</span></div>
            <div class="text-right text-yellow-500/90 italic">
                TP: <span id="tpShow" class="text-white">0</span>% | SL: <span id="slShow" class="text-white">0</span>% | VOL: <span id="volShow" class="text-white">0</span>%
            </div>
        </div>

        <div class="grid grid-cols-2 gap-2 bg-black/40 p-2.5 rounded-lg border border-zinc-800">
            <div class="border-r border-zinc-800 flex justify-between px-2 items-center"><span id="winCount" class="text-xs font-bold up uppercase">0 Win</span><span id="winSum" class="text-sm font-bold up">+0.00</span></div>
            <div class="flex justify-between px-2 items-center"><span id="loseCount" class="text-xs font-bold down uppercase">0 Loss</span><span id="loseSum" class="text-sm font-bold down">-0.00</span></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr class="pb-2"><th>Time</th><th>Pair</th><th>Margin</th><th class="text-center">Lev/Target</th><th>Entry/Mark</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
         <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider">Top biến động thị trường</div>
         <div class="overflow-x-auto"><table class="w-full text-[11px] text-left"><thead><tr class="text-gray-custom text-[10px] border-b border-zinc-800"><th>SYMBOL</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-right">15M</th></tr></thead><tbody id="liveBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 pb-32"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>Time In-Out</th><th>Pair/Vol</th><th>Margin</th><th class="text-center">Target</th><th>Price Info</th><th class="text-center">Max Drawdown</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, initialBal = 1000;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;

    if(saved.running) {
        running = true; initialBal = saved.initialBal;
        document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
        syncConfig();
    }

    function fPrice(p) {
        if (!p || p === 0) return "0.0000";
        let s = p.toFixed(20); let match = s.match(/^-?\\d+\\.0*[1-9]/);
        if (!match) return p.toFixed(4);
        let index = match[0].length; return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
    }
    function syncConfig() {
        const tp = document.getElementById('tpInp').value, sl = document.getElementById('slInp').value, vol = document.getElementById('volInp').value;
        fetch(\`/api/config?tp=\${tp}&sl=\${sl}&vol=\${vol}\`);
        document.getElementById('tpShow').innerText = tp; document.getElementById('slShow').innerText = sl; document.getElementById('volShow').innerText = vol;
    }
    function start() {
        running = true; initialBal = parseFloat(document.getElementById('balanceInp').value);
        localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value }));
        syncConfig(); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);

            document.getElementById('liveBody').innerHTML = (d.top5 || []).map(c => \`<tr class="border-b border-zinc-800/50 hover:bg-white/5"><td class="py-2.5 font-bold text-white">\${c.symbol}</td><td class="text-center \${c.c1>=0?'up':'down'} font-medium">\${c.c1}%</td><td class="text-center \${c.c5>=0?'up':'down'} font-medium">\${c.c5}%</td><td class="text-right \${c.c15>=0?'up':'down'} font-medium">\${c.c15}%</td></tr>\`).join('');

            let runningBal = initialBal, winSum = 0, loseSum = 0, winCount = 0, loseCount = 0;
            let histHTML = [...d.history].reverse().map(h => {
                let margin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let netPnl = (margin * (h.maxLev || 20) * (h.pnlPercent/100)) - (margin * (h.maxLev || 20) * 0.001);
                runningBal += netPnl;
                if(netPnl >= 0) { winSum += netPnl; winCount++; } else { loseSum += netPnl; loseCount++; }
                let tpP = h.type==='UP' ? h.snapPrice*(1+h.tpTarget/100) : h.snapPrice*(1-h.tpTarget/100);
                let slP = h.type==='UP' ? h.snapPrice*(1-h.slTarget/100) : h.snapPrice*(1+h.slTarget/100);
                let v = h.snapVol || {c1:0,c5:0,c15:0};
                
                // Hiển thị Max Negative (PnL / ROI / Time)
                let maxNegRoi = h.maxNegativeRoi || 0;
                let maxNegPnl = (margin * maxNegRoi / 100);
                let maxNegTimeStr = h.maxNegativeTime ? new Date(h.maxNegativeTime).toLocaleTimeString([], {hour12:false}) : '--';

                return \`<tr class="border-b border-zinc-800/30 text-zinc-400 hover:bg-white/5">
                    <td class="py-2 text-[7px] font-medium">\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}<br>\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td><b class="text-white">\${h.symbol}</b><br><span class="text-[7px] text-zinc-500">\${v.c1} / \${v.c5} / \${v.c15}</span></td>
                    <td>\${margin.toFixed(1)}</td>
                    <td class="text-center text-[7px] font-bold text-yellow-500/70">\${h.maxLev}x<br>\${fPrice(tpP)} / \${fPrice(slP)}</td>
                    <td>\${fPrice(h.snapPrice)}<br>\${fPrice(h.finalPrice)}</td>
                    <td class="text-center down font-bold">
                        <span class="text-[9px]">\${maxNegPnl.toFixed(2)}$ / \${maxNegRoi.toFixed(1)}%</span><br>
                        <span class="text-[7px] text-zinc-500 italic">at \${maxNegTimeStr}</span>
                    </td>
                    <td class="\${netPnl>=0?'up':'down'} font-bold text-[10px]">\${netPnl >= 0 ? '+' : ''}\${netPnl.toFixed(2)}</td>
                    <td class="text-right text-white font-medium">\${runningBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');
            document.getElementById('historyBody').innerHTML = histHTML;

            let unPnl = 0, marginUsed = 0;
            document.getElementById('pendingBody').innerHTML = (d.pending || []).map(h => {
                let lp = d.allPrices[h.symbol] || h.snapPrice;
                let margin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum; marginUsed += margin;
                let roi = (h.type === 'UP' ? (lp-h.snapPrice)/h.snapPrice : (h.snapPrice-lp)/h.snapPrice) * 100 * (h.maxLev || 20);
                let pnl = margin * roi / 100; unPnl += pnl;
                let tpP = h.type==='UP' ? h.snapPrice*(1+h.tpTarget/100) : h.snapPrice*(1-h.tpTarget/100);
                let slP = h.type==='UP' ? h.snapPrice*(1-h.slTarget/100) : h.snapPrice*(1+h.slTarget/100);
                return \`<tr class="bg-white/5 border-b border-zinc-800">
                    <td class="py-3">\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td class="text-white font-bold">\${h.symbol} <span class="text-[8px] px-1 bg-zinc-700 rounded">\${h.type}</span></td>
                    <td>\${margin.toFixed(1)}</td>
                    <td class="text-center text-[7px] font-bold text-yellow-500/70">\${h.maxLev}x<br>\${fPrice(tpP)} / \${fPrice(slP)}</td>
                    <td>\${fPrice(h.snapPrice)}<br><b class="text-white">\${fPrice(lp)}</b></td>
                    <td class="text-right font-bold \${pnl>=0?'up':'down'} text-[11px]">\${pnl >= 0 ? '+' : ''}\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td>
                </tr>\`;
            }).join('');

            if(running) {
                document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
                document.getElementById('walletBal').innerText = (runningBal - marginUsed).toFixed(2);
                document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
                document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
                document.getElementById('winSum').innerText = '+' + winSum.toFixed(2); document.getElementById('loseSum').innerText = loseSum.toFixed(2);
                document.getElementById('winCount').innerText = winCount + ' Win'; document.getElementById('loseCount').innerText = loseCount + ' Loss';
            }
        } catch(e) {}
    }
    setInterval(update, 200);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
