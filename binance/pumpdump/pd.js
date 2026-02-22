import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import WebSocket from 'ws';
import { API_KEY, SECRET_KEY } from './config.js';

// --- PHẦN 1: TOÀN BỘ BIẾN TRẠNG THÁI (GỘP TỪ 3 FILE) ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0, 
    accountSL: 30 
};

let status = { 
    currentBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [], 
    history: [], 
    stats: { win: 0, lose: 0 } 
};

let botManagedSymbols = []; 
let coinData = {}; 
let historyMap = new Map(); 
let cooldownMap = new Map(); // Logic chặn 15p mới thêm
let isInitializing = true;
let isProcessing = false;

// --- PHẦN 2: HÀM LOG CHI TIẾT 100% CỦA BẠN ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const entry = { time, msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 200) status.botLogs.pop();

    const colors = {
        success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m',
        info: '\x1b[36m', debug: '\x1b[90m'
    };
    const c = colors[type] || colors.info;
    console.log(`${c}[${time}] [${type.toUpperCase()}] ${msg}\x1b[0m`);
}

// --- PHẦN 3: BINANCE API CALL (GIỮ NGUYÊN) ---
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
                } catch (e) { reject({ msg: "LỖI_JSON", detail: d }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- PHẦN 4: LOGIC TÍNH BIẾN ĐỘNG (GỘP TỪ SERVER TÍN HIỆU) ---
function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    if (!startPriceObj) return 0;
    return parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2));
}

// --- PHẦN 5: WEBSOCKET & TÍN HIỆU (GỘP CHUNG VÀO 1 LUỒNG) ---
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

            // Tính 3 khung giờ
            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
        });

        // Cập nhật candidatesList dựa trên bất kỳ khung nào đạt minVol
        status.candidatesList = Object.values(coinData)
            .filter(v => v.live && (Math.abs(v.live.c1) >= botSettings.minVol || Math.abs(v.live.c5) >= botSettings.minVol || Math.abs(v.live.c15) >= botSettings.minVol))
            .map(v => {
                const changes = [v.live.c1, v.live.c5, v.live.c15];
                const bestChange = changes.sort((a,b) => Math.abs(b) - Math.abs(a))[0];
                return { symbol: v.symbol, changePercent: bestChange };
            })
            .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// --- PHẦN 6: LOGIC DỌN DẸP & COOLDOWN (GIỮ NGUYÊN) ---
async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🧹 [DỌN DẸP] ${symbol} đã đóng. Chặn 15p bắt đầu.`, "info");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
                
                cooldownMap.set(symbol, Date.now() + 15 * 60 * 1000); // Lưu mốc 15p
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) { addBotLog(`⚠️ Lỗi dọn dẹp: ${e.msg}`, "error"); }
}

// --- PHẦN 7: TÍNH TOÁN TP/SL CHI TIẾT CỦA BẠN (GIỮ NGUYÊN) ---
function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
    const rate = m / lev;
    const tp = side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate);
    const sl = side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate);
    return { tp, sl };
}

async function enforceTPSL() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');

        for (const symbol of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;

            const side = p.positionSide;
            const entry = parseFloat(p.entryPrice);
            if (entry <= 0) continue;

            const hasTP = orders.some(o => o.symbol === symbol && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === symbol && o.type === 'STOP_MARKET');

            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[symbol];
                const plan = calcTPSL(parseFloat(p.leverage), side, entry);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                        stopPrice: plan.tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    });
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    });
                }
                addBotLog(`🎯 [TP/SL] Đã cài đặt cho ${symbol}`, "success");
            }
        }
    } catch (e) {}
}

// --- PHẦN 8: HÀM SĂN LỆNH (GỘP LOGIC CHẶN 15P + DỌN LỆNH CŨ) ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) return;

        for (const c of status.candidatesList) {
            // Kiểm tra cooldown 15p
            if (cooldownMap.has(c.symbol) && Date.now() < cooldownMap.get(c.symbol)) continue;
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            try {
                addBotLog(`🎯 [CHẤP NHẬN] ${c.symbol} đạt ${c.changePercent}%. Đang vào lệnh...`, "info");

                // Dọn lệnh TP/SL cũ nếu có (Tránh lỗi Margin)
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: c.symbol }).catch(() => {});

                // Set Leverage
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                // Tài chính
                const acc = await callBinance('/fapi/v2/account');
                status.currentBalance = parseFloat(acc.totalMarginBalance);
                const info = status.exchangeInfo[c.symbol];
                const side = c.changePercent > 0 ? 'LONG' : 'SHORT';

                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                if ((margin * lev) < 5.1) margin = 5.2 / lev;

                let qty = (Math.floor(((margin * lev) / coinData[c.symbol].live.currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL',
                    positionSide: side, type: 'MARKET', quantity: qty
                });

                botManagedSymbols.push(c.symbol);
                addBotLog(`🚀 [THÀNH CÔNG] Đã mở ${c.symbol}`, "success");
                
                // Đợi khớp rồi cài TP/SL
                setTimeout(enforceTPSL, 3000);

            } catch (err) { addBotLog(`❌ Thất bại ${c.symbol}: ${JSON.stringify(err)}`, "error"); }
        }
    } finally { isProcessing = false; }
}

// --- PHẦN 9: EXPRESS SERVER + TOÀN BỘ GIAO DIỆN LUFFY ---
const APP = express();
APP.use(express.json());

APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice), amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    res.json({ status: "ok" }); 
});

// ROUTE GIAO DIỆN LUFFY (GIỮ NGUYÊN 100% HTML CỦA BẠN)
APP.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8"><title>MONCEY D. LUFFY BOT</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Bangers&display=swap');
            body { background: #0a0a0c; color: #eee; font-family: sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
            .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
            .card { background: rgba(15, 15, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
            .glow-text { text-shadow: 0 0 15px rgba(255, 77, 77, 0.7); }
            .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); }
            .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); animation: pulse 2s infinite; }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
            ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: #ff4d4d; border-radius: 10px; }
        </style>
    </head>
    <body class="p-4">
        <header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-500">
            <div class="flex items-center gap-4">
                <h1 class="luffy-font text-4xl text-white glow-text uppercase">Moncey D. Luffy</h1>
                <span id="botStatusText" class="text-[10px] p-1 bg-gray-800 rounded">OFFLINE</span>
            </div>
            <div class="flex gap-8 bg-black/50 p-3 rounded-2xl border border-white/5">
                <div class="text-center"><p class="text-[10px] text-gray-500 font-bold">KHO BÁU USDT</p><p id="balance" class="text-2xl font-black text-yellow-400">$0.00</p></div>
                <div class="text-center"><p class="text-[10px] text-gray-500 font-bold">LỆNH SỐNG</p><p id="posCount" class="text-2xl font-black text-green-400">0</p></div>
            </div>
        </header>

        <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <div class="card p-3">
                <label class="text-[10px] text-gray-500 font-bold uppercase">Vốn Lệnh</label>
                <div class="flex gap-1"><input type="number" id="invValue" class="w-full bg-black/40 p-1 text-xs" value="1.5">
                <select id="invType" class="bg-black text-yellow-500 text-[10px]"><option value="fixed">$</option><option value="percent">%</option></select></div>
            </div>
            <div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Lọc Sóng %</label><input type="number" id="minVol" class="w-full bg-black/40 p-1 text-xs" value="5.0"></div>
            <div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Số Lệnh Max</label><input type="number" id="maxPositions" class="w-full bg-black/40 p-1 text-xs" value="3"></div>
            <button id="runBtn" onclick="handleToggle()" class="btn-start rounded-xl font-black text-sm">🚢 GIƯƠNG BUỒM</button>
            <button onclick="handleUpdate()" class="bg-white/5 border border-white/10 rounded-xl text-[10px]">CẬP NHẬT</button>
        </div>

        <div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-4 overflow-hidden">
            <div class="md:col-span-4 card flex flex-col overflow-hidden border-t-4 border-blue-500">
                <div id="botLogs" class="flex-grow overflow-y-auto p-3 text-[10px] space-y-1"></div>
            </div>
            <div class="md:col-span-8 card flex flex-col overflow-hidden border-t-4 border-red-500">
                <table class="w-full text-left text-[11px]">
                    <thead class="bg-black/80 sticky top-0 text-gray-500 uppercase">
                        <tr><th class="p-3">Cặp Tiền</th><th class="p-3">Side/Lev</th><th class="p-3">Entry/Mark</th><th class="p-3 text-right">PnL %</th></tr>
                    </thead>
                    <tbody id="positionTable"></tbody>
                </table>
            </div>
        </div>

        <script>
            let isRunning = false;
            async function sync() {
                try {
                    const res = await fetch('/api/status');
                    const d = await res.json();
                    if(d.botSettings.isRunning !== isRunning) {
                        isRunning = d.botSettings.isRunning;
                        const btn = document.getElementById('runBtn');
                        btn.innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
                        btn.className = isRunning ? "btn-stop rounded-xl font-black text-sm" : "btn-start rounded-xl font-black text-sm";
                        document.getElementById('botStatusText').innerText = isRunning ? "ĐANG TUẦN TRA" : "OFFLINE";
                    }
                    document.getElementById('balance').innerText = "$" + d.status.currentBalance.toFixed(2);
                    document.getElementById('posCount').innerText = d.activePositions.length;
                    document.getElementById('botLogs').innerHTML = d.status.botLogs.map(l => \`<div><span class="text-gray-500">[\${l.time}]</span> \${l.msg}</div>\`).join('');
                    document.getElementById('positionTable').innerHTML = d.activePositions.map(p => \`
                        <tr class="border-b border-white/5">
                            <td class="p-3 font-bold text-white">\${p.symbol}</td>
                            <td class="p-3 \${p.side === 'LONG'?'text-green-400':'text-red-400'} font-black italic">\${p.side} \${p.leverage}x</td>
                            <td class="p-3 text-gray-500">$\${p.entryPrice}<br>$\${p.markPrice}</td>
                            <td class="p-3 text-right font-black \${p.pnlPercent >= 0 ? 'text-green-400':'text-red-400'}">\${p.pnlPercent}%</td>
                        </tr>\`).join('');
                } catch(e){}
            }
            async function handleToggle() { isRunning = !isRunning; await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning }) }); sync(); }
            async function handleUpdate() {
                const body = {
                    invValue: parseFloat(document.getElementById('invValue').value),
                    invType: document.getElementById('invType').value,
                    minVol: parseFloat(document.getElementById('minVol').value),
                    maxPositions: parseInt(document.getElementById('maxPositions').value)
                };
                await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            }
            setInterval(sync, 2000);
        </script>
    </body>
    </html>
    `);
});

// --- PHẦN 10: KHỞI TẠO HỆ THỐNG ---
async function start() {
    addBotLog("🔧 [KHỞI TẠO] Đang nạp dữ liệu sàn...", "info");
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            const info = JSON.parse(d);
            info.symbols.forEach(s => {
                const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
            });
            isInitializing = false;
            initWS();
            addBotLog("✅ [HỆ THỐNG] Pirate Engine v4.2 - Gộp toàn diện - Port 9001", "success");
        });
    });
}

// Chạy vòng lặp
start();
setInterval(hunt, 2000);
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 10000);

APP.listen(9001, '0.0.0.0');
