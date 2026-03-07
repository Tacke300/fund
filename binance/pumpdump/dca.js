import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
app.use(express.json());

const STATE_FILE = './bot_state.json';
const LEVERAGE_FILE = './leverage_cache.json';
const HISTORY_FILE = './pnl_history.json';
const PORT = 9009;

let botState = { 
    running: false, startTime: null, totalBalance: 1000, marginValue: 10, marginType: '$',
    maxGrids: 5, stepSize: 1.0, multiplier: 2.0, tpPercent: 1.0, mode: 'LONG', 
    closedPnl: 0, totalClosedGrids: 0 
};

let activePositions = {}; 
let marketPrices = {};
let allSymbols = [];
let symbolMaxLeverage = {}; 
let logs = [];
let pnlHistory = []; // {ts: timestamp, pnl: value}

function logger(msg, type = 'INFO') {
    const color = type === 'ERR' ? 'text-red-500' : (type === 'WIN' ? 'text-green-400' : 'text-emerald-400');
    logs.unshift(`<span class="${color}">[${new Date().toLocaleTimeString()}] [${type}] ${msg}</span>`);
    if (logs.length > 100) logs.pop();
}

// Load data
if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
if (fs.existsSync(HISTORY_FILE)) try { pnlHistory = JSON.parse(fs.readFileSync(HISTORY_FILE)); } catch(e){}

const saveAll = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(pnlHistory));
};

function getFilteredPnL(days) {
    const now = new Date();
    let startTime;
    if (days === 0) { // Hôm nay (từ 7:00 AM)
        startTime = new Date();
        if (now.getHours() < 7) startTime.setDate(now.getDate() - 1);
        startTime.setHours(7, 0, 0, 0);
    } else {
        startTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }
    return pnlHistory.filter(h => h.ts >= startTime.getTime()).reduce((sum, h) => sum + h.pnl, 0);
}

async function fetchActualLeverage() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const options = {
            hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 15000
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const brackets = JSON.parse(data);
                    if (Array.isArray(brackets)) {
                        allSymbols = [];
                        brackets.forEach(item => {
                            symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                            allSymbols.push(item.symbol);
                        });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        logger(`Nạp ${allSymbols.length} coin. Leverage OK.`);
                    } else { throw new Error("Data error"); }
                    resolve();
                } catch (e) { fallbackSymbols().then(resolve); }
            });
        }).on('error', () => fallbackSymbols().then(resolve));
    });
}

async function fallbackSymbols() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    info.symbols.forEach(s => {
                        if (s.status === 'TRADING' && s.quoteAsset === 'USDT') {
                            if (!allSymbols.includes(s.symbol)) allSymbols.push(s.symbol);
                            if(!symbolMaxLeverage[s.symbol]) symbolMaxLeverage[s.symbol] = 20;
                        }
                    });
                } catch(e) {}
                resolve();
            });
        });
    });
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        if (!botState.running) return;
        try {
            const tickers = JSON.parse(data);
            tickers.forEach(t => {
                marketPrices[t.s] = parseFloat(t.c);
                const price = marketPrices[t.s];

                if (activePositions[t.s]) {
                    const pos = activePositions[t.s];
                    if (pos.status === 'WAITING') {
                        const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
                        pos.grids = [{ price, qty: margin }];
                        pos.status = 'TRADING';
                        return;
                    }

                    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                    const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                    if (diffPct * 100 >= botState.tpPercent) {
                        const pnl = totalMargin * (diffPct * pos.maxLev);
                        botState.totalBalance += pnl; 
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: pnl });
                        if(pnlHistory.length > 5000) pnlHistory.shift(); 
                        logger(`WIN: ${t.s} | +${pnl.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                    } else if (pos.grids.length < botState.maxGrids) {
                        const lastPrice = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastPrice - price) / lastPrice : (price - lastPrice) / lastPrice;
                        if (gap * 100 >= botState.stepSize) {
                            pos.grids.push({ price, qty: pos.grids[pos.grids.length-1].qty * botState.multiplier });
                            logger(`DCA: ${t.s} (${pos.grids.length})`, "DCA");
                        }
                    }
                } else if (allSymbols.includes(t.s)) {
                    const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                        grids: [{ price, qty: margin }], status: 'TRADING'
                    };
                }
            });
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

app.get('/api/data', (req, res) => {
    const activeData = Object.values(activePositions).map(p => {
        if (p.status === 'WAITING') return { ...p, avgPrice: 0, totalMargin: 0, currentGrid: 0, roi: 0, pnl: 0, currentPrice: marketPrices[p.symbol] || 0 };
        const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const currentP = marketPrices[p.symbol] || 0;
        const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
        const pnl = totalMargin * diff * p.maxLev;
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi: (pnl/botState.totalBalance)*100, pnl, currentPrice: currentP };
    });
    res.json({ 
        state: botState, active: activeData, logs,
        stats: { today: getFilteredPnL(0), d7: getFilteredPnL(7), d30: getFilteredPnL(30), all: botState.closedPnl }
    });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) {
        if (req.body.running && !botState.running) botState.startTime = Date.now();
        botState.running = req.body.running;
    }
    ['totalBalance', 'marginValue', 'marginType', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = [];
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix v21</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{cursor:pointer;background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;text-transform:uppercase;font-size:10px} th:hover{color:#f0b90b} #logBox{background:#000;padding:10px;height:250px;overflow-y:auto;font-size:11px;border:1px solid #333}</style>
    </head><body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-lg">
            <div class="w-[110px]">VỐN HIỆN TẠI<input id="totalBalance" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[110px]">MARGIN<div class="flex mt-1"><input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded-l border border-gray-700"><select id="marginType" class="bg-gray-800 text-white rounded-r border-y border-r border-gray-700"><option value="$">$</option><option value="%">%</option></select></div></div>
            <div class="w-[60px]">DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[60px]">GAP%<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[60px]">TP%<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">MODE<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-5 py-2 rounded font-bold hover:bg-green-500">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-5 py-2 rounded font-bold hover:bg-red-500">STOP</button>
                <button onclick="resetBot()" class="bg-gray-700 px-3 py-2 rounded font-bold text-[9px]">RESET</button>
            </div>
            <div class="border-l border-gray-700 pl-4 ml-2"><div class="text-gray-500 text-[9px]">UPTIME</div><div id="uptime" class="text-yellow-500 font-bold text-sm">0d 00:00:00</div><div id="botStatus" class="font-bold text-[9px] italic text-red-500">OFFLINE</div></div>
        </div>

        <div class="bg-[#1e2329] p-3 rounded-lg mb-4 border border-blue-900/30 flex justify-between gap-2 shadow-inner">
            <div class="text-center flex-1">HÔM NAY (7AM)<div id="pnlToday" class="text-lg font-bold text-green-400">0.00$</div></div>
            <div class="text-center flex-1 border-x border-gray-800">7 NGÀY QUA<div id="pnl7d" class="text-lg font-bold text-green-500">0.00$</div></div>
            <div class="text-center flex-1 border-r border-gray-800">30 NGÀY QUA<div id="pnl30d" class="text-lg font-bold text-emerald-500">0.00$</div></div>
            <div class="text-center flex-1">TỔNG PNL<div id="pnlAll" class="text-lg font-bold text-yellow-500">0.00$</div></div>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-center">
            <div class="bg-[#1e2329] p-3 rounded-lg border border-gray-800 text-blue-400 font-bold">COINS<div id="statCoins" class="text-xl">0</div></div>
            <div class="bg-[#1e2329] p-3 rounded-lg border border-gray-800 font-bold">LƯỚI CHỐT<div id="statGrids" class="text-purple-400 font-bold">0</div></div>
            <div class="bg-[#1e2329] p-3 rounded-lg border border-gray-800 text-green-500 font-bold">PNL CHUYẾN<div id="statClosedPnl" class="font-bold">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded-lg border border-gray-800 text-gray-400 font-bold">PNL TẠM<div id="statUnrealized" class="font-bold text-white">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded-lg border-t-2 border-yellow-500 text-green-500 font-bold">ROI TỔNG<div id="statTotalRoi" class="text-xl font-bold">0.00%</div></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-4 overflow-hidden"><table class="w-full text-left"><thead class="bg-[#161a1e]"><tr><th onclick="setSort('symbol')">SYMBOL ↕</th><th class="text-right" onclick="setSort('currentPrice')">PRICE ↕</th><th class="text-center" onclick="setSort('currentGrid')">DCA COUNT ↕</th><th class="text-right" onclick="setSort('roi')">ROI (%) ↕</th><th class="text-right pr-2" onclick="setSort('pnl')">PNL ($) ↕</th></tr></thead><tbody id="activeBody"></tbody></table></div>
        <div id="logBox"></div>

        <script>
            let sortKey = 'pnl', sortDir = -1, rawData = [], firstLoad = true;
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            async function sendCtrl(run){ const body = { running: run, totalBalance: Number(document.getElementById('totalBalance').value), marginValue: Number(document.getElementById('marginValue').value), marginType: document.getElementById('marginType').value, maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            async function resetBot(){ if(confirm('RESET DATA?')) await fetch('/api/reset',{method:'POST'}); }
            function render(){ const sorted = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir); document.getElementById('activeBody').innerHTML = sorted.map(p=>\`<tr class="border-b border-gray-800 hover:bg-[#2b3139] \${p.status==='WAITING'?'opacity-40':''}"> <td class="p-2 font-bold text-yellow-500 font-mono">\${p.symbol} \${p.status==='WAITING'?'(WAIT)':''}</td> <td class="text-right font-mono text-gray-400">\${p.currentPrice.toFixed(4)}</td> <td class="text-center font-bold text-yellow-400">\${p.currentGrid}/\${window.maxG}</td> <td class="text-right \${p.roi>=0?'text-green-500':'text-red-500'} font-bold">\${p.roi.toFixed(2)}%</td> <td class="text-right pr-2 font-bold \${p.pnl>=0?'text-green-500':'text-red-500'} font-mono">\${p.pnl.toFixed(2)}$</td> </tr>\`).join(''); }
            function formatUptime(ms) { const s = Math.floor(ms / 1000); return \`\${Math.floor(s/86400)}d \${String(Math.floor((s%86400)/3600)).padStart(2,'0')}:\${String(Math.floor((s%3600)/60)).padStart(2,'0')}:\${String(s%60).padStart(2,'0')}\`; }
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['totalBalance','marginValue','marginType','maxGrids','stepSize','tpPercent','mode'].forEach(id => document.getElementById(id).value = d.state[id]); firstLoad = false; }
                    rawData = d.active; window.maxG = d.state.maxGrids; render();
                    const unreal = d.active.reduce((s,p)=>s+p.pnl,0);
                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('pnl7d').innerText = d.stats.d7.toFixed(2) + '$';
                    document.getElementById('pnl30d').innerText = d.stats.d30.toFixed(2) + '$';
                    document.getElementById('pnlAll').innerText = d.stats.all.toFixed(2) + '$';
                    document.getElementById('statCoins').innerText = d.active.length;
                    document.getElementById('statGrids').innerText = d.state.totalClosedGrids;
                    document.getElementById('statClosedPnl').innerText = d.state.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnrealized').innerText = unreal.toFixed(2) + '$';
                    document.getElementById('statTotalRoi').innerText = (d.active.length > 0 ? ((d.state.closedPnl+unreal)/(d.active.length*d.state.totalBalance))*100 : 0).toFixed(2) + '%';
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    document.getElementById('botStatus').innerText = d.state.running ? "RUNNING" : "STOPPED";
                    document.getElementById('botStatus').className = "font-bold text-[9px] italic " + (d.state.running ? "text-green-500" : "text-red-500");
                    if(d.state.startTime && d.state.running) document.getElementById('uptime').innerText = formatUptime(Date.now() - d.state.startTime);
                    else document.getElementById('uptime').innerText = "0d 00:00:00";
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`BOT READY: http://localhost:${PORT}/gui`));
});
