import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
const PORT = 9001; // Truy cập giao diện tại đây
const HISTORY_FILE = './history_db.json';

// --- CẤU HÌNH BOT ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0,
    leverage: 20 // Mặc định nếu ko lấy được bracket
};

let coinData = {}; 
let historyMap = new Map();
let botManagedSymbols = []; 
let exchangeInfo = {};
let isInitializing = true;

// --- LOGIC THỜI GIAN (UTC+7) ---
function getPivotTime() {
    const now = new Date();
    const pivot = new Date(now);
    pivot.setHours(7, 0, 0, 0);
    // Nếu hiện tại chưa đến 7h sáng, pivot tính từ 7h sáng ngày hôm trước
    if (now < pivot) pivot.setDate(pivot.getDate() - 1);
    return pivot.getTime();
}

// --- BINANCE API CALL ---
async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "JSON_ERR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- CORE: WEBSOCKET TÍN HIỆU (SIÊU NHẠY) ---
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
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();

            // Tính toán biến động nhanh
            const calc = (mins) => {
                const target = now - mins * 60 * 1000;
                const start = coinData[s].prices.find(x => x.t >= target);
                return start ? ((p - start.p) / start.p * 100).toFixed(2) : 0;
            };

            coinData[s].live = { c1: calc(1), c5: calc(5), c15: calc(15), price: p };

            // Cập nhật trạng thái Win/Lose cho lịch sử
            let hist = historyMap.get(s);
            if (hist && hist.status === 'PENDING') {
                const diff = ((p - hist.snapPrice) / hist.snapPrice) * 100;
                const winTarget = 5, loseTarget = -5; // Có thể tùy chỉnh
                if (hist.type === 'UP') {
                    if (diff >= winTarget) hist.status = 'WIN';
                    else if (diff <= loseTarget) hist.status = 'LOSE';
                } else {
                    if (diff <= loseTarget) hist.status = 'WIN';
                    else if (diff >= winTarget) hist.status = 'LOSE';
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 2000));
}

// --- HÀM VÀO LỆNH ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning) return;
    if (botManagedSymbols.length >= botSettings.maxPositions) return;

    const candidates = Object.values(coinData)
        .filter(c => c.live && Math.abs(c.live.c1) >= botSettings.minVol)
        .sort((a,b) => Math.abs(b.live.c1) - Math.abs(a.live.c1));

    for (const c of candidates) {
        if (botManagedSymbols.length >= botSettings.maxPositions) break;
        if (botManagedSymbols.includes(c.symbol)) continue;

        try {
            const side = parseFloat(c.live.c1) > 0 ? 'BUY' : 'SELL';
            const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
            
            // Lấy đòn bẩy & Tài khoản
            const acc = await callBinance('/fapi/v2/account');
            const balance = parseFloat(acc.totalMarginBalance);
            const info = exchangeInfo[c.symbol];

            let margin = botSettings.invType === 'percent' ? (balance * botSettings.invValue) / 100 : botSettings.invValue;
            let qty = (margin * botSettings.leverage) / c.live.price;
            let finalQty = (Math.floor(qty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            await callBinance('/fapi/v1/order', 'POST', {
                symbol: c.symbol, side: side, positionSide: posSide, type: 'MARKET', quantity: finalQty
            });

            botManagedSymbols.push(c.symbol);
            
            // Lưu vào history ngay khi vào lệnh thành công
            historyMap.set(c.symbol, {
                symbol: c.symbol, startTime: Date.now(), snapPrice: c.live.price,
                max1: c.live.c1, type: posSide === 'LONG' ? 'UP' : 'DOWN', status: 'PENDING'
            });

            console.log(`🚀 [ENTRY] ${c.symbol} | ${posSide} | Qty: ${finalQty}`);
        } catch (e) { console.log(`❌ [ERROR] ${c.symbol}: ${e.msg}`); }
    }
}

// --- API & ROUTES ---
app.use(express.json());
app.get('/api/status', async (req, res) => {
    try {
        const pivot = getPivotTime();
        const historyArr = Array.from(historyMap.values());
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const pnl = (parseFloat(p.unrealizedProfit) >= 0 ? '+' : '') + parseFloat(p.unrealizedProfit).toFixed(2);
            return { symbol: p.symbol, side: p.positionSide, entry: p.entryPrice, mark: p.markPrice, pnl };
        });

        res.json({
            botSettings,
            activePositions: active,
            history: historyArr.sort((a,b) => b.startTime - a.startTime).slice(0, 15),
            stats: {
                win: historyArr.filter(h => h.startTime >= pivot && h.status === 'WIN').length,
                lose: historyArr.filter(h => h.startTime >= pivot && h.status === 'LOSE').length
            }
        });
    } catch (e) { res.status(500).send(); }
});

app.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ status: "ok" });
});

// --- HTML INTERFACE ---
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LUFFY V5</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Bangers&display=swap" rel="stylesheet">
    <style>
        body { background:#0a0a0c; color:#d1d1d1; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas; }
        .luffy-text { font-family: 'Bangers', cursive; }
        .card { background: #111114; border: 1px solid #1f1f23; border-radius: 8px; }
        input { background: #000; border: 1px solid #333; padding: 4px 8px; border-radius: 4px; color: #fff; }
        .up { color: #22c55e; } .down { color: #ef4444; }
    </style></head><body class="p-4">
    <div class="max-w-6xl mx-auto space-y-4">
        <div class="card p-4 flex justify-between items-center border-l-4 border-red-600">
            <h1 class="luffy-text text-4xl italic tracking-widest text-white">LUFFY PIRATE BOT</h1>
            <div class="flex gap-6 text-center">
                <div><div class="text-[10px] text-gray-500 uppercase">WIN (7H AM)</div><div id="win" class="text-2xl font-bold up">0</div></div>
                <div><div class="text-[10px] text-gray-500 uppercase">LOSE (7H AM)</div><div id="lose" class="text-2xl font-bold down">0</div></div>
            </div>
        </div>

        <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 md:col-span-4 card p-4 space-y-4">
                <div class="grid grid-cols-2 gap-2">
                    <div><label class="text-[10px]">MAX SLOT</label><input type="number" id="maxPositions" class="w-full" value="3"></div>
                    <div><label class="text-[10px]">MIN VOL %</label><input type="number" id="minVol" class="w-full" value="5.0"></div>
                    <div><label class="text-[10px]">VỐN LỆNH</label><input type="number" id="invValue" class="w-full" value="1.5"></div>
                    <div><label class="text-[10px]">TYPE</label><select id="invType" class="w-full bg-black border border-zinc-800 p-1 rounded"><option value="percent">% ACC</option><option value="fixed">$ USD</option></select></div>
                </div>
                <button id="btn" onclick="save()" class="w-full p-3 rounded font-bold uppercase transition-all"></button>
            </div>

            <div class="col-span-12 md:col-span-8 card overflow-hidden">
                <div class="p-2 bg-zinc-900 text-[10px] font-bold">VỊ THẾ ĐANG MỞ</div>
                <table class="w-full text-left text-xs">
                    <thead class="bg-black/50"><tr><th class="p-2">SYMBOL</th><th class="p-2">SIDE</th><th class="p-2">ENTRY</th><th class="p-2 text-right">PNL($)</th></tr></thead>
                    <tbody id="posBody"></tbody>
                </table>
            </div>

            <div class="col-span-12 card overflow-hidden">
                <div class="p-2 bg-zinc-900 text-[10px] font-bold">NHẬT KÝ TÍN HIỆU (WIN/LOSE TARGET 5%)</div>
                <table class="w-full text-left text-[11px]">
                    <thead class="bg-black/50"><tr><th class="p-2">TIME</th><th class="p-2">SYMBOL</th><th class="p-2">VOL</th><th class="p-2">TYPE</th><th class="p-2 text-right">STATUS</th></tr></thead>
                    <tbody id="histBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('win').innerText = d.stats.win;
            document.getElementById('lose').innerText = d.stats.lose;
            
            const btn = document.getElementById('btn');
            btn.innerText = d.botSettings.isRunning ? "HẠ BUỒM (STOP)" : "GIƯƠNG BUỒM (START)";
            btn.className = d.botSettings.isRunning ? "w-full p-3 rounded font-bold bg-red-600/20 text-red-500 border border-red-600" : "w-full p-3 rounded font-bold bg-green-600/20 text-green-500 border border-green-600";

            document.getElementById('posBody').innerHTML = d.activePositions.map(p => \`
                <tr class="border-b border-zinc-900/50">
                    <td class="p-2 font-bold">\${p.symbol}</td>
                    <td class="p-2 \${p.side==='LONG'?'up':'down'} font-bold">\${p.side}</td>
                    <td class="p-2 text-gray-400">\${p.entry}</td>
                    <td class="p-2 text-right font-bold \${p.pnl>=0?'up':'down'}">\${p.pnl}</td>
                </tr>\`).join('');

            document.getElementById('histBody').innerHTML = d.history.map(h => \`
                <tr class="border-b border-zinc-800">
                    <td class="p-2 text-gray-500">\${new Date(h.startTime).toLocaleTimeString()}</td>
                    <td class="p-2 font-bold \${h.type==='UP'?'up':'down'}">\${h.symbol}</td>
                    <td class="p-2">\${h.max1}%</td>
                    <td class="p-2">\${h.type}</td>
                    <td class="p-2 text-right font-bold \${h.status==='WIN'?'up':(h.status==='LOSE'?'down':'')}">\${h.status}</td>
                </tr>\`).join('');
        }

        async function save() {
            const r = await fetch('/api/status'); const d = await r.json();
            const body = {
                isRunning: !d.botSettings.isRunning,
                maxPositions: parseInt(document.getElementById('maxPositions').value),
                minVol: parseFloat(document.getElementById('minVol').value),
                invValue: parseFloat(document.getElementById('invValue').value),
                invType: document.getElementById('invType').value
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            update();
        }
        setInterval(update, 1000); update();
    </script></body></html>`);
});

// --- KHỞI TẠO ---
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
                console.log("✅ [READY] Dữ liệu sàn OK.");
            } catch (e) { console.log("❌ [ERR] ExchangeInfo fail"); }
        });
    });
}

if (fs.existsSync(HISTORY_FILE)) {
    try { historyMap = new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE)))); } catch(e){}
}

init(); initWS();
setInterval(hunt, 1500); // Quét lệnh mỗi 1.5s
setInterval(() => {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(historyMap)));
    // Tự dọn dẹp danh sách quản lý dựa trên thực tế sàn (Mỗi phút reset slot)
    callBinance('/fapi/v2/positionRisk').then(pos => {
        botManagedSymbols = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);
    }).catch(()=>{});
}, 60000);

app.listen(PORT, '0.0.0.0', () => console.log(`🚢 Luffy Port ${PORT}`));
