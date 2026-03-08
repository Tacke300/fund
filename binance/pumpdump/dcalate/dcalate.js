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
const PORT = 9011;

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
                    const lastGrid = pos.grids[pos.grids.length - 1];
                    const diffPct = pos.side === 'LONG' ? (price - lastGrid.price) / lastGrid.price : (lastGrid.price - price) / lastGrid.price;

                    if (diffPct * 100 >= botState.tpPercent) {
                        // Logic chốt lời tầng cuối (Partial TP)
                        const size = (lastGrid.qty * pos.maxLev) / lastGrid.price;
                        const pnl = pos.side === 'LONG' ? (price - lastGrid.price) * size : (lastGrid.price - price) * size;
                        
                        pnlHistory.push({
                            tsOpen: lastGrid.time, tsClose: Date.now(),
                            symbol: t.s, side: pos.side, lev: pos.maxLev,
                            pnl: pnl, avgPrice: lastGrid.price, closePrice: price,
                            gridsCount: pos.grids.length, totalMargin: lastGrid.qty
                        });
                        
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        logger(`WIN GRID: ${t.s} Tầng ${pos.grids.length} | +${pnl.toFixed(2)}$`, "WIN");
                        
                        pos.grids.pop();
                        if (pos.grids.length === 0) delete activePositions[t.s];
                        saveAll();
                    } else if (pos.grids.length < botState.maxGrids) {
                        const lastEntry = lastGrid.price;
                        const gap = pos.side === 'LONG' ? (lastEntry - price) / lastEntry : (price - lastEntry) / lastEntry;
                        if (gap * 100 >= botState.stepSize) {
                            pos.grids.push({ price, qty: botState.marginValue, time: Date.now() });
                            logger(`DCA: ${t.s} tầng ${pos.grids.length}`, "DCA");
                        }
                    }
                } else if (allSymbols.includes(t.s) && botState.running) {
                    // Trả lại nguyên gốc logic khởi tạo Lev của bạn
                    const maxLev = symbolMaxLeverage[t.s] || 20;
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: maxLev,
                        tsOpen: Date.now(),
                        grids: [{ price, qty: botState.marginValue, time: Date.now() }]
                    };
                }
            });
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

app.get('/api/data', (req, res) => {
    let unrealizedPnl = 0, totalGridsMatched = 0;
    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, totalSize = 0, totalCost = 0;
        p.grids.forEach(g => {
            const size = (g.qty * p.maxLev) / g.price;
            totalSize += size;
            totalCost += (g.qty * p.maxLev);
        });
        const avgPrice = totalCost / totalSize;
        if (currentP > 0) {
            pnl = p.side === 'LONG' ? (currentP - avgPrice) * totalSize : (avgPrice - currentP) * totalSize;
            unrealizedPnl += pnl;
            totalGridsMatched += p.grids.length;
        }
        const coinHistory = pnlHistory.filter(h => h.symbol === p.symbol);
        const totalClosedPnl = coinHistory.reduce((sum, h) => sum + h.pnl, 0);
        const capitalGoc = botState.marginValue * botState.maxGrids; 
        const totalRoi = capitalGoc > 0 ? ((totalClosedPnl + pnl) / capitalGoc) * 100 : 0;
        return { ...p, pnl, totalRoi, totalClosedPnl, currentPrice: currentP, capitalGoc, capitalHienTai: capitalGoc + pnl + totalClosedPnl, closedCount: coinHistory.length };
    });

    let levStats = {};
    [10, 20, 25, 30, 40, 50, 75, 100, 125, 150].forEach(l => {
        const historyLev = pnlHistory.filter(h => h.lev === l);
        const activeLev = activeData.filter(p => p.maxLev === l);
        const closed = historyLev.reduce((sum, h) => sum + h.pnl, 0);
        const unreal = activeLev.reduce((sum, p) => sum + p.pnl, 0);
        const totalPnl = closed + unreal;
        const totalCoinsAtLev = (activeLev.length || 1);
        const baseMarginAtLev = totalCoinsAtLev * botState.marginValue * botState.maxGrids;
        const totalRoi = baseMarginAtLev > 0 ? (totalPnl / baseMarginAtLev) * 100 : 0;
        if (closed !== 0 || unreal !== 0) levStats[l] = { totalPnl, totalRoi };
    });

    res.json({ 
        state: botState, active: activeData, logs, levStats, history: pnlHistory,
        stats: { today: getFilteredPnL(0), d7: getFilteredPnL(7), d30: getFilteredPnL(30), closedPnl: botState.closedPnl, unrealizedPnl, totalGridsMatched } 
    });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) { if (req.body.running && !botState.running) botState.startTime = Date.now(); botState.running = req.body.running; }
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = []; saveAll(); res.json({ status: 'ok' }); });

app.get('/gui', (req, res) => {
    // UI giữ nguyên giao diện Luffy Matrix của bạn
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix Dashboard</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{cursor:pointer;background:#161a1e;padding:10px 8px;border-bottom:1px solid #333;font-size:10px}
    #logBox{background:#000;padding:10px;height:150px;overflow-y:auto;font-size:11px;border:1px solid #333}
    .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); }
    .modal-content { background: #1e2329; margin: 2% auto; padding: 20px; border: 1px solid #f0b90b; width: 95%; max-width: 1100px; border-radius: 8px; }
    .round-card { background: #161a1e; border: 1px solid #333; padding: 10px; border-radius: 4px; cursor: pointer; transition: 0.2s; }
    .round-card:hover { border-color: #f0b90b; background: #2b3139; }</style>
    </head><body class="p-4 text-[11px]">
        <div id="gridModal" class="modal" onclick="closeModal()"><div class="modal-content" onclick="event.stopPropagation()">
            <div class="flex justify-between items-center mb-4"><h2 id="modalTitle" class="text-xl font-black text-yellow-500"></h2><button onclick="closeModal()" class="text-2xl hover:text-red-500">✕</button></div>
            <div id="roundDetail" class="hidden bg-black p-4 rounded border border-yellow-500/50 mb-4 shadow-inner"></div>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 h-[60vh] overflow-y-auto" id="roundsList"></div>
        </div></div>
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-yellow-500/20 flex flex-wrap items-end gap-3 shadow-xl">
            <div class="w-[100px]">MARGIN ($)<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">MAX DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">HƯỚNG<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-2 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-10 py-3 rounded font-black text-sm hover:scale-105 transition-all">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-10 py-3 rounded font-black text-sm hover:scale-105 transition-all">STOP</button>
                <button onclick="resetBot()" class="bg-gray-800 px-4 py-3 rounded text-[9px] hover:bg-black transition-all">RESET</button>
            </div>
        </div>
        <div id="levStats" class="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-10 gap-1 mb-2"></div>
        <div class="grid grid-cols-5 gap-1 mb-2">
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">LƯỚI ĐANG GỒNG</div><div id="statGridsMatched" class="font-bold text-orange-400 text-lg">0</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">HÔM NAY</div><div id="pnlToday" class="font-bold text-green-400 text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">7 NGÀY</div><div id="pnl7d" class="font-bold text-green-500 text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">ĐÃ CHỐT TỔNG</div><div id="statClosedPnl" class="font-bold text-yellow-500 text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[8px]">ĐANG GỒNG PNL</div><div id="statUnreal" class="font-bold text-white text-lg">0.00$</div></div>
        </div>
        <div class="bg-[#1e2329] rounded border border-gray-800 mb-2 overflow-hidden shadow-2xl">
            <table class="w-full text-left">
                <thead class="bg-[#161a1e]"><tr>
                    <th class="p-2 w-10 text-center">STT</th>
                    <th onclick="setSort('symbol')">COIN ↕</th>
                    <th onclick="setSort('closedCount')" class="text-center">VÒNG ↕</th>
                    <th onclick="setSort('maxLev')" class="text-center">LEV ↕</th>
                    <th onclick="setSort('grids.length')" class="text-center">TẦNG ↕</th>
                    <th onclick="setSort('pnl')" class="text-right">GỒNG PNL ($) ↕</th>
                    <th onclick="setSort('totalClosedPnl')" class="text-right">TỔNG PNL ($) ↕</th>
                    <th onclick="setSort('totalRoi')" class="text-center pr-4">ROI TỔNG % ↕</th>
                </tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>
        <div id="logBox"></div>
        <script>
            let sortKey = 'maxLev', sortDir = -1, rawData = [], historyData = [], firstLoad = true;
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            async function sendCtrl(run){ const body = { running: run, marginValue: Number(document.getElementById('marginValue').value), maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            async function resetBot(){ if(confirm('RESET TẤT CẢ DỮ LIỆU?')) await fetch('/api/reset',{method:'POST'}); }
            function openDetail(symbol){
                const rounds = historyData.filter(h => h.symbol === symbol).reverse();
                document.getElementById('modalTitle').innerText = symbol + " - LỊCH SỬ";
                document.getElementById('roundsList').innerHTML = rounds.map((r, i) => \`<div class="round-card" onclick="showRoundDetail('\${r.tsClose}')"><div class="flex justify-between mb-1"><span class="font-black text-yellow-500">#\${rounds.length-i}</span><span class="\${r.pnl>=0?'text-green-400':'text-red-500'} font-bold">+\${r.pnl.toFixed(2)}$</span></div><div class="text-[9px] text-gray-400">TẦNG \${r.gridsCount} | \${new Date(r.tsClose).toLocaleTimeString()}</div></div>\`).join('');
                document.getElementById('gridModal').style.display = "block";
            }
            function closeModal(){ document.getElementById('gridModal').style.display = "none"; }
            function render(){ 
                const sorted = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir); 
                document.getElementById('activeBody').innerHTML = sorted.map((p, i)=> \`<tr class="border-b border-gray-800 hover:bg-[#2b3139]"><td class="p-2 text-gray-500 text-center">\${i+1}</td><td onclick="openDetail('\${p.symbol}')" class="p-2 font-bold text-yellow-500 cursor-pointer underline">\${p.symbol}</td><td class="text-center text-blue-400 font-bold">\${p.closedCount}</td><td class="text-center text-purple-400">x\${p.maxLev}</td><td class="text-center font-bold text-orange-400">\${p.grids.length}</td><td class="text-right font-bold \${p.pnl>=0?'text-green-500':'text-red-500'}">\${p.pnl.toFixed(2)}$</td><td class="text-right font-bold text-emerald-400">\${p.totalClosedPnl.toFixed(2)}$</td><td class="text-center pr-4 font-bold \${p.totalRoi>=0?'text-green-400':'text-red-400'}">\${p.totalRoi.toFixed(1)}%</td></tr>\`).join(''); 
            }
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['marginValue','maxGrids','stepSize','tpPercent','mode'].forEach(id => document.getElementById(id).value = d.state[id]); firstLoad = false; }
                    rawData = d.active; historyData = d.history; render();
                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('pnl7d').innerText = d.stats.d7.toFixed(2) + '$';
                    document.getElementById('statClosedPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    document.getElementById('statGridsMatched').innerText = d.stats.totalGridsMatched;
                    document.getElementById('levStats').innerHTML = Object.entries(d.levStats).map(([lev, val]) => \`<div class="bg-[#1e2329] p-2 border border-gray-800 rounded text-center"><div class="text-[7px] text-gray-500">LEV X\${lev}</div><div class="text-yellow-500 font-bold">\${val.totalPnl.toFixed(1)}$</div><div class="text-[8px] \${val.totalRoi>=0?'text-green-400':'text-red-400'}">ROI \${val.totalRoi.toFixed(1)}%</div></div>\`).join('');
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
