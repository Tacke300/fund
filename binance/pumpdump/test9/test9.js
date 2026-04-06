const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let marketPrices = {}; 
let symbolMaxLeverage = {}; 
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }

// --- HÀNG ĐỢI LỆNH TỔNG ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift(); task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- CẤU TRÚC LUFFY CORE (100% LOGIC GỐC CỦA TÙNG) ---
class LuffyCore {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode; // FOLLOW, REVERSE, LONG, SHORT
        this.minVol = minVol; // 1% -> 10%
        this.initialCapital = 100.0;
        this.historyMap = new Map();
        this.lastTradeClosed = {};
        this.coinData = {}; 
        this.tpTarget = 0.3; // 0.3%
        this.slTarget = 10.0; // DCA 10%
    }

    getStats() {
        const all = Array.from(this.historyMap.values());
        const pending = all.find(h => h.status === 'PENDING');
        const closed = all.filter(h => h.status !== 'PENDING');
        
        let pnlWin = closed.reduce((s, h) => {
            let marginBase = 1.0; // Giả định margin 1$ để tính tỉ lệ, lát sẽ tính chính xác theo avail
            let totalMargin = h.marginOpen * (h.dcaCount + 1);
            return s + (totalMargin * (h.maxLev || 20) * (h.pnlPercent/100));
        }, 0);

        let openMargin = 0, livePnl = 0, roi = 0;
        if (pending) {
            let lp = marketPrices[pending.symbol] || pending.avgPrice;
            openMargin = pending.marginOpen * (pending.dcaCount + 1);
            let diff = ((lp - pending.avgPrice) / pending.avgPrice) * 100;
            roi = (pending.type === 'LONG' ? diff : -diff) * (pending.maxLev || 20);
            livePnl = (openMargin * roi) / 100;
        }

        // SỐ DƯ KHẢ DỤNG THỰC TẾ THEO YÊU CẦU: Tổng - Margin mở + PnL Win +- PnL Live
        let equity = this.initialCapital + pnlWin + livePnl;
        let available = (this.initialCapital + pnlWin - openMargin) + livePnl;

        return { equity, available: Math.max(0, available), pnlWin, livePnl, roi, winCount: closed.length, pending, history: closed };
    }

    update(s, p, c1, c5, c15) {
        const now = Date.now();
        const stats = this.getStats();
        if (!this.coinData[s]) this.coinData[s] = { prices: [] };
        this.coinData[s].prices.push({ p, t: now });
        if (this.coinData[s].prices.length > 100) this.coinData[s].prices.shift();

        if (stats.pending && stats.pending.symbol === s) {
            const h = stats.pending;
            const diffAvg = ((p - h.avgPrice) / h.avgPrice) * 100;
            const win = h.type === 'LONG' ? diffAvg >= this.tpTarget : diffAvg <= -this.tpTarget;

            if (win) {
                h.status = 'WIN'; h.endTime = now; h.finalPrice = p;
                h.pnlPercent = (h.type === 'LONG' ? diffAvg : -diffAvg);
                this.lastTradeClosed[s] = now; return;
            }

            const diffEntry = ((p - h.snapPrice) / h.snapPrice) * 100;
            // LOGIC DCA ĐỘT BIẾN: 9 lần đầu 10%, sau đó mỗi 1%
            let threshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.slTarget : (90 + (h.dcaCount - 8));
            const triggerDCA = h.type === 'LONG' ? diffEntry <= -threshold : diffEntry >= threshold;

            if (triggerDCA && !actionQueue.find(q => q.id === `core_${this.id}_${s}`)) {
                actionQueue.push({ id: `core_${this.id}_${s}`, priority: 1, action: () => {
                    h.dcaCount++;
                    h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                    h.dcaHistory.push({ t: now, p, avg: h.avgPrice });
                }});
            }
        } else if (!stats.pending && Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= this.minVol) {
            if (!(this.lastTradeClosed[s] && (now - this.lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === `core_${this.id}_${s}`)) {
                    actionQueue.push({ id: `core_${this.id}_${s}`, priority: 2, action: () => {
                        let type = this.mode === 'FOLLOW' ? (c1 > 0 ? 'LONG' : 'SHORT') : 
                                   (this.mode === 'REVERSE' ? (c1 > 0 ? 'SHORT' : 'LONG') : this.mode);
                        
                        this.historyMap.set(`${s}_${now}`, {
                            symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING',
                            maxLev: symbolMaxLeverage[s] || 20, marginOpen: stats.available * 0.01,
                            dcaCount: 0, dcaHistory: [{ t: now, p, avg: p }], pnlPercent: 0
                        });
                    }});
                }
            }
        }
    }
}

// KHỞI TẠO 40 CORE THEO HÀNG LỐI
let bots = [];
['FOLLOW', 'REVERSE', 'LONG', 'SHORT'].forEach(m => {
    for (let v = 1; v <= 10; v++) bots.push(new LuffyCore(bots.length, m, v));
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
            marketPrices[s] = p;
            if (!marketPrices[s + '_hist']) marketPrices[s + '_hist'] = [];
            marketPrices[s + '_hist'].push({ p, t: now });
            if (marketPrices[s + '_hist'].length > 300) marketPrices[s + '_hist'].shift();
            
            const c1 = calculateChange(marketPrices[s + '_hist'], 1), c5 = calculateChange(marketPrices[s + '_hist'], 5), c15 = calculateChange(marketPrices[s + '_hist'], 15);
            bots.forEach(b => b.update(s, p, c1, c5, c15));
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// --- API & GUI ---
app.get('/api/data', (req, res) => {
    res.json({
        bots: bots.map(b => ({ id: b.id, mode: b.mode, minVol: b.minVol, stats: b.getStats() })),
        market: Object.entries(marketPrices).filter(([k]) => !k.endsWith('_hist')).map(([s, p]) => ({ symbol: s, price: p }))
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY 40-CORE MATRIX</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; font-size: 10px; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bot-card { border: 1px solid #30363d; padding: 4px; border-radius: 3px; background: #181a20; cursor: pointer; }
        .bot-card.active { border-color: #fcd535; background: #1e2329; }
        .modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.95); z-index:100; overflow-y:auto; }
    </style></head><body>
    
    <div id="dash" class="p-2">
        <div class="flex justify-between items-center mb-4 p-2 bg-[#1e2329] rounded border border-zinc-800">
            <div class="font-black italic text-lg uppercase text-[#fcd535]">Luffy 40-Core Matrix</div>
            <div class="flex gap-6 text-right">
                <div><div class="text-[8px] text-zinc-500 uppercase">Total Equity</div><div id="totalEq" class="text-sm font-bold text-white">0.00</div></div>
                <div><div class="text-[8px] text-zinc-500 uppercase">Total Win</div><div id="totalWin" class="text-sm font-bold text-green-400">0</div></div>
                <div><div class="text-[8px] text-zinc-500 uppercase">PnL Live</div><div id="totalLive" class="text-sm font-bold">0.00</div></div>
            </div>
        </div>

        <div class="grid grid-cols-4 gap-4">
            <div><div class="bg-yellow-500 text-black font-black text-center mb-2 rounded py-1 uppercase">Follow (1-10%)</div><div id="col0" class="space-y-2"></div></div>
            <div><div class="bg-yellow-500 text-black font-black text-center mb-2 rounded py-1 uppercase">Reverse (1-10%)</div><div id="col1" class="space-y-2"></div></div>
            <div><div class="bg-yellow-500 text-black font-black text-center mb-2 rounded py-1 uppercase">Long Only</div><div id="col2" class="space-y-2"></div></div>
            <div><div class="bg-yellow-500 text-black font-black text-center mb-2 rounded py-1 uppercase">Short Only</div><div id="col3" class="space-y-2"></div></div>
        </div>
    </div>

    <div id="botModal" class="modal">
        <div class="p-4 bg-yellow-500 text-black font-black text-center cursor-pointer sticky top-0" onclick="closeBot()">ĐÓNG CHI TIẾT</div>
        <div id="botContent" class="p-4"></div>
    </div>

    <script>
        let allBots = []; let activeBotId = null;
        async function update() {
            const res = await fetch('/api/data'); const d = await res.json(); allBots = d.bots;
            let sumEq = 0, sumWin = 0, sumLive = 0;
            
            for(let i=0; i<4; i++) {
                let html = "";
                let group = d.bots.slice(i*10, (i+1)*10);
                group.forEach(b => {
                    const s = b.stats; sumEq += s.equity; sumWin += s.winCount; sumLive += s.livePnl;
                    html += \`<div class="bot-card \${s.pending?'active':''}" onclick="openBot(\${b.id})">
                        <div class="flex justify-between font-bold text-[8px] mb-1">
                            <span class="text-zinc-500">#\${b.id+1} | \${b.minVol}%</span>
                            <span class="\${s.pending?'up':'text-zinc-700'}">\${s.pending?s.pending.symbol:'IDLE'}</span>
                        </div>
                        <div class="grid grid-cols-2 gap-x-2 border-b border-zinc-800/50 pb-1 mb-1">
                            <div>Eq: <b class="text-white">\${s.equity.toFixed(1)}</b></div>
                            <div>Avail: <b class="text-yellow-500">\${s.available.toFixed(1)}</b></div>
                            <div>Win: <b class="text-green-400">\${s.winCount}</b></div>
                            <div class="text-right">Live: <b class="\${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(1)}</b></div>
                        </div>
                    </div>\`;
                });
                document.getElementById('col'+i).innerHTML = html;
            }
            document.getElementById('totalEq').innerText = sumEq.toFixed(2);
            document.getElementById('totalWin').innerText = sumWin;
            document.getElementById('totalLive').innerText = sumLive.toFixed(2);
            document.getElementById('totalLive').className = 'text-sm font-bold ' + (sumLive>=0?'up':'down');
            if(activeBotId !== null) renderDetail(activeBotId);
        }

        function openBot(id) { activeBotId = id; document.getElementById('botModal').style.display='block'; document.getElementById('dash').style.display='none'; }
        function closeBot() { activeBotId = null; document.getElementById('botModal').style.display='none'; document.getElementById('dash').style.display='block'; }

        function renderDetail(id) {
            const b = allBots[id]; const s = b.stats;
            const content = \`
                <div class="grid grid-cols-2 gap-4 mb-4">
                    <div class="bg-card p-4 rounded">
                        <div class="text-zinc-500 uppercase font-bold text-[9px]">Equity Core #\${id+1}</div>
                        <div class="text-3xl font-black text-white">\${s.equity.toFixed(2)} <span class="text-sm">USDT</span></div>
                        <div class="text-zinc-500 text-[10px] mt-2">Chế độ: \${b.mode} | Biến động: \${b.minVol}%</div>
                    </div>
                    <div class="bg-card p-4 rounded grid grid-cols-2 gap-2">
                        <div class="text-center border-r border-zinc-800">
                            <div class="text-zinc-500 uppercase text-[8px]">PnL Win</div>
                            <div class="text-lg font-bold text-green-400">\${s.pnlWin.toFixed(2)}</div>
                        </div>
                        <div class="text-center">
                            <div class="text-zinc-500 uppercase text-[8px]">Số lệnh Win</div>
                            <div class="text-lg font-bold text-white">\${s.winCount}</div>
                        </div>
                    </div>
                </div>
                <div class="bg-card p-4 rounded mb-4">
                    <div class="text-yellow-500 font-bold uppercase mb-2">Vị thế đang mở</div>
                    \${s.pending ? \`<div class="flex justify-between items-center p-3 bg-zinc-800/50 rounded">
                        <div class="text-xl font-black text-white">\${s.pending.symbol} <span class="text-[10px] px-1 \${s.pending.type==='LONG'?'bg-green-600':'bg-red-600'}">\${s.pending.type}</span></div>
                        <div class="text-right"><div class="text-2xl font-black \${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(2)}$</div><div class="text-[10px] font-black \${s.roi>=0?'up':'down'}">\${s.roi.toFixed(1)}%</div></div>
                    </div>\` : '<div class="text-center py-4 text-zinc-700 italic">KHÔNG CÓ VỊ THẾ</div>'}
                </div>
                <div class="bg-card p-4 rounded">
                    <div class="text-zinc-500 font-bold uppercase mb-2">Nhật ký 5 lệnh gần nhất</div>
                    <table class="w-full text-left text-[9px]">
                        <thead class="text-zinc-600 border-b border-zinc-800 uppercase"><tr><th>Symbol</th><th>Type</th><th>DCA</th><th>PnL Net</th></tr></thead>
                        <tbody>\${s.history.slice(-5).reverse().map(h=>\`<tr class="border-b border-zinc-800/50"><td class="py-2 text-white font-bold">\${h.symbol}</td><td class="\${h.type==='LONG'?'up':'down'}">\${h.type}</td><td class="text-yellow-500">\${h.dcaCount}</td><td class="up font-bold">+\${(h.marginOpen*(h.dcaCount+1)*20*(h.pnlPercent/100)).toFixed(2)}</td></tr>\`).join('')}</tbody>
                    </table>
                </div>\`;
            document.getElementById('botContent').innerHTML = content;
        }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`🚀 READY: http://localhost:${PORT}/gui`); });
