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
const PORT = 9009;

let botState = { 
    running: false, marginValue: 1, 
    maxGrids: 10, stepSize: 1.0, tpPercent: 1.0, mode: 'LONG', 
    closedPnl: 0, totalClosedGrids: 0 
};

let activePositions = {}; 
let marketPrices = {};
let allSymbols = [];
let symbolMaxLeverage = {}; 
let logs = [];

function logger(msg, type = 'INFO') {
    const color = type === 'ERR' ? 'text-red-500' : (type === 'WIN' ? 'text-green-400' : (type === 'DCA' ? 'text-orange-400' : 'text-emerald-400'));
    logs.unshift('<span class="' + color + '">[' + new Date().toLocaleTimeString() + '] [' + type + '] ' + msg + '</span>');
    if (logs.length > 100) logs.pop();
}

// Khởi tạo file nếu chưa có
if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
try { 
    const saved = JSON.parse(fs.readFileSync(STATE_FILE));
    Object.assign(botState, saved);
} catch(e) { logger("Lỗi file state, khởi tạo lại", "ERR"); }

if (fs.existsSync(LEVERAGE_FILE)) {
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
}

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));

async function fetchActualLeverage() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = 'timestamp=' + timestamp;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        
        const options = {
            hostname: 'fapi.binance.com',
            path: '/fapi/v1/leverageBracket?' + query + '&signature=' + signature,
            headers: { 'X-MBX-APIKEY': API_KEY },
            timeout: 10000
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
                        logger("Đã nạp " + allSymbols.length + " coin.");
                    }
                } catch (e) {}
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
                if (!allSymbols.includes(t.s)) return;
                marketPrices[t.s] = parseFloat(t.c);
                const price = marketPrices[t.s];

                if (!activePositions[t.s]) {
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                        grids: [{ price: price, qty: botState.marginValue }], status: 'TRADING'
                    };
                } else {
                    const pos = activePositions[t.s];
                    if (pos.status === 'WAITING') return;

                    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                    const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                    if (diffPct * 100 >= botState.tpPercent) {
                        const pnl = totalMargin * (diffPct * pos.maxLev);
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        logger("WIN: " + t.s + " | +" + pnl.toFixed(2) + "$", "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveState();
                        setTimeout(() => { delete activePositions[t.s]; }, 3000);
                    } else if (pos.grids.length < botState.maxGrids) {
                        const lastEntry = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastEntry - price) / lastEntry : (price - lastEntry) / lastEntry;
                        if (gap * 100 >= botState.stepSize) {
                            pos.grids.push({ price: price, qty: botState.marginValue });
                            logger("DCA: " + t.s + " tầng " + pos.grids.length, "DCA");
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
        let pnl = 0, avgPrice = 0;
        if (p.status !== 'WAITING' && currentP > 0) {
            const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
            avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
            const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
            pnl = totalMargin * diff * p.maxLev;
            unrealizedPnl += pnl;
        }
        return { ...p, avgPrice, pnl, coinVốn: botState.marginValue * p.maxLev * botState.maxGrids };
    });
    res.json({ state: botState, active: activeData, logs, stats: { closedPnl: botState.closedPnl, unrealizedPnl: unrealizedPnl } });
});

app.post('/api/control', (req, res) => { 
    const d = req.body;
    if (d.running !== undefined) botState.running = d.running;
    if (d.marginValue) botState.marginValue = parseFloat(d.marginValue);
    if (d.maxGrids) botState.maxGrids = parseInt(d.maxGrids);
    if (d.stepSize) botState.stepSize = parseFloat(d.stepSize);
    if (d.tpPercent) botState.tpPercent = parseFloat(d.tpPercent);
    if (d.mode) botState.mode = d.mode;
    
    saveState();
    logger("Hệ thống: " + (botState.running ? "BẮT ĐẦU" : "DỪNG"), botState.running ? "INFO" : "ERR");
    res.json({ status: 'ok', running: botState.running }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy DCA v48</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} #logBox{background:#000;padding:10px;height:250px;overflow-y:auto;font-size:11px;border:1px solid #333}</style></head>
    <body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 flex flex-wrap items-end gap-3 shadow-lg border border-gray-800">
            <div>VỐN ($)<input id="mv" type="number" class="w-20 bg-black text-yellow-500 p-2 rounded border border-gray-700 block mt-1"></div>
            <div>DCA<input id="mg" type="number" class="w-16 bg-black text-yellow-500 p-2 rounded border border-gray-700 block mt-1"></div>
            <div>GAP%<input id="ss" type="number" step="0.1" class="w-16 bg-black text-yellow-500 p-2 rounded border border-gray-700 block mt-1"></div>
            <div>TP%<input id="tp" type="number" step="0.1" class="w-16 bg-black text-yellow-500 p-2 rounded border border-gray-700 block mt-1"></div>
            <div>MODE<select id="md" class="w-24 bg-black p-2 rounded border border-gray-700 block mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <button onclick="ctrl(true)" class="bg-green-600 px-6 py-2 rounded font-bold hover:bg-green-500">START</button>
            <button onclick="ctrl(false)" class="bg-red-600 px-6 py-2 rounded font-bold hover:bg-red-500">STOP</button>
            <div id="stt" class="ml-auto font-bold uppercase">OFFLINE</div>
        </div>
        <div class="grid grid-cols-2 gap-4 mb-4">
            <div class="bg-[#1e2329] p-3 rounded border border-gray-800 text-center"><div class="text-gray-400">ĐÃ CHỐT</div><div id="cPnl" class="text-2xl font-bold text-green-400">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded border border-gray-800 text-center"><div class="text-gray-400">ĐANG GỒNG</div><div id="uPnl" class="text-2xl font-bold text-red-500">0.00$</div></div>
        </div>
        <div class="bg-[#1e2329] rounded border border-gray-800 overflow-hidden mb-4"><table class="w-full text-left">
            <thead class="bg-[#161a1e]"><tr><th class="p-2">SYMBOL</th><th class="text-right">PNL</th><th class="text-center">DCA</th><th class="text-right pr-2">AVG PRICE</th></tr></thead>
            <tbody id="list"></tbody></table></div>
        <div id="logBox"></div>
        <script>
            let first = true;
            async function ctrl(run){
                const payload = {
                    running: run,
                    marginValue: document.getElementById('mv').value,
                    maxGrids: document.getElementById('mg').value,
                    stepSize: document.getElementById('ss').value,
                    tpPercent: document.getElementById('tp').value,
                    mode: document.getElementById('md').value
                };
                await fetch('/api/control', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload)
                });
            }
            async function update(){
                try {
                    const r = await fetch('/api/data'); const d = await r.json();
                    if(first){
                        document.getElementById('mv').value = d.state.marginValue;
                        document.getElementById('mg').value = d.state.maxGrids;
                        document.getElementById('ss').value = d.state.stepSize;
                        document.getElementById('tp').value = d.state.tpPercent;
                        document.getElementById('md').value = d.state.mode;
                        first = false;
                    }
                    document.getElementById('stt').innerText = d.state.running ? "RUNNING" : "STOPPED";
                    document.getElementById('stt').style.color = d.state.running ? "#10b981" : "#ef4444";
                    document.getElementById('cPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('uPnl').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    let h = "";
                    d.active.forEach(p => {
                        if(p.status === 'WAITING') return;
                        h += '<tr class="border-b border-gray-800"><td class="p-2 font-bold text-yellow-500">'+p.symbol+'</td><td class="text-right '+(p.pnl>=0?'text-green-400':'text-red-500')+'">'+p.pnl.toFixed(2)+'$</td><td class="text-center">'+p.grids.length+'/'+d.state.maxGrids+'</td><td class="text-right pr-2">'+p.avgPrice.toFixed(5)+'</td></tr>';
                    });
                    document.getElementById('list').innerHTML = h;
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => console.log('Bot OK tại Port ' + PORT));
});
