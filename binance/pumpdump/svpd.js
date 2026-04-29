const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

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
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function initWS() {
    console.log('Đang kết nối tới Binance WebSocket (Tailscale Stable Mode)...');
    
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr', {
        family: 4 // Ép dùng IPv4 để tránh lỗi card mạng ảo của Tailscale
    });

    let pingTimeout = setTimeout(() => {
        console.log('Quá thời gian chờ dữ liệu, đang khởi động lại WebSocket...');
        ws.terminate();
    }, 30000);

    ws.on('open', () => {
        console.log('✅ WebSocket Connected!');
    });

    ws.on('message', (data) => {
        clearTimeout(pingTimeout);
        pingTimeout = setTimeout(() => {
            console.log('Mất tín hiệu dữ liệu, đang reconnect...');
            ws.terminate();
        }, 30000);

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
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) {
                    pending.maxNegativeRoi = currentRoi;
                }

                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);
                if (win || isTimeout) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }

                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
                
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        setTimeout(() => {
                            pending.avgPrice = newAvg;
                            pending.dcaCount = newCount;
                        }, 200); 
                    }});
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = sumVol >= 0 ? 'LONG' : 'SHORT';
                        if (tradeMode === 'REVERSE') type = (type === 'LONG' ? 'SHORT' : 'LONG');

                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                            maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                        });
                    }});
                }
            }
        });
    });

    ws.on('error', (err) => {
        console.error('Lỗi WebSocket:', err.message);
        ws.terminate(); 
    });

    ws.on('close', () => {
        clearTimeout(pingTimeout);
        console.log('WebSocket đóng. Đang kết nối lại sau 5 giây...');
        setTimeout(initWS, 5000);
    });
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const topData = Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1));
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live ? v.live.currentPrice : 0])),
        live: topData, 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.8); align-items:center; justify-content:center; }
    </style></head><body>
    
    <div id="detailModal" class="modal">
        <div class="bg-card p-6 rounded-lg w-11/12 max-w-2xl border border-zinc-700 relative">
            <button onclick="closeModal('detailModal')" class="absolute top-2 right-4 text-2xl text-gray-custom hover:text-white">&times;</button>
            <h2 id="modalTitle" class="text-yellow-500 font-bold mb-4 uppercase"></h2>
            <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800"><tr><th>Lần</th><th>Thời gian</th><th>Giá DCA</th><th>Giá TB</th><th>Margin</th><th>Lev</th><th>TP sau DCA</th></tr></thead><tbody id="modalBody"></tbody></table></div>
        </div>
    </div>

    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
        <div id="active" class="flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP ENGINE</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div><div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Equity (Vốn + PnL Live)</div><span id="displayBal" class="text-4xl font-bold text-white tracking-tighter">0.00</span><span class="text-sm text-gray-custom ml-1">USDT</span></div>
            <div class="text-right"><div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div id="unPnl" class="text-xl font-bold">0.00</div></div>
        </div>

        <div id="setup" class="grid grid-cols-2 gap-3 mb-4 bg-card p-3 rounded-lg">
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Vốn khởi tạo ($)</label><input id="balanceInp" type="number" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div><label class="text-[10px] text-gray-custom ml-1 uppercase font-bold">Margin per Trade</label><input id="marginInp" type="text" class="p-2 rounded w-full text-yellow-500 font-bold outline-none text-sm"></div>
            <div class="col-span-2 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 mt-1">
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="p-2 rounded w-full outline-none text-sm"></div>
                <div><label class="text-[10px] text-gray-custom ml-1 uppercase">Chế độ</label>
                    <select id="modeInp" class="p-2 rounded w-full outline-none text-sm">
                        <option value="FOLLOW">THUẬN (FOLLOW)</option>
                        <option value="REVERSE">NGƯỢC (REVERSE)</option>
                    </select>
                </div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">Lưu cấu hình & Khởi chạy</button>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 border border-zinc-800 h-[250px]"><canvas id="balanceChart"></canvas></div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase italic">Market (3 khung)</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>Coin</th><th>Giá Hiện Tại</th><th class="text-center">1M (%)</th><th class="text-center">5M (%)</th><th class="text-center">15M (%)</th></tr></thead><tbody id="marketBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>Pair</th><th>DCA</th><th>Margin</th><th class="text-center">Lev/Target</th><th>Entry/Live</th><th class="text-right">PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5 pb-32"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>Time</th><th>Pair</th><th>DCA</th><th>PnL Net</th><th class="text-right">Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, initialBal = 1000, lastRawData = null, myChart = null;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;
    document.getElementById('modeInp').value = saved.mode || "FOLLOW";

    function fPrice(p) { return p ? p.toFixed(4) : "0.0000"; }
    function start() {
        running = true; initialBal = parseFloat(document.getElementById('balanceInp').value);
        localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }));
        syncConfig(); location.reload();
    }
    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }
    function syncConfig() {
        fetch(\`/api/config?tp=\${document.getElementById('tpInp').value}&sl=\${document.getElementById('slInp').value}&vol=\${document.getElementById('volInp').value}&mode=\${document.getElementById('modeInp').value}\`);
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json(); lastRawData = d;
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let runningBal = initialBal, unPnl = 0;

            document.getElementById('marketBody').innerHTML = (d.live || []).slice(0, 10).map(m => \`
                <tr class="border-b border-zinc-800/30 text-[11px]"><td class="font-bold text-white py-2">\${m.symbol}</td><td class="text-yellow-500">\${fPrice(m.currentPrice)}</td><td class="text-center font-bold \${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="text-center font-bold \${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="text-center font-bold \${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('');

            document.getElementById('historyBody').innerHTML = d.history.slice(-20).reverse().map(h => {
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let netPnl = (marginBase * (h.dcaCount + 1) * (h.maxLev || 20) * (h.pnlPercent/100));
                runningBal += netPnl;
                return \`<tr class="border-b border-zinc-800/30 text-zinc-400"><td class="py-2 text-[7px]">\${new Date(h.endTime).toLocaleTimeString()}</td><td>\${h.symbol}</td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td class="\${netPnl>=0?'up':'down'} font-bold">\${netPnl.toFixed(2)}</td><td class="text-right text-white">\${runningBal.toFixed(1)}</td></tr>\`;
            }).join('');

            document.getElementById('pendingBody').innerHTML = (d.pending || []).map(h => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let marginBase = mVal.includes('%') ? (runningBal * mNum / 100) : mNum; 
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = (marginBase * (h.dcaCount + 1)) * roi / 100; unPnl += pnl;
                return \`<tr class="bg-white/5 border-b border-zinc-800"><td>\${h.symbol} <span class="text-[8px] \${h.type==='LONG'?'bg-green-600':'bg-red-600'} rounded">\${h.type}</span></td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td>\${(marginBase*(h.dcaCount+1)).toFixed(1)}</td><td class="text-center text-yellow-500/70">\${h.maxLev}x</td><td>\${fPrice(h.avgPrice)}<br><b class="text-green-400">\${fPrice(lp)}</b></td><td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td></tr>\`;
            }).join('');

            document.getElementById('displayBal').innerText = (runningBal + unPnl).toFixed(2);
            document.getElementById('unPnl').innerText = unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
        } catch(e) {}
    }
    setInterval(update, 1000);
    if(saved.running) update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { 
    initWS(); 
    console.log(`Server running at http://localhost:${PORT}/gui`); 
});
