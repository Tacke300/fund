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
let globalHistory = [];

// Khởi tạo 40 cấu hình
let bots = [];
const NUM_BOTS = 40;
const INITIAL_CAPITAL_PER_BOT = 100;

// Cấu trúc Class để nhân bản bot
class TradingBot {
    constructor(id) {
        this.id = id;
        this.config = {
            vol: Math.floor(Math.random() * 10) + 1, // Biến động 1-10
            tp: 0.3,
            dca: 10,
            marginPercent: 1, // 1%
            balance: INITIAL_CAPITAL_PER_BOT,
            // Chế độ: 0: FOLLOW, 1: REVERSE, 2: LONG, 3: SHORT
            mode: ['FOLLOW', 'REVERSE', 'LONG', 'SHORT'][id % 4] 
        };
        this.pendingTrade = null;
        this.history = [];
        this.totalWin = 0;
        this.pnlWin = 0;
        this.lastTradeTime = 0;
    }

    getAvailableBalance() {
        let unPnl = 0;
        let marginInUse = 0;
        if (this.pendingTrade) {
            const currentPrice = coinData[this.pendingTrade.symbol]?.live?.currentPrice || this.pendingTrade.avgPrice;
            const diff = ((currentPrice - this.pendingTrade.avgPrice) / this.pendingTrade.avgPrice) * 100;
            const roi = (this.pendingTrade.type === 'LONG' ? diff : -diff) * (this.pendingTrade.maxLev || 20);
            
            const marginBase = this.config.balance * (this.config.marginPercent / 100);
            marginInUse = marginBase * (this.pendingTrade.dcaCount + 1);
            unPnl = (marginInUse * roi) / 100;
        }
        return this.config.balance - marginInUse + unPnl;
    }

    updateLogic(s, p, c1, c5, c15, now) {
        // --- Xử lý lệnh đang mở ---
        if (this.pendingTrade && this.pendingTrade.symbol === s) {
            const h = this.pendingTrade;
            const diffAvg = ((p - h.avgPrice) / h.avgPrice) * 100;
            const currentRoi = (h.type === 'LONG' ? diffAvg : -diffAvg) * (h.maxLev || 20);
            
            if (!h.maxNegativeRoi || currentRoi < h.maxNegativeRoi) h.maxNegativeRoi = currentRoi;

            const isWin = h.type === 'LONG' ? diffAvg >= h.tpTarget : diffAvg <= -h.tpTarget;
            const isTimeout = (now - h.startTime) >= (MAX_HOLD_MINUTES * 60000);

            if (isWin || isTimeout) {
                const marginBase = this.config.balance * (this.config.marginPercent / 100);
                const totalMargin = marginBase * (h.dcaCount + 1);
                const finalPnl = (totalMargin * currentRoi) / 100;

                h.status = isWin ? 'WIN' : 'TIMEOUT';
                h.finalPrice = p;
                h.endTime = now;
                h.pnlReal = finalPnl;

                if (finalPnl > 0) {
                    this.totalWin++;
                    this.pnlWin += finalPnl;
                }
                
                this.config.balance += finalPnl;
                this.history.push(h);
                globalHistory.push({ botId: this.id, ...h });
                this.pendingTrade = null;
                this.lastTradeTime = now;
                saveData();
                return;
            }

            // --- Logic DCA ---
            const totalDiffFromEntry = Math.abs(((p - h.snapPrice) / h.snapPrice) * 100);
            let triggerDCA = false;
            
            if (h.dcaCount < 9) {
                if (totalDiffFromEntry >= (h.dcaCount + 1) * h.slTarget) triggerDCA = true;
            } else {
                // Sau lần 9: cứ 1% dca 1 lần
                const extraDcaSteps = h.dcaCount - 8; 
                if (totalDiffFromEntry >= (9 * h.slTarget) + extraDcaSteps) triggerDCA = true;
            }

            if (triggerDCA) {
                const newCount = h.dcaCount + 1;
                const newAvg = ((h.avgPrice * (h.dcaCount + 1)) + p) / (newCount + 1);
                h.avgPrice = newAvg;
                h.dcaCount = newCount;
                h.dcaHistory.push({ t: now, p: p, avg: newAvg });
            }
        } 
        
        // --- Tìm lệnh mới ---
        else if (!this.pendingTrade && (now - this.lastTradeTime > COOLDOWN_MINUTES * 60000)) {
            const vol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
            if (vol >= this.config.vol) {
                let type = '';
                if (this.config.mode === 'LONG') type = 'LONG';
                else if (this.config.mode === 'SHORT') type = 'SHORT';
                else if (this.config.mode === 'FOLLOW') type = (c1 > 0 ? 'LONG' : 'SHORT');
                else if (this.config.mode === 'REVERSE') type = (c1 > 0 ? 'SHORT' : 'LONG');

                this.pendingTrade = {
                    symbol: s, startTime: now, snapPrice: p, avgPrice: p, type: type, status: 'PENDING',
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: this.config.tp, slTarget: this.config.dca,
                    snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: now, p: p, avg: p }]
                };
            }
        }
    }
}

// Init Bots
for (let i = 0; i < NUM_BOTS; i++) {
    bots.push(new TradingBot(i));
}

// Logic Helper
function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    let s = p.toFixed(20);
    let match = s.match(/^-?\d+\.0*[1-9]/);
    if (!match) return p.toFixed(4);
    let index = match[0].length;
    return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0];
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

// Files
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
function saveData() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(globalHistory.slice(-1000))); }

// WebSocket
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 200) coinData[s].prices.shift();
            
            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            bots.forEach(bot => bot.updateLogic(s, p, c1, c5, c15, now));
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// API
app.get('/api/data', (req, res) => {
    const botStats = bots.map(b => {
        let pnlLive = 0;
        if (b.pendingTrade) {
            const p = coinData[b.pendingTrade.symbol]?.live?.currentPrice || b.pendingTrade.avgPrice;
            const diff = ((p - b.pendingTrade.avgPrice) / b.pendingTrade.avgPrice) * 100;
            const roi = (b.pendingTrade.type === 'LONG' ? diff : -diff) * (b.pendingTrade.maxLev || 20);
            const marginBase = b.config.balance * (b.config.marginPercent / 100);
            pnlLive = (marginBase * (b.pendingTrade.dcaCount + 1) * roi) / 100;
        }
        return {
            id: b.id,
            config: b.config,
            availableBalance: b.getAvailableBalance(),
            totalWin: b.totalWin,
            pnlWin: b.pnlWin,
            pnlLive: pnlLive,
            isOpening: !!b.pendingTrade,
            pending: b.pendingTrade,
            history: b.history.slice(-10)
        };
    });

    res.json({
        bots: botStats,
        market: Object.entries(coinData).map(([s, v]) => ({ s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 5)
    });
});

app.get('/gui', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Multi-Engine 40</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; font-size: 12px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:100; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.9); overflow-y:auto; }
    </style>
    </head><body class="p-4">
        <div class="flex justify-between items-center mb-4 bg-card p-4 rounded">
            <h1 class="text-2xl font-bold text-yellow-500 italic">LUFFY MULTI-BOT (40 CONFIGS)</h1>
            <div id="globalStats" class="flex gap-6"></div>
        </div>

        <div id="botGrid" class="grid grid-cols-4 gap-2"></div>

        <div id="botModal" class="modal p-4">
            <div class="bg-card max-w-4xl mx-auto p-6 rounded relative">
                <button onclick="closeModal()" class="absolute top-4 right-4 text-2xl">&times;</button>
                <div id="modalContent"></div>
            </div>
        </div>

        <script>
            let lastData = null;
            async function update() {
                const res = await fetch('/api/data');
                const data = await res.json();
                lastData = data;

                let totalBal = 0, totalPnlWin = 0, totalOpening = 0, totalPnlLive = 0;
                data.bots.forEach(b => {
                    totalBal += b.config.balance;
                    totalPnlWin += b.pnlWin;
                    totalPnlLive += b.pnlLive;
                    if(b.isOpening) totalOpening++;
                });

                document.getElementById('globalStats').innerHTML = \`
                    <div class="text-center"><div>Tổng Vốn</div><div class="text-xl font-bold">\${totalBal.toFixed(2)}</div></div>
                    <div class="text-center"><div>PnL Win</div><div class="text-xl font-bold up">\${totalPnlWin.toFixed(2)}</div></div>
                    <div class="text-center"><div>PnL Live</div><div class="text-xl font-bold \${totalPnlLive>=0?'up':'down'}">\${totalPnlLive.toFixed(2)}</div></div>
                    <div class="text-center"><div>Đang mở</div><div class="text-xl font-bold text-yellow-500">\${totalOpening}</div></div>
                \`;

                document.getElementById('botGrid').innerHTML = data.bots.map(b => \`
                    <div onclick="showDetail(\${b.id})" class="bg-card p-3 rounded cursor-pointer hover:border-yellow-500 transition-all">
                        <div class="flex justify-between border-b border-zinc-700 pb-1 mb-2">
                            <span class="font-bold">#\${b.id+1} - \${b.config.mode}</span>
                            <span class="text-yellow-500 font-bold">Vol: \${b.config.vol}%</span>
                        </div>
                        <div class="grid grid-cols-2 gap-1 text-[10px]">
                            <div class="text-gray-400">Available:</div><div class="text-right">\${b.availableBalance.toFixed(2)}</div>
                            <div class="text-gray-400">Win:</div><div class="text-right up">\${b.pnlWin.toFixed(2)} (\${b.totalWin})</div>
                            <div class="text-gray-400">Status:</div><div class="text-right \${b.isOpening?'text-green-500 animate-pulse':'text-zinc-500'}">\${b.isOpening ? b.pending.symbol : 'IDLE'}</div>
                            <div class="text-gray-400">PnL Live:</div><div class="text-right \${b.pnlLive>=0?'up':'down'}">\${b.pnlLive.toFixed(2)}</div>
                        </div>
                    </div>
                \`).join('');
            }

            function showDetail(id) {
                const b = lastData.bots.find(x => x.id == id);
                const modal = document.getElementById('botModal');
                document.getElementById('modalContent').innerHTML = \`
                    <h2 class="text-xl font-bold text-yellow-500 mb-4">Chi tiết Bot #\${b.id+1} (\${b.config.mode})</h2>
                    <div class="grid grid-cols-3 gap-4 mb-6">
                        <div class="p-3 bg-black/30 rounded"><div>Biến động mở</div><div class="text-lg font-bold">\${b.config.vol}%</div></div>
                        <div class="p-3 bg-black/30 rounded"><div>TP / DCA</div><div class="text-lg font-bold">\${b.config.tp}% / \${b.config.dca}%</div></div>
                        <div class="p-3 bg-black/30 rounded"><div>Số dư hiện tại</div><div class="text-lg font-bold text-white">\${b.config.balance.toFixed(2)} $</div></div>
                    </div>
                    
                    <div class="mb-4">
                        <h3 class="font-bold border-l-4 border-green-500 pl-2 mb-2">VỊ THẾ ĐANG MỞ</h3>
                        \${b.isOpening ? \`
                            <table class="w-full text-left">
                                <tr class="text-zinc-500 border-b border-zinc-800"><th>Symbol</th><th>Type</th><th>DCA</th><th>Entry</th><th>Avg Price</th><th>ROI</th></tr>
                                <tr>
                                    <td class="py-2 text-yellow-500 font-bold">\${b.pending.symbol}</td>
                                    <td class="\${b.pending.type==='LONG'?'up':'down'}">\${b.pending.type}</td>
                                    <td>\${b.pending.dcaCount}</td>
                                    <td>\${b.pending.snapPrice}</td>
                                    <td class="text-yellow-500">\${b.pending.avgPrice}</td>
                                    <td class="\${b.pnlLive>=0?'up':'down'} font-bold">\${b.pnlLive.toFixed(2)} $</td>
                                </tr>
                            </table>
                        \` : '<div class="text-zinc-500 italic">Không có lệnh</div>'}
                    </div>

                    <div>
                        <h3 class="font-bold border-l-4 border-yellow-500 pl-2 mb-2">LỊCH SỬ GẦN ĐÂY</h3>
                        <table class="w-full text-[10px] text-left">
                            <thead class="text-zinc-500"><tr><th>Time</th><th>Symbol</th><th>Type</th><th>DCA</th><th>Result</th><th>PnL</th></tr></thead>
                            <tbody>
                                \${b.history.reverse().map(h => \`
                                    <tr class="border-b border-zinc-800">
                                        <td class="py-1">\${new Date(h.endTime).toLocaleTimeString()}</td>
                                        <td class="font-bold">\${h.symbol}</td>
                                        <td>\${h.type}</td>
                                        <td>\${h.dcaCount}</td>
                                        <td>\${h.status}</td>
                                        <td class="\${h.pnlReal>=0?'up':'down'}">\${h.pnlReal.toFixed(2)}</td>
                                    </tr>
                                \`).join('')}
                            </tbody>
                        </table>
                    </div>
                \`;
                modal.style.display = 'block';
            }

            function closeModal() { document.getElementById('botModal').style.display = 'none'; }
            setInterval(update, 1000);
            update();
        </script>
    </body></html>
    `);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Engine started: http://localhost:${PORT}/gui`); });
