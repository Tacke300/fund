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

// --- QUEUE LỆNH (ZIN 100%) ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift(); task.action();
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

// --- CLASS LUFFY 40 CONFIGS ---
class LuffyBot {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode; 
        this.minVol = minVol;
        this.capital = 100.0; // Vốn mỗi cấu hình 100$
        this.tp = 0.3; this.dcaStep = 10.0;
        this.history = []; this.pending = null; this.lastTradeTime = 0;
    }

    getStats() {
        let pnlWin = this.history.reduce((s, h) => s + (h.netPnl || 0), 0);
        let openMargin = 0, livePnl = 0, roi = 0;
        if (this.pending) {
            openMargin = this.pending.totalMargin;
            let lp = coinData[this.pending.symbol]?.live?.currentPrice || this.pending.avgPrice;
            let diff = ((lp - this.pending.avgPrice) / this.pending.avgPrice) * 100;
            roi = diff * (this.pending.maxLev || 20) * (this.pending.type === 'LONG' ? 1 : -1);
            livePnl = (openMargin * roi) / 100;
        }
        let totalBal = this.capital + pnlWin;
        let available = (totalBal - openMargin) + livePnl; // Khả dụng thực tế
        return { equity: totalBal + livePnl, available, pnlWin, livePnl, roi, openMargin, winCount: this.history.length };
    }

    update(s, p, c1, c5, c15) {
        const now = Date.now();
        const stats = this.getStats();
        if (this.pending && this.pending.symbol === s) {
            const h = this.pending;
            const diffAvg = ((p - h.avgPrice) / h.avgPrice) * 100;
            const win = h.type === 'LONG' ? diffAvg >= this.tp : diffAvg <= -this.tp;
            if (win) {
                let finalRoi = diffAvg * (h.maxLev || 20) * (h.type === 'LONG' ? 1 : -1);
                h.netPnl = (h.totalMargin * finalRoi) / 100; h.endTime = now; h.status = 'WIN';
                this.history.push({...h}); this.pending = null; this.lastTradeTime = now; return;
            }
            // DCA Logic: 1-9 lần 10%, từ lần 10 mỗi 1%
            const diffEntry = ((p - h.snapPrice) / h.snapPrice) * 100;
            let threshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.dcaStep : (90 + (h.dcaCount - 8));
            const trigger = h.type === 'LONG' ? diffEntry <= -threshold : diffEntry >= threshold;
            if (trigger && !actionQueue.find(q => q.id === `bot_${this.id}`)) {
                actionQueue.push({ id: `bot_${this.id}`, priority: 1, action: () => {
                    let marginAdd = stats.available * 0.01; // Margin 1% khả dụng
                    h.totalMargin += marginAdd; h.dcaCount++;
                    h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                    h.dcaHistory.push({ t: Date.now(), p, avg: h.avgPrice });
                }});
            }
        } else if (!this.pending && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= this.minVol && (now - this.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
            if (!actionQueue.find(q => q.id === `bot_${this.id}`)) {
                actionQueue.push({ id: `bot_${this.id}`, priority: 2, action: () => {
                    let type = this.mode === 'FOLLOW' ? (c1 > 0 ? 'LONG' : 'SHORT') : (this.mode === 'REVERSE' ? (c1 > 0 ? 'SHORT' : 'LONG') : this.mode);
                    this.pending = { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, totalMargin: stats.available * 0.01, dcaCount: 0, maxLev: symbolMaxLeverage[s] || 20, dcaHistory: [{ t: now, p, avg: p }], snapVol: { c1, c5, c15 } };
                }});
            }
        }
    }
}

let bots = [];
['FOLLOW', 'REVERSE', 'LONG', 'SHORT'].forEach(m => { for (let v = 1; v <= 10; v++) bots.push(new LuffyBot(bots.length, m, v)); });

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data); const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now }); if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            const calc = (m) => { let st = coinData[s].prices.find(i => i.t >= (now - m * 60000)) || coinData[s].prices[0]; return parseFloat((((p - st.p) / st.p) * 100).toFixed(2)); };
            const c1 = calc(1), c5 = calc(5), c15 = calc(15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            bots.forEach(b => b.update(s, p, c1, c5, c15));
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/data', (req, res) => {
    let bData = bots.map(b => ({ ...b, stats: b.getStats() }));
    res.json({ bots: bData, summary: { 
        eq: bData.reduce((s, b) => s + b.stats.equity, 0), 
        av: bData.reduce((s, b) => s + b.stats.available, 0), 
        winCount: bData.reduce((s, b) => s + b.stats.winCount, 0),
        pnlWin: bData.reduce((s, b) => s + b.stats.pnlWin, 0),
        open: bData.filter(b => b.pending).length,
        unPnl: bData.reduce((s, b) => s + b.stats.livePnl, 0)
    }});
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY MATRIX 40</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; padding: 6px; border-radius: 4px; margin-bottom: 8px; cursor: pointer; transition: 0.1s; }
        .bg-card:hover { border-color: #fcd535; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); align-items:center; justify-content:center; }
        .mode-head { background: #fcd535; color: black; font-weight: 900; text-align: center; padding: 5px; border-radius: 2px; margin-bottom: 12px; }
    </style></head><body>
    <div id="detail" class="modal" onclick="this.style.display='none'">
        <div class="bg-[#1e2329] p-6 rounded-lg w-11/12 max-w-4xl border border-zinc-700" onclick="event.stopPropagation()">
            <div id="mTitle" class="text-xl font-bold text-yellow-500 mb-4 border-b border-zinc-800 pb-2 italic"></div>
            <div id="mBody" class="space-y-4"></div>
        </div>
    </div>
    <div class="p-4 border-b border-zinc-800 flex justify-between items-center sticky top-0 bg-[#0b0e11] z-50">
        <div class="font-black italic text-xl">LUFFY <span class="text-[#fcd535]">ORIGIN 40</span></div>
        <div class="grid grid-cols-6 gap-6 text-right">
            <div><div class="text-[9px] text-zinc-500 uppercase">Equity</div><div id="sEq" class="text-lg font-bold">0.00</div></div>
            <div><div class="text-[9px] text-zinc-500 uppercase">Available</div><div id="sAv" class="text-lg font-bold text-yellow-500">0.00</div></div>
            <div><div class="text-[9px] text-zinc-500 uppercase">Total Win</div><div id="sWinC" class="text-lg font-bold text-green-500">0</div></div>
            <div><div class="text-[9px] text-zinc-500 uppercase">PnL Win</div><div id="sPnlW" class="text-lg font-bold">0.00</div></div>
            <div><div class="text-[9px] text-zinc-500 uppercase">Open Pos</div><div id="sOpen" class="text-lg font-bold text-blue-400">0</div></div>
            <div><div class="text-[9px] text-zinc-500 uppercase">UnPnL</div><div id="sUnPnl" class="text-lg font-bold">0.00</div></div>
        </div>
    </div>
    <div class="grid grid-cols-4 gap-4 p-4">
        <div><div class="mode-head">FOLLOW</div><div id="col0"></div></div>
        <div><div class="mode-head">REVERSE</div><div id="col1"></div></div>
        <div><div class="mode-head">LONG ONLY</div><div id="col2"></div></div>
        <div><div class="mode-head">SHORT ONLY</div><div id="col3"></div></div>
    </div>
    <script>
        let rawData = [];
        async function update() {
            const res = await fetch('/api/data'); const d = await res.json(); rawData = d.bots;
            const sum = d.summary;
            document.getElementById('sEq').innerText = sum.eq.toFixed(2);
            document.getElementById('sAv').innerText = sum.av.toFixed(2);
            document.getElementById('sWinC').innerText = sum.winCount;
            document.getElementById('sPnlW').innerText = sum.pnlWin.toFixed(2);
            document.getElementById('sOpen').innerText = sum.open;
            document.getElementById('sUnPnl').innerText = sum.unPnl.toFixed(2);
            document.getElementById('sUnPnl').className = 'text-lg font-bold ' + (sum.unPnl>=0?'up':'down');
            for(let i=0; i<4; i++) {
                let html = ""; let group = d.bots.slice(i*10, (i+1)*10);
                group.forEach(b => {
                    const s = b.stats;
                    html += \`<div class="bg-card \${b.pending?'border-yellow-500':''}" onclick="showDetail(\${b.id})">
                        <div class="flex justify-between font-bold text-[9px] mb-1">
                            <span class="text-zinc-500">#\${b.id+1} | \${b.minVol}%</span>
                            <span class="\${b.pending?'up':'text-zinc-700'}">\${b.pending?b.pending.symbol:'IDLE'}</span>
                        </div>
                        <div class="flex justify-between text-[10px]">
                            <div class="up">+\${s.pnlWin.toFixed(1)}</div>
                            <div class="font-bold \${s.livePnl>=0?'up':'down'}">\${s.livePnl>=0?'+':''}\${s.livePnl.toFixed(2)}</div>
                        </div>
                    </div>\`;
                });
                document.getElementById('col'+i).innerHTML = html;
            }
        }
        function showDetail(id) {
            const b = rawData[id]; const s = b.stats;
            document.getElementById('mTitle').innerText = \`BOT #\${id+1} | \${b.mode} | VOL: \${b.minVol}%\`;
            let body = \`<div class="grid grid-cols-4 gap-4 text-center">
                <div class="bg-[#0b0e11] p-3 rounded border border-zinc-800"><div>EQUITY</div><div class="text-lg font-bold">$\${s.equity.toFixed(2)}</div></div>
                <div class="bg-[#0b0e11] p-3 rounded border border-zinc-800"><div>AVAILABLE</div><div class="text-lg font-bold text-yellow-500">$\${s.available.toFixed(2)}</div></div>
                <div class="bg-[#0b0e11] p-3 rounded border border-zinc-800"><div>TOTAL WIN</div><div class="text-lg font-bold text-green-500">\${s.winCount}</div></div>
                <div id="pnlNow" class="bg-[#0b0e11] p-3 rounded border border-zinc-800"><div>CURR PNL</div><div class="text-lg font-bold \${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(2)}</div></div>
            </div>\`;
            if(b.pending) {
                const p = b.pending;
                body += \`<div class="bg-zinc-900/50 p-4 rounded-lg border border-yellow-500/20 mt-4">
                    <div class="flex justify-between mb-2"><b>\${p.symbol} [\${p.type}]</b><span>DCA: \${p.dcaCount}</span></div>
                    <div class="grid grid-cols-3 gap-2 text-[10px] text-zinc-400 mb-4">
                        <div>Entry: \${p.snapPrice}</div><div>Avg: \${p.avgPrice}</div><div>Margin: \${p.totalMargin.toFixed(2)}</div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 border-t border-zinc-800 pt-2">
                        <div>1M: \${p.snapVol.c1}%</div><div>5M: \${p.snapVol.c5}%</div><div>15M: \${p.snapVol.c15}%</div>
                    </div>
                </div>\`;
            }
            body += \`<div class="mt-4"><div class="text-zinc-500 font-bold mb-2">NHẬT KÝ GẦN NHẤT</div>
                <table class="w-full text-left text-[9px]"><thead class="text-zinc-600 border-b border-zinc-800"><tr><th>SYMBOL</th><th>TYPE</th><th>DCA</th><th>PNL NET</th><th>TIME</th></tr></thead>
                <tbody>\${b.history.slice(-5).reverse().map(h=>\`<tr class="border-b border-zinc-800/30"><td class="py-1">\${h.symbol}</td><td class="\${h.type==='LONG'?'up':'down'}">\${h.type}</td><td>\${h.dcaCount}</td><td class="\${h.netPnl>=0?'up':'down'} font-bold">\${h.netPnl.toFixed(2)}</td><td class="text-zinc-500">\${new Date(h.endTime).toLocaleTimeString()}</td></tr>\`).join('')}</tbody></table></div>\`;
            document.getElementById('mBody').innerHTML = body;
            document.getElementById('detail').style.display = 'flex';
        }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`🚀 http://localhost:${PORT}/gui`); });
