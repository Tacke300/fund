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
    running: false, startTime: null, marginValue: 1, 
    maxGrids: 10, stepSize: 1.0, tpPercent: 1.0, mode: 'LONG', 
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
    if (logs.length > 100) logs.pop();
}

if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
if (fs.existsSync(HISTORY_FILE)) try { pnlHistory = JSON.parse(fs.readFileSync(HISTORY_FILE)); } catch(e){}

const saveAll = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(pnlHistory));
};

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
                            if (!symbolMaxLeverage[s.symbol]) symbolMaxLeverage[s.symbol] = 20;
                        }
                    });
                } catch(e) {}
                resolve();
            });
        }).on('error', () => resolve());
    });
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
                            symbolMaxLeverage[item.symbol] = parseInt(item.brackets[0].initialLeverage);
                            allSymbols.push(item.symbol);
                        });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        logger(`Nạp ${allSymbols.length} coin thành công.`);
                    }
                    resolve();
                } catch (e) { fallbackSymbols().then(resolve); }
            });
        }).on('error', () => fallbackSymbols().then(resolve));
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
                if (!allSymbols.includes(t.s)) return;

                if (!activePositions[t.s]) {
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                        grids: [{ price, qty: botState.marginValue, time: Date.now() }], status: 'TRADING'
                    };
                } else {
                    const pos = activePositions[t.s];
                    if (pos.status === 'WAITING') {
                        pos.grids = [{ price, qty: botState.marginValue, time: Date.now() }];
                        pos.status = 'TRADING';
                        return;
                    }
                    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                    const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                    if (diffPct * 100 >= botState.tpPercent) {
                        const pnl = totalMargin * (diffPct * pos.maxLev);
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: pnl });
                        logger(`WIN: ${t.s} | +${pnl.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                    } else if (pos.grids.length < botState.maxGrids) {
                        const lastEntry = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastEntry - price) / lastEntry : (price - lastEntry) / lastEntry;
                        if (gap * 100 >= botState.stepSize) {
                            pos.grids.push({ price, qty: botState.marginValue, time: Date.now() });
                            logger(`DCA: ${t.s} tầng ${pos.grids.length}`, "DCA");
                        }
                    }
                }
            });
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

app.get('/api/data', (req, res) => {
    let unrealizedPnl = 0;
    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, avgPrice = 0, totalMargin = 0;
        if (p.status !== 'WAITING' && currentP > 0) {
            totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
            avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
            const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
            pnl = totalMargin * diff * p.maxLev;
            unrealizedPnl += pnl;
        }
        return { 
            ...p, avgPrice, totalMargin, currentGrid: p.grids.length, 
            pnl, currentPrice: currentP, coinVốn: botState.marginValue * p.maxLev * botState.maxGrids,
            gridDetails: p.grids.map((g, i) => ({
                index: i + 1, entry: g.price, margin: g.qty, 
                pnl: g.qty * (p.side === 'LONG' ? (currentP - g.price)/g.price : (g.price - currentP)/g.price) * p.maxLev
            }))
        };
    });
    res.json({ state: botState, active: activeData, logs, stats: { closedPnl: botState.closedPnl, totalClosedGrids: botState.totalClosedGrids, unrealizedPnl, totalSystemPnl: botState.closedPnl + unrealizedPnl, runningCoins: activeData.filter(x => x.status !== 'WAITING').length } });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) {
        if (req.body.running && !botState.running) botState.startTime = Date.now();
        botState.running = req.body.running;
    }
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = [];
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy DCA v45</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{cursor:pointer;background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;text-transform:uppercase;font-size:10px}
    #logBox{background:#000;padding:10px;height:220px;overflow-y:auto;font-size:11px;border:1px solid #333}
    .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); }
    .modal-content { background: #1e2329; margin: 10% auto; padding: 20px; border: 1px solid #f0b90b; width: 70%; border-radius: 4px; }</style></head>
    <body class="p-4 text-[11px]">
        <div id="gridModal" class="modal"><div class="modal-content shadow-2xl">
            <div class="flex justify-between mb-4"><h2 id="mTitle" class="text-xl font-bold text-yellow-500 italic"></h2><button onclick="closeM()" class="text-2xl text-red-500">&times;</button></div>
            <table class="w-full text-center text-[10px]"><thead class="bg-black"><tr><th>TẦNG</th><th>GIÁ VÀO</th><th>MARGIN ($)</th><th>PNL ($)</th></tr></thead><tbody id="mBody"></tbody></table>
        </div></div>
        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 border border-gray-800 flex flex-wrap items-end gap-3 shadow-lg">
            <div class="w-[100px]">MARGIN ($)<input id="marginValue" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">MAX DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">MODE<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-6 py-2 rounded font-bold hover:bg-green-500">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-6 py-2 rounded font-bold hover:bg-red-500">STOP</button>
                <button onclick="resetData()" class="bg-gray-700 px-4 py-2 rounded font-bold">RESET</button>
            </div>
            <div id="status" class="font-bold text-red-500 px-2 uppercase">OFFLINE</div>
        </div>
        <div class="bg-[#1e2329] p-3 rounded-lg border border-gray-800 flex justify-between gap-2 shadow-inner mb-4">
            <div class="text-center flex-1 text-yellow-500 font-bold border-r border-gray-800">PNL ĐÃ CHỐT<div id="statClosedPnl" class="text-2xl font-black">0.00$</div></div>
            <div class="text-center flex-1 text-green-400 font-bold border-r border-gray-800">TỔNG PNL HỆ THỐNG<div id="pnlAll" class="text-2xl font-black">0.00$</div></div>
            <div class="text-center flex-1 text-red-400 font-bold">PNL ĐANG GỒNG<div id="statUnreal" class="text-2xl font-black">0.00$</div></div>
        </div>
        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-4 overflow-hidden"><table class="w-full text-left">
            <thead class="bg-[#161a1e]"><tr>
                <th onclick="setSort('maxLev')">SYMBOL (xLEV) ↕</th>
                <th class="text-right" onclick="setSort('pnl')">PNL HIỆN TẠI ↕</th>
                <th class="text-center">TẦNG DCA</th>
                <th class="text-right">VỐN COIN ($)</th>
                <th class="text-right pr-2">GIÁ TRUNG BÌNH</th>
            </tr></thead><tbody id="activeBody"></tbody></table></div>
        <div id="logBox"></div>
        <script>
            let sortKey = 'maxLev', sortDir = -1, rawData = [], firstLoad = true;
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            async function sendCtrl(run){
                const body = { running: run, marginValue: Number(document.getElementById('marginValue').value), maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetData(){ if(confirm('RESET ALL?')) await fetch('/api/reset',{method:'POST'}); }
            function openDetail(s){
                const p = rawData.find(x => x.symbol === s); if(!p) return;
                document.getElementById('mTitle').innerText = s + " - Tầng DCA";
                document.getElementById('mBody').innerHTML = p.gridDetails.map(g => {
                    const c = g.pnl >= 0 ? 'text-green-500' : 'text-red-500';
                    return '<tr class="border-b border-gray-800"><td class="p-2 text-yellow-500">Tầng '+g.index+'</td><td>'+g.entry.toFixed(5)+'</td><td>'+g.margin.toFixed(2)+'</td><td class="'+c+' font-bold">'+g.pnl.toFixed(4)+'</td></tr>';
                }).join('');
                document.getElementById('gridModal').style.display = 'block';
            }
            function closeM(){ document.getElementById('gridModal').style.display = 'none'; }
            function render(){ 
                const s = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir); 
                document.getElementById('activeBody').innerHTML = s.map(p=>{
                    const c = p.pnl>=0?'text-green-400':'text-red-500';
                    const op = p.status==='WAITING'?'opacity-30':'';
                    return '<tr class="border-b border-gray-800 hover:bg-[#2b3139] '+op+'"><td onclick="openDetail(\\''+p.symbol+'\\')" class="p-3 font-bold text-yellow-500 cursor-pointer underline">'+p.symbol+' (x'+p.maxLev+')</td><td class="text-right font-bold '+c+'">'+p.pnl.toFixed(2)+'$</td><td class="text-center font-bold text-yellow-400">'+p.currentGrid+'/'+window.maxG+'</td><td class="text-right font-bold text-blue-400">'+p.coinVốn.toFixed(1)+'$</td><td class="text-right pr-2 font-bold text-white">'+(p.avgPrice||0).toFixed(5)+'</td></tr>';
                }).join(''); 
            }
            async function update(){
                try {
                    const r = await fetch('/api/data'); const d = await r.json();
                    if(firstLoad) { ['marginValue','maxGrids','stepSize','tpPercent','mode'].forEach(id => { document.getElementById(id).value = d.state[id]; }); firstLoad = false; }
                    rawData = d.active; window.maxG = d.state.maxGrids; render();
                    document.getElementById('pnlAll').innerText = d.stats.totalSystemPnl.toFixed(2) + '$';
                    document.getElementById('statClosedPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    document.getElementById('status').innerText = d.state.running ? "RUNNING" : "STOPPED";
                    document.getElementById('status').className = "font-bold " + (d.state.running ? "text-green-500" : "text-red-500");
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
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
