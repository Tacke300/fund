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

// --- CLASS LUFFY CORE - 100% LOGIC GỐC ---
class LuffyCore {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode; 
        this.minVol = minVol;
        this.initialCapital = 100.0; // Vốn mỗi cấu hình 100$
        this.history = [];
        this.pending = null;
        this.lastTradeTime = 0;
        
        // Cấu hình gốc
        this.tpTarget = 0.3; 
        this.slTarget = 10.0; // DCA Step gốc
    }

    getStats() {
        let pnlWin = this.history.reduce((s, h) => s + (h.netPnl || 0), 0);
        let openMargin = 0, livePnl = 0, roi = 0;
        
        if (this.pending) {
            openMargin = this.pending.totalMargin;
            let lp = coinData[this.pending.symbol]?.live?.currentPrice || this.pending.avgPrice;
            let diff = ((lp - this.pending.avgPrice) / this.pending.avgPrice) * 100;
            roi = diff * (this.pending.type === 'LONG' ? 1 : -1) * (this.pending.maxLev || 20);
            livePnl = (openMargin * roi) / 100;
        }

        let equity = this.initialCapital + pnlWin;
        // Khả dụng = (Tổng vốn + Lãi) - Margin đang giữ + PnL tạm tính
        let available = (equity - openMargin) + livePnl;

        return { equity: equity + livePnl, available: Math.max(0, available), pnlWin, livePnl, roi, openMargin, winCount: this.history.length };
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
                this.history.push({...h}); this.pending = null; this.lastTradeTime = now; return;
            }

            // Logic DCA: 9 lần đầu mỗi 10%, sau đó mỗi 1% (100% THEO YÊU CẦU)
            const diffFromEntry = ((p - h.snapPrice) / h.snapPrice) * 100;
            let nextThreshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.slTarget : (90 + (h.dcaCount - 8));
            const triggerDCA = h.type === 'LONG' ? diffFromEntry <= -nextThreshold : diffFromEntry >= nextThreshold;

            if (triggerDCA && !actionQueue.find(q => q.id === `b${this.id}`)) {
                actionQueue.push({ id: `b${this.id}`, priority: 1, action: () => {
                    const mAdd = stats.available * 0.01; // 1% Khả dụng thực tế
                    h.totalMargin += mAdd; h.dcaCount++;
                    h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                    h.dcaHistory.push({ t: Date.now(), p, avg: h.avgPrice });
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
                        maxLev: symbolMaxLeverage[s] || 20, snapVol: { c1, c5, c15 },
                        dcaHistory: [{ t: now, p, avg: p }]
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

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data); const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            const calc = (m) => { 
                let st = coinData[s].prices.find(i => i.t >= (now - m * 60000)) || coinData[s].prices[0]; 
                return parseFloat((((p - st.p) / st.p) * 100).toFixed(2)); 
            };
            const c1 = calc(1), c5 = calc(5), c15 = calc(15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            botCores.forEach(b => b.update(s, p, c1, c5, c15));
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/data', (req, res) => {
    let bData = botCores.map(b => ({ ...b, stats: b.getStats() }));
    res.json({ bots: bData, summary: {
        eq: bData.reduce((s, b) => s + b.stats.equity, 0),
        av: bData.reduce((s, b) => s + b.stats.available, 0),
        open: bData.filter(b => b.pending).length,
        pnlWin: bData.reduce((s, b) => s + b.stats.pnlWin, 0),
        unPnl: bData.reduce((s, b) => s + b.stats.livePnl, 0)
    }});
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY MATRIX 40 ORIGIN</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bot-card { border: 1px solid #30363d; padding: 6px; border-radius: 4px; background: #181a20; margin-bottom: 8px; cursor: pointer; transition: 0.1s; }
        .bot-card:hover { border-color: #fcd535; }
        .bot-card.active { border-color: #fcd535; background: #1e2329; box-shadow: 0 0 8px rgba(252, 213, 53, 0.15); }
        .mode-title { background: #fcd535; color: black; font-weight: 900; text-align: center; padding: 6px; border-radius: 2px; margin-bottom: 12px; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); align-items:center; justify-content:center; }
    </style></head><body>
    <div id="detail" class="modal" onclick="this.style.display='none'">
        <div class="bg-[#1e2329] p-6 rounded-lg w-11/12 max-w-4xl border border-zinc-700" onclick="event.stopPropagation()">
            <div id="mTitle" class="text-xl font-bold text-yellow-500 mb-4 italic uppercase"></div>
            <div id="mBody"></div>
        </div>
    </div>
    <div class="p-4 border-b border-zinc-800 flex justify-between items-center sticky top-0 bg-[#0b0e11] z-50">
        <div class="font-black italic text-xl">LUFFY <span class="text-[#fcd535]">MATRIX</span> 40</div>
        <div class="grid grid-cols-5 gap-6 text-right">
            <div><div class="text-[9px] text-zinc-500">TOTAL EQUITY</div><div id="sEq" class="text-lg font-bold">0.00</div></div>
            <div><div class="text-[9px] text-zinc-500">AVAILABLE</div><div id="sAv" class="text-lg font-bold text-yellow-500">0.00</div></div>
            <div><div class="text-[9px] text-zinc-500">PNL WIN</div><div id="sPnlW" class="text-lg font-bold text-green-500">0.00</div></div>
            <div><div class="text-[9px] text-zinc-500">OPEN POS</div><div id="sOpen" class="text-lg font-bold text-blue-400">0</div></div>
            <div><div class="text-[9px] text-zinc-500">UNPNL</div><div id="sUnPnl" class="text-lg font-bold">0.00</div></div>
        </div>
    </div>
    <div class="grid grid-cols-4 gap-4 p-4">
        <div><div class="mode-title">FOLLOW</div><div id="col0"></div></div>
        <div><div class="mode-title">REVERSE</div><div id="col1"></div></div>
        <div><div class="mode-title">LONG ONLY</div><div id="col2"></div></div>
        <div><div class="mode-title">SHORT ONLY</div><div id="col3"></div></div>
    </div>
    <script>
        let rawBots = [];
        async function update() {
            const res = await fetch('/api/data'); const d = await res.json(); rawBots = d.bots;
            document.getElementById('sEq').innerText = d.summary.eq.toFixed(2);
            document.getElementById('sAv').innerText = d.summary.av.toFixed(2);
            document.getElementById('sPnlW').innerText = d.summary.pnlWin.toFixed(2);
            document.getElementById('sOpen').innerText = d.summary.open;
            document.getElementById('sUnPnl').innerText = d.summary.unPnl.toFixed(2);
            document.getElementById('sUnPnl').className = 'text-lg font-bold ' + (d.summary.unPnl>=0?'up':'down');
            for(let i=0; i<4; i++) {
                let html = ""; let group = d.bots.slice(i*10, (i+1)*10);
                group.forEach(b => {
                    const s = b.stats;
                    html += \`<div class="bot-card \${b.pending?'active':''}" onclick="showDetail(\${b.id})">
                        <div class="flex justify-between font-bold text-[9px] mb-1">
                            <span class="text-zinc-500">#\${b.id+1} | \${b.minVol}%</span>
                            <span class="\${b.pending?'up':'text-zinc-700'}">\${b.pending?b.pending.symbol:'IDLE'}</span>
                        </div>
                        <div class="flex justify-between text-[10px]">
                            <div class="text-zinc-400">Win: <b class="text-white">\${s.pnlWin.toFixed(1)}</b></div>
                            <div class="font-bold \${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(2)}</div>
                        </div>
                    </div>\`;
                });
                document.getElementById('col'+i).innerHTML = html;
            }
        }
        function showDetail(id) {
            const b = rawBots[id]; const s = b.stats;
            document.getElementById('mTitle').innerText = \`Bot #\${id+1} | \${b.mode} | \${b.minVol}%\`;
            let body = \`<div class="grid grid-cols-4 gap-4 text-center mb-6">
                <div class="bg-[#0b0e11] p-3 rounded"><div>EQUITY</div><div class="text-lg font-bold">$\${s.equity.toFixed(2)}</div></div>
                <div class="bg-[#0b0e11] p-3 rounded"><div>AVAILABLE</div><div class="text-lg font-bold text-yellow-500">$\${s.available.toFixed(2)}</div></div>
                <div class="bg-[#0b0e11] p-3 rounded"><div>PNL WIN</div><div class="text-lg font-bold text-green-500">$\${s.pnlWin.toFixed(2)}</div></div>
                <div class="bg-[#0b0e11] p-3 rounded"><div>ROI LIVE</div><div class="text-lg font-bold \${s.roi>=0?'up':'down'}">\${s.roi.toFixed(2)}%</div></div>
            </div>\`;
            if(b.pending) {
                const p = b.pending;
                body += \`<div class="bg-zinc-900 p-4 rounded border border-yellow-500/30 mb-6">
                    <div class="flex justify-between font-bold mb-2"><span>\${p.symbol} [\${p.type}]</span><span>DCA Lần: \${p.dcaCount}</span></div>
                    <div class="grid grid-cols-3 gap-4 text-zinc-400 mb-4">
                        <div>Entry: \${p.snapPrice}</div><div>Avg: \${p.avgPrice}</div><div>Margin: \${p.totalMargin.toFixed(2)}</div>
                    </div>
                    <div class="grid grid-cols-3 gap-4 border-t border-zinc-800 pt-2 text-[10px]">
                        <div class="italic">1M: \${p.snapVol.c1}%</div><div class="italic">5M: \${p.snapVol.c5}%</div><div class="italic">15M: \${p.snapVol.c15}%</div>
                    </div>
                </div>\`;
            }
            body += \`<div class="text-zinc-500 font-bold mb-2 uppercase italic text-[10px]">Nhật ký 5 lệnh gần nhất</div>
                <table class="w-full text-left text-[10px]"><thead class="text-zinc-600 border-b border-zinc-800"><tr><th>TIME</th><th>SYMBOL</th><th>TYPE</th><th>DCA</th><th>PNL NET</th></tr></thead>
                <tbody>\${b.history.slice(-5).reverse().map(h=>\`<tr class="border-b border-zinc-800/30"><td class="py-2 text-zinc-500">\${new Date(h.endTime).toLocaleTimeString()}</td><td class="font-bold">\${h.symbol}</td><td class="\${h.type==='LONG'?'up':'down'}">\${h.type}</td><td>\${h.dcaCount}</td><td class="\${h.netPnl>=0?'up':'down'} font-bold">\${h.netPnl.toFixed(2)}</td></tr>\`).join('')}</tbody></table>\`;
            document.getElementById('mBody').innerHTML = body;
            document.getElementById('detail').style.display = 'flex';
        }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`🚀 http://localhost:${PORT}/gui`); });
