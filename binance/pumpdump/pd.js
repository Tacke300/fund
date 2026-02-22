import https from 'https';
import crypto from 'crypto';
import express from 'express';
import WebSocket from 'ws';
import { API_KEY, SECRET_KEY } from './config.js';

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
    activePositions: [] 
};

let botManagedSymbols = []; 
let coinData = {}; 
let cooldownMap = new Map(); 
let isInitializing = true;
let isProcessing = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || ''}[${time}] [${type.toUpperCase()}] ${msg}\x1b[0m`);
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

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    if (!startPriceObj) return 0;
    return parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2));
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
            if (coinData[s].prices.length > 310) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
        });

        status.candidatesList = Object.values(coinData)
            .filter(v => v.live && (Math.abs(v.live.c1) >= botSettings.minVol || Math.abs(v.live.c5) >= botSettings.minVol || Math.abs(v.live.c15) >= botSettings.minVol))
            .map(v => {
                const changes = [v.live.c1, v.live.c5, v.live.c15];
                const bestChange = changes.sort((a,b) => Math.abs(b) - Math.abs(a))[0];
                return { symbol: v.symbol, changePercent: bestChange, currentPrice: v.live.currentPrice };
            })
            .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
            .slice(0, 15);
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🧹 ${symbol} đã đóng. Nghỉ 15 phút.`, "info");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
                cooldownMap.set(symbol, Date.now() + 15 * 60 * 1000);
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

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
            const side = p.positionSide, entry = parseFloat(p.entryPrice);
            if (entry <= 0) continue;
            const hasTP = orders.some(o => o.symbol === symbol && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === symbol && o.type === 'STOP_MARKET');
            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[symbol], plan = calcTPSL(parseFloat(p.leverage), side, entry), closeSide = side === 'LONG' ? 'SELL' : 'BUY';
                if (!hasTP) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                        stopPrice: plan.tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true', timeInForce: 'GTC'
                    });
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true', timeInForce: 'GTC'
                    });
                }
                addBotLog(`🎯 Đã đặt TP/SL cho ${symbol}`, "success");
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
            if (cooldownMap.has(c.symbol)) {
                if (Date.now() < cooldownMap.get(c.symbol)) continue;
                else cooldownMap.delete(c.symbol);
            }
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            try {
                addBotLog(`🎯 Kích hoạt ${c.symbol} (${c.changePercent}%)`, "info");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: c.symbol }).catch(() => {});
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                const acc = await callBinance('/fapi/v2/account');
                status.currentBalance = parseFloat(acc.totalMarginBalance);
                const info = status.exchangeInfo[c.symbol], side = c.changePercent > 0 ? 'LONG' : 'SHORT';
                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                if ((margin * lev) < 5.5) margin = 6 / lev;
                let qty = (Math.floor(((margin * lev) / c.currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL', positionSide: side, type: 'MARKET', quantity: qty
                });
                botManagedSymbols.push(c.symbol);
                addBotLog(`🚀 Đã mở vị thế ${c.symbol}`, "success");
                setTimeout(enforceTPSL, 3000);
            } catch (err) { addBotLog(`❌ Lỗi vào lệnh ${c.symbol}: ${JSON.stringify(err)}`, "error"); }
        }
    } finally { isProcessing = false; }
}

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
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ status: "ok" }); });
APP.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>LUFFY BOT</title><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Bangers&display=swap');body{background:#0a0a0c;color:#eee;font-family:sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}.luffy-font{font-family:'Bangers',cursive;letter-spacing:2px}.card{background:rgba(15,15,20,0.9);border:1px solid rgba(255,255,255,0.08);border-radius:16px}.glow-text{text-shadow:0 0 15px rgba(255,77,77,0.7)}.btn-start{background:linear-gradient(135deg,#22c55e,#15803d)}.btn-stop{background:linear-gradient(135deg,#ef4444,#b91c1c);animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#ff4d4d;border-radius:10px}</style></head><body class="p-4"><header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-500"><div class="flex items-center gap-4"><h1 class="luffy-font text-4xl text-white glow-text uppercase">Moncey D. Luffy</h1><span id="botStatusText" class="text-[10px] p-1 bg-gray-800 rounded">OFFLINE</span></div><div class="flex gap-8 bg-black/50 p-3 rounded-2xl border border-white/5"><div class="text-center"><p class="text-[10px] text-gray-500 font-bold uppercase">Kho Báu</p><p id="balance" class="text-2xl font-black text-yellow-400">$0.00</p></div><div class="text-center"><p class="text-[10px] text-gray-500 font-bold uppercase">Lệnh</p><p id="posCount" class="text-2xl font-black text-green-400">0</p></div></div></header><div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4"><div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Vốn</label><div class="flex gap-1"><input type="number" id="invValue" class="w-full bg-black/40 p-1 text-xs" value="1.5"><select id="invType" class="bg-black text-yellow-500 text-[10px]"><option value="fixed">$</option><option value="percent">%</option></select></div></div><div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Sóng %</label><input type="number" id="minVol" class="w-full bg-black/40 p-1 text-xs" value="5.0"></div><div class="card p-3"><label class="text-[10px] text-gray-500 font-bold uppercase">Max Lệnh</label><input type="number" id="maxPositions" class="w-full bg-black/40 p-1 text-xs" value="3"></div><button id="runBtn" onclick="handleToggle()" class="btn-start rounded-xl font-black text-sm uppercase">Giương Buồm</button><button onclick="handleUpdate()" class="bg-white/5 border border-white/10 rounded-xl text-[10px] uppercase">Cập Nhật</button></div><div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-4 overflow-hidden"><div class="md:col-span-4 card flex flex-col overflow-hidden border-t-4 border-blue-500"><div id="botLogs" class="flex-grow overflow-y-auto p-3 text-[10px] space-y-1"></div></div><div class="md:col-span-8 card flex flex-col overflow-hidden border-t-4 border-red-500"><table class="w-full text-left text-[11px]"><thead class="bg-black/80 sticky top-0 text-gray-500 uppercase"><tr><th class="p-3">Cặp Tiền</th><th class="p-3">Side/Lev</th><th class="p-3">Entry/Mark</th><th class="p-3 text-right">PnL %</th></tr></thead><tbody id="positionTable"></tbody></table></div></div><script>let isRunning=false;async function sync(){try{const res=await fetch('/api/status');const d=await res.json();if(d.botSettings.isRunning
