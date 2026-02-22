import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
const PORT = 9001;
const HISTORY_FILE = './history_db.json';

// --- CẤU HÌNH XƯƠNG TỦY ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
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

// --- LOGIC THỜI GIAN CHUẨN UTC+7 (7H SÁNG) ---
function getPivotTime() {
    const now = new Date();
    const pivot = new Date(now);
    pivot.setHours(7, 0, 0, 0);
    if (now < pivot) pivot.setDate(pivot.getDate() - 1);
    return pivot.getTime();
}

// --- HÀM GỌI API BINANCE CHI TIẾT ---
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

// --- 1. TỰ ĐỘNG CÀI TP/SL (KHÔNG GẶM XƯƠNG) ---
async function enforceTPSL() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');

        for (const symbol of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;

            const side = p.positionSide;
            const entry = parseFloat(p.entryPrice);
            if (entry <= 0) continue;

            const hasTP = orders.some(o => o.symbol === symbol && o.positionSide === side && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === symbol && o.positionSide === side && o.type === 'STOP_MARKET');

            if (!hasTP || !hasSL) {
                const info = exchangeInfo[symbol];
                const lev = parseFloat(p.leverage);
                const rate = (lev < 26 ? 1.2 : 2.5) / lev; // Tỷ lệ chốt lời tùy biến theo đòn bẩy
                
                const tp = side === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
                const sl = side === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                        stopPrice: tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    }).catch(() => {});
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    }).catch(() => {});
                }
            }
        }
    } catch (e) {}
}

// --- 2. DỌN DẸP SLOT (GIỮ BOT KHÔNG TREO) ---
async function cleanup() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);
        
        // Cập nhật botManagedSymbols theo thực tế sàn
        botManagedSymbols = botManagedSymbols.filter(s => activeOnExchange.includes(s));
    } catch (e) {}
}

// --- 3. CORE: WEBSOCKET TÍN HIỆU (NHẠY LIÊN TỤC) ---
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

            const calc = (m) => {
                const start = coinData[s].prices.find(x => x.t >= (now - m * 60 * 1000));
                return start ? ((p - start.p) / start.p * 100).toFixed(2) : 0;
            };
            coinData[s].live = { c1: calc(1), c5: calc(5), price: p };

            // Logic tính Win/Lose lịch sử
            let h = historyMap.get(s);
            if (h && h.status === 'PENDING') {
                const diff = ((p - h.snapPrice) / h.snapPrice) * 100;
                if ((h.type === 'UP' && diff >= 3) || (h.type === 'DOWN' && diff <= -3)) h.status = 'WIN';
                else if ((h.type === 'UP' && diff <= -3) || (h.type === 'DOWN' && diff >= 3)) h.status = 'LOSE';
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 2000));
}

// --- 4. HÀM SĂN LỆNH (HUNT) ---
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
            
            const acc = await callBinance('/fapi/v2/account');
            const balance = parseFloat(acc.totalMarginBalance);
            const info = exchangeInfo[c.symbol];

            // Set Leverage tự động theo sàn cho phép
            const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
            const lev = brackets[0].brackets[0].initialLeverage;
            await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

            let margin = botSettings.invType === 'percent' ? (balance * botSettings.invValue) / 100 : botSettings.invValue;
            let qty = (margin * lev) / c.live.price;
            let finalQty = (Math.floor(qty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            await callBinance('/fapi/v1/order', 'POST', {
                symbol: c.symbol, side: side, positionSide: posSide, type: 'MARKET', quantity: finalQty
            });

            botManagedSymbols.push(c.symbol);
            historyMap.set(c.symbol, {
                symbol: c.symbol, startTime: Date.now(), snapPrice: c.live.price,
                max1: c.live.c1, type: posSide === 'LONG' ? 'UP' : 'DOWN', status: 'PENDING'
            });
            console.log(`🚀 VÀO LỆNH: ${c.symbol} (${posSide})`);
        } catch (e) { console.log(`❌ Lỗi vào lệnh ${c.symbol}: ${JSON.stringify(e)}`); }
    }
}

// --- 5. EXPRESS API & GIAO DIỆN PIRATE FULL ---
app.use(express.json());
app.get('/api/status', async (req, res) => {
    try {
        const pivot = getPivotTime();
        const historyArr = Array.from(historyMap.values());
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol, side: p.positionSide, entry: p.entryPrice, mark: p.markPrice, pnl: parseFloat(p.unrealizedProfit).toFixed(2)
        }));
        res.json({
            botSettings, activePositions: active,
            history: historyArr.sort((a,b) => b.startTime - a.startTime).slice(0, 15),
            stats: {
                win: historyArr.filter(h => h.startTime >= pivot && h.status === 'WIN').length,
                lose: historyArr.filter(h => h.startTime >= pivot && h.status === 'LOSE').length
            }
        });
    } catch (e) { res.status(500).send(); }
});

app.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({status:"ok"}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Bangers&display=swap" rel="stylesheet"><style>body{background:#050505;color:#eee;font-family:monospace}.luffy{font-family:'Bangers',cursive}.up{color:#22c55e}.down{color:#ef4444}input,select{background:#111;border:1px solid #333;color:#fff;padding:4px;width:100%}</style></head><body class="p-4">
    <div class="max-w-6xl mx-auto space-y-4">
        <div class="flex justify-between items-center bg-[#111] p-4 border-b-2 border-red-600 rounded shadow-lg shadow-red-900/20">
            <h1 class="luffy text-4xl italic text-white uppercase tracking-wider">Luffy Pirate Bot v5</h1>
            <div class="flex gap-10">
                <div class="text-center"><p class="text-[10px] text-gray-500">WIN (7AM-7AM)</p><p id="win" class="text-3xl font-bold up">0</p></div>
                <div class="text-center"><p class="text-[10px] text-gray-500">LOSE (7AM-7AM)</p><p id="lose" class="text-3xl font-bold down">0</p></div>
            </div>
        </div>
        <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 md:col-span-3 bg-[#111] p-4 rounded space-y-4 border border-zinc-800">
                <h2 class="text-xs font-bold text-red-500 uppercase italic">Thuyền trưởng cài đặt</h2>
                <div><label class="text-[10px]">MAX LỆNH</label><input type="number" id="maxPositions" value="3"></div>
                <div><label class="text-[10px]">MIN VOL %</label><input type="number" id="minVol" value="5.0"></div>
                <div><label class="text-[10px]">VỐN VÀO</label><input type="number" id="invValue" value="1.5"></div>
                <div><label class="text-[10px]">KIỂU VỐN</label><select id="invType"><option value="percent">% Ví</option><option value="fixed">$ USD</option></select></div>
                <button id="btn" onclick="save()" class="w-full p-4 font-bold uppercase rounded transition-all shadow-lg"></button>
            </div>
            <div class="col-span-12 md:col-span-9 bg-[#111] rounded overflow-hidden border border-zinc-800">
                <div class="p-2 bg-zinc-900 text-[10px] font-bold italic tracking-widest text-blue-400">ĐANG RA KHƠI (POSITIONS)</div>
                <table class="w-full text-left text-xs"><thead class="bg-black/80"><tr><th class="p-3">MÃ</th><th class="p-3">SIDE</th><th class="p-3">ENTRY</th><th class="p-3 text-right">PNL ($)</th></tr></thead><tbody id="posBody"></tbody></table>
            </div>
            <div class="col-span-12 bg-[#111] rounded overflow-hidden border border-zinc-800">
                <div class="p-2 bg-zinc-900 text-[10px] font-bold italic tracking-widest text-yellow-500">NHẬT KÝ TÍN HIỆU (HISTORY)</div>
                <table class="w-full text-left text-[11px]"><thead class="bg-black/80"><tr><th class="p-2">GIỜ</th><th class="p-2">MÃ</th><th class="p-2">BIẾN ĐỘNG</th><th class="p-2">TYPE</th><th class="p-2 text-right">KẾT QUẢ</th></tr></thead><tbody id="histBody"></tbody></table>
            </div>
        </div>
    </div>
    <script>
        async function update(){
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('win').innerText = d.stats.win;
                document.getElementById('lose').innerText = d.stats.lose;
                const btn = document.getElementById('btn');
                btn.innerText = d.botSettings.isRunning ? "Hạ Buồm (STOP)" : "Giương Buồm (START)";
                btn.style.background = d.botSettings.isRunning ? "#7f1d1d" : "#14532d";
                btn.style.color = d.botSettings.isRunning ? "#f87171" : "#4ade80";
                document.getElementById('posBody').innerHTML = d.activePositions.map(p=>\`<tr class="border-b border-zinc-900">
                    <td class="p-3 font-bold text-white">\${p.symbol}</td>
                    <td class="p-3 \${p.side==='LONG'?'up':'down'} font-black italic">\${p.side}</td>
                    <td class="p-3 text-gray-400">\${p.entry}</td>
                    <td class="p-3 text-right font-bold \${p.pnl>=0?'up':'down'}">\${p.pnl}</td>
                </tr>\`).join('');
                document.getElementById('histBody').innerHTML = d.history.map(h=>\`<tr class="border-b border-zinc-900/50">
                    <td class="p-2 text-gray-500">\${new Date(h.startTime).toLocaleTimeString()}</td>
                    <td class="p-2 font-bold \${h.type==='UP'?'up':'down'}">\${h.symbol}</td>
                    <td class="p-2">\${h.max1}%</td>
                    <td class="p-2 text-[10px]">\${h.type}</td>
                    <td class="p-2 text-right font-bold \${h.status==='WIN'?'up':(h.status==='LOSE'?'down':'text-gray-600')}">\${h.status}</td>
                </tr>\`).join('');
            } catch(e) {}
        }
        async function save(){
            const body = { 
                isRunning: !document.getElementById('btn').innerText.includes('STOP'), 
                maxPositions: parseInt(document.getElementById('maxPositions').value), 
                minVol: parseFloat(document.getElementById('minVol').value), 
                invValue: parseFloat(document.getElementById('invValue').value), 
                invType: document.getElementById('invType').value 
            };
            await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            update();
        }
        setInterval(update, 1000); update();
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
                    exchangeInfo[s.symbol] = { 
                        quantityPrecision: s.quantityPrecision, 
                        pricePrecision: s.pricePrecision, 
                        stepSize: parseFloat(lot.stepSize) 
                    };
                });
                isInitializing = false;
                console.log("✅ HỆ THỐNG SẴN SÀNG. TRUY CẬP PORT 9001");
            } catch (e) { console.log("❌ Lỗi ExchangeInfo"); }
        });
    });
}

if (fs.existsSync(HISTORY_FILE)) {
    try { historyMap = new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE)))); } catch(e){}
}

init(); 
initWS();
setInterval(hunt, 2000); 
setInterval(enforceTPSL, 5000); 
setInterval(cleanup, 10000); 
setInterval(() => { fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(historyMap))); }, 60000);

app.listen(PORT, '0.0.0.0');
