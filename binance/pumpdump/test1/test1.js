const PORT = 7001;
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

// Biến lưu trữ số dư để vẽ biểu đồ real-time
let equityHistory = [];

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
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) {
                    pending.maxNegativeRoi = currentRoi;
                }

                // Check WIN hoặc TIMEOUT
                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);

                // Đặc biệt: Nếu có lệnh bù lỗ (Recovery Order), check TP/SL riêng cho nó
                if (pending.recoveryOrder) {
                    const r = pending.recoveryOrder;
                    const rDiff = ((p - r.entry) / r.entry) * 100;
                    const rRoi = (r.type === 'LONG' ? rDiff : -rDiff) * r.lev;
                    if (rRoi >= 10 || rRoi <= -10) { // TP 10% giá tương đương ROI cực lớn, ở đây hiểu là biến động giá 10%
                         pending.status = rRoi >= 10 ? 'WIN_RECOVERY' : 'FAILED_RECOVERY';
                         pending.finalPrice = p; pending.endTime = now;
                         pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                         lastTradeClosed[s] = now;
                         fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                         return;
                    }
                }

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
                    // Nếu dcaCount đang là 5, chuẩn bị DCA lần 6 nhưng thực tế là mở lệnh ngược
                    if (pending.dcaCount === 5) {
                        actionQueue.push({ id: s, priority: 1, action: () => {
                            pending.status_note = "MAX_DCA_REACHED_OPEN_REVERSE";
                            // Xóa SL cũ, điểm đóng lệnh là khi chạm mốc DCA 6
                            pending.finalExitThreshold = (pending.dcaCount + 2) * pending.slTarget; 
                            
                            // Tính toán Margin cho lệnh ngược
                            let baseM = pending.initialMargin; 
                            let revMargin = 0;
                            let lev = pending.maxLev || 20;
                            if (lev < 50) revMargin = baseM * 50;
                            else if (lev === 50) revMargin = baseM * 100;
                            else revMargin = baseM * 150;

                            pending.recoveryOrder = {
                                type: pending.type === 'LONG' ? 'SHORT' : 'LONG',
                                entry: p,
                                margin: revMargin,
                                lev: lev
                            };
                            pending.dcaCount++; // Tăng lên 6 để đánh dấu
                        }});
                    } else if (pending.dcaCount < 5) {
                        actionQueue.push({ id: s, priority: 1, action: () => {
                            const newCount = pending.dcaCount + 1;
                            const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                            pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg, vol: {c1, c5, c15} });
                            setTimeout(() => {
                                pending.avgPrice = newAvg;
                                pending.dcaCount = newCount;
                            }, 200); 
                        }});
                    } else {
                        // Đang ở trạng thái sau DCA 5, check xem giá có chạm mốc DCA 6 (SL tổng) không
                        const hitFinalSL = pending.type === 'LONG' ? totalDiffFromEntry <= -pending.finalExitThreshold : totalDiffFromEntry >= pending.finalExitThreshold;
                        if (hitFinalSL) {
                            pending.status = 'STOP_LOSS_TOTAL';
                            pending.finalPrice = p; pending.endTime = now;
                            pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                            lastTradeClosed[s] = now;
                            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                        }
                    }
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = '';

                        if (tradeMode === 'LONG_ONLY') type = 'LONG';
                        else if (tradeMode === 'SHORT_ONLY') type = 'SHORT';
                        else if (tradeMode === 'REVERSE') type = sumVol >= 0 ? 'SHORT' : 'LONG';
                        else type = sumVol >= 0 ? 'LONG' : 'SHORT';

                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                            maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p, vol: {c1, c5, c15} }]
                        });
                    }});
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro - Ultimate</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin: 0; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; } .text-gray-custom { color: #848e9c; }
        input, select { border: 1px solid #30363d !important; background: #0b0e11; color: white; }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 border-b border-zinc-800">
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
                        <option value="LONG_ONLY">CHỈ LONG</option>
                        <option value="SHORT_ONLY">CHỈ SHORT</option>
                    </select>
                </div>
            </div>
            <button onclick="start()" class="col-span-2 bg-[#fcd535] hover:bg-[#ffe066] text-black py-2.5 rounded-md font-bold uppercase text-xs mt-2">Lưu & Khởi chạy</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
            <div class="font-bold italic text-white text-xl tracking-tighter">BINANCE <span class="text-[#fcd535]">LUFFY PRO</span></div>
            <div class="text-[#fcd535] font-black italic text-sm border border-[#fcd535] px-2 py-1 rounded cursor-pointer" onclick="stop()">STOP ENGINE</div>
        </div>

        <div class="flex justify-between items-end mb-3">
            <div>
                <div class="text-gray-custom text-[11px] uppercase font-bold tracking-widest mb-1">Available Balance (Khả dụng)</div>
                <span id="displayAvail" class="text-4xl font-bold text-white tracking-tighter">0.00</span><span class="text-sm text-gray-custom ml-1">USDT</span>
            </div>
            <div class="text-right">
                <div class="text-gray-custom text-[11px] uppercase font-bold mb-1">PnL Tạm tính (Cả +/-)</div>
                <div id="unPnl" class="text-xl font-bold">0.00</div>
            </div>
        </div>
    </div>

    <div class="px-4 mt-5">
        <div class="bg-card rounded-xl p-4 border border-zinc-800">
            <div class="text-[11px] font-bold text-gray-custom uppercase tracking-widest italic mb-2">Equity Chart (Wallet + UnPnL)</div>
            <div style="height: 220px;"><canvas id="balanceChart"></canvas></div>
        </div>
    </div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-white mb-3 uppercase tracking-wider flex items-center">Vị thế đang mở</div>
        <div class="overflow-x-auto"><table class="w-full text-[10px] text-left"><thead class="text-gray-custom uppercase border-b border-zinc-800"><tr><th>STT</th><th>Pair</th><th>Vol Snap</th><th>DCA</th><th>Margin</th><th>Entry/Live</th><th>PnL (ROI%)</th></tr></thead><tbody id="pendingBody"></tbody></table></div>
    </div></div>

    <div class="px-4 mt-5"><div class="bg-card rounded-xl p-4 shadow-lg">
        <div class="text-[11px] font-bold text-gray-custom mb-3 uppercase tracking-wider italic">Nhật ký giao dịch</div>
        <div class="overflow-x-auto"><table class="w-full text-[9px] text-left"><thead class="text-gray-custom border-b border-zinc-800 uppercase"><tr><th>STT</th><th>Pair/Vol Snap</th><th>DCA</th><th>Margin</th><th>PnL Net</th><th>Balance</th></tr></thead><tbody id="historyBody"></tbody></table></div>
    </div></div>

    <script>
    let running = false, initialBal = 1000, myChart = null;
    const saved = JSON.parse(localStorage.getItem('luffy_state') || '{}');
    document.getElementById('balanceInp').value = saved.initialBal || 1000;
    document.getElementById('marginInp').value = saved.marginVal || "10%";
    document.getElementById('tpInp').value = saved.tp || 0.5;
    document.getElementById('slInp').value = saved.sl || 10.0;
    document.getElementById('volInp').value = saved.vol || 5.0;
    document.getElementById('modeInp').value = saved.mode || "FOLLOW";

    if(saved.running) {
        running = true; initialBal = saved.initialBal;
        document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden');
        syncConfig();
    }

    function syncConfig() {
        const tp = document.getElementById('tpInp').value, sl = document.getElementById('slInp').value, vol = document.getElementById('volInp').value, mode = document.getElementById('modeInp').value;
        fetch(\`/api/config?tp=\${tp}&sl=\${sl}&vol=\${vol}&mode=\${mode}\`);
    }

    function start() {
        running = true; initialBal = parseFloat(document.getElementById('balanceInp').value);
        localStorage.setItem('luffy_state', JSON.stringify({ running: true, initialBal, marginVal: document.getElementById('marginInp').value, tp: document.getElementById('tpInp').value, sl: document.getElementById('slInp').value, vol: document.getElementById('volInp').value, mode: document.getElementById('modeInp').value }));
        syncConfig(); location.reload();
    }

    function stop() { let s = JSON.parse(localStorage.getItem('luffy_state')); s.running = false; localStorage.setItem('luffy_state', JSON.stringify(s)); location.reload(); }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line', 
            data: { labels: [], datasets: [{ label: 'Equity', data: [], borderWidth: 2, fill: true, tension: 0.1, pointRadius: 0, borderColor: '#0ecb81', backgroundColor: 'rgba(14, 203, 129, 0.1)' }] },
            options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.03)' } } } }
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); const d = await res.json();
            let mVal = document.getElementById('marginInp').value, mNum = parseFloat(mVal);
            let walletBal = initialBal, totalUsedMargin = 0, unPnl = 0;
            let chartLabels = [], chartData = [];

            // Tính toán lịch sử để lấy Wallet Balance
            let histHTML = [...d.history].reverse().map((h, i) => {
                let mBase = mVal.includes('%') ? (walletBal * mNum / 100) : mNum;
                let tM = mBase * (h.dcaCount + 1);
                let netPnl = (tM * (h.maxLev || 20) * (h.pnlPercent/100)) - (tM * (h.maxLev || 20) * 0.001);
                walletBal += netPnl;
                chartLabels.push(""); chartData.push(walletBal);
                return \`<tr><td>\${i+1}</td><td>\${h.symbol}<br><small>V: \${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</small></td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td class="\${netPnl>=0?'up':'down'}">\${netPnl.toFixed(2)}</td><td>\${walletBal.toFixed(1)}</td></tr>\`;
            }).reverse().join('');

            // Tính toán lệnh đang mở (Pending)
            let pendingHTML = (d.pending || []).map((h, idx) => {
                let lp = d.allPrices[h.symbol] || h.avgPrice;
                let mBase = mVal.includes('%') ? (walletBal * mNum / 100) : mNum; 
                if(!h.initialMargin) h.initialMargin = mBase; // Lưu lại margin gốc
                let tM = mBase * (h.dcaCount + 1);
                totalUsedMargin += tM;
                let roi = (h.type === 'LONG' ? (lp-h.avgPrice)/h.avgPrice : (h.avgPrice-lp)/h.avgPrice) * 100 * (h.maxLev || 20);
                let pnl = tM * roi / 100;
                
                // Nếu có lệnh ngược chiều, cộng thêm margin và pnl của nó
                if(h.recoveryOrder) {
                    totalUsedMargin += h.recoveryOrder.margin;
                    let rDiff = ((lp - h.recoveryOrder.entry) / h.recoveryOrder.entry) * 100;
                    let rPnl = h.recoveryOrder.margin * (h.recoveryOrder.type === 'LONG' ? rDiff : -rDiff) / 100 * h.recoveryOrder.lev;
                    pnl += rPnl;
                }
                
                unPnl += pnl;
                return \`<tr><td>\${idx+1}</td><td>\${h.symbol} [\${h.type}]\${h.recoveryOrder?'<br>RECOVERY':''}</td><td>\${h.snapVol.c1}/\${h.snapVol.c5}/\${h.snapVol.c15}</td><td>\${h.dcaCount}</td><td>\${tM.toFixed(1)}</td><td>\${lp.toFixed(4)}</td><td class="\${pnl>=0?'up':'down'}">\${pnl.toFixed(2)} (\${roi.toFixed(1)}%)</td></tr>\`;
            }).join('');

            let currentEquity = walletBal + unPnl;
            let availBal = walletBal - totalUsedMargin + (unPnl < 0 ? unPnl : 0); // Chỉ trừ PnL nếu nó âm để tính sức mua

            chartLabels.push("NOW"); chartData.push(currentEquity);
            if(myChart) { 
                myChart.data.labels = chartLabels; 
                myChart.data.datasets[0].data = chartData;
                myChart.data.datasets[0].borderColor = currentEquity >= initialBal ? '#0ecb81' : '#f6465d';
                myChart.update('none'); 
            }

            document.getElementById('displayAvail').innerText = availBal.toFixed(2);
            document.getElementById('unPnl').innerText = (unPnl >= 0 ? '+' : '') + unPnl.toFixed(2);
            document.getElementById('unPnl').className = 'text-xl font-bold ' + (unPnl >= 0 ? 'up' : 'down');
            document.getElementById('historyBody').innerHTML = histHTML;
            document.getElementById('pendingBody').innerHTML = pendingHTML;
        } catch(e) {}
    }
    initChart();
    setInterval(update, 500); 
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Engine running on http://localhost:${PORT}/gui`); });
