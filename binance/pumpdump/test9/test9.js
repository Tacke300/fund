const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 500000; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let symbolMaxLeverage = {}; 
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }

// --- HỆ THỐNG QUẢN LÝ HÀNG ĐỢI (GIỮ NGUYÊN) ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- CLASS BOT ĐỘC LẬP (NHÂN BẢN 40 CẤU HÌNH) ---
class LuffyCore {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode; // LONG, SHORT, FOLLOW, REVERSE
        this.minVol = minVol; // 1 -> 10
        this.capital = 100.0;
        this.history = [];
        this.pending = null;
        this.lastTradeTime = 0;
        this.tpTarget = 0.3;
        this.slTarget = 10.0; // DCA Step
    }

    // TÍNH SỐ DƯ KHẢ DỤNG THỰC TẾ (MECHANIC CỐT LÕI)
    // Formula: (100 + PnL Win + PnL Tạm tính) - Margin đang mở
    getAvailableBalance() {
        let pnlWin = this.history.reduce((s, h) => s + (h.netPnl || 0), 0);
        let openMargin = 0;
        let livePnl = 0;

        if (this.pending) {
            openMargin = this.pending.totalMargin;
            let lp = coinData[this.pending.symbol]?.live?.currentPrice || this.pending.avgPrice;
            let diff = ((lp - this.pending.avgPrice) / this.pending.avgPrice) * 100;
            livePnl = openMargin * (this.pending.type === 'LONG' ? diff : -diff) / 100 * (this.pending.maxLev || 20);
        }
        
        let totalEquity = this.capital + pnlWin;
        let available = (totalEquity + livePnl) - openMargin;
        return {
            total: totalEquity + livePnl,
            available: Math.max(0, available),
            pnlWin: pnlWin,
            livePnl: livePnl,
            winCount: this.history.length
        };
    }

    update(s, p, c1, c5, c15) {
        const now = Date.now();
        const stats = this.getAvailableBalance();

        if (this.pending) {
            const h = this.pending;
            const diffAvg = ((p - h.avgPrice) / h.avgPrice) * 100;
            const win = h.type === 'LONG' ? diffAvg >= this.tpTarget : diffAvg <= -this.tpTarget;

            if (win) {
                h.status = 'WIN'; h.endTime = now; h.finalPrice = p;
                h.netPnl = h.totalMargin * (h.type === 'LONG' ? diffAvg : -diffAvg) / 100 * (h.maxLev || 20);
                this.history.push(h); this.pending = null; this.lastTradeTime = now;
                return;
            }

            // LOGIC DCA ĐẶC BIỆT: Sau lần 9 cứ 1% DCA 1 lần
            const totalDiffFromEntry = ((p - h.snapPrice) / h.snapPrice) * 100;
            let nextThreshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.slTarget : (90 + (h.dcaCount - 8));
            
            const triggerDCA = h.type === 'LONG' ? totalDiffFromEntry <= -nextThreshold : totalDiffFromEntry >= nextThreshold;
            if (triggerDCA && !actionQueue.find(q => q.id === `${this.id}_${s}`)) {
                actionQueue.push({ id: `${this.id}_${s}`, priority: 1, action: () => {
                    const newMargin = stats.available * 0.01; // 1% khả dụng thực tế
                    h.totalMargin += newMargin;
                    h.dcaCount++;
                    h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                    h.dcaHistory.push({ t: Date.now(), p: p, avg: h.avgPrice });
                }});
            }
        } else {
            // Mở lệnh dựa trên biến động 1 -> 10
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= this.minVol && (now - this.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
                if (!actionQueue.find(q => q.id === `${this.id}_${s}`)) {
                    actionQueue.push({ id: `${this.id}_${s}`, priority: 2, action: () => {
                        let type = this.mode;
                        if (this.mode === 'FOLLOW') type = c1 > 0 ? 'LONG' : 'SHORT';
                        if (this.mode === 'REVERSE') type = c1 > 0 ? 'SHORT' : 'LONG';

                        this.pending = {
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type,
                            dcaCount: 0, totalMargin: stats.available * 0.01,
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: this.tpTarget,
                            dcaHistory: [{ t: Date.now(), p: p, avg: p }],
                            snapVol: { c1, c5, c15 }, maxNegativeRoi: 0
                        };
                    }});
                }
            }
        }
    }
}

// Khởi tạo 4 nhóm: LONG, SHORT, FOLLOW, REVERSE. Mỗi nhóm 10 bot (Vol 1-10)
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

app.get('/api/data', (req, res) => {
    res.json({
        bots: bots.map(b => ({
            ...b,
            stats: b.getAvailableBalance(),
            market: b.pending ? coinData[b.pending.symbol]?.live : null,
            allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live?.currentPrice]))
        })),
        topMarket: Object.entries(coinData).filter(([_,v])=>v.live).map(([s,v])=>({symbol:s, ...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Multi-Core 40 Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .grid-container { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 10px; }
        .bot-card { background: #1e2329; border: 1px solid #30363d; padding: 10px; border-radius: 4px; cursor: pointer; transition: 0.2s; }
        .bot-card:hover { border-color: #fcd535; }
        .is-trading { border-left: 4px solid #fcd535; background: #2b3139; }
        #fullModal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#0b0e11; z-index:9999; overflow-y:auto; }
    </style></head><body>

    <div id="mainUI">
        <div class="p-4 bg-[#1e2329] border-b border-zinc-800 flex justify-between items-center sticky top-0 z-50">
            <h1 class="font-black italic text-yellow-500 text-xl">LUFFY 40-CORE PRO</h1>
            <div class="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">4 Cột x 10 Cấu Hình | UTC+7</div>
        </div>
        
        <div class="grid grid-cols-4 gap-2 p-2 text-center text-[10px] font-bold text-zinc-600 uppercase italic">
            <div>Follow</div><div>Reverse</div><div>Long</div><div>Short</div>
        </div>

        <div id="gridBots" class="grid-container"></div>
    </div>

    <div id="fullModal">
        <div class="p-3 bg-yellow-500 text-black font-black text-center cursor-pointer sticky top-0 z-[10000]" onclick="closeModal()">ĐÓNG VÀ QUAY LẠI DASHBOARD TỔNG</div>
        <div id="modalBody" class="p-4"></div>
    </div>

    <script>
        let botsData = []; let activeId = null;
        function fPrice(p) { return p ? parseFloat(p).toFixed(4) : "0.0000"; }

        async function update() {
            const r = await fetch('/api/data'); const d = await r.json(); botsData = d.bots;
            let html = "";
            for(let row=0; row<10; row++) {
                [0, 10, 20, 30].forEach(col => {
                    const b = botsData[col + row];
                    html += \`
                    <div class="bot-card \${b.pending ? 'is-trading shadow-lg shadow-yellow-500/10' : ''}" onclick="openModal(\${b.id})">
                        <div class="flex justify-between text-[9px] font-bold mb-2"><span class="text-zinc-500">#\${b.id+1}</span><span class="text-yellow-500">VOL \${b.minVol}%</span></div>
                        <div class="text-lg font-black text-white">\${b.stats.available.toFixed(1)} <span class="text-[10px] text-zinc-500">$</span></div>
                        <div class="flex justify-between text-[10px] mt-2 font-bold">
                            <span class="up">W:\${b.stats.winCount}</span>
                            <span class="\${b.stats.livePnl >= 0 ? 'up' : 'down'}">\${b.stats.livePnl.toFixed(2)}</span>
                        </div>
                    </div>\`;
                });
            }
            document.getElementById('gridBots').innerHTML = html;
            if(activeId !== null) renderDetail(activeId, d.topMarket, d.allPrices);
        }

        function openModal(id) { activeId = id; document.getElementById('fullModal').style.display = 'block'; document.getElementById('mainUI').style.display = 'none'; }
        function closeModal() { activeId = null; document.getElementById('fullModal').style.display = 'none'; document.getElementById('mainUI').style.display = 'block'; }

        function renderDetail(id, topMarket, allPrices) {
            const b = botsData[id]; const s = b.stats;
            const content = \`
                <div class="flex justify-between items-end mb-6">
                    <div><div class="text-zinc-500 text-[11px] uppercase font-bold tracking-widest mb-1">Equity Bot #\${id+1} (\${b.mode})</div><span class="text-4xl font-bold text-white tracking-tighter">\${s.total.toFixed(2)}</span><span class="text-sm text-zinc-500 ml-1">USDT</span></div>
                    <div class="text-right"><div class="text-zinc-500 text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div><div class="text-xl font-bold \${s.livePnl>=0?'up':'down'}">\${s.livePnl.toFixed(2)}</div></div>
                </div>

                <div class="grid grid-cols-3 gap-2 mb-6 text-center">
                    <div class="bg-[#1e2329] p-3 rounded border border-zinc-800"><div class="text-[9px] text-zinc-500 uppercase font-bold">Khả dụng</div><div class="text-lg font-bold text-green-400">\${s.available.toFixed(2)}</div></div>
                    <div class="bg-[#1e2329] p-3 rounded border border-zinc-800"><div class="text-[9px] text-zinc-500 uppercase font-bold">PnL Win ($)</div><div class="text-lg font-bold text-white">\${s.pnlWin.toFixed(2)}</div></div>
                    <div class="bg-[#1e2329] p-3 rounded border border-zinc-800"><div class="text-[9px] text-zinc-500 uppercase font-bold">Lệnh Win</div><div class="text-lg font-bold text-yellow-500">\${s.winCount}</div></div>
                </div>

                <div class="bg-[#1e2329] rounded-xl p-4 border border-zinc-800 mb-6 shadow-lg">
                    <div class="text-[11px] font-bold text-yellow-500 mb-3 uppercase italic tracking-widest">Biến động Market (Top 10)</div>
                    <table class="w-full text-[10px] text-left"><thead class="text-zinc-600 border-b border-zinc-800"><tr><th>Coin</th><th>Giá</th><th>1M</th><th>5M</th><th>15M</th></tr></thead>
                    <tbody>\${topMarket.map(m=>\`<tr class="border-b border-zinc-800/30 text-[11px]"><td class="font-bold py-2 text-white">\${m.symbol}</td><td class="text-yellow-500">\${fPrice(m.currentPrice)}</td><td class="\${m.c1>=0?'up':'down'} font-bold">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'} font-bold">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'} font-bold">\${m.c15}%</td></tr>\`).join('')}</tbody></table>
                </div>

                <div class="bg-[#1e2329] rounded-xl p-4 mb-6 shadow-lg">
                    <div class="text-[11px] font-bold text-white mb-3 uppercase flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế hiện tại</div>
                    <table class="w-full text-[10px] text-left"><thead class="text-zinc-600 uppercase border-b border-zinc-800"><tr><th>Pair</th><th>Side</th><th>DCA</th><th>Entry</th><th>Avg Price</th><th class="text-right">PnL Live</th></tr></thead>
                    <tbody>\${b.pending ? \`<tr><td class="py-3 font-bold text-white text-sm">\${b.pending.symbol}</td><td><span class="px-2 py-0.5 \${b.pending.type==='LONG'?'bg-green-600':'bg-red-600'} rounded font-black text-[9px]">\${b.pending.type}</span></td><td class="text-yellow-500 font-bold text-lg">\${b.pending.dcaCount}</td><td class="text-zinc-400 font-bold">\${fPrice(b.pending.snapPrice)}</td><td class="text-yellow-500 font-bold">\${fPrice(b.pending.avgPrice)}</td><td class="text-right font-black \${s.livePnl>=0?'up':'down'} text-sm animate-pulse">\${s.livePnl.toFixed(2)}</td></tr>\` : '<tr><td colspan="6" class="text-center py-6 text-zinc-700 italic font-bold">ĐANG QUÉT TÍN HIỆU...</td></tr>'}</tbody></table>
                </div>

                <div class="bg-[#1e2329] rounded-xl p-4 shadow-lg border border-zinc-800">
                    <div class="text-[11px] font-bold text-zinc-500 mb-3 uppercase italic tracking-wider">Nhật ký chiến đấu</div>
                    <table class="w-full text-[9px] text-left"><thead class="text-zinc-600 border-b border-zinc-800"><tr><th>Thời gian</th><th>Cặp/Side</th><th>DCA</th><th>Vào/Ra</th><th>PnL Net</th></tr></thead>
                    <tbody>\${b.history.slice(-10).reverse().map(h=>\`<tr class="border-b border-zinc-800/30"><td class="py-2 text-zinc-500">\${new Date(h.endTime).toLocaleTimeString()}</td><td><b class="text-white text-[11px]">\${h.symbol}</b> <br> <span class="\${h.type==='LONG'?'up':'down'} font-black text-[8px]">\${h.type}</span></td><td class="text-yellow-500 font-bold text-center text-sm">\${h.dcaCount}</td><td class="text-zinc-400 font-bold">\${fPrice(h.snapPrice)}<br>\${fPrice(h.finalPrice)}</td><td class="up font-black text-[11px]">+\${h.netPnl.toFixed(2)}</td></tr>\`).join('')}</tbody></table>
                </div>
            \`;
            document.getElementById('modalBody').innerHTML = content;
        }

        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
