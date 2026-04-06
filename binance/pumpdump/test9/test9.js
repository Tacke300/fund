const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const INITIAL_BOT_CAPITAL = 100.0;

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let symbolMaxLeverage = {}; 

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }

// --- HÀNG ĐỢI LỆNH (GIỮ NGUYÊN TỐC ĐỘ GỐC) ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift(); task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- LUFFY CORE - NHÂN BẢN 100% LOGIC GỐC ---
class LuffyCore {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode; 
        this.minVol = minVol;
        this.initialCapital = INITIAL_BOT_CAPITAL;
        this.history = [];
        this.pending = null;
        this.lastTradeTime = 0;
        
        // Cấu hình gốc 100%
        this.tpTarget = 0.3; // 0.3%
        this.dcaStep = 10.0; // 10% cho 9 lần đầu
    }

    getStats() {
        let pnlWin = this.history.reduce((s, h) => s + (h.netPnl || 0), 0);
        let openMargin = 0; let livePnl = 0; let roi = 0;
        
        if (this.pending) {
            openMargin = this.pending.totalMargin;
            let lp = coinData[this.pending.symbol]?.live?.currentPrice || this.pending.avgPrice;
            let diff = ((lp - this.pending.avgPrice) / this.pending.avgPrice) * 100;
            roi = diff * (this.pending.type === 'LONG' ? 1 : -1) * (this.pending.maxLev || 20);
            livePnl = (openMargin * roi) / 100;
        }

        let equity = this.initialCapital + pnlWin + livePnl;
        // Số dư khả dụng = (Vốn + Lãi - Ký quỹ đang dùng) + PnL tạm tính
        let available = (this.initialCapital + pnlWin - openMargin) + livePnl;

        return { equity, available, pnlWin, livePnl, roi, openMargin, winCount: this.history.length };
    }

    update(s, p, c1, c5, c15) {
        const now = Date.now();
        const stats = this.getStats();

        if (this.pending && this.pending.symbol === s) {
            const h = this.pending;
            const diffAvg = ((p - h.avgPrice) / h.avgPrice) * 100;
            const isWin = h.type === 'LONG' ? diffAvg >= this.tpTarget : diffAvg <= -this.tpTarget;

            if (isWin) {
                h.status = 'WIN'; h.endTime = now; h.finalPrice = p;
                let currentRoi = diffAvg * (h.type === 'LONG' ? 1 : -1) * (h.maxLev || 20);
                h.netPnl = (h.totalMargin * currentRoi) / 100;
                this.history.push(h); this.pending = null; this.lastTradeTime = now; return;
            }

            // LOGIC DCA GỐC: 9 lần đầu mỗi 10%, sau đó mỗi 1%
            const diffFromEntry = ((p - h.snapPrice) / h.snapPrice) * 100;
            let nextThreshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.dcaStep : (90 + (h.dcaCount - 8));
            const triggerDCA = h.type === 'LONG' ? diffFromEntry <= -nextThreshold : diffFromEntry >= nextThreshold;

            if (triggerDCA && !actionQueue.find(q => q.id === `bot_${this.id}`)) {
                actionQueue.push({ id: `bot_${this.id}`, priority: 1, action: () => {
                    const m = stats.available * 0.01; // Margin 1% số dư khả dụng
                    if (m <= 0) return;
                    h.totalMargin += m; h.dcaCount++;
                    h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                    h.dcaHistory.push({ t: Date.now(), p, avg: h.avgPrice });
                }});
            }
        } else if (!this.pending && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= this.minVol && (now - this.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
            if (!actionQueue.find(q => q.id === `bot_${this.id}`)) {
                actionQueue.push({ id: `bot_${this.id}`, priority: 2, action: () => {
                    let type = this.mode === 'FOLLOW' ? (c1 > 0 ? 'LONG' : 'SHORT') : 
                               (this.mode === 'REVERSE' ? (c1 > 0 ? 'SHORT' : 'LONG') : this.mode);
                    
                    this.pending = { 
                        symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, 
                        dcaCount: 0, totalMargin: stats.available * 0.01, 
                        maxLev: symbolMaxLeverage[s] || 20,
                        snapVol: { c1, c5, c15 },
                        dcaHistory: [{ t: now, p, avg: p }]
                    };
                }});
            }
        }
    }
}

// KHỞI TẠO 40 BOT
let botCores = [];
const modes = ['FOLLOW', 'REVERSE', 'LONG', 'SHORT'];
modes.forEach(m => {
    for (let v = 1; v <= 10; v++) botCores.push(new LuffyCore(botCores.length, m, v));
});

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
            botCores.forEach(b => b.update(s, p, c1, c5, c15));
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/data', (req, res) => {
    res.json({
        bots: botCores.map(b => ({ ...b, stats: b.getStats() })),
        summary: {
            eq: botCores.reduce((s, b) => s + b.getStats().equity, 0),
            win: botCores.reduce((s, b) => s + b.getStats().pnlWin, 0),
            open: botCores.filter(b => b.pending).length,
            livePnl: botCores.reduce((s, b) => s + b.getStats().livePnl, 0)
        }
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY MATRIX 40 ORIGIN</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; font-size: 11px; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .bot-card { border: 1px solid #30363d; padding: 6px; border-radius: 4px; background: #181a20; margin-bottom: 8px; cursor: pointer; transition: 0.2s; }
        .bot-card:hover { border-color: #fcd535; }
        .bot-card.active { border-color: #fcd535; background: #1e2329; box-shadow: 0 0 10px rgba(252, 213, 53, 0.1); }
        .mode-title { background: #fcd535; color: black; font-weight: 900; text-align: center; padding: 4px; border-radius: 4px; margin-bottom: 10px; text-transform: uppercase; font-size: 10px; }
        .modal { display:none; position:fixed; z-index:100; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); align-items:center; justify-content:center; }
    </style></head><body>
    
    <div id="modal" class="modal" onclick="this.style.display='none'">
        <div class="bg-card p-6 rounded-lg w-11/12 max-w-3xl border border-yellow-500" onclick="event.stopPropagation()">
            <div id="modalContent"></div>
        </div>
    </div>

    <div class="p-4 border-b border-zinc-800 flex justify-between items-center sticky top-0 bg-[#0b0e11] z-50">
        <div class="font-black italic text-xl">LUFFY <span class="text-[#fcd535]">ORIGIN</span> 40</div>
        <div class="flex gap-6">
            <div class="text-right"><div class="text-[9px] text-zinc-500 uppercase">Total Equity</div><div id="sumEq" class="text-lg font-bold">0.00</div></div>
            <div class="text-right"><div class="text-[9px] text-zinc-500 uppercase">Live PnL</div><div id="sumLive" class="text-lg font-bold">0.00</div></div>
            <div class="text-right"><div class="text-[9px] text-zinc-500 uppercase">Total Profit</div><div id="sumWin" class="text-lg font-bold text-green-400">0.00</div></div>
            <div class="text-right"><div class="text-[9px] text-zinc-500 uppercase">Open Positions</div><div id="sumOpen" class="text-lg font-bold text-blue-400">0</div></div>
        </div>
    </div>

    <div class="grid grid-cols-4 gap-4 p-4">
        <div><div class="mode-title">Follow (1-10%)</div><div id="col0"></div></div>
        <div><div class="mode-title">Reverse (1-10%)</div><div id="col1"></div></div>
        <div><div class="mode-title">Long Only (1-10%)</div><div id="col2"></div></div>
        <div><div class="mode-title">Short Only (1-10%)</div><div id="col3"></div></div>
    </div>

    <script>
        let rawData = null;
        function showDetail(id) {
            const bot = rawData.bots.find(b => b.id === id);
            if(!bot) return;
            const s = bot.stats;
            let html = \`
                <div class="flex justify-between items-start border-b border-zinc-700 pb-4 mb-4">
                    <div>
                        <h2 class="text-2xl font-black text-yellow-500">BOT #\${bot.id + 1} [\${bot.mode}]</h2>
                        <p class="text-zinc-400">Trigger Vol: \${bot.minVol}% | Vốn: \${bot.initialCapital}$</p>
                    </div>
                    <div class="text-right">
                        <div class="text-3xl font-bold \${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(2)}$</div>
                        <div class="text-sm font-bold">\${s.roi.toFixed(2)}% ROI</div>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-4 mb-6">
                    <div class="bg-[#0b0e11] p-3 rounded">
                        <div class="text-[10px] text-zinc-500">KÝ QUỸ HIỆN TẠI</div>
                        <div class="text-lg font-bold text-white">\${s.openMargin.toFixed(2)}$</div>
                    </div>
                    <div class="bg-[#0b0e11] p-3 rounded">
                        <div class="text-[10px] text-zinc-500">SỐ DƯ KHẢ DỤNG</div>
                        <div class="text-lg font-bold text-yellow-500">\${s.available.toFixed(2)}$</div>
                    </div>
                    <div class="bg-[#0b0e11] p-3 rounded">
                        <div class="text-[10px] text-zinc-500">TỔNG LỆNH WIN</div>
                        <div class="text-lg font-bold text-green-400">\${s.winCount}</div>
                    </div>
                </div>
                <h3 class="text-xs font-bold mb-2 uppercase text-zinc-500">Nhật ký DCA & Vị thế</h3>
                <div class="max-h-60 overflow-y-auto bg-[#0b0e11] rounded p-2">
                    <table class="w-full text-[10px] text-left">
                        <thead class="text-zinc-600 border-b border-zinc-800">
                            <tr><th>Thời gian</th><th>Giá khớp</th><th>Giá trung bình</th></tr>
                        </thead>
                        <tbody>
                            \${bot.pending ? bot.pending.dcaHistory.map(h => \`
                                <tr class="border-b border-zinc-900"><td class="py-1">\${new Date(h.t).toLocaleTimeString()}</td><td>\${h.p}</td><td class="text-yellow-500 font-bold">\${h.avg.toFixed(5)}</td></tr>
                            \`).join('') : '<tr><td colspan="3" class="text-center py-4 text-zinc-700">Không có vị thế mở</td></tr>'}
                        </tbody>
                    </table>
                </div>
            \`;
            document.getElementById('modalContent').innerHTML = html;
            document.getElementById('modal').style.display = 'flex';
        }

        async function update() {
            try {
                const res = await fetch('/api/data'); rawData = await res.json();
                const d = rawData;
                document.getElementById('sumEq').innerText = d.summary.eq.toFixed(2);
                document.getElementById('sumLive').innerText = d.summary.livePnl.toFixed(2);
                document.getElementById('sumWin').innerText = d.summary.win.toFixed(2);
                document.getElementById('sumOpen').innerText = d.summary.open;
                
                for(let i=0; i<4; i++) {
                    let html = "";
                    let group = d.bots.slice(i*10, (i+1)*10);
                    group.forEach(b => {
                        const s = b.stats;
                        html += \`<div class="bot-card \${b.pending?'active':''}" onclick="showDetail(\${b.id})">
                            <div class="flex justify-between font-bold text-[9px] mb-1">
                                <span class="text-zinc-500">#\${b.id+1} | \${b.minVol}%</span>
                                <span class="\${b.pending?'up':'text-zinc-700'} font-black text-[10px]">\${b.pending?b.pending.symbol:'IDLE'}</span>
                            </div>
                            <div class="grid grid-cols-2 gap-x-2 text-[10px] border-b border-zinc-800 pb-1 mb-1">
                                <div class="text-zinc-400">Equity: <b class="text-white">\${s.equity.toFixed(1)}</b></div>
                                <div class="text-zinc-400">Profit: <b class="text-green-400">\${s.pnlWin.toFixed(1)}</b></div>
                                <div class="text-zinc-400">Avail: <b class="text-yellow-500">\${s.available.toFixed(1)}</b></div>
                                <div class="text-zinc-400 text-right">Win: <b class="text-white">\${s.winCount}</b></div>
                            </div>
                            <div class="flex justify-between items-center mt-1">
                                <div class="font-black text-[12px] \${s.livePnl>=0?'up':'down'}">\${s.livePnl>=0?'+':''}\${s.livePnl.toFixed(2)}$</div>
                                <div class="font-black text-[11px] \${s.roi>=0?'up':'down'}">\${s.roi.toFixed(1)}%</div>
                            </div>
                        </div>\`;
                    });
                    document.getElementById('col'+i).innerHTML = html;
                }
            } catch(e) {}
        }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`🚀 LUFFY MATRIX: http://localhost:${PORT}/gui`); });
