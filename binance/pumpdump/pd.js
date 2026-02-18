import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, 'trade_history.json');

// --- CẤU HÌNH HỆ THỐNG ---
let botSettings = {
    isRunning: false,
    maxPositions: 5,
    invValue: 1.5,
    invType: 'fixed', 
    minVol: 5.0,
    accountSLValue: 30,
    accountSLType: 'percent', 
    isProtectProfit: true,
    openInterval: 30000 
};

let status = {
    initialBalance: 0,
    highestBalance: 0,
    currentBalance: 0,
    lastOpenTimestamp: 0,
    exchangeInfo: null,
    blacklist: new Set()
};

// --- HÀM CORE: BINANCE API CHUẨN ---
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    let queryString = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${queryString}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const options = { method, headers: { 'X-MBX-APIKEY': API_KEY } };
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                    else reject(json);
                } catch (e) { reject({ msg: "JSON Parse Error", raw: data }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- LẤY THÔNG SỐ SÀN (PRECISION) ---
async function refreshExchangeInfo() {
    try {
        const res = await new Promise((resolve) => {
            https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
                let d = ''; r.on('data', c => d += c);
                r.on('end', () => resolve(JSON.parse(d)));
            });
        });
        status.exchangeInfo = {};
        res.symbols.forEach(s => {
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = {
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: parseFloat(priceFilter.tickSize),
                stepSize: parseFloat(lotFilter.stepSize)
            };
        });
        console.log("⚓ Đã cập nhật thông số các cặp tiền từ Binance.");
    } catch (e) { console.error("Lỗi ExchangeInfo:", e); }
}

// --- LOGIC VÀO LỆNH PUMP/DUMP ---
async function openPumpDumpOrder(coin) {
    try {
        const symbol = coin.symbol;
        const info = status.exchangeInfo[symbol];
        if (!info) return;

        const posSide = coin.changePercent > 0 ? 'LONG' : 'SHORT';
        const side = posSide === 'LONG' ? 'BUY' : 'SELL';

        const ticker = await new Promise(res => {
            https.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, r => {
                let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
            });
        });
        const price = parseFloat(ticker.price);

        // Đòn bẩy
        let leverage = 20;
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });

        // Tính số lượng (Quantity)
        let investUSD = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
        let qty = (investUSD * leverage) / price;
        qty = Math.floor(qty / info.stepSize) * info.stepSize;
        const finalQty = qty.toFixed(info.quantityPrecision);

        if (parseFloat(finalQty) <= 0) return console.log(`Số dư không đủ vào lệnh ${symbol}`);

        // Vào lệnh Market
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty
        });

        // Thiết lập TP 100% Margin, SL 50% Margin
        const priceMove = (price * 1.0) / leverage; 
        const tpPrice = (posSide === 'LONG' ? price + priceMove : price - priceMove);
        const slPrice = (posSide === 'LONG' ? price - (priceMove/2) : price + (priceMove/2));

        const batch = [
            { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: (Math.round(tpPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision), closePosition: 'true' },
            { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', stopPrice: (Math.round(slPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision), closePosition: 'true' }
        ];
        
        await callSignedAPI('/fapi/v1/batchOrders', 'POST', { batchOrders: JSON.stringify(batch) });

        status.lastOpenTimestamp = Date.now();
        console.log(`🚀 Đã vào lệnh: ${symbol} | ${posSide} | Vol: ${coin.changePercent}%`);
        saveLog(symbol, posSide, investUSD, coin.changePercent);
    } catch (e) {
        console.error(`Lỗi vào lệnh ${coin.symbol}:`, e);
        status.blacklist.add(coin.symbol);
    }
}

// --- VÒNG LẶP CHÍNH ---
async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        if (status.initialBalance === 0) {
            status.initialBalance = status.currentBalance;
            status.highestBalance = status.currentBalance;
        }

        if (botSettings.isProtectProfit && status.currentBalance > status.highestBalance) {
            status.highestBalance = status.currentBalance;
        }

        // Kiểm tra Stop Loss tài khoản
        let stopThreshold = botSettings.accountSLType === 'fixed' 
            ? status.highestBalance - botSettings.accountSLValue 
            : status.highestBalance * (1 - botSettings.accountSLValue / 100);

        if (status.currentBalance <= stopThreshold) {
            botSettings.isRunning = false;
            return console.error("🛑 DỪNG BOT: Chạm ngưỡng cắt lỗ tài khoản!");
        }

        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

        if (activePos.length >= botSettings.maxPositions) return;
        if (Date.now() - status.lastOpenTimestamp < botSettings.openInterval) return;

        // --- KẾT NỐI LOCALHOST ĐỂ LẤY DATA TỪ SVPD.JS ---
        http.get('http://127.0.0.1:9000/api/live', (res) => {
            let data = ''; res.on('data', d => data += d);
            res.on('end', async () => {
                try {
                    const candidates = JSON.parse(data)
                        .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                        .filter(c => !activePos.some(p => p.symbol === c.symbol))
                        .filter(c => !status.blacklist.has(c.symbol));

                    if (candidates.length > 0) {
                        await openPumpDumpOrder(candidates[0]);
                    }
                } catch (e) { /* Data chưa sẵn sàng */ }
            });
        }).on('error', (e) => console.log("Chưa kết nối được với Bot Server Port 9000..."));

    } catch (e) { console.error("Main Loop Error:", e.message); }
}

function saveLog(symbol, side, capital, change) {
    const log = { symbol, side, capital, change, time: new Date().toLocaleString() };
    let logs = fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)) : [];
    logs.push(log);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(logs.slice(-50), null, 2));
}

// --- WEB SERVER QUẢN LÝ ---
const APP = express();
APP.use(express.json());

// GIAO DIỆN CHÍNH (Sửa lỗi Cannot GET /)
APP.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>LUFFY EXECUTOR</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-950 text-slate-200 font-mono p-4">
        <div class="max-w-md mx-auto">
            <header class="flex justify-between items-center border-b border-red-600 pb-2 mb-4">
                <h1 class="text-xl font-bold text-red-500">PIRATE BOT 9001</h1>
                <div id="statusBadge" class="text-xs px-2 py-1 rounded bg-red-900">OFFLINE</div>
            </header>

            <div class="grid grid-cols-2 gap-2 mb-4">
                <div class="bg-slate-900 p-3 rounded border border-slate-800">
                    <p class="text-[10px] text-slate-500 uppercase">Balance</p>
                    <p id="curBal" class="text-lg font-bold text-green-400">0.00</p>
                </div>
                <div class="bg-slate-900 p-3 rounded border border-slate-800">
                    <p class="text-[10px] text-slate-500 uppercase">Highest</p>
                    <p id="highBal" class="text-lg font-bold text-blue-400">0.00</p>
                </div>
            </div>

            <button onclick="toggleBot()" id="masterBtn" class="w-full py-3 rounded bg-red-600 font-bold mb-4 shadow-lg shadow-red-900/20">START BOT</button>

            <section class="mb-4">
                <h2 class="text-sm font-bold text-yellow-500 mb-2">⦿ POSITIONS</h2>
                <div id="posBox" class="space-y-2"></div>
            </section>

            <section>
                <h2 class="text-sm font-bold text-slate-500 mb-2">⦿ RECENT LOGS</h2>
                <div id="logBox" class="text-[10px] space-y-1 opacity-70"></div>
            </section>
        </div>

        <script>
            async function refresh() {
                try {
                    const r = await fetch('/api/status');
                    const d = await r.json();
                    
                    document.getElementById('curBal').innerText = d.status.currentBalance.toFixed(2) + ' $';
                    document.getElementById('highBal').innerText = d.status.highestBalance.toFixed(2) + ' $';
                    
                    const running = d.botSettings.isRunning;
                    const btn = document.getElementById('masterBtn');
                    const badge = document.getElementById('statusBadge');
                    
                    btn.innerText = running ? "STOP BOT" : "START BOT";
                    btn.className = running ? "w-full py-3 rounded bg-slate-800 font-bold mb-4 border border-red-500" : "w-full py-3 rounded bg-red-600 font-bold mb-4";
                    badge.innerText = running ? "RUNNING" : "STOPPED";
                    badge.className = running ? "text-xs px-2 py-1 rounded bg-green-600" : "text-xs px-2 py-1 rounded bg-red-900";

                    document.getElementById('posBox').innerHTML = d.activePositions.map(p => \`
                        <div class="bg-slate-900 p-2 rounded flex justify-between items-center text-xs border-l-2 \${p.side === 'LONG' ? 'border-green-500' : 'border-red-500'}">
                            <span>\${p.symbol}</span>
                            <span class="\${p.pnlPercent >= 0 ? 'text-green-400' : 'text-red-400'} font-bold">\${p.pnlPercent}%</span>
                        </div>
                    \`).join('') || '<p class="text-slate-600 text-xs text-center">No active trades</p>';

                    document.getElementById('logBox').innerHTML = d.history.slice(-5).reverse().map(l => \`
                        <p>\${l.time}: \${l.symbol} \${l.side} (\${l.change}%)</p>
                    \`).join('');
                } catch(e) {}
            }

            async function toggleBot() {
                const r = await fetch('/api/status');
                const d = await r.json();
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ isRunning: !d.botSettings.isRunning })
                });
                refresh();
            }

            setInterval(refresh, 2000);
            refresh();
        </script>
    </body>
    </html>
    `);
});

APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = parseFloat(p.unrealizedProfit);
            const margin = (entry * amt) / parseFloat(p.leverage);
            return {
                symbol: p.symbol,
                side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                margin: margin.toFixed(2),
                pnlPercent: ((pnl / margin) * 100).toFixed(2)
            };
        });
        res.json({ botSettings, status, activePositions, history: fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)) : [] });
    } catch (e) { res.status(500).json({error: e.message}); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = {...botSettings, ...req.body};
    res.sendStatus(200);
});

// --- KHỞI CHẠY ---
refreshExchangeInfo();
setInterval(mainLoop, 5000);
APP.listen(9001, '0.0.0.0', () => {
    console.log("🚀 BOT TRADE ĐÃ SẴN SÀNG TẠI CỔNG 9001");
});
