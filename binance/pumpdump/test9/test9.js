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

// --- KHỞI TẠO 40 BOT: CHIA THEO 4 CỘT CHẾ ĐỘ ---
const MODES = ['LONG', 'SHORT', 'REVERSE', 'FOLLOW'];
let bots = [];

class LuffyBot {
    constructor(id, mode, minVol) {
        this.id = id;
        this.mode = mode;
        this.minVol = minVol;
        this.tpTarget = 0.3; // TP 0.3%
        this.dcaStep = 10.0; // DCA 10%
        this.capital = 100.0; 
        this.history = [];
        this.pending = null; 
        this.lastTradeTime = 0;
    }

    getAvailableBalance() {
        let pnlWin = this.history.reduce((s, h) => s + h.netPnl, 0);
        let openMargin = this.pending ? ( (this.capital + pnlWin) * 0.01 * (this.pending.dcaCount + 1) ) : 0;
        let livePnl = 0;
        if (this.pending) {
            let lp = coinData[this.pending.symbol]?.live?.currentPrice || this.pending.avgPrice;
            let roi = (this.pending.type === 'LONG' ? (lp - this.pending.avgPrice) / this.pending.avgPrice : (this.pending.avgPrice - lp) / this.pending.avgPrice) * 100 * (this.pending.maxLev || 20);
            livePnl = openMargin * roi / 100;
        }
        return (this.capital + pnlWin + livePnl) - openMargin;
    }

    checkTrade(s, p, c1, c5, c15) {
        const now = Date.now();
        if (this.pending) {
            const h = this.pending;
            const diffAvg = ((p - h.avgPrice) / h.avgPrice) * 100;
            const win = h.type === 'LONG' ? diffAvg >= this.tpTarget : diffAvg <= -this.tpTarget;
            if (win) {
                h.status = 'WIN'; h.endTime = now; h.finalPrice = p;
                let margin = ( (this.capital + this.history.reduce((s, h) => s + h.netPnl, 0)) * 0.01 ) * (h.dcaCount + 1);
                h.netPnl = margin * (h.type === 'LONG' ? diffAvg : -diffAvg) / 100 * (h.maxLev || 20);
                this.history.push(h); this.pending = null; this.lastTradeTime = now;
                return;
            }
            // Logic DCA: Sau lần 9 cứ mỗi 1% DCA thêm 1 lần
            const totalDiff = ((p - h.snapPrice) / h.snapPrice) * 100;
            let nextThreshold = h.dcaCount < 9 ? (h.dcaCount + 1) * this.dcaStep : (9 * this.dcaStep) + (h.dcaCount - 8);
            if (h.type === 'LONG' ? totalDiff <= -nextThreshold : totalDiff >= nextThreshold) {
                h.dcaCount++; h.avgPrice = ((h.avgPrice * h.dcaCount) + p) / (h.dcaCount + 1);
                h.dcaHistory.push({ t: now, p: p, avg: h.avgPrice });
            }
        } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= this.minVol && (now - this.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
            let type = this.mode;
            if (this.mode === 'FOLLOW') type = c1 > 0 ? 'LONG' : 'SHORT';
            if (this.mode === 'REVERSE') type = c1 > 0 ? 'SHORT' : 'LONG';
            this.pending = { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, dcaCount: 0, maxLev: symbolMaxLeverage[s] || 20, dcaHistory: [{ t: now, p: p, avg: p }], tpTarget: this.tpTarget, snapPrice: p };
        }
    }
}

MODES.forEach(m => { for (let v = 1; v <= 10; v++) { bots.push(new LuffyBot(bots.length, m, v)); } });

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
            if (coinData[s].prices.length > 200) coinData[s].prices.shift();
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            bots.forEach(bot => bot.checkTrade(s, p, c1, c5, c15));
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/data', (req, res) => {
    res.json({
        bots: bots.map(b => ({
            id: b.id, mode: b.mode, vol: b.minVol,
            balance: (b.capital + b.history.reduce((s, h) => s + h.netPnl, 0)).toFixed(2),
            available: b.getAvailableBalance().toFixed(2),
            winCount: b.history.length,
            pnlWin: b.history.reduce((s, h) => s + h.netPnl, 0).toFixed(2),
            isTrading: !!b.pending, pair: b.pending?.symbol || null,
            pending: b.pending, history: b.history.slice(-15)
        }))
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Multi-40 Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; overflow-x: hidden; }
        .grid-container { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 15px; }
        .bot-card { background: #1e2329; border: 1px solid #30363d; padding: 12px; border-radius: 4px; cursor: pointer; transition: 0.1s; }
        .bot-card:hover { border-color: #fcd535; transform: translateY(-2px); }
        .active { border-left: 4px solid #fcd535; background: #2b3139; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        #detailView { display:none; position:fixed; top:0; left:0; width:100%; height:100vh; background:#0b0e11; z-index:1000; overflow-y:auto; }
        .col-header { text-align: center; font-weight: 900; color: #fcd535; padding: 10px; border-bottom: 2px solid #30363d; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 2px; font-style: italic; }
    </style></head><body>

    <div id="dashView">
        <div class="p-4 bg-[#1e2329] border-b border-[#fcd535] flex justify-between items-center sticky top-0 z-50 shadow-xl">
            <h1 class="text-2xl font-black italic text-[#fcd535] tracking-tighter">LUFFY MULTI-40</h1>
            <div class="text-[10px] text-zinc-500 font-bold uppercase tracking-widest text-right">© 2026 TunggBeoo | UTC+7 | 1% Margin</div>
        </div>
        
        <div class="grid grid-cols-4 px-[15px] pt-4">
            <div class="col-header border-green-500/50">LONG ONLY</div>
            <div class="col-header border-red-500/50">SHORT ONLY</div>
            <div class="col-header border-orange-500/50">REVERSE</div>
            <div class="col-header border-blue-500/50">FOLLOW</div>
        </div>

        <div id="grid40" class="grid-container"></div>
    </div>

    <div id="detailView">
        <div class="p-4 bg-[#fcd535] text-black font-black text-center cursor-pointer hover:bg-yellow-400 transition-all uppercase italic" onclick="closeDetail()">
             <<< QUAY LẠI DASHBOARD TỔNG QUAN >>>
        </div>
        <div id="detailContent" class="p-6"></div>
    </div>

    <script>
        let allBots = [];
        async function update() {
            try {
                const res = await fetch('/api/data');
                const d = await res.json(); allBots = d.bots;
                
                // Sắp xếp 40 bot vào 4 cột: Cột 1 (0-9), Cột 2 (10-19), Cột 3 (20-29), Cột 4 (30-39)
                // Grid grid-cols-4 sẽ tự động đổ theo hàng ngang, nên ta phải sắp xếp mảng hiển thị
                let gridHTML = "";
                for(let row=0; row<10; row++) {
                    for(let col=0; col<4; col++) {
                        const b = allBots[col * 10 + row];
                        gridHTML += \`
                            <div class="bot-card \${b.isTrading ? 'active' : ''}" onclick="openDetail(\${b.id})">
                                <div class="flex justify-between text-[10px] font-bold mb-1">
                                    <span class="text-zinc-500">ID#\${b.id+1}</span>
                                    <span class="text-yellow-500">Vol \${b.vol}%</span>
                                </div>
                                <div class="text-sm font-black text-white">\${b.available} <span class="text-[9px] text-zinc-500">USD</span></div>
                                <div class="flex justify-between mt-2 text-[10px]">
                                    <span class="text-zinc-500 font-bold">W: \${b.winCount}</span>
                                    <span class="up font-black">+\${b.pnlWin}</span>
                                </div>
                                \${b.isTrading ? \`<div class="mt-2 text-[10px] font-black text-[#fcd535] animate-pulse border-t border-zinc-800 pt-1 text-center italic uppercase">\${b.pair}</div>\` : ''}
                            </div>\`;
                    }
                }
                document.getElementById('grid40').innerHTML = gridHTML;
            } catch(e) {}
        }

        function openDetail(id) {
            const b = allBots[id];
            document.getElementById('dashView').style.display = 'none';
            document.getElementById('detailView').style.display = 'block';
            
            document.getElementById('detailContent').innerHTML = \`
                <div class="bg-card p-6 rounded-xl border-l-8 border-[#fcd535] mb-6 shadow-2xl">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="text-4xl font-black italic text-white uppercase tracking-tighter">BOT #\${b.id+1} <span class="text-[#fcd535]">| \${b.mode} \${b.vol}%</span></h2>
                        <div class="text-right"><p class="text-xs text-zinc-500 font-bold uppercase">Trạng thái</p><p class="font-black \${b.isTrading ? 'up animate-pulse' : 'text-zinc-600'}">\${b.isTrading ? 'ĐANG CHIẾN ĐẤU' : 'ĐANG QUÉT SÓNG'}</p></div>
                    </div>
                    <div class="grid grid-cols-4 gap-4">
                        <div class="bg-[#0b0e11] p-4 rounded border border-zinc-800">
                            <p class="text-[10px] text-zinc-500 font-bold uppercase">Khả dụng (Equity)</p>
                            <p class="text-2xl font-black text-white">\${b.available} <span class="text-xs font-normal">USDT</span></p>
                        </div>
                        <div class="bg-[#0b0e11] p-4 rounded border border-zinc-800 text-center">
                            <p class="text-[10px] text-zinc-500 font-bold uppercase">PnL Lãi ròng</p>
                            <p class="text-2xl font-black up">+\${b.pnlWin}</p>
                        </div>
                        <div class="bg-[#0b0e11] p-4 rounded border border-zinc-800 text-center">
                            <p class="text-[10px] text-zinc-500 font-bold uppercase">Lệnh Win</p>
                            <p class="text-2xl font-black text-white">\${b.winCount}</p>
                        </div>
                        <div class="bg-[#0b0e11] p-4 rounded border border-zinc-800 text-center">
                            <p class="text-[10px] text-zinc-500 font-bold uppercase">DCA Level</p>
                            <p class="text-2xl font-black text-yellow-500">\${b.pending ? b.pending.dcaCount : 0}</p>
                        </div>
                    </div>
                </div>

                <div class="bg-card rounded-xl p-4 shadow-lg mb-6 border border-zinc-800">
                    <div class="text-[11px] font-bold text-white mb-4 uppercase tracking-widest flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang gồng</div>
                    <div class="overflow-x-auto"><table class="w-full text-[11px] text-left">
                        <thead class="text-zinc-500 uppercase border-b border-zinc-800"><tr><th>Pair</th><th>Side</th><th>DCA</th><th>Entry</th><th>Avg Price</th><th class="text-right">Live ROI</th></tr></thead>
                        <tbody>\${b.pending ? \`
                            <tr class="bg-white/5"><td class="py-4 font-black text-white text-lg">\${b.pending.symbol}</td>
                            <td><span class="px-2 py-1 \${b.pending.type==='LONG'?'bg-green-600':'bg-red-600'} rounded text-[10px] font-black">\${b.pending.type}</span></td>
                            <td class="text-yellow-500 font-black text-lg">\${b.pending.dcaCount}</td>
                            <td class="text-zinc-400 font-bold">\${b.pending.snapPrice}</td>
                            <td class="text-yellow-500 font-bold">\${b.pending.avgPrice}</td>
                            <td class="text-right font-black up text-lg animate-pulse">ROI LIVE %</td></tr>\` : '<tr><td colspan="6" class="text-center py-10 text-zinc-700 italic font-bold">CHƯA CÓ LỆNH</td></tr>'}
                        </tbody>
                    </table></div>
                </div>

                <div class="bg-card rounded-xl p-4 border border-zinc-800 shadow-2xl">
                    <div class="text-[11px] font-bold text-zinc-500 mb-4 uppercase tracking-widest italic">Lịch sử 15 trận đánh gần nhất</div>
                    <div class="overflow-x-auto"><table class="w-full text-[10px] text-left">
                        <thead class="text-zinc-600 border-b border-zinc-800 uppercase"><tr><th>Thời gian</th><th>Pair</th><th>DCA</th><th>Vào/Ra</th><th>PnL Net</th><th class="text-right text-white">Số dư cuối</th></tr></thead>
                        <tbody>\${b.history.reverse().map(h => \`
                            <tr class="border-b border-zinc-800/30 hover:bg-white/5 transition-colors">
                                <td class="py-3 text-zinc-500 text-[8px]">\${new Date(h.endTime).toLocaleString()}</td>
                                <td><b class="text-white text-sm">\${h.symbol}</b> <span class="\${h.type==='LONG'?'up':'down'} font-black">[\${h.type}]</span></td>
                                <td class="text-yellow-500 font-black">\${h.dcaCount}</td>
                                <td class="text-zinc-400">\${h.snapPrice} <span class="mx-1">→</span> <b class="text-white">\${h.finalPrice}</b></td>
                                <td class="up font-black text-sm">+\${h.netPnl.toFixed(2)}</td>
                                <td class="text-right text-white font-bold text-sm">\${(100 + b.history.filter((_,i)=>i<=b.history.indexOf(h)).reduce((s,x)=>s+x.netPnl,0)).toFixed(2)}</td>
                            </tr>\`).join('')}
                        </tbody>
                    </table></div>
                </div>
            \`;
        }

        function closeDetail() { document.getElementById('dashView').style.display = 'block'; document.getElementById('detailView').style.display = 'none'; }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Hệ thống Multi-40 Luffy sẵn sàng: http://localhost:${PORT}/gui`); });
