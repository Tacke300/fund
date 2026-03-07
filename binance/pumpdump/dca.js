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
    running: false, startTime: null, totalBalance: 1000, marginValue: 10, marginType: '$',
    maxGrids: 5, stepSize: 1.0, multiplier: 2.0, tpPercent: 1.0, mode: 'LONG', 
    closedPnl: 0, totalClosedGrids: 0 
};

let activePositions = {}; 
let marketPrices = {};
let allSymbols = [];
let symbolMaxLeverage = {}; 
let logs = [];

function logger(msg, type = 'INFO') {
    const logEntry = `[${new Date().toLocaleTimeString()}] [${type}] ${msg}`;
    console.log(logEntry);
    logs.unshift(logEntry);
    if (logs.length > 40) logs.pop();
}

if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));

async function fetchActualLeverage() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        https.get({
            hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000
        }, (res) => {
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
                        logger(`Nạp ${allSymbols.length} coin.`, "INFO");
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
        if (!botState.running) return; // DỪNG TUYỆT ĐỐI KHI STOP
        
        const tickers = JSON.parse(data);
        tickers.forEach(t => {
            marketPrices[t.s] = parseFloat(t.c);
            const price = marketPrices[t.s];
            
            if (activePositions[t.s]) {
                // Xử lý DCA & TP
                const pos = activePositions[t.s];
                const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                if (diffPct * 100 >= botState.tpPercent) {
                    const pnl = totalMargin * diffPct * pos.maxLev;
                    botState.closedPnl += pnl;
                    botState.totalClosedGrids++;
                    logger(`CHỐT LỜI: ${t.s} +${pnl.toFixed(2)}$`, "WIN");
                    delete activePositions[t.s];
                    saveState();
                } else if (pos.grids.length < botState.maxGrids) {
                    const lastPrice = pos.grids[pos.grids.length - 1].price;
                    const gap = pos.side === 'LONG' ? (lastPrice - price) / lastPrice : (price - lastPrice) / lastPrice;
                    if (gap * 100 >= botState.stepSize) {
                        pos.grids.push({ price, qty: pos.grids[pos.grids.length-1].qty * botState.multiplier });
                        logger(`DCA: ${t.s} Lưới ${pos.grids.length}`, "DCA");
                    }
                }
            } else if (allSymbols.includes(t.s)) {
                // Mở lệnh mới
                const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
                activePositions[t.s] = {
                    symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                    grids: [{ price, qty: margin }]
                };
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const activeData = Object.values(activePositions).map(p => {
        const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = p.grids.reduce((sum, g) => sum + (p.price * p.qty), 0) / totalMargin; // Logic cũ bị nhầm p.price
        const realAvg = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const currentP = marketPrices[p.symbol] || 0;
        const diff = p.side === 'LONG' ? (currentP - realAvg) / realAvg : (realAvg - currentP) / realAvg;
        const pnl = totalMargin * diff * p.maxLev;
        const roi = (pnl / botState.totalBalance) * 100; // ROI trên vốn phân bổ cho coin đó
        return { ...p, avgPrice: realAvg, totalMargin, currentGrid: p.grids.length, roi, pnl, currentPrice: currentP };
    });
    res.json({ state: botState, active: activeData, logs });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running && !botState.running) {
        botState.startTime = Date.now();
        logger("BOT STARTED", "INFO");
    } else if (!req.body.running) {
        logger("BOT STOPPED", "ERR");
    }
    Object.assign(botState, req.body);
    saveState(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = [];
    logger("RESTART - CLEARED ALL", "ERR");
    saveState(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(fs.readFileSync('./gui.html', 'utf8')); // Bạn nên để code HTML vào file gui.html cho gọn
});

// Tích hợp HTML trực tiếp vào nếu bạn không muốn dùng file riêng
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix v7</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{cursor:pointer;background:#161a1e;padding:12px} #logBox{background:#000;color:#0ecb81;padding:10px;height:200px;overflow-y:auto;font-size:10px;border:1px solid #333}</style>
    </head><body class="p-4 text-[11px]">
        
        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4 text-center">
            <div class="bg-[#1e2329] p-3 rounded">UPTIME<div id="uptime" class="text-yellow-500 font-bold">0s</div></div>
            <div class="bg-[#1e2329] p-3 rounded text-blue-400">COINS<div id="statCoins" class="text-xl font-bold">0</div></div>
            <div class="bg-[#1e2329] p-3 rounded">LƯỚI CHỐT<div id="statGrids" class="text-purple-400 font-bold">0</div></div>
            <div class="bg-[#1e2329] p-3 rounded">PNL CHỐT<div id="statClosedPnl" class="text-green-500 font-bold">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded text-gray-400">PNL TẠM TÍNH<div id="statUnrealized" class="font-bold text-white">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded border-t-2 border-yellow-500">ROI TỔNG<div id="statTotalRoi" class="text-xl font-bold text-green-500">0.00%</div></div>
        </div>

        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 border border-gray-800 grid grid-cols-2 md:grid-cols-7 gap-3">
            <div>VỐN/COIN ($)<input id="totalBalance" type="number" value="\${botState.totalBalance}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MARGIN<div class="flex"><input id="marginValue" type="number" value="\${botState.marginValue}" class="w-full bg-black text-yellow-500 p-1 rounded"><select id="marginType" class="bg-black"><option value="$">$</option><option value="%">%</option></select></div></div>
            <div>DCA MAX<input id="maxGrids" type="number" value="\${botState.maxGrids}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>GAP (%)<input id="stepSize" type="number" value="\${botState.stepSize}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>TP (%)<input id="tpPercent" type="number" value="\${botState.tpPercent}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MODE<select id="mode" class="w-full bg-black p-1 rounded"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 items-end">
                <button onclick="sendCtrl(true)" class="bg-green-600 p-2 rounded font-bold flex-1">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 p-2 rounded font-bold flex-1">STOP</button>
                <button onclick="resetBot()" class="bg-yellow-700 p-2 rounded font-bold text-[9px]">RESTART</button>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div class="md:col-span-3 bg-[#1e2329] rounded-lg border border-gray-800 h-[500px] overflow-y-auto">
                <table class="w-full text-left">
                    <thead class="sticky top-0 bg-[#161a1e]"><tr>
                        <th onclick="setSort('symbol')">SYMBOL ↕</th>
                        <th class="text-right" onclick="setSort('currentPrice')">PRICE ↕</th>
                        <th class="text-right" onclick="setSort('currentGrid')">GRID ↕</th>
                        <th class="text-right" onclick="setSort('roi')">ROI ↕</th>
                        <th class="text-right pr-2" onclick="setSort('pnl')">PNL ↕</th>
                    </tr></thead>
                    <tbody id="activeBody"></tbody>
                </table>
            </div>
            <div id="logBox"></div>
        </div>

        <script>
            let sortKey = 'pnl', sortDir = -1, rawData = [];
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            
            async function sendCtrl(run){
                const body = { running:run, totalBalance:Number(document.getElementById('totalBalance').value), marginValue:Number(document.getElementById('marginValue').value), marginType:document.getElementById('marginType').value, maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), tpPercent:Number(document.getElementById('tpPercent').value), mode:document.getElementById('mode').value, multiplier: 2.0 };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetBot(){ if(confirm('RESTART sẽ xóa sạch lệnh đang chạy và PnL. Tiếp tục?')) await fetch('/api/reset',{method:'POST'}); }

            function render(){
                const sorted = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir);
                document.getElementById('activeBody').innerHTML = sorted.map(p=>\`<tr class="border-b border-gray-800">
                    <td class="p-2 font-bold text-yellow-500">\${p.symbol} <span class="text-gray-500">\${p.maxLev}x</span></td>
                    <td class="text-right font-mono">\${p.currentPrice.toFixed(4)}</td>
                    <td class="text-right">\${p.currentGrid}/\${window.maxG}</td>
                    <td class="text-right \${p.roi>=0?'text-green-500':'text-red-500'}">\${p.roi.toFixed(2)}%</td>
                    <td class="text-right pr-2 font-bold \${p.pnl>=0?'text-green-500':'text-red-500'}">\${p.pnl.toFixed(2)}$</td>
                </tr>\`).join('');
            }

            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    rawData = d.active; window.maxG = d.state.maxGrids;
                    render();
                    const unreal = d.active.reduce((s,p)=>s+p.pnl,0);
                    const totalInvested = d.active.length * d.state.totalBalance;
                    const totalRoi = totalInvested > 0 ? ((d.state.closedPnl + unreal) / totalInvested) * 100 : 0;
                    
                    document.getElementById('statCoins').innerText = d.active.length;
                    document.getElementById('statGrids').innerText = d.state.totalClosedGrids;
                    document.getElementById('statClosedPnl').innerText = d.state.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnrealized').innerText = unreal.toFixed(2) + '$';
                    document.getElementById('statTotalRoi').innerText = totalRoi.toFixed(2) + '%';
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    
                    if(d.state.startTime){
                        const s = Math.floor((Date.now()-d.state.startTime)/1000);
                        document.getElementById('uptime').innerText = s + "s";
                    }
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`BOT READY: PORT ${PORT}`, "INFO"));
});
