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

// --- HÀNG ĐỢI LỆNH (GIỮ NGUYÊN TỐC ĐỘ GỐC) ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift(); task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- CLASS LUFFY CORE - 100% LOGIC GỐC CỦA TÙNG ---
class LuffyCore {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode; 
        this.minVol = minVol;
        this.initialCapital = 100.0; 
        this.history = [];
        this.pending = null;
        this.lastTradeTime = 0;
        
        // Cấu hình gốc 100%
        this.tpTarget = 0.3; // 0.3% giá
        this.dcaStep = 10.0; // 10% giá cho 9 lần đầu
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

            // Logic DCA: 9 lần đầu mỗi 10%, sau đó mỗi 1% (NHÂN BẢN 100% LOGIC)
            const diffFromEntry = ((p - h.snapPrice) / h.snapPrice) * 100;
            let nextThreshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.dcaStep : (90 + (h.dcaCount - 8));
            const triggerDCA = h.type === 'LONG' ? diffFromEntry <= -nextThreshold : diffFromEntry >= nextThreshold;

            if (triggerDCA && !actionQueue.find(q => q.id === `b${this.id}`)) {
                actionQueue.push({ id: `b${this.id}`, priority: 1, action: () => {
                    const m = stats.available * 0.01; 
                    h.totalMargin += m; h.dcaCount++;
                    h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                }});
            }
        } else if (!this.pending && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= this.minVol && (now - this.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
            if (!actionQueue.find(q => q.id === `b${this.id}`)) {
                actionQueue.push({ id: `b${this.id}`, priority: 2, action: () => {
                    let type = this.mode === 'FOLLOW' ? (c1 > 0 ? 'LONG' : 'SHORT') : 
                               (this.mode === 'REVERSE' ? (c1 > 0 ? 'SHORT' : 'LONG') : this.mode);
                    
                    this.pending = { 
                        symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, 
                        dcaCount: 0, totalMargin: stats.available * 0.01, 
                        maxLev: symbolMaxLeverage[s] || 20,
                        snapVol: { c1, c5, c15 } 
                    };
                }});
            }
        }
    }
}

let botCores = [];
['FOLLOW', 'REVERSE', 'LONG', 'SHORT'].forEach(m => {
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
            open: botCores.filter(b => b.pending).length
        }
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY MATRIX 40 ORIGIN</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; font-size: 11px; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bot-card { border: 1px solid #30363d; padding: 6px; border-radius: 4px; background: #181a20; margin-bottom: 8px; }
        .bot-card.active { border-color: #fcd535; background: #1e2329; box-shadow: 0 0 10px rgba(252, 213, 53, 0.1); }
        .mode-title { background: #fcd535; color: black; font-weight: 900; text-align: center; padding: 6px; border-radius: 4px; margin-bottom: 12px; text-transform: uppercase; }
    </style></head><body>
    <div class="p-4 border-b border-zinc-800 flex justify-between items-center sticky top-0 bg-[#0b0e11] z-50">
        <div class="font-black italic text-xl">LUFFY <span class="text-[#fcd535]">ORIGIN</span> 40</div>
        <div class="flex gap-8">
            <div class="text-right"><div class="text-[9px] text-zinc-500">TOTAL EQUITY</div><div id="sumEq" class="text-lg font-bold">0.00</div></div>
            <div class="text-right"><div class="text-[9px] text-zinc-500">TOTAL PROFIT</div><div id="sumWin" class="text-lg font-bold text-green-400">0.00</div></div>
            <div class="text-right"><div class="text-[9px] text-zinc-500">OPEN BOTS</div><div id="sumOpen" class="text-lg font-bold text-blue-400">0</div></div>
        </div>
    </div>
    <div class="grid grid-cols-4 gap-4 p-4">
        <div><div class="mode-title">Follow (1-10%)</div><div id="col0"></div></div>
        <div><div class="mode-title">Reverse (1-10%)</div><div id="col1"></div></div>
        <div><div class="mode-title">Long Only</div><div id="col2"></div></div>
        <div><div class="mode-title">Short Only</div><div id="col3"></div></div>
    </div>
    <script>
        async function update() {
            try {
                const res = await fetch('/api/data'); const d = await res.json();
                document.getElementById('sumEq').innerText = d.summary.eq.toFixed(2);
                document.getElementById('sumWin').innerText = d.summary.win.toFixed(2);
                document.getElementById('sumOpen').innerText = d.summary.open;
                for(let i=0; i<4; i++) {
                    let html = "";
                    let group = d.bots.slice(i*10, (i+1)*10);
                    group.forEach(b => {
                        const s = b.stats;
                        html += \`<div class="bot-card \${b.pending?'active':''}">
                            <div class="flex justify-between font-bold text-[9px] mb-1">
                                <span class="text-zinc-500">#\${b.id+1} | \${b.minVol}%</span>
                                <span class="\${b.pending?'up':'text-zinc-700'} font-black text-[10px]">\${b.pending?b.pending.symbol:'IDLE'}</span>
                            </div>
                            <div class="grid grid-cols-2 gap-x-2 text-[10px] border-b border-zinc-800 pb-1 mb-1">
                                <div class="text-zinc-400">Vốn: <b class="text-white">\${s.equity.toFixed(1)}</b></div>
                                <div class="text-zinc-400">Lãi: <b class="text-green-400">\${s.pnlWin.toFixed(1)}</b></div>
                                <div class="text-zinc-400">K.Dụng: <b class="text-yellow-500">\${s.available.toFixed(1)}</b></div>
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
