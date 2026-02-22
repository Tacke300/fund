import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = './history_db.json';

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
let isInitializing = true;
let isProcessing = false;
let coinData = {}; 
let historyMap = new Map();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
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
            const s = t.s; const p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices = coinData[s].prices.slice(-100);
            coinData[s].live = { c1: calculateChange(coinData[s].prices, 1), c5: calculateChange(coinData[s].prices, 5), currentPrice: p };
        });
        status.candidatesList = Object.entries(coinData)
            .filter(([_, v]) => v.live && Math.abs(v.live.c1) >= botSettings.minVol)
            .map(([s, v]) => ({ symbol: s, changePercent: v.live.c1 }))
            .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 10);
    });
    ws.on('error', () => setTimeout(initWS, 5000));
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
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(()=>{});
                botManagedSymbols.splice(i, 1);
                addBotLog(`Giải phóng ${symbol}`, "success");
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
                        stopPrice: plan.tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true', timeInForce: 'GTC'
                    });
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true', timeInForce: 'GTC'
                    });
                }
            }
        }
    } catch (e) {}
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing || botManagedSymbols.length >= botSettings.maxPositions) return;
    isProcessing = true;
    try {
        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol)) continue;
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
            const qty = ((margin * lev) / parseFloat(ticker.price)).toFixed(info.quantityPrecision);
            await callBinance('/fapi/v1/order', 'POST', { symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL', positionSide: side, type: 'MARKET', quantity: qty });
            botManagedSymbols.push(c.symbol);
            addBotLog(`Mở ${c.symbol}`, "success");
            await new Promise(r => setTimeout(r, 2000));
            await enforceTPSL();
            break;
        }
    } catch (e) {} finally { isProcessing = false; }
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
        res.json({ botSettings, status, activePositions: active, live: Object.entries(coinData).filter(([_,v])=>v.live).map(([s,v])=>({symbol:s,...v.live})).sort((a,b)=>Math.abs(b.c1)-Math.abs(a.c1)).slice(0,10) });
    } catch (e) { res.status(500).send(); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ status: "ok" }); });
APP.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Bangers&display=swap');body{background:#0a0a0c;color:#eee;font-family:monospace;} .luffy{font-family:'Bangers',cursive;}</style></head><body class="p-4">
    <header class="flex justify-between items-center mb-4 border-b-2 border-red-500 pb-2"><h1 class="luffy text-4xl text-white">LUFFY BOT v5.1</h1><div class="text-right"><p class="text-xs text-gray-500">BALANCE</p><p id="balance" class="text-2xl text-yellow-400 font-bold">$0.00</p></div></header>
    <div class="grid grid-cols-6 gap-2 mb-4">
        <input id="invValue" type="number" class="bg-gray-900 p-2 rounded text-center" value="1.5">
        <select id="invType" class="bg-gray-900 p-2 rounded"><option value="percent">%</option><option value="fixed">$</option></select>
        <input id="minVol" type="number" class="bg-gray-900 p-2 rounded text-center" value="5.0">
        <input id="maxPositions" type="number" class="bg-gray-900 p-2 rounded text-center" value="3">
        <button id="runBtn" onclick="toggle()" class="bg-green-600 rounded font-bold text-xs">START</button>
        <button onclick="update()" class="bg-white/10 rounded font-bold text-xs">SAVE</button>
    </div>
    <div class="grid grid-cols-12 gap-4 h-[70vh]">
        <div class="col-span-3 bg-gray-900/50 rounded p-2 overflow-y-auto"><h2 class="text-blue-400 text-xs font-bold mb-2">LIVE WAVE</h2><div id="live"></div></div>
        <div class="col-span-6 bg-gray-900/50 rounded p-2 overflow-y-auto"><h2 class="text-red-500 text-xs font-bold mb-2">POSITIONS</h2><table class="w-full text-[10px]"><thead><tr class="text-gray-500"><th>SYMBOL</th><th>SIDE</th><th>PNL%</th></tr></thead><tbody id="pos"></tbody></table></div>
        <div class="col-span-3 bg-gray-900/50 rounded p-2 overflow-y-auto"><h2 class="text-yellow-500 text-xs font-bold mb-2">LOGS</h2><div id="logs" class="text-[9px]"></div></div>
    </div>
    <script>
        let isRunning = false;
        async function sync(){
            const r = await fetch('/api/status'); const d = await r.json();
            isRunning = d.botSettings.isRunning;
            document.getElementById('balance').innerText = '$'+d.status.currentBalance.toFixed(2);
            document.getElementById('runBtn').innerText = isRunning ? 'STOP' : 'START';
            document.getElementById('runBtn').className = isRunning ? 'bg-red-600 rounded font-bold' : 'bg-green-600 rounded font-bold';
            document.getElementById('live').innerHTML = d.live.map(v=>\`<div class="flex justify-between border-b border-white/5 p-1 text-[10px]"><span>\${v.symbol}</span><span class="\${v.c1>=0?'text-green-400':'text-red-400'}">\${v.c1}%</span></div>\`).join('');
            document.getElementById('pos').innerHTML = d.activePositions.map(p=>\`<tr class="text-center border-b border-white/5"><td class="p-1">\${p.symbol}</td><td class="\${p.side==='LONG'?'text-green-400':'text-red-400'}">\${p.side}</td><td class="\${parseFloat(p.pnlPercent)>=0?'text-green-400':'text-red-400'}">\${p.pnlPercent}%</td></tr>\`).join('');
            document.getElementById('logs').innerHTML = d.status.botLogs.map(l=>\`<div class="mb-1 text-gray-400">[\${l.time}] \${l.msg}</div>\`).join('');
        }
        function toggle(){ isRunning = !isRunning; fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({isRunning})}); }
        function update(){ const body={invValue:parseFloat(document.getElementById('invValue').value),invType:document.getElementById('invType').value,minVol:parseFloat(document.getElementById('minVol').value),maxPositions:parseInt(document.getElementById('maxPositions').value)}; fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
        setInterval(sync, 2000); sync();
    </script></body></html>`);
});

async function start() {
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
}

APP.listen(9001, '0.0.0.0', start);
