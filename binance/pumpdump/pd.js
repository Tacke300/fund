import https from 'https';
import crypto from 'crypto';
import express from 'express';
import WebSocket from 'ws';
import { API_KEY, SECRET_KEY } from './config.js';

// --- CẤU HÌNH HỆ THỐNG ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0, 
    accountSL: 30 
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let cooldownMap = new Map(); 
let coinData = {};
let isInitializing = true;
let isProcessing = false;

// --- HÀM LOG ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

// --- BINANCE API ---
async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
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

// --- LOGIC TÍNH BIẾN ĐỘNG ---
function getChange(priceArray, mins) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const start = priceArray.find(i => i.t >= (now - mins * 60000));
    if (!start) return 0;
    return parseFloat(((priceArray[priceArray.length - 1].p - start.p) / start.p * 100).toFixed(2));
}

// --- WEBSOCKET TÍN HIỆU ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 150) coinData[s].prices.shift();
            
            const c1 = getChange(coinData[s].prices, 1);
            const c5 = getChange(coinData[s].prices, 5);
            const c15 = getChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, p };
        });

        status.candidatesList = Object.values(coinData)
            .filter(v => v.live && (Math.abs(v.live.c1) >= botSettings.minVol || Math.abs(v.live.c5) >= botSettings.minVol || Math.abs(v.live.c15) >= botSettings.minVol))
            .map(v => {
                const maxV = [v.live.c1, v.live.c5, v.live.c15].sort((a,b) => Math.abs(b) - Math.abs(a))[0];
                return { symbol: v.symbol, changePercent: maxV };
            }).sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    });
    ws.on('close', () => setTimeout(initWS, 2000));
}

// --- QUẢN LÝ LỆNH ---
async function cleanup() {
    if (!botSettings.isRunning) return;
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const s = botManagedSymbols[i];
            const p = pos.find(x => x.symbol === s);
            if (!p || parseFloat(p.positionAmt) === 0) {
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: s }).catch(()=>{});
                cooldownMap.set(s, Date.now() + 900000); // 15p chặn
                botManagedSymbols.splice(i, 1);
                addBotLog(`🧹 Đã đóng ${s}, chặn 15p.`, "info");
            }
        }
    } catch (e) {}
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    if (botManagedSymbols.length >= botSettings.maxPositions) return;
    isProcessing = true;
    try {
        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (cooldownMap.has(c.symbol) && Date.now() < cooldownMap.get(c.symbol)) continue;
            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            addBotLog(`🚀 Vào lệnh ${c.symbol} (${c.changePercent}%)`, "success");
            await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: c.symbol }).catch(()=>{});
            
            const brackets = await callBinance('/fapi/v1/leverageBracket', { symbol: c.symbol });
            const lev = brackets[0].brackets[0].initialLeverage;
            await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

            const acc = await callBinance('/fapi/v2/account');
            status.currentBalance = parseFloat(acc.totalMarginBalance);
            const info = status.exchangeInfo[c.symbol];
            const side = c.changePercent > 0 ? 'BUY' : 'SELL';
            const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            if ((margin * lev) < 5.1) margin = 5.2 / lev;
            let qty = (Math.floor(((margin * lev) / coinData[c.symbol].live.p) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            await callBinance('/fapi/v1/order', 'POST', { symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });
            botManagedSymbols.push(c.symbol);
            setTimeout(enforceTPSL, 2000);
        }
    } catch (e) { addBotLog("Lỗi Hunt: " + e.msg, "error"); }
    isProcessing = false;
}

async function enforceTPSL() {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');
        for (const s of botManagedSymbols) {
            const p = pos.find(x => x.symbol === s && parseFloat(x.positionAmt) !== 0);
            if (!p) continue;
            const hasTP = orders.some(o => o.symbol === s && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === s && o.type === 'STOP_MARKET');
            if (!hasTP || !hasSL) {
                const entry = parseFloat(p.entryPrice);
                const lev = parseFloat(p.leverage);
                let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
                const rate = m / lev;
                const tp = p.positionSide === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
                const sl = p.positionSide === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
                const closeSide = p.positionSide === 'LONG' ? 'SELL' : 'BUY';
                const prec = status.exchangeInfo[s].pricePrecision;
                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol: s, side: closeSide, positionSide: p.positionSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(prec), closePosition: 'true', workingType: 'MARK_PRICE' });
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol: s, side: closeSide, positionSide: p.positionSide, type: 'STOP_MARKET', stopPrice: sl.toFixed(prec), closePosition: 'true', workingType: 'MARK_PRICE' });
            }
        }
    } catch (e) {}
}

// --- EXPRESS SERVER + HTML ---
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
    } catch (e) { res.status(500).json({error: true}); }
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ok: true}); });

// NHÚNG TOÀN BỘ HTML VÀO ĐÂY
APP.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8"><title>MONCEY D. LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&display=swap');
        body { background: #0a0a0c; color: #eee; font-family: sans-serif; }
        .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
        .card { background: rgba(15, 15, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; }
        .btn-start { background: linear-gradient(135deg, #22c55e, #15803d); }
        .btn-stop { background: linear-gradient(135deg, #ef4444, #b91c1c); }
    </style>
</head>
<body class="p-4">
    <header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <h1 class="luffy-font text-4xl text-white uppercase">Moncey D. Luffy</h1>
            <span id="botStatusText" class="text-xs font-bold px-2 py-1 rounded bg-gray-800">OFFLINE</span>
        </div>
        <div class="flex gap-6">
            <div class="text-right"><p class="text-[10px] text-gray-500">USDT</p><p id="balance" class="text-2xl font-bold text-yellow-400">$0.00</p></div>
        </div>
    </header>

    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <div class="card p-3"><label class="text-[10px] text-gray-500">Vốn Lệnh</label>
            <input type="number" id="invValue" class="w-full bg-black/40 p-1 text-white" value="1.5">
            <select id="invType" class="w-full bg-black text-yellow-500 text-xs"><option value="fixed">$</option><option value="percent">%</option></select>
        </div>
        <div class="card p-3"><label class="text-[10px] text-gray-500">Lọc Sóng %</label><input type="number" id="minVol" class="w-full bg-black/40 p-1 text-white" value="5.0"></div>
        <div class="card p-3"><label class="text-[10px] text-gray-500">Max Slot</label><input type="number" id="maxPositions" class="w-full bg-black/40 p-1 text-white" value="3"></div>
        <button id="runBtn" onclick="handleToggle()" class="btn-start rounded-xl font-bold">GIƯƠNG BUỒM</button>
        <button onclick="handleUpdate()" class="bg-gray-700 rounded-xl text-xs">CẬP NHẬT</button>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-12 gap-4">
        <div class="md:col-span-4 card h-[400px] flex flex-col">
            <div class="p-2 border-b border-white/10 text-xs text-blue-400">LOGS</div>
            <div id="botLogs" class="p-2 overflow-y-auto text-[10px] mono space-y-1"></div>
        </div>
        <div class="md:col-span-8 card h-[400px] overflow-y-auto">
            <table class="w-full text-left text-xs">
                <thead class="bg-black text-gray-500"><tr><th class="p-3">Coin</th><th class="p-3">Side</th><th class="p-3">Entry/Mark</th><th class="p-3 text-right">PnL%</th></tr></thead>
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
                isRunning = d.botSettings.isRunning;
                document.getElementById('runBtn').innerText = isRunning ? "🛑 HẠ BUỒM" : "🚢 GIƯƠNG BUỒM";
                document.getElementById('runBtn').className = isRunning ? "btn-stop rounded-xl font-bold" : "btn-start rounded-xl font-bold";
                document.getElementById('balance').innerText = "$" + d.status.currentBalance.toFixed(2);
                document.getElementById('botStatusText').innerText = isRunning ? "RUNNING" : "OFFLINE";
                document.getElementById('botLogs').innerHTML = d.status.botLogs.map(l => \`<div>[\${l.time}] \${l.msg}</div>\`).join('');
                document.getElementById('positionTable').innerHTML = d.activePositions.map(p => \`
                    <tr class="border-b border-white/5">
                        <td class="p-3 font-bold">\${p.symbol}</td>
                        <td class="p-3 \${p.side === 'LONG' ? 'text-green-400':'text-red-400'}">\${p.side} \${p.leverage}x</td>
                        <td class="p-3 text-gray-400">\${p.entryPrice}<br>\${p.markPrice}</td>
                        <td class="p-3 text-right font-bold \${p.pnlPercent >= 0 ? 'text-green-400':'text-red-400'}">\${p.pnlPercent}%</td>
                    </tr>\`).join('');
            } catch(e) {}
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

// --- INIT ---
async function start() {
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
            addBotLog("Hệ thống Pirate sẵn sàng!", "success");
        });
    });
}

start();
setInterval(hunt, 2000);
setInterval(cleanup, 5000);
setInterval(enforceTPSL, 10000);
APP.listen(9001, '0.0.0.0');
