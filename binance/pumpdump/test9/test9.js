const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let symbolMaxLeverage = {};

// Load cache đòn bẩy nếu có
if (fs.existsSync(LEVERAGE_FILE)) { 
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} 
}

// --- HÀNG ĐỢI LỆNH (CHỐNG BAN IP) ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 300); 
}
setInterval(processQueue, 50);

// --- CLASS BOT NHÂN BẢN 40 CẤU HÌNH (CÔ LẬP VỐN) ---
class LuffyBot {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode; 
        this.minVol = minVol;
        this.capital = 100.0; // Vốn gốc mỗi bot là 100$
        this.history = [];
        this.pending = null;
        this.lastTradeTime = 0;
        this.tpTarget = 0.3; // Chốt lời 0.3% giá
        this.dcaStep = 10.0; // Bước DCA 10%
    }

    getStats() {
        // TÍNH TOÁN CHUẨN: Không lấy lãi tổng, chỉ lấy lãi của riêng bot này
        let pnlWin = this.history.reduce((s, h) => s + (h.netPnl || 0), 0);
        let openMargin = 0; 
        let livePnl = 0; 
        let roi = 0;

        if (this.pending) {
            openMargin = this.pending.totalMargin;
            let lp = coinData[this.pending.symbol]?.live?.currentPrice || this.pending.avgPrice;
            let diff = ((lp - this.pending.avgPrice) / this.pending.avgPrice) * 100;
            // ROI Margin = % giá * đòn bẩy
            roi = diff * (this.pending.type === 'LONG' ? 1 : -1) * (this.pending.maxLev || 20);
            livePnl = openMargin * roi / 100;
        }

        let currentEquity = this.capital + pnlWin + livePnl;
        let available = (this.capital + pnlWin) - openMargin; // Tiền mặt thực tế còn lại để DCA

        return { 
            total: currentEquity, 
            available: Math.max(0, available), 
            pnlWin, 
            livePnl, 
            roi, 
            winCount: this.history.length 
        };
    }

    update(s, p, c1, c5, c15) {
        const now = Date.now();
        const stats = this.getStats();

        if (this.pending) {
            const h = this.pending;
            const diffAvg = ((p - h.avgPrice) / h.avgPrice) * 100;
            const isWin = h.type === 'LONG' ? diffAvg >= this.tpTarget : diffAvg <= -this.tpTarget;

            if (isWin) {
                h.status = 'WIN'; h.endTime = now; h.finalPrice = p;
                h.netPnl = h.totalMargin * (h.type === 'LONG' ? diffAvg : -diffAvg) / 100 * (h.maxLev || 20);
                this.history.push(h); this.pending = null; this.lastTradeTime = now; return;
            }

            // LOGIC DCA TỬ THẦN: Sau 9 lần, mỗi 1% nhồi 1 lệnh
            const totalDiffFromEntry = ((p - h.snapPrice) / h.snapPrice) * 100;
            let nextThreshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.dcaStep : (90 + (h.dcaCount - 8));
            const triggerDCA = h.type === 'LONG' ? totalDiffFromEntry <= -nextThreshold : totalDiffFromEntry >= nextThreshold;

            if (triggerDCA && !actionQueue.find(q => q.id === `${this.id}_${s}`)) {
                actionQueue.push({ id: `${this.id}_${s}`, priority: 1, action: () => {
                    const newMargin = stats.available * 0.01; // Lấy 1% của khả dụng thực tế
                    h.totalMargin += newMargin; h.dcaCount++;
                    h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                }});
            }
        } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= this.minVol && (now - this.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
            // VÀO LỆNH MỚI
            if (!actionQueue.find(q => q.id === `${this.id}_${s}`)) {
                actionQueue.push({ id: `${this.id}_${s}`, priority: 2, action: () => {
                    let type = this.mode === 'FOLLOW' ? (c1 > 0 ? 'LONG' : 'SHORT') : (this.mode === 'REVERSE' ? (c1 > 0 ? 'SHORT' : 'LONG') : this.mode);
                    this.pending = { 
                        symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, 
                        dcaCount: 0, totalMargin: stats.available * 0.01, 
                        maxLev: symbolMaxLeverage[s] || 20, snapVol: { c1, c5, c15 } 
                    };
                }});
            }
        }
    }
}

let bots = [];
['FOLLOW', 'REVERSE', 'LONG', 'SHORT'].forEach(m => { for (let v = 1; v <= 10; v++) bots.push(new LuffyBot(bots.length, m, v)); });

// --- XỬ LÝ DATA BINANCE ---
function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data); const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            bots.forEach(b => b.update(s, p, c1, c5, c15));
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// --- SERVER HTTP & GUI ---
app.get('/api/data', (req, res) => {
    const bData = bots.map(b => ({ ...b, stats: b.getStats() }));
    const sumPnlWin = bData.reduce((s, b) => s + b.stats.pnlWin, 0);
    const sumLivePnl = bData.reduce((s, b) => s + b.stats.livePnl, 0);
    res.json({ 
        bots: bData, 
        summary: { 
            totalPnlWin: sumPnlWin, 
            totalLivePnl: sumLivePnl, 
            totalEquity: 4000 + sumPnlWin + sumLivePnl, 
            totalWin: bData.reduce((s, b) => s + b.stats.winCount, 0) 
        }, 
        topMarket: Object.entries(coinData).filter(([_,v])=>v.live).map(([s,v])=>({symbol:s, ...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10) 
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY 40-CORE ULTRA</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .bot-card { background: #1e2329; border: 1px solid #30363d; border-radius: 4px; padding: 8px; cursor: pointer; transition: 0.2s; position:relative; }
        .bot-card:hover { border-color: #fcd535; }
        .bot-card.active { border-left: 4px solid #fcd535; background: #2b3139; }
        #fullModal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#0b0e11; z-index:9999; overflow-y:auto; }
    </style></head><body>

    <div id="dash">
        <div class="p-4 bg-[#1e2329] border-b border-zinc-800 sticky top-0 z-50">
            <div class="flex justify-between items-center mb-4">
                <div class="font-black italic text-2xl text-white">LUFFY <span class="text-[#fcd535]">40-CORE</span> DASHBOARD</div>
                <div class="text-[10px] font-bold text-zinc-500">REALTIME PNL CALCULATION</div>
            </div>
            <div class="grid grid-cols-4 gap-4">
                <div><div class="text-[10px] text-zinc-500 uppercase font-bold">Hạm đội Equity</div><div id="sumEquity" class="text-2xl font-bold text-white">4000.00</div></div>
                <div><div class="text-[10px] text-zinc-500 uppercase font-bold">Tổng lãi chốt</div><div id="sumPnlWin" class="text-2xl font-bold text-green-400">0.00</div></div>
                <div><div class="text-[10px] text-zinc-500 uppercase font-bold">Lãi đang chạy</div><div id="sumLivePnl" class="text-2xl font-bold">0.00</div></div>
                <div><div class="text-[10px] text-zinc-500 uppercase font-bold">Lệnh Win</div><div id="sumWinCount" class="text-2xl font-bold text-yellow-500">0</div></div>
            </div>
        </div>

        <div class="grid grid-cols-4 gap-2 px-2 mt-4 text-center text-[10px] font-black text-zinc-600 uppercase">
            <div>Follow</div><div>Reverse</div><div>Long Only</div><div>Short Only</div>
        </div>
        <div id="gridBots" class="grid grid-cols-4 gap-2 p-2"></div>
    </div>

    <div id="fullModal">
        <div class="p-3 bg-[#fcd535] text-black font-black text-center cursor-pointer sticky top-0 z-[10000]" onclick="closeModal()">ĐÓNG CHI TIẾT</div>
        <div id="modalBody" class="p-4"></div>
    </div>

    <script>
        let botsData = []; let myChart = null; let activeId = null;
        function fPrice(p) { return p ? parseFloat(p).toFixed(4) : "0.0000"; }

        async function update() {
            const res = await fetch('/api/data'); const d = await res.json(); botsData = d.bots;
            document.getElementById('sumEquity').innerText = d.summary.totalEquity.toFixed(2);
            document.getElementById('sumPnlWin').innerText = d.summary.totalPnlWin.toFixed(2);
            document.getElementById('sumLivePnl').innerText = d.summary.totalLivePnl.toFixed(2);
            document.getElementById('sumLivePnl').className = 'text-2xl font-bold ' + (d.summary.totalLivePnl >= 0 ? 'up' : 'down');
            document.getElementById('sumWinCount').innerText = d.summary.totalWin;

            let html = "";
            for(let row=0; row<10; row++) {
                [0, 10, 20, 30].forEach(col => {
                    const b = botsData[col + row]; const s = b.stats;
                    html += \`
                    <div class="bot-card \${b.pending?'active':''}" onclick="openModal(\${b.id})">
                        <div class="flex justify-between text-[8px] font-bold text-zinc-500 mb-1">
                            <span>#\${b.id+1} | VOL \${b.minVol}%</span>
                            <span class="\${b.pending?'up':'text-zinc-700'}">\${b.pending?'TRADING':'WAITING'}</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <div class="text-[12px] font-black text-white">\${b.pending?b.pending.symbol:'---'}</div>
                            <div class="text-[9px] font-bold \${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(2)}$</div>
                        </div>
                        <div class="flex justify-between text-[8px] mt-1 text-zinc-500">
                            <span>ROI: <b class="\${s.roi>=0?'up':'down'}">\${s.roi.toFixed(1)}%</b></span>
                            <span>DCA: \${b.pending?b.pending.dcaCount:0}</span>
                        </div>
                    </div>\`;
                });
            }
            document.getElementById('gridBots').innerHTML = html;
            if(activeId !== null) renderModalContent(activeId, d.topMarket);
        }

        function openModal(id) { activeId = id; document.getElementById('fullModal').style.display = 'block'; document.getElementById('dash').style.display = 'none'; }
        function closeModal() { activeId = null; document.getElementById('fullModal').style.display = 'none'; document.getElementById('dash').style.display = 'block'; if(myChart) { myChart.destroy(); myChart = null; } }

        function renderModalContent(id, topMarket) {
            const b = botsData[id]; const s = b.stats;
            const content = \`
                <div class="flex justify-between items-end mb-4">
                    <div><div class="text-zinc-500 text-[10px] font-bold uppercase">Equity Bot #\${id+1}</div><div class="text-4xl font-black text-white">\${s.total.toFixed(2)} <span class="text-sm">USDT</span></div></div>
                    <div class="text-right text-[10px] font-bold text-zinc-500 uppercase">Mode: \${b.mode} | Vol: \${b.minVol}%</div>
                </div>
                <div class="grid grid-cols-3 gap-2 mb-4">
                    <div class="bg-card p-3 rounded text-center"><div class="text-[10px] text-zinc-500 uppercase font-bold">Khả dụng DCA</div><div class="text-xl font-bold text-green-400">\${s.available.toFixed(2)}</div></div>
                    <div class="bg-card p-3 rounded text-center"><div class="text-[10px] text-zinc-500 uppercase font-bold">Lợi nhuận chốt</div><div class="text-xl font-bold text-white">\${s.pnlWin.toFixed(2)}</div></div>
                    <div class="bg-card p-3 rounded text-center"><div class="text-[10px] text-zinc-500 uppercase font-bold">Lệnh Win</div><div class="text-xl font-bold text-yellow-500">\${s.winCount}</div></div>
                </div>
                <div class="bg-card rounded-lg p-4 mb-4"><div style="height: 180px;"><canvas id="balanceChart"></canvas></div></div>
                <div class="bg-card rounded-lg p-4 mb-4">
                    <div class="text-[10px] font-bold text-yellow-500 mb-2 uppercase">Market 3 Khung</div>
                    <table class="w-full text-[10px] text-left"><thead><tr class="text-zinc-600 border-b border-zinc-800"><th>Coin</th><th>Giá</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-center">15M</th></tr></thead>
                    <tbody>\${topMarket.map(m=>\`<tr class="border-b border-zinc-800/30 font-bold"><td class="py-1 text-white">\${m.symbol}</td><td class="text-yellow-500">\${fPrice(m.currentPrice)}</td><td class="text-center \${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="text-center \${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="text-center \${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('')}</tbody></table>
                </div>
                <div class="bg-card rounded-lg p-4 mb-4">
                    <div class="text-[10px] font-bold text-white mb-2 uppercase">Vị thế hiện tại</div>
                    \${b.pending ? \`
                    <div class="flex justify-between items-center p-2 bg-zinc-800/50 rounded border border-zinc-700">
                        <div><div class="text-xl font-black text-white">\${b.pending.symbol} <span class="text-[10px] px-1 \${b.pending.type==='LONG'?'bg-green-600':'bg-red-600'}">\${b.pending.type}</span></div><div class="text-[10px] text-zinc-500 font-bold">AVG: \${fPrice(b.pending.avgPrice)}</div></div>
                        <div class="text-right"><div class="text-2xl font-black \${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(2)}$</div><div class="text-[10px] font-bold \${s.roi>=0?'up':'down'}">\${s.roi.toFixed(1)}%</div></div>
                    </div>\` : '<div class="text-center py-4 text-zinc-700 font-bold">KHÔNG CÓ VỊ THẾ</div>'}
                </div>
                <div class="bg-card rounded-lg p-4 text-[10px]">
                    <div class="text-zinc-500 mb-2 uppercase font-bold">Lịch sử 5 lệnh gần nhất</div>
                    \${b.history.slice(-5).reverse().map(h=>\`<div class="flex justify-between border-b border-zinc-800 py-1 font-bold"><span>\${h.symbol} (\${h.type})</span><span class="up">+\${h.netPnl.toFixed(2)}$</span></div>\`).join('')}
                </div>
            \`;
            document.getElementById('modalBody').innerHTML = content;
            if(!myChart) initChart(b);
        }

        function initChart(b) {
            const ctx = document.getElementById('balanceChart').getContext('2d');
            const data = b.history.map((h, i) => 100 + b.history.slice(0, i+1).reduce((s,x)=>s+x.netPnl, 0));
            myChart = new Chart(ctx, { type: 'line', data: { labels: b.history.map((_,i)=>i), datasets: [{ data: [100, ...data], borderColor: '#0ecb81', borderWidth: 2, fill: true, tension: 0.1, pointRadius: 0, backgroundColor: 'rgba(14, 203, 129, 0.05)' }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#848e9c', font: { size: 9 } } } }, animation: false } });
        }

        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`🚀 LUFFY 40-CORE READY: http://localhost:${PORT}/gui`); });
