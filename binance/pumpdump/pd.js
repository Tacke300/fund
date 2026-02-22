import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
const PORT = 9001;
const HISTORY_FILE = './history_db.json';

// --- CẤU HÌNH BOT & TRẠNG THÁI ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 5, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0, 
    accountSL: 30 
};

let coinData = {}; 
let historyMap = new Map();
let botManagedSymbols = []; 
let exchangeInfo = {};
let isInitializing = true;

// --- HÀM TÍNH TOÁN & UTILS ---
function getPivotTime() {
    const now = new Date();
    let pivot = new Date(now);
    pivot.setHours(7, 0, 0, 0);
    if (now < pivot) pivot.setDate(pivot.getDate() - 1);
    return pivot.getTime();
}

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startObj = priceArray.find(item => item.t >= targetTime);
    if (!startObj) return 0;
    return parseFloat(((priceArray[priceArray.length - 1].p - startObj.p) / startObj.p * 100).toFixed(2));
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "LỖI_JSON" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- CORE: WEBSOCKET TÍN HIỆU & WIN/LOSE ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s; if(!s.endsWith('USDT')) return;
            const p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            // Kiểm tra Win/Lose cho History
            let hist = historyMap.get(s);
            if (hist && hist.status === 'PENDING') {
                const diff = ((p - hist.snapPrice) / hist.snapPrice) * 100;
                if (hist.type === 'DOWN') {
                    if (diff <= -5) hist.status = 'WIN'; else if (diff >= 5) hist.status = 'LOSE';
                } else {
                    if (diff >= 5) hist.status = 'WIN'; else if (diff <= -5) hist.status = 'LOSE';
                }
            }

            // Ghi nhận tín hiệu mới vào History (Chụp ảnh lúc biến động)
            if (Math.abs(c1) >= botSettings.minVol || Math.abs(c5) >= botSettings.minVol || Math.abs(c15) >= botSettings.minVol) {
                if (!hist || hist.status !== 'PENDING') {
                    historyMap.set(s, { 
                        symbol: s, startTime: now, snapPrice: p, 
                        max1: c1, max5: c5, max15: c15,
                        type: (c1+c5+c15 >= 0) ? 'UP' : 'DOWN', status: 'PENDING' 
                    });
                }
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
}

// --- LOGIC VÀO LỆNH (HUNT) ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning) return;
    
    const candidates = Object.values(coinData)
        .filter(c => c.live && (Math.abs(c.live.c1) >= botSettings.minVol || Math.abs(c.live.c5) >= botSettings.minVol))
        .sort((a,b) => Math.max(Math.abs(b.live.c1), Math.abs(b.live.c5)) - Math.max(Math.abs(a.live.c1), Math.abs(a.live.c5)));

    for (const c of candidates) {
        if (botManagedSymbols.length >= botSettings.maxPositions) break;
        if (botManagedSymbols.includes(c.symbol)) continue;

        try {
            console.log(`[BOT] 🎯 Phát hiện tín hiệu: ${c.symbol}`);
            const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
            const lev = brackets[0].brackets[0].initialLeverage;
            await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

            const acc = await callBinance('/fapi/v2/account');
            const balance = parseFloat(acc.totalMarginBalance);
            const side = (c.live.c1 + c.live.c5 >= 0) ? 'BUY' : 'SELL';
            const posSide = (side === 'BUY') ? 'LONG' : 'SHORT';
            
            let margin = botSettings.invType === 'percent' ? (balance * botSettings.invValue) / 100 : botSettings.invValue;
            let qty = (margin * lev) / c.live.currentPrice;
            
            const info = exchangeInfo[c.symbol];
            const finalQty = (Math.floor(qty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            await callBinance('/fapi/v1/order', 'POST', {
                symbol: c.symbol, side: side, positionSide: posSide, type: 'MARKET', quantity: finalQty
            });

            botManagedSymbols.push(c.symbol);
            console.log(`[BOT] ✅ Đã mở lệnh ${c.symbol} (${posSide})`);
        } catch (e) { console.log(`[BOT] ❌ Lỗi vào lệnh ${c.symbol}: ${e.msg || 'API Error'}`); }
    }
}

// --- API & GIAO DIỆN ---
app.use(express.json());

app.get('/api/status', async (req, res) => {
    try {
        const pivot = getPivotTime();
        const historyArr = Array.from(historyMap.values());
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });

        const live = Object.entries(coinData)
            .filter(([_, v]) => v.live)
            .map(([s, v]) => ({ symbol: s, ...v.live }))
            .sort((a,b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5)))
            .slice(0, 15);

        res.json({
            botSettings,
            live,
            history: historyArr.sort((a,b) => b.startTime - a.startTime).slice(0, 20),
            stats: {
                win: historyArr.filter(h => h.startTime >= pivot && h.status === 'WIN').length,
                lose: historyArr.filter(h => h.startTime >= pivot && h.status === 'LOSE').length
            },
            activePositions: active
        });
    } catch (e) { res.status(500).send(); }
});

app.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ status: "ok" });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY BOT ULTIMATE</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono&display=swap" rel="stylesheet">
    <style>
        body { background: #050505; color: #eee; font-family: 'JetBrains Mono', monospace; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .card { background: rgba(15, 15, 20, 0.95); border: 1px solid #222; border-radius: 12px; }
        .up { color: #22c55e; } .down { color: #ef4444; }
        .btn-start { background: #15803d; } .btn-stop { background: #b91c1c; }
    </style></head><body class="p-4">
    <header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-600">
        <div>
            <h1 class="luffy-font text-4xl text-white uppercase italic">Moncey D. Luffy Bot</h1>
            <div id="botStatus" class="text-[10px] font-bold">● OFFLINE</div>
        </div>
        <div class="flex gap-8 text-center">
            <div><p class="text-[10px] text-gray-500 uppercase">Win (7h)</p><p id="winStats" class="text-2xl font-bold up">0</p></div>
            <div><p class="text-[10px] text-gray-500 uppercase">Lose (7h)</p><p id="loseStats" class="text-2xl font-bold down">0</p></div>
        </div>
    </header>

    <div class="grid grid-cols-12 gap-4">
        <div class="col-span-12 md:col-span-3 card p-4 space-y-4">
            <div><label class="text-[10px] text-gray-400">BIẾN ĐỘNG %</label>
            <input type="number" id="minVol" class="w-full bg-black border border-zinc-800 p-2 text-sm mono" value="5"></div>
            <div><label class="text-[10px] text-gray-400">SỐ LỆNH MAX</label>
            <input type="number" id="maxPositions" class="w-full bg-black border border-zinc-800 p-2 text-sm mono" value="5"></div>
            <button id="runBtn" onclick="handleToggle()" class="w-full p-4 rounded-xl font-black text-sm btn-start uppercase">Giương Buồm</button>
        </div>

        <div class="col-span-12 md:col-span-9 card flex flex-col overflow-hidden border-t-2 border-blue-600">
            <div class="p-3 bg-blue-900/10 font-bold text-xs">CHIẾN TRƯỜNG LIVE</div>
            <table class="w-full text-left text-[11px] mono">
                <thead class="bg-black text-gray-500 uppercase text-[9px]">
                    <tr><th class="p-3">Cặp Tiền</th><th class="p-3">Side</th><th class="p-3">Entry/Mark</th><th class="p-3 text-right">PnL %</th></tr>
                </thead>
                <tbody id="posTable"></tbody>
            </table>
        </div>

        <div class="col-span-12 md:col-span-5 card overflow-hidden border-t-2 border-yellow-600">
            <div class="p-3 bg-yellow-900/10 font-bold text-xs uppercase">Sóng Hiện Tại</div>
            <div id="liveBody" class="p-2 space-y-1"></div>
        </div>

        <div class="col-span-12 md:col-span-7 card overflow-hidden border-t-2 border-gray-600">
            <div class="p-3 bg-gray-900/10 font-bold text-xs uppercase">Nhật Ký Tín Hiệu</div>
            <div class="overflow-y-auto max-h-[400px]">
                <table class="w-full text-[11px] text-left">
                    <thead class="text-gray-500 uppercase text-[9px]">
                        <tr><th class="p-2">Thời gian</th><th class="p-2">Mã</th><th class="p-2">1M</th><th class="p-2">5M</th><th class="p-2">Kết quả</th></tr>
                    </thead>
                    <tbody id="histBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        async function refresh() {
            try {
                const res = await fetch('/api/status');
                const d = await res.json();
                
                document.getElementById('botStatus').innerText = d.botSettings.isRunning ? '● ĐANG TUẦN TRA' : '○ ĐANG NGHỈ';
                document.getElementById('botStatus').className = d.botSettings.isRunning ? 'text-green-500' : 'text-gray-500';
                const btn = document.getElementById('runBtn');
                btn.innerText = d.botSettings.isRunning ? "🛑 Hạ Buồm" : "🚢 Giương Buồm";
                btn.className = \`w-full p-4 rounded-xl font-black text-sm uppercase \${d.botSettings.isRunning ? 'btn-stop' : 'btn-start'}\`;

                document.getElementById('winStats').innerText = d.stats.win;
                document.getElementById('loseStats').innerText = d.stats.lose;

                document.getElementById('posTable').innerHTML = d.activePositions.map(p => \`
                    <tr class="border-b border-zinc-900">
                        <td class="p-3 font-bold">\${p.symbol}</td>
                        <td class="p-3 \${p.side==='LONG'?'up':'down'} font-black italic">\${p.side} \${p.leverage}x</td>
                        <td class="p-3 text-[10px] text-gray-400">\${p.entryPrice}<br>\${p.markPrice}</td>
                        <td class="p-3 text-right font-black \${p.pnlPercent >= 0 ? 'up' : 'down'}">\${p.pnlPercent}%</td>
                    </tr>\`).join('');

                document.getElementById('liveBody').innerHTML = d.live.slice(0,10).map(c => \`
                    <div class="flex justify-between p-2 border-b border-zinc-900/50">
                        <span class="font-bold">\${c.symbol}</span>
                        <div class="flex gap-4">
                            <span class="\${c.c1>=0?'up':'down'}">1M: \${c.c1}%</span>
                            <span class="\${c.c5>=0?'up':'down'}">5M: \${c.c5}%</span>
                        </div>
                    </div>\`).join('');

                document.getElementById('histBody').innerHTML = d.history.map(h => \`
                    <tr class="border-b border-zinc-900/50">
                        <td class="p-2 text-gray-500">\${new Date(h.startTime).toLocaleTimeString()}</td>
                        <td class="p-2 font-black \${h.type==='UP'?'up':'down'}">\${h.symbol}</td>
                        <td class="p-2 \${h.max1>=0?'up':'down'}">\${h.max1}%</td>
                        <td class="p-2 \${h.max5>=0?'up':'down'}">\${h.max5}%</td>
                        <td class="p-2 font-bold \${h.status==='WIN'?'up':(h.status==='LOSE'?'down':'text-gray-500')}">\${h.status}</td>
                    </tr>\`).join('');
            } catch(e) {}
        }

        async function handleToggle() {
            const res = await fetch('/api/status'); const d = await res.json();
            const body = { 
                isRunning: !d.botSettings.isRunning,
                minVol: parseFloat(document.getElementById('minVol').value),
                maxPositions: parseInt(document.getElementById('maxPositions').value)
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            refresh();
        }
        setInterval(refresh, 1000); refresh();
    </script></body></html>`);
});

// --- KHỞI TẠO HỆ THỐNG ---
async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                const info = JSON.parse(d);
                info.symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
                console.log("✅ Hệ thống đã sẵn sàng.");
            } catch (e) { console.log("❌ Lỗi khởi tạo sàn."); }
        });
    });
}

if (fs.existsSync(HISTORY_FILE)) {
    try { historyMap = new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE)))); } catch(e){}
}

init();
initWS();
setInterval(hunt, 2000);
setInterval(() => {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(historyMap)));
    // Tự động dọn danh sách quản lý để mở slot mới nếu sàn đã đóng lệnh
    botManagedSymbols = []; 
}, 60000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚓ Luffy Bot đang chạy tại http://localhost:${PORT}`);
});
