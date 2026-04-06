const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 500000; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let symbolMaxLeverage = {}; 

// KHỞI TẠO 40 BOT - MỖI BOT LÀ MỘT THỂ THỐNG NHẤT NHƯ BẢN GỐC
let bots = [];
for (let i = 0; i < 40; i++) {
    bots.push({
        id: i,
        config: {
            vol: (i % 10) + 1, // Biến động từ 1 tới 10
            tp: 0.3,
            dca: 10,
            marginPercent: 1,
            balance: 100,
            mode: ['FOLLOW', 'REVERSE', 'LONG', 'SHORT'][i % 4]
        },
        pendingTrade: null,
        history: [],
        totalWin: 0,
        pnlWin: 0,
        lastTradeTime: 0
    });
}

function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    let s = p.toFixed(20);
    let match = s.match(/^-?\d+\.0*[1-9]/);
    if (!match) return p.toFixed(4);
    return parseFloat(p).toFixed(match[0].length - match[0].indexOf('.') + 3);
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

// WS CẬP NHẬT CHUNG CHO TẤT CẢ BOT
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
            
            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            // CHẠY LOGIC CHO 40 BOT
            bots.forEach(bot => {
                const pending = bot.pendingTrade;
                if (pending && pending.symbol === s) {
                    const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                    const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                    if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;

                    const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget;
                    if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                        const marginBase = (bot.config.balance + bot.pnlWin) * (bot.config.marginPercent / 100);
                        const totalMargin = marginBase * (pending.dcaCount + 1);
                        const finalPnl = (totalMargin * currentRoi) / 100;
                        
                        pending.status = win ? 'WIN' : 'TIMEOUT';
                        pending.finalPrice = p; pending.endTime = now; pending.pnlReal = finalPnl;
                        if (finalPnl > 0) { bot.totalWin++; bot.pnlWin += finalPnl; }
                        bot.history.push({...pending});
                        bot.pendingTrade = null; bot.lastTradeTime = now;
                        return;
                    }

                    // LOGIC DCA LẦN 9+ (CỨ 1% NHỒI 1 LẦN)
                    const totalDiff = Math.abs(((p - pending.snapPrice) / pending.snapPrice) * 100);
                    let triggerDCA = false;
                    if (pending.dcaCount < 9) {
                        if (totalDiff >= (pending.dcaCount + 1) * pending.slTarget) triggerDCA = true;
                    } else {
                        const extra = pending.dcaCount - 8;
                        if (totalDiff >= (9 * pending.slTarget) + extra) triggerDCA = true;
                    }

                    if (triggerDCA) {
                        pending.dcaCount++;
                        pending.avgPrice = ((pending.avgPrice * pending.dcaCount) + p) / (pending.dcaCount + 1);
                        pending.dcaHistory.push({ t: now, p: p, avg: pending.avgPrice });
                    }
                } else if (!pending && (now - bot.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
                    if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= bot.config.vol) {
                        let type = bot.config.mode;
                        if (type === 'FOLLOW') type = c1 > 0 ? 'LONG' : 'SHORT';
                        else if (type === 'REVERSE') type = c1 > 0 ? 'SHORT' : 'LONG';
                        
                        bot.pendingTrade = {
                            symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING',
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: bot.config.tp, slTarget: bot.config.dca,
                            snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: now, p: p, avg: p }]
                        };
                    }
                }
            });
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/data', (req, res) => {
    const data = bots.map(b => {
        let unPnl = 0;
        let availBal = b.config.balance + b.pnlWin;
        if (b.pendingTrade) {
            const lp = coinData[b.pendingTrade.symbol]?.live?.currentPrice || b.pendingTrade.avgPrice;
            const roi = (b.pendingTrade.type === 'LONG' ? (lp - b.pendingTrade.avgPrice)/b.pendingTrade.avgPrice : (b.pendingTrade.avgPrice - lp)/b.pendingTrade.avgPrice) * 100 * (b.pendingTrade.maxLev || 20);
            const marginBase = availBal * (b.config.marginPercent / 100);
            const totalMargin = marginBase * (b.pendingTrade.dcaCount + 1);
            unPnl = totalMargin * roi / 100;
            availBal = availBal - totalMargin + unPnl;
        }
        return { ...b, unPnl, availBal, marketAll: Object.entries(coinData).slice(0,10).map(([s,v])=>({s, ...v.live})) };
    });
    res.json(data);
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Binance Luffy 40-Core</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; font-size: 11px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:#0b0e11; overflow-y:auto; }
    </style></head><body>
        <div class="p-2 flex justify-between items-center bg-card mb-2 sticky top-0 z-40">
            <h1 class="text-yellow-500 font-bold italic">LUFFY MULTI-CORE 40</h1>
            <div id="globalStats" class="flex gap-4 font-bold text-[10px]"></div>
        </div>
        
        <div id="botGrid" class="grid grid-cols-4 gap-2 px-2"></div>

        <div id="detailModal" class="modal">
            <div class="p-4"><button onclick="closeModal()" class="fixed top-2 right-6 text-4xl text-yellow-500 z-50">×</button>
            <div id="modalContent"></div></div>
        </div>

    <script>
        let lastData = [];
        async function update() {
            const res = await fetch('/api/data'); const data = await res.json(); lastData = data;
            let totalWin = 0, totalPnl = 0;
            document.getElementById('botGrid').innerHTML = data.map(b => {
                totalWin += b.totalWin; totalPnl += b.pnlWin;
                const v = b.pendingTrade ? b.pendingTrade.snapVol : {c1:0,c5:0,c15:0};
                return \`
                <div onclick="showDetail(\${b.id})" class="bg-card p-2 rounded cursor-pointer border-\${b.pendingTrade?'yellow-500/50':'zinc-800'}">
                    <div class="flex justify-between border-b border-zinc-800 pb-1 mb-1 font-bold">
                        <span class="text-yellow-500">BOT #\${b.id+1}</span>
                        <span class="text-zinc-500 uppercase">\${b.config.mode}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-y-1">
                        <span class="text-zinc-500">Cặp/Vị thế:</span><span class="text-right \${b.pendingTrade?'text-white font-bold':''}">\${b.pendingTrade?b.pendingTrade.symbol+' '+b.pendingTrade.type:'IDLE'}</span>
                        <span class="text-zinc-500">Biến động:</span><span class="text-right text-yellow-500">\${v.c1}/\${v.c5}/\${v.c15}</span>
                        <span class="text-zinc-500">Win/PnL:</span><span class="text-right up font-bold">\${b.totalWin} (\${b.pnlWin.toFixed(1)})</span>
                        <span class="text-zinc-500">Khả dụng:</span><span class="text-right text-white font-bold">\${b.availBal.toFixed(2)}</span>
                        <span class="text-zinc-500">PnL Live:</span><span class="text-right font-bold \${b.unPnl>=0?'up':'down'}">\${b.unPnl.toFixed(2)}</span>
                    </div>
                </div>\`;
            }).join('');
            document.getElementById('globalStats').innerHTML = \`WIN: <span class="up">\${totalWin}</span> | PNL: <span class="up">\${totalPnl.toFixed(2)}</span>\`;
        }

        function showDetail(id) {
            const b = lastData.find(x => x.id == id);
            document.getElementById('modalContent').innerHTML = \`
                <div class="max-w-6xl mx-auto">
                    <div class="flex justify-between items-end mb-6">
                        <div><div class="text-zinc-500 text-[11px] uppercase font-bold mb-1">Bot #\${b.id+1} - Equity (Vốn + PnL Live)</div>
                        <span class="text-5xl font-bold text-white">\${(b.availBal + (b.pendingTrade?0:0)).toFixed(2)}</span><span class="text-zinc-500 ml-2">USDT</span></div>
                        <div class="text-right"><div class="text-zinc-500 text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div>
                        <div class="text-3xl font-bold \${b.unPnl>=0?'up':'down'}">\${b.unPnl.toFixed(2)}</div></div>
                    </div>

                    <div class="grid grid-cols-4 gap-3 mb-6">
                        <div class="bg-card p-3 rounded text-center"><div class="text-zinc-500 uppercase text-[9px]">Lệnh Win</div><div class="text-xl font-bold up">\${b.totalWin}</div></div>
                        <div class="bg-card p-3 rounded text-center"><div class="text-zinc-500 uppercase text-[9px]">PnL Win ($)</div><div class="text-xl font-bold text-white">\${b.pnlWin.toFixed(2)}</div></div>
                        <div class="bg-card p-3 rounded text-center"><div class="text-zinc-500 uppercase text-[9px]">DCA Config</div><div class="text-xl font-bold text-yellow-500">\${b.config.dca}%</div></div>
                        <div class="bg-card p-3 rounded text-center"><div class="text-zinc-500 uppercase text-[9px]">Vol Signal</div><div class="text-xl font-bold text-yellow-500">\${b.config.vol}%</div></div>
                    </div>

                    <div class="bg-card p-4 rounded-xl mb-6 shadow-lg">
                        <div class="text-yellow-500 font-bold mb-4 uppercase italic">Biến động Market (3 khung thời gian)</div>
                        <table class="w-full text-left text-[12px]">
                            <thead class="text-zinc-500 border-b border-zinc-800"><tr><th>Coin</th><th>1M (%)</th><th>5M (%)</th><th>15M (%)</th></tr></thead>
                            <tbody>\${b.marketAll.map(m=>\`<tr class="border-b border-zinc-800/30"><td class="py-2 text-white font-bold">\${m.s}</td><td class="\${m.c1>=0?'up':'down'} font-bold">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'} font-bold">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'} font-bold">\${m.c15}%</td></tr>\`).join('')}</tbody>
                        </table>
                    </div>

                    <div class="bg-card p-4 rounded-xl mb-6 shadow-lg">
                        <div class="text-white font-bold mb-4 uppercase tracking-widest flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
                        <table class="w-full text-left text-[12px]">
                            <thead class="text-zinc-500 border-b border-zinc-800"><tr><th>Time</th><th>Pair</th><th>DCA</th><th>Entry</th><th>Avg Price</th><th>PnL (Live)</th></tr></thead>
                            <tbody>\${b.pendingTrade ? \`
                                <tr>
                                    <td class="py-3 text-zinc-400">\${new Date(b.pendingTrade.startTime).toLocaleTimeString()}</td>
                                    <td class="font-bold text-white">\${b.pendingTrade.symbol} <span class="bg-zinc-700 px-1 text-[10px]">\${b.pendingTrade.type}</span></td>
                                    <td class="text-yellow-500 font-bold">\${b.pendingTrade.dcaCount}</td>
                                    <td>\${b.pendingTrade.snapPrice.toFixed(4)}</td>
                                    <td class="text-yellow-500 font-bold">\${b.pendingTrade.avgPrice.toFixed(4)}</td>
                                    <td class="\${b.unPnl>=0?'up':'down'} font-bold">\${b.unPnl.toFixed(2)}</td>
                                </tr>
                            \` : '<tr><td colspan="6" class="text-center py-6 text-zinc-600 italic">Hệ thống đang quét tín hiệu Market...</td></tr>'}</tbody>
                        </table>
                    </div>

                    <div class="bg-card p-4 rounded-xl shadow-lg border border-yellow-500/10">
                        <div class="text-zinc-500 font-bold mb-4 uppercase italic">Nhật ký giao dịch chi tiết</div>
                        <table class="w-full text-left text-[10px]">
                            <thead class="text-zinc-500 border-b border-zinc-800"><tr><th>Time Out</th><th>Pair</th><th>Type</th><th>DCA</th><th>PnL Net</th><th>Result</th></tr></thead>
                            <tbody>\${b.history.reverse().map(h=>\`<tr class="border-b border-zinc-800/30"><td class="py-2 text-zinc-500">\${new Date(h.endTime).toLocaleTimeString()}</td><td class="text-white font-bold">\${h.symbol}</td><td class="\${h.type==='LONG'?'up':'down'}">\${h.type}</td><td class="text-yellow-500 font-bold">\${h.dcaCount}</td><td class="\${h.pnlReal>=0?'up':'down'} font-bold">\${h.pnlReal.toFixed(2)}</td><td>\${h.status}</td></tr>\`).join('')}</tbody>
                        </table>
                    </div>
                </div>
            \`;
            document.getElementById('detailModal').style.display = 'block';
        }

        function closeModal() { document.getElementById('detailModal').style.display = 'none'; }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Engine 40-Core started: http://localhost:${PORT}/gui`); });
