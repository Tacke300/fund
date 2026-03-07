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
    running: false, startTime: null, totalBalance: 100, marginValue: 10, marginType: '$',
    maxGrids: 5, stepSize: 1.0, multiplier: 2.0, tpPercent: 1.0, mode: 'LONG', 
    closedPnl: 0, totalClosedGrids: 0 
};

let activePositions = {}; 
let marketPrices = {};
let allSymbols = [];
let symbolMaxLeverage = {}; 
let logs = [];
let pnlHistory = [];

function logger(msg, type = 'INFO') {
    const color = type === 'ERR' ? 'text-red-500' : (type === 'WIN' ? 'text-green-400' : (type === 'DCA' ? 'text-orange-400' : 'text-emerald-400'));
    logs.unshift(`<span class="${color}">[${new Date().toLocaleTimeString()}] [${type}] ${msg}</span>`);
    if (logs.length > 50) logs.pop();
}

try {
    if (fs.existsSync(STATE_FILE)) Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE)));
    if (fs.existsSync(LEVERAGE_FILE)) symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE));
    if (fs.existsSync(HISTORY_FILE)) pnlHistory = JSON.parse(fs.readFileSync(HISTORY_FILE));
} catch(e) {}

const saveAll = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(pnlHistory));
};

function processTick(symbol, price) {
    if (!botState.running) return;
    marketPrices[symbol] = price;

    if (activePositions[symbol]) {
        const pos = activePositions[symbol];
        if (pos.status === 'WAITING') {
            const margin = botState.marginType === '$' ? botState.marginValue : (pos.coinBalance * botState.marginValue / 100);
            pos.grids = [{ price, qty: margin }];
            pos.status = 'TRADING';
            return;
        }

        const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

        if (diffPct * 100 >= botState.tpPercent) {
            const pnl = totalMargin * (diffPct * pos.maxLev);
            pos.coinBalance += pnl; 
            botState.closedPnl += pnl;
            botState.totalClosedGrids++;
            pnlHistory.push({ ts: Date.now(), pnl: pnl });
            logger(`WIN: ${symbol} | +${pnl.toFixed(2)}$ | Bal: ${pos.coinBalance.toFixed(2)}$`, "WIN");
            pos.status = 'WAITING';
            pos.grids = []; 
            saveAll();
        } else if (pos.grids.length < botState.maxGrids) {
            const lastPrice = pos.grids[pos.grids.length - 1].price;
            const gap = pos.side === 'LONG' ? (lastPrice - price) / lastPrice : (price - lastPrice) / lastPrice;
            if (gap * 100 >= botState.stepSize) {
                pos.grids.push({ price, qty: pos.grids[pos.grids.length-1].qty * botState.multiplier });
                logger(`DCA: ${symbol} (#${pos.grids.length})`, "DCA");
            }
        }
    } else if (allSymbols.includes(symbol)) {
        const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
        activePositions[symbol] = {
            symbol, side: botState.mode, maxLev: symbolMaxLeverage[symbol] || 20,
            coinBalance: botState.totalBalance,
            grids: [{ price, qty: margin }], status: 'TRADING'
        };
    }
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            tickers.forEach(t => processTick(t.s, parseFloat(t.c)));
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

app.get('/api/data', (req, res) => {
    const activeData = Object.values(activePositions).map(p => {
        const totalMargin = p.grids.length ? p.grids.reduce((sum, g) => sum + g.qty, 0) : 0;
        const avgPrice = p.grids.length ? p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin : 0;
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, roi = 0;
        if (p.status !== 'WAITING' && avgPrice > 0) {
            const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
            pnl = totalMargin * diff * p.maxLev;
            roi = (pnl / p.coinBalance) * 100;
        }
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi, pnl, currentPrice: currentP };
    });
    res.json({ state: botState, active: activeData, logs, stats: { all: botState.closedPnl } });
});

app.post('/api/control', (req, res) => {
    const wasRunning = botState.running;
    if (req.body.running !== undefined) {
        botState.running = req.body.running;
        if (botState.running && !wasRunning) {
            botState.startTime = Date.now();
            logger("HỆ THỐNG START", "INFO");
            Object.keys(marketPrices).forEach(s => processTick(s, marketPrices[s]));
        }
    }
    ['totalBalance', 'marginValue', 'marginType', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' });
});

app.post('/api/reset', (req, res) => { activePositions = {}; botState.closedPnl = 0; logs = []; pnlHistory = []; saveAll(); res.json({ status: 'ok' }); });

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix v27</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace}
        .neon-glow { color: #4ade80; text-shadow: 0 0 8px rgba(74,222,128,0.5); }
        .neon-red { color: #f87171; text-shadow: 0 0 8px rgba(248,113,113,0.5); }
        th{background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;font-size:10px;cursor:pointer}
        #logBox{background:#000;padding:10px;height:200px;overflow-y:auto;font-size:11px;border:1px solid #333}
    </style>
    </head><body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-lg">
            <div class="w-[110px]">VỐN GỐC/COIN<input id="totalBalance" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[110px]">MARGIN<div class="flex mt-1"><input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded-l border border-gray-700"><select id="marginType" class="bg-gray-800 text-white rounded-r border-y border-r border-gray-700"><option value="$">$</option><option value="%">%</option></select></div></div>
            <div class="w-[60px]">DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[60px]">GAP%<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[60px]">TP%<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">MODE<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-6 py-2 rounded font-bold">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-6 py-2 rounded font-bold">STOP</button>
                <button onclick="resetBot()" class="bg-gray-700 px-3 py-2 rounded font-bold text-[9px]">RESET</button>
            </div>
            <div class="border-l border-gray-700 pl-4 ml-2">
                <div class="text-gray-500 text-[9px]">UPTIME / STATUS</div>
                <div id="uptime" class="text-yellow-500 font-bold text-sm">0d 00:00:00</div>
                <div id="botStatus" class="font-bold text-[9px] italic">OFFLINE</div>
            </div>
        </div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-4 overflow-hidden">
            <table class="w-full text-left"><thead class="bg-[#161a1e]"><tr>
                <th onclick="setSort('symbol')">SYMBOL ↕</th>
                <th class="text-right" onclick="setSort('coinBalance')">VỐN HIỆN TẠI ↕</th>
                <th class="text-center" onclick="setSort('currentGrid')">DCA ↕</th>
                <th class="text-right" onclick="setSort('roi')">ROI (%) ↕</th>
                <th class="text-right pr-2" onclick="setSort('pnl')">PNL ($) ↕</th>
            </tr></thead><tbody id="activeBody"></tbody></table>
        </div>
        <div id="logBox"></div>

        <script>
            let sortKey = 'pnl', sortDir = -1, rawData = [], firstLoad = true;
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            async function sendCtrl(run){ const body = { running: run, totalBalance: Number(document.getElementById('totalBalance').value), marginValue: Number(document.getElementById('marginValue').value), marginType: document.getElementById('marginType').value, maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            async function resetBot(){ if(confirm('RESET ALL?')) await fetch('/api/reset',{method:'POST'}); }
            function render(){
                const base = Number(document.getElementById('totalBalance').value);
                const sorted = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir);
                document.getElementById('activeBody').innerHTML = sorted.map(p=> {
                    const balClass = p.coinBalance < base ? 'neon-red font-bold' : (p.coinBalance > base ? 'neon-glow font-bold' : 'text-blue-400');
                    return \`<tr class="border-b border-gray-800 hover:bg-[#2b3139] \${p.status==='WAITING'?'opacity-40':''}">
                        <td class="p-2 font-bold text-yellow-500 font-mono">\${p.symbol}</td>
                        <td class="text-right \${balClass}">\${p.coinBalance.toFixed(2)}$</td>
                        <td class="text-center font-bold text-yellow-400">\${p.currentGrid}/\${window.maxG}</td>
                        <td class="text-right \${p.roi>=0?'text-green-500':'text-red-500'} font-bold">\${p.roi.toFixed(2)}%</td>
                        <td class="text-right pr-2 font-bold \${p.pnl>=0?'text-green-500':'text-red-500'} font-mono">\${p.pnl.toFixed(2)}$</td>
                    </tr>\`;
                }).join('');
            }
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['totalBalance','marginValue','marginType','maxGrids','stepSize','tpPercent','mode'].forEach(id => { const el = document.getElementById(id); if(el) el.value = d.state[id]; }); firstLoad = false; }
                    rawData = d.active; window.maxG = d.state.maxGrids; render();
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    document.getElementById('botStatus').innerText = d.state.running ? "RUNNING" : "STOPPED";
                    document.getElementById('botStatus').className = "font-bold text-[9px] italic " + (d.state.running ? "text-green-500" : "text-red-500");
                    if(d.state.startTime && d.state.running) {
                        const s = Math.floor((Date.now() - d.state.startTime)/1000);
                        document.getElementById('uptime').innerText = \`\${Math.floor(s/86400)}d \${String(Math.floor((s%86400)/3600)).padStart(2,'0')}:\${String(Math.floor((s%3600)/60)).padStart(2,'0')}:\${String(s%60).padStart(2,'0')}\`;
                    }
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

async function main() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (res) => {
            let data = ''; res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    info.symbols.forEach(s => { if(s.status === 'TRADING' && s.quoteAsset === 'USDT') allSymbols.push(s.symbol); });
                    logger(`Đã tải ${allSymbols.length} coin.`);
                } catch(e){}
                resolve();
            });
        }).on('error', () => resolve());
    });
}

main().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`BOT READY: http://localhost:${PORT}/gui`));
});
