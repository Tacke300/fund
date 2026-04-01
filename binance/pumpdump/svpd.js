const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 1440; 

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

let currentTP = 0.5, currentSL = 2.0, currentMinVol = 6.5; // currentSL giờ đóng vai trò là % để DCA

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
                // Tính khoảng cách giá từ Entry gần nhất để DCA
                const lastEntry = pending.dcaHistory[pending.dcaHistory.length - 1].price;
                const diffFromAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const diffFromLast = ((p - lastEntry) / lastEntry) * 100;
                
                // Cập nhật ROI âm nhất
                const currentRoi = (pending.type === 'UP' ? diffFromAvg : -diffFromAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) {
                    pending.maxNegativeRoi = currentRoi;
                    pending.maxNegativeTime = now;
                }

                // Kiểm tra điều kiện DCA (Giá đi ngược currentSL %)
                const shouldDCA = pending.type === 'UP' ? diffFromLast <= -pending.slTarget : diffFromLast >= pending.slTarget;
                if (shouldDCA) {
                    const newDcaIdx = pending.dcaCount + 1;
                    const newTotalMargin = pending.totalMargin + pending.initialMargin;
                    // Tính lại giá trung bình: (P1*M1 + P2*M2) / (M1+M2)
                    pending.avgPrice = ((pending.avgPrice * pending.totalMargin) + (p * pending.initialMargin)) / newTotalMargin;
                    pending.totalMargin = newTotalMargin;
                    pending.dcaCount = newDcaIdx;
                    pending.dcaHistory.push({
                        time: now,
                        price: p,
                        avgPriceAfter: pending.avgPrice,
                        margin: pending.initialMargin
                    });
                }

                // Kiểm tra Chốt lời (TP) dựa trên giá trung bình mới
                const win = pending.type === 'UP' ? diffFromAvg >= pending.tpTarget : diffFromAvg <= -pending.tpTarget; 
                const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);

                if (win || isTimeout) { 
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'UP' ? diffFromAvg : -diffFromAvg);
                    
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }

            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !pending && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, avgPrice: p,
                    type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, 
                    snapVol: { c1, c5, c15 },
                    maxNegativeRoi: 0, maxNegativeTime: now,
                    dcaCount: 0, initialMargin: 0, totalMargin: 0, // Sẽ được cập nhật ở Client GUI
                    dcaHistory: [{ time: now, price: p, avgPriceAfter: p, margin: 0 }] 
                });
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp) || 0.5; 
    currentSL = parseFloat(req.query.sl) || 2.0; 
    currentMinVol = parseFloat(req.query.vol) || 5;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const topData = Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1));
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
    <title>Binance Luffy Pro DCA</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .modal { display:none; position:fixed; z-index:100; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.8); }
    </style></head><body>
    
    <div id="dcaModal" class="modal flex items-center justify-center p-4">
        <div class="bg-card w-full max-w-2xl rounded-xl p-6 relative">
            <button onclick="closeModal()" class="absolute top-4 right-4 text-gray-custom text-2xl">&times;</button>
            <h3 id="modalTitle" class="text-xl font-bold text-yellow-500 mb-4">Chi tiết DCA</h3>
            <div class="overflow-y-auto max-h-[60vh]">
                <table class="w-full text-left text-xs">
                    <thead class="text-gray-custom border-b border-zinc-700">
                        <tr><th class="py-2">Lần</th><th>Thời gian</th><th>Giá DCA</th><th>Giá TB</th><th>Margin</th></tr>
                    </thead>
                    <tbody id="modalBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 shadow-2xl border-b border-zinc-800">
        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] uppercase font-bold text-gray-400">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="bg-[#0b0e11] p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] uppercase font-bold text-gray-400">Margin/Trade</label><input id="marginInp" type="text" class="bg-[#0b0e11] p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-400">TP (%)</label><input id="tpInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-400">DCA tại (%)</label><input id="slInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-400">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="bg-[#0b0e11] p-2 rounded w-full text-white outline-none text-sm"></div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">Lưu & Khởi chạy</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl">BINANCE <span class="text-[#fcd535]">LUFFY DCA</span></div>
            <div onclick="stop()" class="text-[#fcd535] font-black text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer">STOP</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div><div class="text-gray-400 text-[11px] uppercase font-bold">Tổng tài sản</div><span id="displayBal" class="text-4xl font-bold text-white">0.00</span><span class="text-sm text-gray-400 ml-1">USDT</span></div>
            <div class="text-right"><div class="text-gray-400 text-[11px] uppercase font-bold">PnL Live</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-white mb-3 uppercase flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2"></span> Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-400 uppercase border-b border-zinc-800">
            <tr><th>STT</th><th>Pair</th><th>DCA</th><th>Margin</th><th>Lev/Target</th><th>Entry/Avg</th><th class="text-right">PnL (ROI%)</th></tr>
        </thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-400 mb-3 uppercase italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-400 border-b border-zinc-800 uppercase">
            <tr><th>STT</th><th>Time</th><th>Pair/DCA</th><th>Margin</th><th>Target</th><th>Price Info</th><th class="text-center">Max Neg</th><th>PnL Net</th><th class="text-right">Balance</th></tr>
        </thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 pb-32"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase tracking-wider">Thống kê hiệu suất Coin</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-400 border-b border-zinc-800">
            <tr><th>STT</th><th>Tên Coin</th><th>Lev</th><th>Lệnh</th><th>DCA</th><th>PnL Lãi</th><th>PnL Lỗ</th><th class="text-right">Tổng PnL</th></tr>
        </thead><tbody id="statsBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, initialBal = 1000, currentData = null;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 2.0;
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
    }
    function start() {
        running = true; initialBal = parseFloat(document.getElementById('balanceInp').value);
        localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value }));
        syncConfig(); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    function showDcaDetail(symbol, startTime) {
        const item = [...currentData.pending, ...currentData.history].find(h => h.symbol === symbol && h.startTime == startTime);
        if(!item) return;
        document.getElementById('modalTitle').innerText = \`Chi tiết DCA: \${symbol}\`;
        document.getElementById('modalBody').innerHTML = item.dcaHistory.map((d, i) => \`
            <tr class="border-b border-zinc-800"><td class="py-2">\${i}</td><td>\${new Date(d.time).toLocaleTimeString()}</td><td>\${fPrice(d.price)}</td><td>\${fPrice(d.avgPriceAfter)}</td><td>\${d.margin.toFixed(2)}</td></tr>
        \`).join('');
        document.getElementById('dcaModal').style.display = 'flex';
    }
    function closeModal() { document.getElementById('dcaModal').style.display = 'none'; }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); currentData = d;
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let runningBal = initialBal, winSum = 0, loseSum = 0, winCount = 0, loseCount = 0;
            let coinStats = {};

            // Xử lý Lịch sử & Thống kê
            let histHTML = [...d.history].reverse().map((h, idx) => {
                let marginInit = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                h.initialMargin = marginInit; 
                h.totalMargin = marginInit * (h.dcaCount + 1);
                
                let netPnl = (h.totalMargin * (h.maxLev || 20) * (h.pnlPercent/100)) - (h.totalMargin * (h.maxLev || 20) * 0.001);
                runningBal += netPnl;
                
                if(netPnl >= 0) { winSum += netPnl; winCount++; } else { loseSum += netPnl; loseCount++; }

                // Gom dữ liệu thống kê
                if(!coinStats[h.symbol]) coinStats[h.symbol] = { lev: h.maxLev, count: 0, dca: 0, profit: 0, loss: 0 };
                coinStats[h.symbol].count++;
                coinStats[h.symbol].dca += h.dcaCount;
                if(netPnl >= 0) coinStats[h.symbol].profit += netPnl; else coinStats[h.symbol].loss += netPnl;

                let tpP = h.type==='UP' ? h.avgPrice*(1+h.tpTarget/100) : h.avgPrice*(1-h.tpTarget/100);
                return \`<tr class="border-b border-zinc-800/30 text-zinc-400">
                    <td>\${d.history.length - idx}</td>
                    <td class="py-2 text-[7px]">\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}<br>\${new Date(h.endTime).toLocaleTimeString([],{hour12:false})}</td>
                    <td><b class="text-white cursor-pointer underline" onclick="showDcaDetail('\${h.symbol}', \${h.startTime})">\${h.symbol}</b><br>DCA: \${h.dcaCount}</td>
                    <td>\${h.totalMargin.toFixed(1)}</td>
                    <td class="text-center text-[7px] text-yellow-500/70">\${h.maxLev}x<br>TP: \${fPrice(tpP)}</td>
                    <td>Avg: \${fPrice(h.avgPrice)}<br>End: \${fPrice(h.finalPrice)}</td>
                    <td class="text-center down text-[9px]">\${h.maxNegativeRoi.toFixed(1)}%</td>
                    <td class="\${netPnl>=0?'up':'down'} font-bold">\${netPnl.toFixed(2)}</td>
                    <td class="text-right text-white font-medium">\${runningBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');
            document.getElementById('historyBody').innerHTML = histHTML;

            // Xử lý Vị thế đang mở
            let unPnl = 0, marginUsed = 0;
            document.getElementById('pendingBody').innerHTML = (d.pending || []).map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let marginInit = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                h.initialMargin = marginInit;
                h.totalMargin = marginInit * (h.dcaCount + 1);
                marginUsed += h.totalMargin;

                let roi = (h.type === 'UP' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = h.totalMargin * roi / 100; unPnl += pnl;
                let tpP = h.type==='UP' ? h.avgPrice*(1+h.tpTarget/100) : h.avgPrice*(1-h.tpTarget/100);

                return \`<tr class="bg-white/5 border-b border-zinc-800">
                    <td class="py-3">\${idx + 1}</td>
                    <td class="text-white font-bold cursor-pointer underline" onclick="showDcaDetail('\${h.symbol}', \${h.startTime})">\${h.symbol} <span class="text-[8px] px-1 bg-zinc-700 rounded">\${h.type}</span></td>
                    <td class="text-yellow-500 font-bold">\${h.dcaCount}</td>
                    <td>\${h.totalMargin.toFixed(1)}</td>
                    <td class="text-center text-[7px] font-bold text-yellow-500/70">\${h.maxLev}x<br>TP: \${fPrice(tpP)}</td>
                    <td>\${fPrice(h.snapPrice)}<br><b class="text-white">Avg: \${fPrice(h.avgPrice)}</b></td>
                    <td class="text-right font-bold \${pnl>=0?'up':'down'} text-[11px]">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td>
                </tr>\`;
            }).join('');

            // Xử lý Bảng Thống kê Coin
            document.getElementById('statsBody').innerHTML = Object.entries(coinStats).map(([sym, s], i) => \`
                <tr class="border-b border-zinc-800">
                    <td class="py-2">\${i+1}</td>
                    <td class="font-bold text-white">\${sym}</td>
                    <td>\${s.lev}x</td>
                    <td>\${s.count}</td>
                    <td class="text-yellow-500">\${s.dca}</td>
                    <td class="up">\${s.profit.toFixed(2)}</td>
                    <td class="down">\${s.loss.toFixed(2)}</td>
                    <td class="text-right font-bold \${(s.profit+s.loss)>=0?'up':'down'}">\${(s.profit+s.loss).toFixed(2)}</td>
                </tr>\`).join('');

            if(running) {
                document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
                document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
                document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
            }
        } catch(e) {}
    }
    setInterval(update, 500);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
