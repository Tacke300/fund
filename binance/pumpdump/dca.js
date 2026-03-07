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
    let startTime;
    if (days === 0) {
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
                        logger(`Nạp ${allSymbols.length} coin. Leverage OK.`, "SYS");
                    }
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
                        const margin = botState.marginType === '$' ? botState.marginValue : (pos.coinBalance * botState.marginValue / 100);
                        pos.grids = [{ price, qty: margin, time: Date.now() }];
                        pos.status = 'TRADING';
                        return;
                    }

                    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                    const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                    if (diffPct * 100 >= botState.tpPercent) {
                        const pnl = totalMargin * (diffPct * pos.maxLev);
                        pos.coinBalance += pnl; 
                        pos.closedCount = (pos.closedCount || 0) + 1;
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: pnl });
                        logger(`WIN: ${t.s} | +${pnl.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                    } else if (pos.grids.length < botState.maxGrids) {
                        const lastPrice = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastPrice - price) / lastPrice : (price - lastPrice) / lastPrice;
                        if (gap * 100 >= botState.stepSize) {
                            pos.grids.push({ price, qty: pos.grids[pos.grids.length-1].qty * botState.multiplier, time: Date.now() });
                            logger(`DCA: ${t.s} (${pos.grids.length})`, "DCA");
                        }
                    }
                } else if (allSymbols.includes(t.s)) {
                    const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                        coinBalance: botState.totalBalance, closedCount: 0,
                        grids: [{ price, qty: margin, time: Date.now() }], status: 'TRADING'
                    };
                }
            });
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

app.get('/api/data', (req, res) => {
    let gridsGong = 0;
    let unrealizedPnl = 0;
    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, avgPrice = 0, totalMargin = 0;
        if (p.status !== 'WAITING' && currentP > 0) {
            totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
            avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
            const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
            pnl = totalMargin * diff * p.maxLev;
            gridsGong += p.grids.length;
            unrealizedPnl += pnl;
        }
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, pnl, currentPrice: currentP, displayBalance: p.coinBalance + pnl };
    });
    res.json({ state: botState, active: activeData, logs, stats: { today: getFilteredPnL(0), closedPnl: botState.closedPnl, totalClosedGrids: botState.totalClosedGrids, unrealizedPnl, gridsGong } });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) {
        if (req.body.running && !botState.running) botState.startTime = Date.now();
        botState.running = req.body.running;
    }
    ['totalBalance', 'marginValue', 'marginType', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;}
        th{background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;text-transform:uppercase;font-size:10px;text-align:left}
        #logBox{background:#000;padding:10px;height:250px;overflow-y:auto;font-size:11px;border:1px solid #333;}
        input, select { background: #000 !important; border: 1px solid #333 !important; color: #f0b90b !important; }
    </style></head><body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-xl">
            <div class="w-[110px]">VỐN GỐC/COIN<input id="totalBalance" type="number" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[110px]">MARGIN<div class="flex mt-1"><input id="marginValue" type="number" class="w-full p-2 rounded-l border-r-0"><select id="marginType" class="bg-gray-800 text-white rounded-r border border-gray-700 px-1"><option value="$">$</option><option value="%">%</option></select></div></div>
            <div class="w-[60px]">DCA<input id="maxGrids" type="number" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[60px]">GAP%<input id="stepSize" type="number" step="0.1" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[60px]">TP%<input id="tpPercent" type="number" step="0.1" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[90px]">MODE<select id="mode" class="w-full p-2 rounded mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-5 py-2 rounded font-bold hover:bg-green-500 shadow-lg">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-5 py-2 rounded font-bold hover:bg-red-500 shadow-lg">STOP</button>
            </div>
            <div class="border-l border-gray-700 pl-4 ml-2 text-right">
                <div id="uptime" class="text-yellow-500 font-bold text-sm">0d 00:00:00</div>
                <div id="botStatus" class="font-bold text-[9px] italic text-red-500">OFFLINE</div>
            </div>
        </div>

        <div class="bg-[#1e2329] p-3 rounded-t-lg border-x border-t border-gray-800 flex justify-between gap-2 shadow-inner">
            <div class="text-center flex-1 text-gray-400">HÔM NAY (7AM)<div id="pnlToday" class="text-lg font-bold text-green-400">0.00$</div></div>
            <div class="text-center flex-1 border-x border-gray-800 text-yellow-500 font-bold">LÃI ĐÃ CHỐT<div id="pnlAll" class="text-2xl font-black">0.00$</div></div>
            <div class="text-center flex-1 text-gray-400 font-bold">PNL GỒNG<div id="statUnreal" class="text-2xl font-black text-white">0.00$</div></div>
        </div>
        <div class="bg-[#161a1e] p-2 flex justify-around border-x border-b border-gray-800 text-[10px] font-bold mb-4 shadow-md text-gray-400">
            <div>GỒNG: <span id="statGrids" class="text-orange-400">0</span></div>
            <div>WIN: <span id="statClosedGrids" class="text-purple-400">0</span></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-4 overflow-hidden shadow-xl">
            <table class="w-full">
                <thead><tr>
                    <th>SYMBOL</th>
                    <th class="text-right">BALANCE ($)</th>
                    <th class="text-center">LƯỚI KHỚP</th>
                    <th class="text-right pr-2">PNL GỒNG ($)</th>
                </tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>
        <div id="logBox"></div>

        <script>
            let firstLoad = true;
            async function sendCtrl(run){
                const body = { 
                    running: run, 
                    totalBalance: Number(document.getElementById('totalBalance').value),
                    marginValue: Number(document.getElementById('marginValue').value), 
                    marginType: document.getElementById('marginType').value,
                    maxGrids: Number(document.getElementById('maxGrids').value), 
                    stepSize: Number(document.getElementById('stepSize').value), 
                    tpPercent: Number(document.getElementById('tpPercent').value), 
                    mode: document.getElementById('mode').value 
                };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            
            async function update(){
                try {
                    const res = await fetch('/api/data'); 
                    const d = await res.json();
                    if(firstLoad) { 
                        ['totalBalance','marginValue','marginType','maxGrids','stepSize','tpPercent','mode'].forEach(id => document.getElementById(id).value = d.state[id]); 
                        firstLoad = false; 
                    }
                    
                    document.getElementById('activeBody').innerHTML = d.active.filter(p=>p.currentGrid>0).map(p=>\`
                        <tr class="border-b border-gray-800 hover:bg-[#2b3139]">
                            <td class="p-2 font-bold text-yellow-500 font-mono">\${p.symbol} <span class="text-gray-500 text-[9px]">x\${p.maxLev}</span></td>
                            <td class="text-right font-bold \${p.pnl>=0?'text-green-400':'text-red-500'}">\${p.displayBalance.toFixed(2)}$</td>
                            <td class="text-center font-bold text-yellow-400">\${p.currentGrid}</td>
                            <td class="text-right pr-2 font-bold \${p.pnl>=0?'text-green-500':'text-red-500'} font-mono">\${p.pnl.toFixed(2)}$</td>
                        </tr>\`).join('');

                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('pnlAll').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    document.getElementById('statGrids').innerText = d.stats.gridsGong;
                    document.getElementById('statClosedGrids').innerText = d.stats.totalClosedGrids;
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    document.getElementById('botStatus').innerText = d.state.running ? "RUNNING" : "OFFLINE";
                    document.getElementById('botStatus').className = "font-bold " + (d.state.running ? "text-green-500" : "text-red-500");
                    
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

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => console.log(`http://localhost:${PORT}/gui`));
});
