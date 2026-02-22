import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const CONFIG_FILE = './bot_settings.json';
const HISTORY_FILE = './history_db.json';

// Tải cấu hình cũ hoặc dùng mặc định
let botSettings = { isRunning: false, maxPositions: 3, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 };
if (fs.existsSync(CONFIG_FILE)) {
    botSettings = JSON.parse(fs.readFileSync(CONFIG_FILE));
}

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;
let coinData = {}; 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || ''}[${time}] [${type.toUpperCase()}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() - 1000;
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY.trim()).update(fullQuery).digest('hex');
    return new Promise((resolve, reject) => {
        const req = https.request(`https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`, {
            method, headers: { 'X-MBX-APIKEY': API_KEY.trim() }
        }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.end();
    });
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s; const p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 60) coinData[s].prices.shift();
            
            const pArr = coinData[s].prices;
            if (pArr.length > 2) {
                const startP = pArr[0].p;
                const change = ((p - startP) / startP) * 100;
                coinData[s].c1 = parseFloat(change.toFixed(2));
            }
        });
        status.candidatesList = Object.entries(coinData)
            .filter(([_, v]) => Math.abs(v.c1) >= botSettings.minVol)
            .map(([s, v]) => ({ symbol: s, changePercent: v.c1 }))
            .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 10);
    });
    ws.on('error', () => setTimeout(initWS, 5000));
}

async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        // Đồng bộ danh sách đang quản lý với thực tế sàn
        const realActive = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);
        
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            if (!realActive.includes(symbol)) {
                addBotLog(`🧹 Giải phóng slot ${symbol} (Lệnh đã đóng)`, "info");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(()=>{});
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.2 : (lev < 50 ? 2.5 : 5.0);
    const rate = m / lev;
    return {
        tp: side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate),
        sl: side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate)
    };
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
                        stopPrice: plan.tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true', timeInForce: 'GTC'
                    });
                    addBotLog(`🎯 Cài TP ${symbol} tại ${plan.tp.toFixed(info.pricePrecision)}`, "success");
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true', timeInForce: 'GTC'
                    });
                    addBotLog(`🛑 Cài SL ${symbol} tại ${plan.sl.toFixed(info.pricePrecision)}`, "warn");
                }
            }
        }
    } catch (e) { addBotLog(`Lỗi TP/SL: ${e.message}`, "error"); }
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing || botManagedSymbols.length >= botSettings.maxPositions) return;
    isProcessing = true;
    try {
        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol)) continue;
            
            addBotLog(`🔍 Mục tiêu: ${c.symbol} biến động ${c.changePercent}%`, "info");
            const info = status.exchangeInfo[c.symbol];
            const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
            const lev = brackets[0].brackets[0].initialLeverage;
            
            await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
            const acc = await callBinance('/fapi/v2/account');
            status.currentBalance = parseFloat(acc.totalMarginBalance);
            
            const side = c.changePercent > 0 ? 'LONG' : 'SHORT';
            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            if ((margin * lev) < 5.1) margin = 5.2 / lev;
            
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const qty = (Math.floor(((margin * lev) / parseFloat(ticker.price)) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            const order = await callBinance('/fapi/v1/order', 'POST', { 
                symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL', 
                positionSide: side, type: 'MARKET', quantity: qty 
            });

            if (order.orderId) {
                botManagedSymbols.push(c.symbol);
                addBotLog(`🚀 VÀO LỆNH THÀNH CÔNG: ${side} ${c.symbol} | Đòn bẩy: ${lev}x`, "success");
                await new Promise(r => setTimeout(r, 2000));
                await enforceTPSL();
            } else {
                addBotLog(`❌ Thất bại ${c.symbol}: ${order.msg}`, "error");
            }
            break; 
        }
    } catch (e) { addBotLog(`Lỗi hệ thống hunt: ${e.message}`, "error"); }
    finally { isProcessing = false; }
}

const APP = express();
APP.use(express.json());
APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active, live: status.candidatesList });
    } catch (e) { res.status(500).send(); }
});
APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings)); // Lưu vào file
    addBotLog("⚙️ Đã lưu cấu hình mới", "info");
    res.json({ status: "ok" }); 
});
APP.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Bangers&display=swap');body{background:#050505;color:#eee;font-family:monospace;} .luffy{font-family:'Bangers',cursive;}</style></head><body class="p-4">
    <header class="flex justify-between items-center mb-4 border-b border-red-600 pb-2"><h1 class="luffy text-5xl text-red-500 italic">LUFFY COMMANDER</h1><div class="text-right"><p id="balance" class="text-3xl text-yellow-400 font-bold">$0.00</p></div></header>
    <div class="grid grid-cols-6 gap-2 mb-4">
        <div class="bg-white/5 p-2 rounded"><label class="text-[9px] text-gray-400 block">VỐN</label><input id="invValue" type="number" class="bg-transparent w-full outline-none" value="\${botSettings.invValue}"></div>
        <div class="bg-white/5 p-2 rounded"><label class="text-[9px] text-gray-400 block">KIỂU</label><select id="invType" class="bg-transparent w-full outline-none text-yellow-500"><option value="percent" \${botSettings.invType==='percent'?'selected':''}>% Acc</option><option value="fixed" \${botSettings.invType==='fixed'?'selected':''}>$ Fix</option></select></div>
        <div class="bg-white/5 p-2 rounded"><label class="text-[9px] text-gray-400 block">SÓNG %</label><input id="minVol" type="number" class="bg-transparent w-full outline-none text-red-500" value="\${botSettings.minVol}"></div>
        <div class="bg-white/5 p-2 rounded"><label class="text-[9px] text-gray-400 block">MÃ TỐI ĐA</label><input id="maxPositions" type="number" class="bg-transparent w-full outline-none" value="\${botSettings.maxPositions}"></div>
        <button id="runBtn" onclick="toggle()" class="bg-green-600 rounded font-black text-xs">START</button>
        <button onclick="update()" class="bg-white/10 rounded font-bold text-xs">SAVE SETTINGS</button>
    </div>
    <div class="grid grid-cols-12 gap-4 h-[75vh]">
        <div class="col-span-3 bg-white/5 rounded p-3"><h2 class="text-blue-400 text-xs font-bold mb-3">📡 SIGNALS</h2><div id="live" class="space-y-2"></div></div>
        <div class="col-span-6 bg-white/5 rounded p-0 overflow-hidden flex flex-col"><h2 class="p-3 text-red-500 text-xs font-bold bg-white/5">🚢 ACTIVE BATTLE</h2><div class="overflow-y-auto flex-grow"><table class="w-full text-[11px] text-left"><thead><tr class="text-gray-500 bg-black/50"><th class="p-3">COIN</th><th class="p-3">SIDE</th><th class="p-3">PNL%</th></tr></thead><tbody id="pos"></tbody></table></div></div>
        <div class="col-span-3 bg-white/5 rounded p-3 flex flex-col"><h2 class="text-yellow-500 text-xs font-bold mb-3">📜 LOGS</h2><div id="logs" class="text-[10px] space-y-1 overflow-y-auto flex-grow"></div></div>
    </div>
    <script>
        let isRunning = false;
        async function sync(){
            const r = await fetch('/api/status'); const d = await r.json();
            isRunning = d.botSettings.isRunning;
            document.getElementById('balance').innerText = '$'+d.status.currentBalance.toFixed(2);
            document.getElementById('runBtn').innerText = isRunning ? 'STOP BOT' : 'START BOT';
            document.getElementById('runBtn').className = isRunning ? 'bg-red-600 rounded font-black' : 'bg-green-600 rounded font-black';
            document.getElementById('live').innerHTML = d.live.map(v=>\`<div class="flex justify-between bg-black/40 p-2 rounded border-l-2 \${v.changePercent>=0?'border-green-500':'border-red-500'}"><span>\${v.symbol}</span><span class="\${v.changePercent>=0?'text-green-400':'text-red-400'}">\${v.changePercent}%</span></div>\`).join('');
            document.getElementById('pos').innerHTML = d.activePositions.map(p=>\`<tr class="border-b border-white/5 hover:bg-white/5"><td class="p-3 font-bold">\${p.symbol}</td><td class="p-3 \${p.side==='LONG'?'text-green-400':'text-red-400'} font-black">\${p.side} \${p.leverage}x</td><td class="p-3 font-bold \${parseFloat(p.pnlPercent)>=0?'text-green-400':'text-red-400'}">\${p.pnlPercent}%</td></tr>\`).join('');
            document.getElementById('logs').innerHTML = d.status.botLogs.map(l=>\`<div class="border-b border-white/5 pb-1"><span class="text-gray-500">[\${l.time}]</span> <span class="\${l.type==='success'?'text-green-400':(l.type==='error'?'text-red-500':'text-gray-300')}">\${l.msg}</span></div>\`).join('');
        }
        function toggle(){ isRunning = !isRunning; fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({isRunning})}); }
        function update(){ 
            const body={invValue:parseFloat(document.getElementById('invValue').value),invType:document.getElementById('invType').value,minVol:parseFloat(document.getElementById('minVol').value),maxPositions:parseInt(document.getElementById('maxPositions').value)}; 
            fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); 
            alert("Đã lưu!");
        }
        setInterval(sync, 2000); sync();
    </script></body></html>`);
});

async function start() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
        });
        initWS();
        isInitializing = false;
        setInterval(hunt, 3000);
        setInterval(cleanupClosedPositions, 5000);
        setInterval(enforceTPSL, 10000);
        addBotLog("⚓ LUFFY ĐÃ SẴN SÀNG RA KHƠI!", "success");
    } catch (e) { addBotLog("Lỗi khởi tạo: " + e.message, "error"); }
}

APP.listen(9001, '0.0.0.0', start);
