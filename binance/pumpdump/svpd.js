const TP_PERCENT = 0.5; 
const SL_PERCENT = 10.0;  
const MIN_VOLATILITY_TO_SAVE = 5; 
const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

// Logic hiển thị: Giữ lại mọi số 0 và đúng 4 số có nghĩa sau đó
function formatDynamic(price) {
    if (!price || price === 0) return "0.0000";
    let s = price.toFixed(12); // Lấy sâu để không mất số rác
    let match = s.match(/^-?\d+\.?0*[1-9]{1,4}/);
    return match ? match[0] : price.toFixed(4);
}

async function fetchActualLeverage() {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const options = { 
        hostname: 'fapi.binance.com', 
        path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`, 
        headers: { 'X-MBX-APIKEY': API_KEY } 
    };
    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                if (Array.isArray(brackets)) {
                    brackets.forEach(item => { if (item.brackets?.[0]) symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage; });
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                }
            } catch (e) {}
        });
    });
}

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = pArr[pArr.length - 1].t;
    let start = pArr.find(i => i.t >= (now - min * 60000));
    if (!start) start = pArr[0]; 
    const diff = ((pArr[pArr.length - 1].p - start.p) / start.p) * 100;
    return parseFloat(diff.toFixed(2));
}

function initWS() {
    fetchActualLeverage();
    // Stream !ticker@arr của Binance thường update mỗi 1000ms. 
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
            
            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const win = pending.type === 'UP' ? diff >= TP_PERCENT : diff <= -TP_PERCENT; 
                const lose = pending.type === 'UP' ? diff <= -SL_PERCENT : diff >= SL_PERCENT; 

                if (win || lose) { 
                    pending.status = win ? 'WIN' : 'LOSE'; 
                    pending.finalPrice = p; 
                    pending.endTime = now;
                    pending.pnlPercent = win ? TP_PERCENT : -SL_PERCENT;
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                }
            }
            
            const isCooldown = lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000);
            if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= MIN_VOLATILITY_TO_SAVE && !pending && !isCooldown) {
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: now, snapPrice: p, 
                    type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20,
                    snapVol: { c1, c5, c15 },
                    tpTarget: TP_PERCENT,
                    slTarget: SL_PERCENT
                });
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })),
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime),
        config: { tp: TP_PERCENT, sl: SL_PERCENT }
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Luffy Pro - ULTRA REALTIME</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; }
        .blink { animation: blinker 0.2s linear; }
        @keyframes blinker { 50% { opacity: 0.5; } }
    </style></head><body>
    
    <div class="p-4 bg-[#0b0e11] sticky top-0 z-50 shadow-2xl border-b border-zinc-800">
        <div id="setup" class="flex gap-2 mb-4">
            <input id="balanceInp" type="number" value="1000" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none">
            <input id="marginInp" type="text" value="10%" class="bg-black border border-zinc-700 p-2 rounded w-full text-yellow-500 font-bold outline-none">
            <button onclick="start()" class="bg-[#fcd535] text-black px-6 py-2 rounded font-bold uppercase">Start</button>
        </div>

        <div id="active" class="hidden flex justify-between items-center mb-4">
             <div class="flex items-center gap-2"><h1 class="font-bold italic text-white tracking-tighter">BINANCE <span class="text-[#fcd535]">ULTRA LIVE</span></h1></div>
             <div id="user-id" class="text-[#fcd535] font-black italic" onclick="stop()">MONKEY_D_LUFFY</div>
        </div>

        <div class="flex items-end gap-2">
            <span id="displayBal" class="text-4xl font-bold tracking-tighter text-white">0.00</span>
            <span class="text-sm font-medium text-gray-400 mb-1">USDT</span>
        </div>
    </div>

    <div class="px-4 mt-4">
        <div class="bg-card rounded-xl p-4 border border-zinc-800">
            <div class="text-[10px] font-bold text-green-400 mb-3 uppercase tracking-widest border-b border-green-900/50 pb-2">Vị thế đang mở (Live Every 0.1s)</div>
            <div class="overflow-x-auto">
                <table class="w-full text-[10px] text-left">
                    <thead class="text-gray-500 uppercase border-b border-zinc-800">
                        <tr>
                            <th class="pb-2">Coin</th>
                            <th class="pb-2">Entry</th>
                            <th class="pb-2">Live Price</th>
                            <th class="pb-2 text-right">PnL (ROI%)</th>
                        </tr>
                    </thead>
                    <tbody id="pendingBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <div class="px-4 mt-4 pb-20">
        <div class="bg-card rounded-xl p-4 border border-zinc-800">
            <div class="text-[10px] font-bold text-gray-500 mb-3 uppercase border-b border-zinc-800 pb-2">Lịch sử khớp lệnh</div>
            <table class="w-full text-[10px] text-left"><tbody id="historyBody"></tbody></table>
        </div>
    </div>

    <script>
    let running = false, initialBal = 1000;
    let lastPrices = {};

    // HÀM QUAN TRỌNG: Format đúng 4 số sau các số 0
    function fPrice(price) {
        if (!price || price === 0) return "0.0000";
        let s = price.toFixed(12);
        let match = s.match(/^-?\d+\.?0*[1-9]{1,4}/);
        return match ? match[0] : price.toFixed(4);
    }

    function start() { running = true; initialBal = parseFloat(document.getElementById('balanceInp').value) || 1000; document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
    function stop() { running = false; document.getElementById('setup').classList.remove('hidden'); document.getElementById('active').classList.add('hidden'); }

    async function update() {
        try {
            const res = await fetch('/api/data'); 
            const d = await res.json();
            
            let mVal = document.getElementById('marginInp').value;
            let mNum = parseFloat(mVal) || 0;
            let runningBal = initialBal;

            // Xử lý history để tính Balance hiện tại
            d.history.reverse().forEach(h => {
                let margin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let netPnl = (margin * (h.maxLev || 20) * (h.pnlPercent/100)) - (margin * (h.maxLev || 20) * 0.001);
                runningBal += netPnl;
            });

            // Render Vị thế đang mở
            let totalUnPnl = 0;
            document.getElementById('pendingBody').innerHTML = d.pending.map(h => {
                let coin = d.live.find(c => c.symbol === h.symbol);
                let livePrice = coin ? coin.currentPrice : h.snapPrice;
                
                let margin = mVal.includes('%') ? (runningBal * mNum / 100) : mNum;
                let diff = ((livePrice - h.snapPrice) / h.snapPrice) * 100;
                let roi = (h.type === 'UP' ? diff : -diff) * (h.maxLev || 20);
                let pnl = margin * roi / 100;
                totalUnPnl += pnl;

                // Hiệu ứng nháy khi giá đổi
                let priceClass = lastPrices[h.symbol] !== livePrice ? 'text-white blink font-bold' : 'text-zinc-400';
                lastPrices[h.symbol] = livePrice;

                return \`<tr class="border-b border-zinc-800/50">
                    <td class="py-3"><b>\${h.symbol}</b><br><span class="\${h.type==='UP'?'up':'down'}">\${h.type} \${h.maxLev}x</span></td>
                    <td>\${fPrice(h.snapPrice)}</td>
                    <td class="\${priceClass}">\${fPrice(livePrice)}</td>
                    <td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}<br>(\${roi.toFixed(2)}%)</td>
                </tr>\`;
            }).join('');

            // Render Lịch sử (rút gọn)
            document.getElementById('historyBody').innerHTML = d.history.slice(0, 10).map(h => \`
                <tr class="border-b border-zinc-800/20 text-zinc-500">
                    <td class="py-2">\${h.symbol}</td>
                    <td class="\${h.status==='WIN'?'up':'down'}">\${h.status}</td>
                    <td class="text-right">\${fPrice(h.finalPrice)}</td>
                </tr>
            \`).join('');

            if(running) {
                document.getElementById('displayBal').innerText = (runningBal + totalUnPnl).toFixed(2);
            }
        } catch(e) {}
    }

    // Tần suất cực cao: 100ms (0.1 giây) để đảm bảo Backend có gì là Frontend hiện nấy
    setInterval(update, 100);
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`\n\x1b[32m[SERVER RUNNING] http://localhost:${PORT}/gui\x1b[0m\n`); });
