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

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }

// --- HÀNG ĐỢI LỆNH ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift(); task.action();
    setTimeout(processQueue, 300); 
}
setInterval(processQueue, 50);

// --- CLASS LUFFY CORE 40 ---
class LuffyCore {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode; 
        this.minVol = minVol;
        this.initialCapital = 100.0; // Vốn gốc mỗi cấu hình
        this.history = [];
        this.pending = null;
        this.lastTradeTime = 0;
        this.tpTarget = 0.3; 
        this.dcaStep = 10.0; 
    }

    getStats() {
        let pnlWin = this.history.reduce((s, h) => s + (h.netPnl || 0), 0);
        let openMargin = 0; let livePnl = 0; let roi = 0;
        
        if (this.pending) {
            openMargin = this.pending.totalMargin;
            let lp = coinData[this.pending.symbol]?.live?.currentPrice || this.pending.avgPrice;
            let diff = ((lp - this.pending.avgPrice) / this.pending.avgPrice) * 100;
            roi = diff * (this.pending.type === 'LONG' ? 1 : -1) * (this.pending.maxLev || 20);
            livePnl = openMargin * roi / 100;
        }

        // Vốn thực tế = Vốn gốc + Lãi chốt + Lãi chạy
        let equity = this.initialCapital + pnlWin + livePnl;
        // Vốn khả dụng = (Vốn gốc + Lãi chốt) - Margin đang giam + Lãi chạy
        let available = (this.initialCapital + pnlWin - openMargin) + livePnl;

        return { 
            equity, 
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

            const totalDiffFromEntry = ((p - h.snapPrice) / h.snapPrice) * 100;
            let nextThreshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.dcaStep : (90 + (h.dcaCount - 8));
            const triggerDCA = h.type === 'LONG' ? totalDiffFromEntry <= -nextThreshold : totalDiffFromEntry >= nextThreshold;

            if (triggerDCA && !actionQueue.find(q => q.id === `b\${this.id}_\${s}`)) {
                actionQueue.push({ id: `b\${this.id}_\${s}`, priority: 1, action: () => {
                    const m = stats.available * 0.01; // Margin 1% khả dụng
                    h.totalMargin += m; h.dcaCount++;
                    h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                }});
            }
        } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= this.minVol && (now - this.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
            if (!actionQueue.find(q => q.id === `b\${this.id}_\${s}`)) {
                actionQueue.push({ id: `b\${this.id}_\${s}`, priority: 2, action: () => {
                    let type = this.mode === 'FOLLOW' ? (c1 > 0 ? 'LONG' : 'SHORT') : (this.mode === 'REVERSE' ? (c1 > 0 ? 'SHORT' : 'LONG') : this.mode);
                    this.pending = { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, dcaCount: 0, totalMargin: stats.available * 0.01, maxLev: symbolMaxLeverage[s] || 20, snapVol: { c1, c5, c15 } };
                }});
            }
        }
    }
}

let botCores = [];
['FOLLOW', 'REVERSE', 'LONG', 'SHORT'].forEach(m => { for (let v = 1; v <= 10; v++) botCores.push(new LuffyCore(botCores.length, m, v)); });

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
            botCores.forEach(b => b.update(s, p, c1, c5, c15));
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}
function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

// --- GUI ---
app.get('/api/data', (req, res) => {
    const data = botCores.map(b => ({ ...b, stats: b.getStats() }));
    res.json({
        bots: data,
        summary: {
            totalEquity: data.reduce((s, b) => s + b.stats.equity, 0),
            totalPnlWin: data.reduce((s, b) => s + b.stats.pnlWin, 0),
            totalLivePnl: data.reduce((s, b) => s + b.stats.livePnl, 0),
            totalWin: data.reduce((s, b) => s + b.stats.winCount, 0),
            active: data.filter(b => b.pending).length
        },
        topMarket: Object.entries(coinData).filter(([_,v])=>v.live).map(([s,v])=>({symbol:s, ...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY 40-CORE FULL INFO</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .bot-card { background: #1e2329; border: 1px solid #30363d; padding: 6px; cursor: pointer; border-radius: 4px; position: relative; }
        .bot-card:hover { border-color: #fcd535; }
        .bot-card.active { border-left: 3px solid #fcd535; background: #2b3139; }
        #detailModal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#0b0e11; z-index:9999; overflow-y:auto; }
    </style></head><body>

    <div id="dash">
        <div class="p-4 bg-[#1e2329] border-b border-zinc-800 sticky top-0 z-50">
            <div class="flex justify-between items-center mb-4">
                <div class="font-black italic text-xl text-white">LUFFY <span class="text-[#fcd535]">40-CORE</span> PRO</div>
                <div class="flex gap-4">
                   <div class="text-right"><div class="text-[9px] text-zinc-500 uppercase font-bold">Tổng Equity</div><div id="sumEq" class="text-lg font-bold text-white">0.00</div></div>
                   <div class="text-right"><div class="text-[9px] text-zinc-500 uppercase font-bold">Tổng PnL Win</div><div id="sumWin" class="text-lg font-bold text-green-400">0.00</div></div>
                   <div class="text-right"><div class="text-[9px] text-zinc-500 uppercase font-bold">Vị thế mở</div><div id="sumOpen" class="text-lg font-bold text-blue-400">0</div></div>
                </div>
            </div>
            <div class="grid grid-cols-4 gap-2 text-center text-[10px] font-black text-zinc-600 uppercase tracking-widest">
                <div>Follow (1-10%)</div><div>Reverse (1-10%)</div><div>Long Only</div><div>Short Only</div>
            </div>
        </div>

        <div id="gridBots" class="grid grid-cols-4 gap-2 p-2"></div>
    </div>

    <div id="detailModal">
        <div class="p-3 bg-[#fcd535] text-black font-black text-center cursor-pointer sticky top-0" onclick="closeModal()">ĐÓNG CHI TIẾT</div>
        <div id="modalBody" class="p-4"></div>
    </div>

    <script>
        let bots = []; let myChart = null; let activeId = null;
        async function update() {
            const res = await fetch('/api/data'); const d = await res.json(); bots = d.bots;
            document.getElementById('sumEq').innerText = d.summary.totalEquity.toFixed(2);
            document.getElementById('sumWin').innerText = d.summary.totalPnlWin.toFixed(2);
            document.getElementById('sumOpen').innerText = d.summary.active;

            let html = "";
            bots.forEach(b => {
                const s = b.stats;
                html += \`
                <div class="bot-card \${b.pending?'active':''}" onclick="openModal(\${b.id})">
                    <div class="flex justify-between text-[8px] font-bold text-zinc-500 mb-1">
                        <span>#\${b.id+1} | \${b.mode} | \${b.minVol}%</span>
                        <span class="\${b.pending?'up':'text-zinc-700'} font-black uppercase">\${b.pending?b.pending.symbol:'IDLE'}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-x-2 gap-y-1 text-[9px]">
                        <div class="text-zinc-500">Equity: <b class="text-white">\${s.equity.toFixed(1)}</b></div>
                        <div class="text-zinc-500">Profit: <b class="text-green-400">\${s.pnlWin.toFixed(1)}</b></div>
                        <div class="text-zinc-500">Avail: <b class="text-yellow-500">\${s.available.toFixed(1)}</b></div>
                        <div class="text-zinc-500 text-right">Win: <b class="text-white">\${s.winCount}</b></div>
                    </div>
                    <div class="flex justify-between mt-1 pt-1 border-t border-zinc-800/50">
                        <div class="text-[10px] font-black \${s.livePnl>=0?'up':'down'}">\${s.livePnl>=0?'+':''}\${s.livePnl.toFixed(2)}$</div>
                        <div class="text-[10px] font-black \${s.roi>=0?'up':'down'}">\${s.roi.toFixed(1)}%</div>
                    </div>
                </div>\`;
            });
            document.getElementById('gridBots').innerHTML = html;
            if(activeId !== null) renderModal(activeId, d.topMarket);
        }

        function openModal(id) { activeId = id; document.getElementById('detailModal').style.display = 'block'; document.getElementById('dash').style.display = 'none'; }
        function closeModal() { activeId = null; document.getElementById('detailModal').style.display = 'none'; document.getElementById('dash').style.display = 'block'; if(myChart) { myChart.destroy(); myChart = null; } }

        function renderModal(id, topMarket) {
            const b = bots[id]; const s = b.stats;
            const content = \`
                <div class="flex justify-between items-end mb-4">
                    <div><div class="text-zinc-500 text-[10px] font-bold uppercase tracking-widest">Detail Bot #\${id+1}</div><div class="text-4xl font-black text-white">\${s.equity.toFixed(2)}</div></div>
                    <div class="text-right text-[10px] font-bold text-zinc-500 uppercase">Mode: \${b.mode} | Vol: \${b.minVol}%</div>
                </div>
                <div class="bg-card rounded p-4 mb-4"><div style="height: 180px;"><canvas id="botChart"></canvas></div></div>
                <div class="bg-card rounded p-3 mb-4">
                    <div class="text-[10px] font-black text-yellow-500 mb-2 uppercase italic tracking-widest">Market Status (3 Khung)</div>
                    <table class="w-full text-[10px] text-left"><thead><tr class="text-zinc-600 border-b border-zinc-800 uppercase"><th>Coin</th><th>Giá</th><th>1M</th><th>5M</th><th>15M</th></tr></thead>
                    <tbody>\${topMarket.map(m=>\`<tr class="border-b border-zinc-800/30"><td class="py-1 font-bold text-white">\${m.symbol}</td><td class="text-yellow-500 font-bold">\${parseFloat(m.currentPrice).toFixed(4)}</td><td class="font-black \${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="font-black \${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="font-black \${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('')}</tbody></table>
                </div>
                <div class="bg-card rounded p-3 mb-4">
                    <div class="text-[10px] font-black text-white mb-2 uppercase tracking-widest">Vị thế hiện tại</div>
                    \${b.pending ? \`<div class="flex justify-between items-center p-3 bg-zinc-800/50 rounded"><div class="text-xl font-black text-white">\${b.pending.symbol} <span class="text-[10px] px-1 \${b.pending.type==='LONG'?'bg-green-600':'bg-red-600'}">\${b.pending.type}</span></div><div class="text-right"><div class="text-2xl font-black \${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(2)}$</div><div class="text-[10px] font-black \${s.roi>=0?'up':'down'}">\${s.roi.toFixed(1)}%</div></div></div>\` : '<div class="text-center py-4 text-zinc-700 font-bold italic uppercase tracking-tighter">Bot đang quét tín hiệu...</div>'}
                </div>
                <div class="bg-card rounded p-3 text-[10px]">
                    <div class="text-zinc-500 mb-2 uppercase font-bold tracking-widest">Lịch sử giao dịch</div>
                    \${b.history.slice(-5).reverse().map(h=>\`<div class="flex justify-between border-b border-zinc-800 py-1.5 font-bold"><span class="text-white">\${h.symbol} (\${h.type})</span><span class="up">+\${h.netPnl.toFixed(2)}$</span></div>\`).join('')}
                </div>\`;
            document.getElementById('modalBody').innerHTML = content;
            if(!myChart) initChart(b);
        }

        function initChart(b) {
            const ctx = document.getElementById('botChart').getContext('2d');
            const data = b.history.map((h, i) => 100 + b.history.slice(0, i+1).reduce((s,x)=>s+x.netPnl, 0));
            myChart = new Chart(ctx, { type: 'line', data: { labels: b.history.map((_,i)=>i), datasets: [{ data: [100, ...data], borderColor: '#0ecb81', borderWidth: 2, fill: true, tension: 0.1, pointRadius: 0, backgroundColor: 'rgba(14, 203, 129, 0.05)' }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#848e9c', font: { size: 9 } } } }, animation: false } });
        }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
