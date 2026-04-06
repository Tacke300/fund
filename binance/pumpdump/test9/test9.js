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

// KHỞI TẠO 40 BOT VỚI THÔNG SỐ RIÊNG BIỆT
let bots = [];
for (let i = 0; i < 40; i++) {
    bots.push({
        id: i,
        config: {
            vol: (i % 10) + 1, // Biến động 1% -> 10%
            tp: 0.3,
            dca: 10,
            marginPercent: 1,
            balance: 100, // Vốn gốc 100$
            mode: ['FOLLOW', 'REVERSE', 'LONG', 'SHORT'][i % 4]
        },
        pendingTrade: null,
        history: [],
        totalWin: 0,
        pnlWin: 0, // Tổng lãi lỗ đã chốt
        lastTradeTime: 0
    });
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

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

            bots.forEach(bot => {
                const pending = bot.pendingTrade;
                if (pending && pending.symbol === s) {
                    const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                    const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                    
                    const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget;
                    if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                        const marginBase = (bot.config.balance + bot.pnlWin) * (bot.config.marginPercent / 100);
                        const totalMargin = marginBase * (pending.dcaCount + 1);
                        const finalPnl = (totalMargin * currentRoi) / 100;
                        
                        pending.status = win ? 'WIN' : 'TIMEOUT';
                        pending.finalPrice = p; pending.endTime = now; pending.pnlReal = finalPnl;
                        if (finalPnl > 0) { bot.totalWin++; bot.pnlWin += finalPnl; }
                        else { bot.pnlWin += finalPnl; } // Cộng cả pnl âm nếu cháy/cắt
                        
                        bot.history.push({...pending});
                        bot.pendingTrade = null; bot.lastTradeTime = now;
                        return;
                    }

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
        let pnlTong = b.config.balance + b.pnlWin;
        let openMargin = 0;
        if (b.pendingTrade) {
            const lp = coinData[b.pendingTrade.symbol]?.live?.currentPrice || b.pendingTrade.avgPrice;
            const roi = (b.pendingTrade.type === 'LONG' ? (lp - b.pendingTrade.avgPrice)/b.pendingTrade.avgPrice : (b.pendingTrade.avgPrice - lp)/b.pendingTrade.avgPrice) * 100 * (b.pendingTrade.maxLev || 20);
            const marginBase = pnlTong * (b.config.marginPercent / 100);
            openMargin = marginBase * (b.pendingTrade.dcaCount + 1);
            unPnl = openMargin * roi / 100;
        }
        let availBal = pnlTong - openMargin + unPnl;
        return { ...b, unPnl, pnlTong, availBal, marketAll: Object.entries(coinData).slice(0,10).map(([s,v])=>({s, ...v.live})) };
    });
    res.json(data);
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Multi-40</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; font-size: 11px; margin:0; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:#0b0e11; overflow-y:auto; }
        .bot-status-active { border-left: 4px solid #fcd535 !important; }
    </style></head><body>
        <div class="p-3 flex justify-between items-center bg-card mb-2 border-b border-zinc-800 sticky top-0 z-50">
            <h1 class="text-[#fcd535] font-black italic text-lg tracking-tighter">BINANCE LUFFY MULTI-40</h1>
            <div id="globalStats" class="flex gap-6 font-bold text-[10px] uppercase"></div>
        </div>
        
        <div id="botGrid" class="grid grid-cols-4 gap-2 px-2 pb-10"></div>

        <div id="detailModal" class="modal">
            <div class="p-4"><button onclick="closeModal()" class="fixed top-2 right-6 text-4xl text-yellow-500 z-50 hover:scale-110">×</button>
            <div id="modalContent"></div></div>
        </div>

    <script>
        let lastData = [];
        async function update() {
            const res = await fetch('/api/data'); const data = await res.json(); lastData = data;
            let sumWin = 0, sumPnlWin = 0, sumOpen = 0;
            document.getElementById('botGrid').innerHTML = data.map(b => {
                sumWin += b.totalWin; sumPnlWin += b.pnlWin; if(b.pendingTrade) sumOpen++;
                return \`
                <div onclick="showDetail(\${b.id})" class="bg-card p-2 rounded cursor-pointer hover:border-yellow-500/50 transition-all \${b.pendingTrade?'bot-status-active':''}">
                    <div class="flex justify-between border-b border-zinc-800 pb-1 mb-2">
                        <span class="text-yellow-500 font-bold italic">BOT #\${b.id+1}</span>
                        <span class="text-zinc-500 font-bold">\${b.config.mode} | VOL \${b.config.vol}%</span>
                    </div>
                    <div class="grid grid-cols-2 gap-y-1 text-[10px]">
                        <span class="text-zinc-500 uppercase">PnL Tổng:</span><span class="text-right text-white font-bold">\${b.pnlTong.toFixed(2)}</span>
                        <span class="text-zinc-500 uppercase">Khả dụng:</span><span class="text-right text-yellow-500 font-bold">\${b.availBal.toFixed(2)}</span>
                        <span class="text-zinc-500 uppercase">Tổng Win:</span><span class="text-right up">\${b.totalWin}</span>
                        <span class="text-zinc-500 uppercase">PnL Win:</span><span class="text-right up">\${b.pnlWin.toFixed(2)}</span>
                        <span class="text-zinc-500 uppercase font-bold">PnL Tạm tính:</span><span class="text-right font-bold \${b.unPnl>=0?'up':'down'}">\${b.unPnl.toFixed(2)}</span>
                    </div>
                    <div class="mt-2 pt-1 border-t border-zinc-800/50 text-center text-[9px] text-zinc-500 uppercase">
                        \${b.pendingTrade ? '<span class="up animate-pulse font-bold">Đang mở: '+b.pendingTrade.symbol+'</span>' : 'Đang đợi tín hiệu...'}
                    </div>
                </div>\`;
            }).join('');
            document.getElementById('globalStats').innerHTML = \`
                <span>TỔNG WIN: <span class="up">\${sumWin}</span></span>
                <span>PNL WIN: <span class="up">\${sumPnlWin.toFixed(2)} $</span></span>
                <span>ĐANG MỞ: <span class="text-yellow-500">\${sumOpen} LỆNH</span></span>\`;
        }

        function showDetail(id) {
            const b = lastData.find(x => x.id == id);
            document.getElementById('modalContent').innerHTML = \`
                <div class="max-w-6xl mx-auto">
                    <div class="flex justify-between items-end mb-6 bg-card p-4 rounded-xl border-l-4 border-yellow-500">
                        <div><div class="text-zinc-500 text-[11px] uppercase font-bold mb-1">Cấu hình #\${b.id+1} - \${b.config.mode} / VOL \${b.config.vol}%</div>
                        <span class="text-5xl font-bold text-white">\${b.availBal.toFixed(2)}</span><span class="text-zinc-500 ml-2 text-xl font-bold uppercase tracking-tighter">USDT (Available)</span></div>
                        <div class="text-right"><div class="text-zinc-500 text-[11px] uppercase font-bold mb-1">PnL Tạm tính</div>
                        <div class="text-4xl font-bold \${b.unPnl>=0?'up':'down'}">\${b.unPnl.toFixed(2)}</div></div>
                    </div>

                    <div class="grid grid-cols-4 gap-4 mb-6">
                        <div class="bg-card p-4 rounded-xl text-center"><div class="text-zinc-500 uppercase text-[10px] mb-1 font-bold">Vốn Tổng</div><div class="text-2xl font-bold text-white">\${b.pnlTong.toFixed(2)}</div></div>
                        <div class="bg-card p-4 rounded-xl text-center"><div class="text-zinc-500 uppercase text-[10px] mb-1 font-bold">PnL Win (Đã chốt)</div><div class="text-2xl font-bold up">\${b.pnlWin.toFixed(2)}</div></div>
                        <div class="bg-card p-4 rounded-xl text-center"><div class="text-zinc-500 uppercase text-[10px] mb-1 font-bold">Target TP</div><div class="text-2xl font-bold text-yellow-500">\${b.config.tp}%</div></div>
                        <div class="bg-card p-4 rounded-xl text-center"><div class="text-zinc-500 uppercase text-[10px] mb-1 font-bold">Bước DCA</div><div class="text-2xl font-bold text-yellow-500">\${b.config.dca}%</div></div>
                    </div>

                    <div class="bg-card p-5 rounded-xl mb-6">
                        <div class="text-yellow-500 font-bold mb-4 uppercase italic flex items-center"><span class="mr-2">⚡</span> Biến động Market (3 khung)</div>
                        <table class="w-full text-left text-[12px]">
                            <tr class="text-zinc-500 border-b border-zinc-800 uppercase text-[10px] font-bold"><th class="pb-2">Coin</th><th>1M (%)</th><th>5M (%)</th><th>15M (%)</th></tr>
                            \${b.marketAll.map(m=>\`<tr class="border-b border-zinc-800/30 font-medium"><td class="py-2 text-white font-bold">\${m.s}</td><td class="\${m.c1>=0?'up':'down'}">\${m.c1}%</td><td class="\${m.c5>=0?'up':'down'}">\${m.c5}%</td><td class="\${m.c15>=0?'up':'down'}">\${m.c15}%</td></tr>\`).join('')}
                        </table>
                    </div>

                    <div class="bg-card p-5 rounded-xl mb-6 border border-zinc-700">
                        <div class="text-white font-bold mb-4 uppercase tracking-widest flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở chi tiết</div>
                        <table class="w-full text-left text-[12px]">
                            <tr class="text-zinc-500 border-b border-zinc-800 uppercase text-[10px] font-bold"><th>Time</th><th>Pair</th><th>DCA</th><th>Entry/Avg</th><th>PnL (Live)</th></tr>
                            <tbody>\${b.pendingTrade ? \`
                                <tr>
                                    <td class="py-4 text-zinc-400">\${new Date(b.pendingTrade.startTime).toLocaleTimeString()}</td>
                                    <td class="font-bold text-white">\${b.pendingTrade.symbol} <span class="bg-zinc-700 px-2 py-0.5 rounded text-[10px] ml-1">\${b.pendingTrade.type}</span></td>
                                    <td class="text-yellow-500 font-bold text-lg">\${b.pendingTrade.dcaCount}</td>
                                    <td>\${b.pendingTrade.snapPrice.toFixed(4)} <br> <span class="text-yellow-500 font-bold">\${b.pendingTrade.avgPrice.toFixed(4)}</span></td>
                                    <td class="\${b.unPnl>=0?'up':'down'} font-black text-lg">\${b.unPnl.toFixed(2)}</td>
                                </tr>
                            \` : '<tr><td colspan="5" class="text-center py-10 text-zinc-600 italic font-bold">CHƯA CÓ VỊ THẾ ĐANG MỞ</td></tr>'}</tbody>
                        </table>
                    </div>

                    <div class="bg-card p-5 rounded-xl">
                        <div class="text-zinc-500 font-bold mb-4 uppercase italic">Nhật ký & Hiệu suất 100%</div>
                        <table class="w-full text-left text-[11px]">
                            <tr class="text-zinc-500 border-b border-zinc-800 uppercase text-[10px] font-bold"><th>Time Out</th><th>Pair</th><th>Type</th><th>DCA</th><th>PnL Net</th><th>Status</th></tr>
                            \${b.history.reverse().map(h=>\`<tr class="border-b border-zinc-800/30 text-zinc-400"><td class="py-2">\${new Date(h.endTime).toLocaleTimeString()}</td><td class="text-white font-bold">\${h.symbol}</td><td class="\${h.type==='LONG'?'up':'down'} font-bold">\${h.type}</td><td class="text-yellow-500 font-bold text-center">\${h.dcaCount}</td><td class="\${h.pnlReal>=0?'up':'down'} font-bold">\${h.pnlReal.toFixed(2)}</td><td>\${h.status}</td></tr>\`).join('')}
                        </table>
                    </div>
                </div>\`;
            document.getElementById('detailModal').style.display = 'block';
        }

        function closeModal() { document.getElementById('detailModal').style.display = 'none'; }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
