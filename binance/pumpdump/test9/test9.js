const PORT = 9063;
const STATS_FILE = './72h_stats.json';
const COOLDOWN_MINUTES = 15;

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {};
let statsHistory = [];

// 1. KHỞI TẠO 40 BOT - XẾP THEO 4 CỘT (FOLLOW, REVERSE, LONG, SHORT)
const MODES = ['FOLLOW', 'REVERSE', 'LONG', 'SHORT'];
let bots = [];
for (let m = 0; m < 4; m++) {
    for (let v = 1; v <= 10; v++) {
        bots.push({
            id: bots.length,
            config: { vol: v, tp: 0.3, dca: 10, marginPercent: 1, balance: 100, mode: MODES[m] },
            pendingTrade: null,
            history: [],
            totalWin: 0,
            pnlWin: 0,
            lastTradeTime: 0
        });
    }
}

// 2. LOGIC THỐNG KÊ 72 LẦN (1H/LẦN)
function saveStats() {
    const snapshot = {
        time: new Date().toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'}),
        data: bots.map(b => ({ id: b.id, pnl: b.pnlWin }))
    };
    statsHistory.push(snapshot);
    if (statsHistory.length > 72) statsHistory.shift();
    fs.writeFileSync(STATS_FILE, JSON.stringify(statsHistory));
}
setInterval(saveStats, 3600000);

// 3. API DATA
app.get('/api/data', (req, res) => {
    let gPnlTotal = 0, gAvailTotal = 0, gWin = 0;
    const botData = bots.map(b => {
        let unPnl = 0, pnlTong = b.config.balance + b.pnlWin, openMargin = 0;
        if (b.pendingTrade) {
            const lp = coinData[b.pendingTrade.symbol]?.live?.currentPrice || b.pendingTrade.avgPrice;
            const roi = (b.pendingTrade.type === 'LONG' ? (lp - b.pendingTrade.avgPrice)/b.pendingTrade.avgPrice : (b.pendingTrade.avgPrice - lp)/b.pendingTrade.avgPrice) * 100 * 20;
            openMargin = (pnlTong * (b.config.marginPercent / 100)) * (b.pendingTrade.dcaCount + 1);
            unPnl = openMargin * roi / 100;
        }
        let avail = pnlTong - openMargin + unPnl;
        gPnlTotal += pnlTong; gAvailTotal += avail; gWin += b.totalWin;
        return { ...b, unPnl, pnlTong, avail, market: Object.entries(coinData).slice(0,10).map(([s,v])=>({s, ...v.live})) };
    });
    res.json({ bots: botData, global: { pnl: gPnlTotal, avail: gAvailTotal, win: gWin }, stats: statsHistory });
});

// 4. GIAO DIỆN PHỆT THẲNG CODE GỐC
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Pro Multi-40</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; margin:0; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .text-luffy { color: #fcd535; }
        .grid-container { display: grid; grid-template-columns: repeat(4, 1fr); grid-auto-flow: column; grid-template-rows: repeat(10, auto); gap: 10px; padding: 15px; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(11,14,17,0.98); overflow-y:auto; }
        /* Style bản gốc của ông */
        .luffy-header { background: linear-gradient(180deg, #1e2329 0%, #0b0e11 100%); border-bottom: 2px solid #fcd535; }
        .stat-box { background: #1e2329; border-radius: 12px; border: 1px solid #2b3139; transition: 0.3s; }
        .stat-box:hover { border-color: #fcd535; }
    </style></head><body>
        <div class="luffy-header p-4 flex justify-between items-center sticky top-0 z-50">
            <div class="flex items-center gap-6">
                <div class="text-2xl font-black italic text-luffy tracking-tighter">LUFFY MULTI-40</div>
                <div class="flex gap-4 border-l border-zinc-700 pl-4">
                    <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Tổng Vốn Hệ Thống</p><p id="gPnl" class="text-lg font-black text-white">0.00 $</p></div>
                    <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Vốn Khả Dụng Tổng</p><p id="gAvail" class="text-lg font-black text-luffy">0.00 $</p></div>
                    <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Tổng Win</p><p id="gWin" class="text-lg font-black up">0</p></div>
                </div>
            </div>
        </div>

        <div id="botGrid" class="grid-container"></div>

        <div id="detailModal" class="modal">
            <div class="p-6 relative max-w-[1400px] mx-auto">
                <button onclick="closeModal()" class="fixed top-4 right-10 text-5xl text-luffy z-[1001] hover:rotate-90 transition-transform">&times;</button>
                <div id="modalContent"></div>
            </div>
        </div>

    <script>
        let lastData = {};
        async function update() {
            const res = await fetch('/api/data'); const d = await res.json(); lastData = d;
            document.getElementById('gPnl').innerText = d.global.pnl.toFixed(2) + ' $';
            document.getElementById('gAvail').innerText = d.global.avail.toFixed(2) + ' $';
            document.getElementById('gWin').innerText = d.global.win;

            document.getElementById('botGrid').innerHTML = d.bots.map(b => \`
                <div onclick="showDetail(\${b.id})" class="stat-box p-3 cursor-pointer \${b.pendingTrade?'border-l-4 border-l-luffy shadow-[0_0_15px_rgba(252,213,53,0.1)]':''}">
                    <div class="flex justify-between items-center mb-2 border-b border-zinc-800 pb-1">
                        <span class="text-luffy font-black uppercase text-[10px]">#\${b.id+1} \${b.config.mode}</span>
                        <span class="bg-zinc-800 px-1.5 rounded text-white font-bold">\${b.config.vol}%</span>
                    </div>
                    <div class="space-y-1 text-[10px]">
                        <div class="flex justify-between"><span class="text-zinc-500">TỔNG:</span><span class="font-bold">\${b.pnlTong.toFixed(1)}</span></div>
                        <div class="flex justify-between"><span class="text-zinc-500">KHẢ DỤNG:</span><span class="text-luffy font-bold">\${b.avail.toFixed(1)}</span></div>
                        <div class="flex justify-between"><span class="text-zinc-500 font-bold">LIVE:</span><span class="font-black \${b.unPnl>=0?'up':'down'}">\${b.unPnl.toFixed(2)}</span></div>
                    </div>
                </div>\`).join('');
        }

        function showDetail(id) {
            const b = lastData.bots.find(x => x.id == id);
            // PHỆT THẲNG CODE GIAO DIỆN GỐC VÀO ĐÂY
            document.getElementById('modalContent').innerHTML = \`
                <div class="space-y-4">
                    <div class="bg-card p-8 rounded-[24px] border-l-[8px] border-luffy shadow-2xl flex justify-between items-center">
                        <div>
                            <h2 class="text-zinc-500 font-bold uppercase text-sm mb-2 tracking-widest">Cấu hình #\${b.id+1} | \${b.config.mode} \${b.config.vol}%</h2>
                            <div class="flex items-baseline gap-3">
                                <span class="text-7xl font-black text-white tracking-tighter">\${b.avail.toFixed(2)}</span>
                                <span class="text-2xl text-zinc-500 font-bold uppercase">USDT Khả dụng</span>
                            </div>
                        </div>
                        <div class="text-right">
                            <p class="text-zinc-500 font-bold uppercase text-sm mb-1">Pnl Tạm Tính (Live)</p>
                            <p class="text-5xl font-black \${b.unPnl>=0?'up':'down'}">\${b.unPnl.toFixed(2)}</p>
                        </div>
                    </div>

                    <div class="grid grid-cols-4 gap-4">
                        <div class="bg-card p-6 rounded-2xl border border-zinc-800"><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">Vốn Gốc + Lãi Chốt</p><p class="text-2xl font-black">\${b.pnlTong.toFixed(2)}</p></div>
                        <div class="bg-card p-6 rounded-2xl border border-zinc-800"><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">Số Lệnh Win</p><p class="text-2xl font-black up">\${b.totalWin}</p></div>
                        <div class="bg-card p-6 rounded-2xl border border-zinc-800"><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">Tổng Lãi Đã Chốt</p><p class="text-2xl font-black up">\${b.pnlWin.toFixed(2)}</p></div>
                        <div class="bg-card p-6 rounded-2xl border border-zinc-800"><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">Target TP / DCA</p><p class="text-2xl font-black text-luffy">\${b.config.tp}% / \${b.config.dca}%</p></div>
                    </div>

                    <div class="grid grid-cols-3 gap-4">
                        <div class="col-span-2 bg-card p-6 rounded-2xl">
                            <h3 class="text-luffy font-black mb-4 italic uppercase">■ Live Market Signals (3 Khung)</h3>
                            <table class="w-full text-[13px]">
                                <tr class="text-zinc-500 border-b border-zinc-800 uppercase text-[10px] font-bold"><th class="pb-3 text-left">Coin</th><th>1M %</th><th>5M %</th><th>15M %</th><th class="text-right">Price</th></tr>
                                \${b.market.map(m=>\`<tr class="border-b border-zinc-800/30"><td class="py-3 font-black text-white uppercase">\${m.s}</td><td class="\${m.c1>=0?'up':'down'} font-bold">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'} font-bold">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'} font-bold">\${m.c15}%</td><td class="text-right text-zinc-400 font-mono">\${m.currentPrice}</td></tr>\`).join('')}
                            </table>
                        </div>

                        <div class="bg-card p-6 rounded-2xl border border-blue-500/20">
                            <h3 class="text-blue-400 font-black mb-4 italic uppercase">■ Performance Log (72h)</h3>
                            <div class="flex items-end gap-[2px] h-40 bg-[#0b0e11] p-2 rounded-lg">
                                \${lastData.stats.map(s => {
                                    const botPnl = s.data.find(x => x.id == id)?.pnl || 0;
                                    const h = Math.max(5, Math.min(100, (botPnl/20)*100));
                                    return \`<div class="flex-1 bg-blue-500/30 hover:bg-luffy transition-all" style="height:\${h}%" title="\${s.time}"></div>\`;
                                }).join('')}
                            </div>
                            <p class="text-[9px] text-zinc-500 mt-2 text-center">Cột hiển thị biến động PnL mỗi giờ</p>
                        </div>
                    </div>

                    <div class="bg-card p-6 rounded-2xl shadow-inner border border-zinc-800">
                        <div class="text-white font-black mb-4 uppercase tracking-[0.3em] flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-3 animate-ping"></span> Vị thế đang chạy</div>
                        \${b.pendingTrade ? \`
                            <div class="grid grid-cols-5 gap-6 py-6 px-8 bg-[#0b0e11] rounded-2xl border border-zinc-800 shadow-2xl">
                                <div><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">Symbol</p><p class="text-2xl font-black text-white">\${b.pendingTrade.symbol}</p></div>
                                <div><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">Side/DCA</p><p class="text-2xl font-black \${b.pendingTrade.type==='LONG'?'up':'down'}">\${b.pendingTrade.type} <span class="text-luffy ml-2">\${b.pendingTrade.dcaCount}</span></p></div>
                                <div><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">Avg Price</p><p class="text-xl font-mono text-white font-bold">\${b.pendingTrade.avgPrice.toFixed(4)}</p></div>
                                <div><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">PnL Realtime</p><p class="text-3xl font-black \${b.unPnl>=0?'up':'down'}">\${b.unPnl.toFixed(2)}</p></div>
                                <div class="text-right"><p class="text-zinc-500 text-[10px] font-bold uppercase mb-1">Entry Time</p><p class="text-zinc-400 font-bold">\${new Date(b.pendingTrade.startTime).toLocaleTimeString()}</p></div>
                            </div>
                        \` : '<div class="text-center py-16 bg-[#0b0e11] rounded-2xl text-zinc-600 font-black italic border-2 border-dashed border-zinc-800">WAITING FOR NEXT SIGNAL...</div>'}
                    </div>
                </div>\`;
            document.getElementById('detailModal').style.display = 'block';
        }

        function closeModal() { document.getElementById('detailModal').style.display = 'none'; }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

// 5. WS & LOGIC (GIỮ NGUYÊN CHUẨN DCA 9+ VÀ GIÁ MARGIN)
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
            coinData[s].live = { c1: calculateChange(coinData[s].prices, 1), c5: calculateChange(coinData[s].prices, 5), c15: calculateChange(coinData[s].prices, 15), currentPrice: p };
            
            bots.forEach(bot => {
                const pending = bot.pendingTrade;
                if (pending && pending.symbol === s) {
                    const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                    const roi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * 20;
                    if (roi >= pending.tpTarget) {
                        const margin = ((bot.config.balance + bot.pnlWin) * (bot.config.marginPercent/100)) * (pending.dcaCount + 1);
                        bot.pnlWin += (margin * roi / 100); bot.totalWin++;
                        bot.history.push({...pending, endTime: now}); bot.pendingTrade = null; bot.lastTradeTime = now;
                    } else {
                        const totalDiff = Math.abs(((p - pending.snapPrice) / pending.snapPrice) * 100);
                        let trigger = pending.dcaCount < 9 ? (totalDiff >= (pending.dcaCount + 1) * pending.slTarget) : (totalDiff >= (9 * pending.slTarget) + (pending.dcaCount - 8));
                        if (trigger) { pending.dcaCount++; pending.avgPrice = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1); }
                    }
                } else if (!pending && (now - bot.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
                    if (Math.max(Math.abs(coinData[s].live.c1), Math.abs(coinData[s].live.c5)) >= bot.config.vol) {
                        let type = bot.config.mode === 'FOLLOW' ? (coinData[s].live.c1 > 0 ? 'LONG' : 'SHORT') : (bot.config.mode === 'REVERSE' ? (coinData[s].live.c1 > 0 ? 'SHORT' : 'LONG') : bot.config.mode);
                        bot.pendingTrade = { symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, dcaCount: 0, tpTarget: bot.config.tp, slTarget: bot.config.dca };
                    }
                }
            });
        });
    });
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0];
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Dashboard Multi-40: http://localhost:${PORT}/gui`); });
