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

// Khởi tạo dữ liệu
if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
if (fs.existsSync(HISTORY_FILE)) try { pnlHistory = JSON.parse(fs.readFileSync(HISTORY_FILE)); } catch(e){}

const saveAll = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(pnlHistory));
};

async function fetchActualLeverage() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const options = {
            hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 10000
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
                        logger(`Đã cập nhật đòn bẩy cho ${allSymbols.length} cặp tiền`, "INFO");
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
                const maxLev = symbolMaxLeverage[t.s] || 20;

                if (activePositions[t.s]) {
                    const pos = activePositions[t.s];
                    if (pos.status === 'WAITING') {
                        pos.grids = [{ price, qty: botState.marginValue, time: Date.now() }];
                        pos.status = 'TRADING';
                        pos.maxLev = maxLev;
                        return;
                    }

                    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                    const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                    if (diffPct * 100 >= botState.tpPercent) {
                        const pnl = totalMargin * (diffPct * pos.maxLev);
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: pnl, lev: pos.maxLev });
                        logger(`WIN: ${t.s} (x${pos.maxLev}) | +${pnl.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                    } else if (pos.grids.length < botState.maxGrids) {
                        const lastPrice = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastPrice - price) / lastPrice : (price - lastPrice) / lastPrice;
                        if (gap * 100 >= botState.stepSize) {
                            pos.grids.push({ price, qty: botState.marginValue, time: Date.now() });
                            logger(`DCA: ${t.s} tầng ${pos.grids.length}`, "DCA");
                        }
                    }
                } else if (allSymbols.includes(t.s)) {
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: maxLev,
                        grids: [{ price, qty: botState.marginValue, time: Date.now() }], status: 'TRADING'
                    };
                }
            });
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

app.get('/api/data', (req, res) => {
    let levGroups = {};
    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, avgPrice = 0, totalMargin = 0, roi = 0;
        const lev = p.maxLev || 20;
        
        if (p.status !== 'WAITING' && currentP > 0) {
            totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
            avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
            const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
            pnl = totalMargin * diff * lev;
            roi = diff * lev * 100;

            if (!levGroups[lev]) levGroups[lev] = { count: 0, pnl: 0, closedPnl: 0, totalRoi: 0 };
            levGroups[lev].count++;
            levGroups[lev].pnl += pnl;
            levGroups[lev].totalRoi += roi;
        }

        const tpPrice = p.side === 'LONG' ? avgPrice * (1 + botState.tpPercent/100) : avgPrice * (1 - botState.tpPercent/100);
        const coinVốn = botState.marginValue * lev * botState.maxGrids;

        return { 
            ...p, avgPrice, totalMargin, currentGrid: p.grids.length, 
            pnl, roi, currentPrice: currentP, displayBalance: coinVốn + pnl, tpPrice, coinVốn, maxLev: lev
        };
    });

    pnlHistory.forEach(h => {
        const lev = h.lev || 20;
        if (!levGroups[lev]) levGroups[lev] = { count: 0, pnl: 0, closedPnl: 0, totalRoi: 0 };
        levGroups[lev].closedPnl += h.pnl;
    });

    res.json({ state: botState, active: activeData, logs, levGroups, stats: { closedPnl: botState.closedPnl, totalClosedGrids: botState.totalClosedGrids, unrealizedPnl: Object.values(levGroups).reduce((s,g)=>s+g.pnl,0), totalSystemPnl: botState.closedPnl + Object.values(levGroups).reduce((s,g)=>s+g.pnl,0) } });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) botState.running = req.body.running;
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = [];
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix v41</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{cursor:pointer;background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;text-transform:uppercase;font-size:10px} th:hover{color:#f0b90b} #logBox{background:#000;padding:10px;height:220px;overflow-y:auto;font-size:11px;border:1px solid #333}
    .lev-card { background: #1e2329; border: 1px solid #333; padding: 10px; border-radius: 4px; min-width: 140px; text-align: center; border-bottom: 3px solid #f0b90b; }</style></head>
    <body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-lg">
            <div class="w-[120px]">MARGIN LỚP ($)<input id="marginValue" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">MAX DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">MODE<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto"><button onclick="sendCtrl(true)" class="bg-green-600 px-6 py-2 rounded font-bold hover:bg-green-500">START</button><button onclick="sendCtrl(false)" class="bg-red-600 px-6 py-2 rounded font-bold hover:bg-red-500">STOP</button></div>
        </div>

        <div class="flex gap-2 overflow-x-auto mb-4" id="levStatBar"></div>

        <div class="bg-[#1e2329] p-3 rounded-lg border border-gray-800 flex justify-between gap-2 shadow-inner mb-4">
            <div class="text-center flex-1 text-yellow-500 font-bold">PNL ĐÃ CHỐT<div id="statClosedPnl" class="text-2xl font-black">0.00$</div></div>
            <div class="text-center flex-1 text-green-400 font-bold">TỔNG PNL HỆ THỐNG<div id="pnlAll" class="text-2xl font-black">0.00$</div></div>
            <div class="text-center flex-1 text-red-400 font-bold border-l border-gray-800">PNL CHƯA CHỐT<div id="statUnreal" class="text-2xl font-black">0.00$</div></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-4 overflow-hidden"><table class="w-full text-left">
            <thead class="bg-[#161a1e]"><tr><th onclick="setSort('maxLev')">SYMBOL (xLEV) ↕</th><th class="text-right" onclick="setSort('pnl')">PNL HIỆN TẠI ↕</th><th class="text-center">LƯỚI KHỚP</th><th class="text-right">VỐN COIN</th><th class="text-right pr-2">GIÁ TRUNG BÌNH</th></tr></thead>
            <tbody id="activeBody"></tbody>
        </table></div>
        <div id="logBox"></div>

        <script>
            let sortKey = 'maxLev', sortDir = -1, rawData = [], firstLoad = true;
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            async function sendCtrl(run){ const body = { running: run, marginValue: Number(document.getElementById('marginValue').value), maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            
            function render(){ 
                const sorted = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir); 
                document.getElementById('activeBody').innerHTML = sorted.map(p=>{
                    const balColor = p.pnl >= 0 ? 'text-green-400' : 'text-red-500';
                    return \`<tr class="border-b border-gray-800 hover:bg-[#2b3139] \${p.status==='WAITING'?'opacity-40':''}"> 
                        <td class="p-2 font-bold text-yellow-500 font-mono">\${p.symbol} (x\${p.maxLev})</td> 
                        <td class="text-right font-bold \${balColor}">\${p.pnl.toFixed(2)}$ (\${p.roi.toFixed(1)}%)</td> 
                        <td class="text-center font-bold text-yellow-400">\${p.currentGrid}/\${window.maxG}</td> 
                        <td class="text-right font-bold text-blue-400">\${p.coinVốn.toFixed(2)}$</td> 
                        <td class="text-right pr-2 font-bold text-white font-mono">\${p.avgPrice.toFixed(5)}</td> </tr>\`
                }).join(''); 
            }

            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['marginValue','maxGrids','stepSize','tpPercent','mode'].forEach(id => { document.getElementById(id).value = d.state[id]; }); firstLoad = false; }
                    rawData = d.active; window.maxG = d.state.maxGrids; render();
                    
                    const levHtml = Object.keys(d.levGroups).sort((a,b)=>b-a).map(lev => {
                        const g = d.levGroups[lev];
                        const tPnL = g.pnl + g.closedPnl;
                        return \`<div class="lev-card">
                            <div class="text-[10px] text-gray-400">LEV x\${lev}</div>
                            <div class="text-sm font-bold \${tPnL>=0?'text-green-400':'text-red-500'}">\${tPnL.toFixed(2)}$</div>
                            <div class="text-[9px] text-gray-500">\${g.count} Coins Đang Chạy</div>
                        </div>\`;
                    }).join('');
                    document.getElementById('levStatBar').innerHTML = levHtml;

                    document.getElementById('pnlAll').innerText = d.stats.totalSystemPnl.toFixed(2) + '$';
                    document.getElementById('statClosedPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
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
