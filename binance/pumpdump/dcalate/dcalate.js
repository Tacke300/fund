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
const PORT = 9008;

let botState = { 
    running: false, startTime: null, marginValue: 10,
    maxGrids: 5, stepSize: 1.0, tpPercent: 1.0, mode: 'LONG', 
    closedPnl: 0, totalClosedGrids: 0 
};

let activePositions = {}; 
let marketPrices = {};
let allSymbols = [];
let symbolMaxLeverage = {}; 
let logs = [];
let pnlHistory = [];

function logger(msg, type = 'INFO') {
    const color = type === 'ERR' ? 'text-red-500' : (type === 'WIN' ? 'text-green-400' : 'text-emerald-400');
    logs.unshift(`<span class="${color}">[${new Date().toLocaleTimeString()}] [${type}] ${msg}</span>`);
    if (logs.length > 100) logs.pop();
}

if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
if (fs.existsSync(HISTORY_FILE)) try { pnlHistory = JSON.parse(fs.readFileSync(HISTORY_FILE)); } catch(e){}

const saveAll = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(pnlHistory));
};

function getFilteredPnL(days) {
    const now = new Date();
    let startTime = new Date();
    if (now.getHours() < 7) startTime.setDate(now.getDate() - 1);
    startTime.setHours(7, 0, 0, 0);
    if (days > 0) startTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return pnlHistory.filter(h => h.tsClose >= startTime.getTime()).reduce((sum, h) => sum + h.pnl, 0);
}

async function fetchActualLeverage() {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const options = {
        hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
        headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000
    };
    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const brackets = JSON.parse(data);
                if (Array.isArray(brackets)) {
                    brackets.forEach(item => {
                        symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                        if (!allSymbols.includes(item.symbol)) allSymbols.push(item.symbol);
                    });
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                }
            } catch (e) {}
        });
    }).on('error', () => {});
}

async function initSymbols() {
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
                            if (!symbolMaxLeverage[s.symbol]) symbolMaxLeverage[s.symbol] = 20;
                        }
                    });
                } catch(e) {}
                resolve();
            });
        }).on('error', () => resolve());
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
                    const isLong = pos.side === 'LONG';

                    for (let i = pos.grids.length - 1; i >= 0; i--) {
                        const grid = pos.grids[i];
                        const shouldClose = isLong ? (price >= grid.tpPrice) : (price <= grid.tpPrice);
                        
                        if (shouldClose) {
                            const size = (grid.qty * pos.maxLev) / grid.entryPrice;
                            const gridPnl = isLong ? (grid.tpPrice - grid.entryPrice) * size : (grid.entryPrice - grid.tpPrice) * size;
                            
                            botState.closedPnl += gridPnl;
                            pos.totalClosedPnl += gridPnl;
                            
                            pnlHistory.push({
                                tsOpen: grid.time, tsClose: Date.now(),
                                symbol: t.s, side: pos.side, lev: pos.maxLev,
                                pnl: gridPnl, avgPrice: grid.entryPrice, closePrice: price
                            });

                            logger(`GRID WIN: ${t.s} tầng ${i + 1} | +${gridPnl.toFixed(2)}$`, "WIN");
                            pos.grids.splice(i, 1);
                            if (pos.grids.length === 0) pos.lastPriceAtZero = price;
                            saveAll();
                        }
                    }

                    if (pos.grids.length < botState.maxGrids) {
                        const lastEntry = pos.grids.length > 0 ? pos.grids[pos.grids.length - 1].entryPrice : pos.lastPriceAtZero;
                        const gap = isLong ? (lastEntry - price) / lastEntry : (price - lastEntry) / lastEntry;

                        if (gap * 100 >= botState.stepSize) {
                            const tpPrice = isLong ? price * (1 + botState.tpPercent / 100) : price * (1 - botState.tpPercent / 100);
                            pos.grids.push({ entryPrice: price, tpPrice: tpPrice, qty: botState.marginValue, time: Date.now() });
                            logger(`OPEN GRID: ${t.s} tầng ${pos.grids.length}`, "INFO");
                        }
                    }
                } else if (allSymbols.includes(t.s) && botState.running) {
                    const maxLev = symbolMaxLeverage[t.s] || 20;
                    const tpPrice = botState.mode === 'LONG' ? price * (1 + botState.tpPercent / 100) : price * (1 - botState.tpPercent / 100);
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: maxLev,
                        totalClosedPnl: 0, lastPriceAtZero: price,
                        grids: [{ entryPrice: price, tpPrice: tpPrice, qty: botState.marginValue, time: Date.now() }]
                    };
                }
            });
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

app.get('/api/data', (req, res) => {
    let unrealizedPnlTotal = 0;
    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let unrealP = 0;
        p.grids.forEach(g => {
            const size = (g.qty * p.maxLev) / g.entryPrice;
            unrealP += p.side === 'LONG' ? (currentP - g.entryPrice) * size : (g.entryPrice - currentP) * size;
        });
        unrealizedPnlTotal += unrealP;
        return { ...p, unrealizedPnl: unrealP, totalCoinPnl: p.totalClosedPnl + unrealP, currentPrice: currentP };
    });

    res.json({ 
        state: botState, active: activeData, logs,
        stats: { today: getFilteredPnL(0), closedPnl: botState.closedPnl, unrealizedPnl: unrealizedPnlTotal } 
    });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) { if (req.body.running && !botState.running) botState.startTime = Date.now(); botState.running = req.body.running; }
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = []; saveAll(); res.json({ status: 'ok' }); });

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Grid Matrix</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{background:#161a1e;padding:10px 8px;border-bottom:1px solid #333;font-size:10px}
    #logBox{background:#000;padding:10px;height:180px;overflow-y:auto;font-size:11px;border:1px solid #333;color:#00ff00}</style>
    </head><body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-yellow-500/20 flex flex-wrap items-end gap-3 shadow-xl">
            <div class="w-[100px]">MARGIN ($)<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">MAX GRID<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">HƯỚNG<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-2 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-8 py-3 rounded font-black hover:bg-green-500">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-8 py-3 rounded font-black hover:bg-red-500">STOP</button>
                <button onclick="resetBot()" class="bg-gray-800 px-4 py-3 rounded hover:bg-black">RESET</button>
            </div>
        </div>

        <div class="grid grid-cols-4 gap-1 mb-2">
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">HÔM NAY</div><div id="pnlToday" class="font-bold text-green-400 text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">ĐÃ CHỐT TỔNG</div><div id="statClosedPnl" class="font-bold text-yellow-500 text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">ĐANG GỒNG PNL</div><div id="statUnreal" class="font-bold text-white text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">TRẠNG THÁI</div><div id="botStatus" class="font-bold text-lg">-</div></div>
        </div>

        <div class="bg-[#1e2329] rounded border border-gray-800 mb-2 overflow-hidden">
            <table class="w-full text-left">
                <thead class="bg-[#161a1e]"><tr>
                    <th class="p-2 text-center">STT</th>
                    <th>COIN</th>
                    <th class="text-center">TẦNG</th>
                    <th class="text-right">PNL ĐANG ÂM</th>
                    <th class="text-right">PNL ĐÃ CHỐT</th>
                    <th class="text-right">TỔNG PNL COIN</th>
                    <th class="text-center">LEV</th>
                </tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>
        <div id="logBox"></div>

        <script>
            let firstLoad = true;
            async function sendCtrl(run){ const body = { running: run, marginValue: Number(document.getElementById('marginValue').value), maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            async function resetBot(){ if(confirm('RESET?')) await fetch('/api/reset',{method:'POST'}); }
            
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['marginValue','maxGrids','stepSize','tpPercent','mode'].forEach(id => document.getElementById(id).value = d.state[id]); firstLoad = false; }
                    
                    document.getElementById('botStatus').innerText = d.state.running ? 'RUNNING' : 'STOPPED';
                    document.getElementById('botStatus').className = d.state.running ? 'font-bold text-lg text-green-400' : 'font-bold text-lg text-red-500';
                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('statClosedPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';

                    document.getElementById('activeBody').innerHTML = d.active.map((p, i) => \`
                        <tr class="border-b border-gray-800 hover:bg-[#2b3139]">
                            <td class="p-2 text-center text-gray-500">\${i+1}</td>
                            <td class="p-2 font-bold text-yellow-500">\${p.symbol}</td>
                            <td class="text-center font-bold text-orange-400">\${p.grids.length}</td>
                            <td class="text-right font-bold \${p.unrealizedPnl >= 0 ? 'text-green-500' : 'text-red-500'}">\${p.unrealizedPnl.toFixed(2)}$</td>
                            <td class="text-right font-bold text-emerald-400">\${p.totalClosedPnl.toFixed(2)}$</td>
                            <td class="text-right font-bold \${p.totalCoinPnl >= 0 ? 'text-green-400' : 'text-blue-400'}">\${p.totalCoinPnl.toFixed(2)}$</td>
                            <td class="text-center text-gray-400">x\${p.maxLev}</td>
                        </tr>\`).join('');
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

initSymbols().then(() => { 
    initWS(); 
    app.listen(PORT, '0.0.0.0', () => logger(`DASHBOARD: http://localhost:${PORT}/gui`)); 
    fetchActualLeverage(); 
});
