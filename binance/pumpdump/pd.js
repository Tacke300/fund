import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = './bot_settings.json';
const HISTORY_FILE = './history_db.json';

// --- CẤU HÌNH & TRẠNG THÁI ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0, 
    accountSL: 30 
};
if (fs.existsSync(CONFIG_FILE)) botSettings = JSON.parse(fs.readFileSync(CONFIG_FILE));

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let historyMap = new Map();
let isInitializing = true;
let isProcessing = false;

if (fs.existsSync(HISTORY_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
        data.forEach(h => historyMap.set(h.symbol, h));
    } catch (e) {}
}

// --- HÀM HELPER & SERVER LOGIC ---
function getPivotTime() {
    const now = new Date();
    let pivot = new Date(now);
    pivot.setHours(7, 0, 0, 0);
    if (now < pivot) pivot.setDate(pivot.getDate() - 1);
    return pivot.getTime();
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
    console.log(`${colors[type] || ''}[${time}] [${type.toUpperCase()}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    return new Promise((resolve, reject) => {
        const req = https.request(`https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`, { 
            method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000 
        }, res => {
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

// --- 1. DỌN DẸP VỊ THẾ (GIỮ NGUYÊN GỐC) ---
async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🧹 [DỌN DẸP] Phát hiện ${symbol} đã đóng vị thế.`, "info");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(()=>{});
                botManagedSymbols.splice(i, 1);
                addBotLog(`🔓 [SLOT] Giải phóng xong ${symbol}.`, "success");
            }
        }
    } catch (e) { addBotLog(`⚠️ [LỖI DỌN DẸP] ${e.msg}`, "error"); }
}

// --- 2. TÍNH TOÁN TP/SL (GIỮ NGUYÊN GỐC) ---
function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
    const rate = m / lev;
    const tp = side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate);
    const sl = side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate);
    return { tp, sl };
}

// --- 3. CÀI ĐẶT TP/SL (GIỮ NGUYÊN GỐC) ---
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

            const hasTP = orders.some(o => o.symbol === symbol && o.positionSide === side && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === symbol && o.positionSide === side && o.type === 'STOP_MARKET');

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
                    addBotLog(`🎯 [TP] Cài chốt lãi ${symbol} tại: ${plan.tp.toFixed(info.pricePrecision)}`, "success");
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    });
                    addBotLog(`🛑 [SL] Cài cắt lỗ ${symbol} tại: ${plan.sl.toFixed(info.pricePrecision)}`, "success");
                }
            }
        }
    } catch (e) {}
}

// --- 4. HÀM SĂN LỆNH (GIỮ NGUYÊN GỐC) ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    try {
        isProcessing = true;
        const currentUsed = botManagedSymbols.length;
        if (currentUsed >= botSettings.maxPositions || status.candidatesList.length === 0) return;

        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            try {
                addBotLog(`🎯 [CHẤP NHẬN] ${c.symbol} đạt ${c.changePercent}%.`, "info");
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                
                const acc = await callBinance('/fapi/v2/account');
                status.currentBalance = parseFloat(acc.totalMarginBalance);
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                const info = status.exchangeInfo[c.symbol];
                const side = c.changePercent > 0 ? 'LONG' : 'SHORT';

                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                if ((margin * lev) < 5.1) margin = 5.2 / lev;

                let qty = Math.floor(((margin * lev) / price) / info.stepSize) * info.stepSize;
                const finalQty = qty.toFixed(info.quantityPrecision);

                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL',
                    positionSide: side, type: 'MARKET', quantity: finalQty
                });

                botManagedSymbols.push(c.symbol);
                addBotLog(`🚀 [THÀNH CÔNG] Đã mở lệnh ${c.symbol}.`, "success");
                await new Promise(res => setTimeout(res, 3000));
                await enforceTPSL();
            } catch (err) { addBotLog(`❌ [THẤT BẠI] ${c.symbol}: ${JSON.stringify(err)}`, "error"); }
        }
    } catch (e) {} finally { isProcessing = false; }
}

// --- 5. LẤY TÍN HIỆU & CẬP NHẬT LỊCH SỬ (GIỮ LOGIC SERVER) ---
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                status.candidatesList = all.filter(c => Math.abs(c.c1) >= botSettings.minVol)
                    .map(c => ({ symbol: c.symbol, changePercent: c.c1, c5: c.c5, c15: c.c15, currentPrice: c.currentPrice }))
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 10);
                
                // Logic Win/Lose Lịch sử (Y như Server)
                const now = Date.now();
                status.candidatesList.forEach(c => {
                    let hist = historyMap.get(c.symbol);
                    if (hist && hist.status === 'PENDING') {
                        const diff = ((c.currentPrice - hist.snapPrice) / hist.snapPrice) * 100;
                        if (hist.type === 'DOWN') {
                            if (diff <= -5) hist.status = 'WIN'; else if (diff >= 5) hist.status = 'LOSE';
                        } else {
                            if (diff >= 5) hist.status = 'WIN'; else if (diff <= -5) hist.status = 'LOSE';
                        }
                    }
                    if (Math.abs(c.changePercent) >= botSettings.minVol) {
                        if (!hist || hist.status !== 'PENDING') {
                            historyMap.set(c.symbol, { 
                                symbol: c.symbol, startTime: now, max1: c.changePercent, max5: c.c5, max15: c.c15,
                                snapPrice: c.currentPrice, type: (c.changePercent >= 0) ? 'UP' : 'DOWN', status: 'PENDING' 
                            });
                        }
                    }
                });
            } catch (e) {}
        });
    }).on('error', () => {});
}

// --- EXPRESS SERVER & GIAO DIỆN ---
const APP = express();
APP.use(express.json());

APP.get('/api/status', async (req, res) => {
    try {
        const pivot = getPivotTime();
        const historyArr = Array.from(historyMap.values());
        const win = historyArr.filter(h => h.startTime >= pivot && h.status === 'WIN').length;
        const lose = historyArr.filter(h => h.startTime >= pivot && h.status === 'LOSE').length;
        
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active, history: historyArr.sort((a,b)=>b.startTime-a.startTime).slice(0, 30), stats: { win, lose } });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings));
    res.json({ status: "ok" });
});

APP.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><style>body{background:#050505;color:#d4d4d8;font-family:monospace;}.up{color:#ef4444;}.down{color:#22c55e;}</style></head><body class="p-4">
    <div class="flex justify-between items-center mb-4 border-b border-zinc-800 pb-2"><h1 class="text-2xl font-black text-red-500 italic">LUFFY COMMANDER</h1><div id="stats" class="font-bold text-sm"></div><div id="balance" class="text-xl font-bold text-yellow-400">$0.00</div></div>
    <div class="grid grid-cols-5 gap-2 mb-4 bg-zinc-900 p-2 rounded">
        <input id="invValue" type="number" class="bg-black p-1 rounded border border-zinc-700" value="\${botSettings.invValue}">
        <select id="invType" class="bg-black p-1 rounded border border-zinc-700"><option value="percent" \${botSettings.invType==='percent'?'selected':''}>% Acc</option><option value="fixed" \${botSettings.invType==='fixed'?'selected':''}>$ Fix</option></select>
        <input id="minVol" type="number" class="bg-black p-1 rounded border border-zinc-700" value="\${botSettings.minVol}">
        <button id="runBtn" onclick="toggle()" class="bg-green-600 rounded font-bold text-xs uppercase">START</button>
        <button onclick="update()" class="bg-zinc-700 rounded font-bold text-xs">SAVE</button>
    </div>
    <div class="grid grid-cols-12 gap-4">
        <div class="col-span-4 bg-zinc-900/50 p-2 rounded"><h2 class="text-blue-400 font-bold mb-2 text-[10px] uppercase">Live Wave (1m|5m|15m)</h2><table class="w-full text-[10px] text-left"><thead><tr class="text-zinc-500 border-b border-zinc-800"><th class="p-1">COIN</th><th>1M</th><th>5M</th><th>15M</th></tr></thead><tbody id="live"></tbody></table></div>
        <div class="col-span-5 bg-zinc-900/50 p-2 rounded"><h2 class="text-red-500 font-bold mb-2 text-[10px] uppercase">History Signals</h2><table class="w-full text-[10px] text-left"><thead><tr class="text-zinc-500 border-b border-zinc-800"><th>TIME</th><th>COIN</th><th>MAX</th><th>PRICE</th><th>RES</th></tr></thead><tbody id="hist"></tbody></table></div>
        <div class="col-span-3 bg-zinc-900/50 p-2 rounded"><h2 class="text-yellow-500 font-bold mb-2 text-[10px] uppercase">Bot Logs</h2><div id="logs" class="text-[9px] space-y-1"></div></div>
    </div>
    <script>
        let running = false;
        async function refresh() {
            const r = await fetch('/api/status'); const d = await r.json();
            running = d.botSettings.isRunning;
            document.getElementById('balance').innerText = '$' + d.status.currentBalance.toFixed(2);
            document.getElementById('stats').innerHTML = \`<span class="text-green-500">WIN: \${d.stats.win}</span> | <span class="text-red-500">LOSE: \${d.stats.lose}</span>\`;
            document.getElementById('runBtn').innerText = running ? 'STOP' : 'START';
            document.getElementById('runBtn').className = running ? 'bg-red-600 rounded font-bold' : 'bg-green-600 rounded font-bold';
            document.getElementById('live').innerHTML = d.status.candidatesList.map(c => \`<tr><td class="p-1 font-bold">\${c.symbol}</td><td class="\${c.changePercent>=0?'up':'down'}">\${c.changePercent}%</td><td class="\${c.c5>=0?'up':'down'}">\${c.c5}%</td><td class="\${c.c15>=0?'up':'down'}">\${c.c15}%</td></tr>\`).join('');
            document.getElementById('hist').innerHTML = d.history.map(h => \`<tr class="border-b border-zinc-800/50"><td>\${new Date(h.startTime).toLocaleTimeString([],{hour12:false})}</td><td class="font-bold \${h.max1>=0?'up':'down'}">\${h.symbol}</td><td>\${h.max1}%</td><td>\${h.snapPrice}</td><td class="font-bold \${h.status==='WIN'?'text-green-500':'text-red-500'}">\${h.status}</td></tr>\`).join('');
            document.getElementById('logs').innerHTML = d.status.botLogs.map(l => \`<div><span class="text-zinc-600">[\${l.time}]</span> \${l.msg}</div>\`).join('');
        }
        function toggle(){ running=!running; fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({isRunning:running})}); }
        function update(){ const body={invValue:parseFloat(document.getElementById('invValue').value),invType:document.getElementById('invType').value,minVol:parseFloat(document.getElementById('minVol').value)}; fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
        setInterval(refresh, 2000); refresh();
    </script></body></html>`);
});

async function init() {
    addBotLog("🔧 [KHỞI TẠO] Lấy Exchange Info...", "info");
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            const info = JSON.parse(d);
            info.symbols.forEach(s => {
                const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
            });
            isInitializing = false;
            addBotLog("✅ [HỆ THỐNG] Ready.", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 2000);
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 10000);
setInterval(() => fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()).slice(-500))), 30000);

APP.listen(9001, '0.0.0.0');
