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
    if (days === 0) {
        if (now.getHours() < 7) startTime.setDate(now.getDate() - 1);
        startTime.setHours(7, 0, 0, 0);
    } else {
        startTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }
    return pnlHistory.filter(h => h.ts >= startTime.getTime()).reduce((sum, h) => sum + h.pnl, 0);
}

async function fetchActualLeverage() {
    logger("Đang lấy dữ liệu đòn bẩy từ Binance...");
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const options = {
            hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 10000
        };
        const req = https.get(options, (res) => {
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
                        logger(`Nạp ${allSymbols.length} coin thành công.`, "INFO");
                    } else { throw new Error("Data format error"); }
                    resolve();
                } catch (e) { 
                    logger("Lỗi API đòn bẩy, đang dùng dự phòng...", "ERR");
                    fallbackSymbols().then(resolve); 
                }
            });
        });
        req.on('error', () => {
            logger("Kết nối Binance thất bại, dùng dữ liệu cũ...", "ERR");
            fallbackSymbols().then(resolve);
        });
        req.end();
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
                    logger(`Đã nạp ${allSymbols.length} coin (Dự phòng).`);
                } catch(e) { logger("Không thể lấy danh sách coin!", "ERR"); }
                resolve();
            });
        }).on('error', () => resolve());
    });
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('open', () => logger("Kết nối WebSocket thành công. Đang đợi tín hiệu...", "INFO"));
    ws.on('message', (data) => {
        if (!botState.running) return;
        try {
            const tickers = JSON.parse(data);
            tickers.forEach(t => {
                marketPrices[t.s] = parseFloat(t.c);
                const price = marketPrices[t.s];

                if (activePositions[t.s]) {
                    const pos = activePositions[t.s];
                    if (pos.status === 'WAITING') return;

                    let totalSize = 0, totalCost = 0;
                    pos.grids.forEach(g => {
                        const size = (g.qty * pos.maxLev) / g.price;
                        totalSize += size;
                        totalCost += (g.qty * pos.maxLev);
                    });
                    const avgPrice = totalCost / totalSize;
                    const pnl = pos.side === 'LONG' ? (price - avgPrice) * totalSize : (avgPrice - price) * totalSize;
                    const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                    if (diffPct * 100 >= botState.tpPercent) {
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: pnl, lev: pos.maxLev });
                        logger(`CHỐT LỜI: ${t.s} | +${pnl.toFixed(2)}$ | DCA: ${pos.grids.length}`, "WIN");
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
                } else if (allSymbols.includes(t.s) && botState.running) {
                    const maxLev = symbolMaxLeverage[t.s] || 20;
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: maxLev,
                        grids: [{ price, qty: botState.marginValue, time: Date.now() }], 
                        status: 'TRADING'
                    };
                }
            });
        } catch(e) {}
    });
    ws.on('error', (e) => logger("Lỗi WebSocket: " + e.message, "ERR"));
    ws.on('close', () => {
        logger("Mất kết nối WebSocket, đang thử lại...", "ERR");
        setTimeout(initWS, 3000);
    });
}

app.get('/api/data', (req, res) => {
    let unrealizedPnl = 0, gridsGong = 0;
    let levStats = {};

    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, avgPrice = 0, totalSize = 0, totalCost = 0;
        if (p.status !== 'WAITING' && currentP > 0) {
            p.grids.forEach(g => {
                const size = (g.qty * p.maxLev) / g.price;
                totalSize += size;
                totalCost += (g.qty * p.maxLev);
            });
            avgPrice = totalCost / totalSize;
            pnl = p.side === 'LONG' ? (currentP - avgPrice) * totalSize : (avgPrice - currentP) * totalSize;
            unrealizedPnl += pnl;
            gridsGong += p.grids.length;
        }
        const autoCap = botState.marginValue * p.maxLev * botState.maxGrids;
        return { ...p, avgPrice, currentGrid: p.grids.length, pnl, currentPrice: currentP, autoCapital: autoCap, displayBalance: autoCap + pnl };
    });

    [10, 20, 25, 30, 40, 50, 75, 100, 125].forEach(l => {
        const closed = pnlHistory.filter(h => h.lev === l).reduce((sum, h) => sum + h.pnl, 0);
        const unreal = activeData.filter(p => p.maxLev === l).reduce((sum, p) => sum + p.pnl, 0);
        const count = activeData.filter(p => p.maxLev === l && p.status !== 'WAITING').length;
        const cap = count * (botState.marginValue * l * botState.maxGrids);
        if (closed !== 0 || unreal !== 0) levStats[l] = { closed, unreal, roi: cap > 0 ? ((closed + unreal) / cap * 100) : 0 };
    });

    res.json({ state: botState, active: activeData, logs, levStats, stats: { today: getFilteredPnL(0), closedPnl: botState.closedPnl, totalClosedGrids: botState.totalClosedGrids, unrealizedPnl, runningCoins: activeData.filter(x => x.status !== 'WAITING').length, gridsGong } });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) { 
        if (req.body.running) {
            if (!botState.running) {
                botState.startTime = Date.now();
                activePositions = {}; // Clear để quét lại lệnh mới khi bấm Start
                logger("BOT BẮT ĐẦU CHẠY...", "WIN");
            }
        } else {
            logger("BOT ĐÃ DỪNG.", "ERR");
        }
        botState.running = req.body.running; 
    }
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = []; saveAll(); res.json({ status: 'ok' }); });

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix DCA</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{cursor:pointer;background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;font-size:10px} th:hover{color:#f0b90b} #logBox{background:#000;padding:10px;height:220px;overflow-y:auto;font-size:11px;border:1px solid #333}
    .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); }
    .modal-content { background: #1e2329; margin: 10% auto; padding: 20px; border: 1px solid #f0b90b; width: 400px; border-radius: 8px; text-align:center; }</style>
    </head><body class="p-4 text-[11px]">
        <div id="gridModal" class="modal" onclick="closeModal()"><div class="modal-content" onclick="event.stopPropagation()">
            <h2 id="modalTitle" class="text-xl font-bold text-yellow-500 mb-4"></h2>
            <div class="text-gray-400 mb-2">SỐ LƯỚI DCA ĐANG GỒNG</div>
            <div id="modalGrids" class="text-6xl font-black text-white mb-4">0</div>
            <div id="modalInfo" class="text-left bg-black p-4 rounded border border-gray-800 space-y-2"></div>
        </div></div>

        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-lg">
            <div class="w-[120px]">MARGIN ($)<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">MAX DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">HƯỚNG<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-6 py-2 rounded font-bold hover:bg-green-500 text-sm">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-6 py-2 rounded font-bold hover:bg-red-500 text-sm">STOP</button>
                <button onclick="resetBot()" class="bg-gray-700 px-3 py-2 rounded font-bold text-[9px]">RESET</button>
            </div>
            <div id="statusIndicator" class="ml-4 px-3 py-1 rounded-full font-bold text-[10px]">OFFLINE</div>
        </div>

        <div id="levStats" class="grid grid-cols-3 md:grid-cols-9 gap-1 mb-2 text-[10px]"></div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-2 overflow-hidden shadow-xl">
            <table class="w-full text-left">
                <thead class="bg-[#161a1e]"><tr>
                    <th onclick="setSort('symbol')">SYMBOL (XẾP THEO LEV) ↕</th>
                    <th class="text-center" onclick="setSort('maxLev')">MAX LEV ↕</th>
                    <th class="text-right" onclick="setSort('autoCapital')">VỐN TỰ ĐỘNG ↕</th>
                    <th class="text-center" onclick="setSort('currentGrid')">LƯỚI DCA ↕</th>
                    <th class="text-right pr-4" onclick="setSort('pnl')">PNL TẠM TÍNH ↕</th>
                </tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>
        <div id="logBox"></div>

        <script>
            let sortKey = 'maxLev', sortDir = -1, rawData = [], firstLoad = true;
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            async function sendCtrl(run){ const body = { running: run, marginValue: Number(document.getElementById('marginValue').value), maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            async function resetBot(){ if(confirm('XOÁ HẾT DỮ LIỆU?')) await fetch('/api/reset',{method:'POST'}); }
            
            function openDetail(symbol){
                const p = rawData.find(x => x.symbol === symbol); if(!p || p.status === 'WAITING') return;
                document.getElementById('modalTitle').innerText = symbol;
                document.getElementById('modalGrids').innerText = p.currentGrid;
                document.getElementById('modalInfo').innerHTML = \`<div>Giá entry TB: <span class="text-yellow-500 font-bold">\${p.avgPrice.toFixed(5)}</span></div><div>Giá hiện tại: <span class="text-white font-bold">\${p.currentPrice.toFixed(5)}</span></div><div>PNL: <span class="\${p.pnl>=0?'text-green-400':'text-red-500'} font-bold">\${p.pnl.toFixed(2)}$</span></div>\`;
                document.getElementById('gridModal').style.display = "block";
            }
            function closeModal(){ document.getElementById('gridModal').style.display = "none"; }

            function render(){ 
                const sorted = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir); 
                document.getElementById('activeBody').innerHTML = sorted.map(p=>{
                    return \`<tr class="border-b border-gray-800 hover:bg-[#2b3139] \${p.status==='WAITING'?'opacity-20':''}"> 
                        <td onclick="openDetail('\${p.symbol}')" class="p-2 font-bold text-yellow-500 cursor-pointer underline">\${p.symbol}</td> 
                        <td class="text-center font-bold text-purple-400">x\${p.maxLev}</td>
                        <td class="text-right font-mono text-gray-400">\${p.autoCapital.toFixed(0)}$</td> 
                        <td class="text-center font-bold text-orange-400">\${p.currentGrid}</td> 
                        <td class="text-right pr-4 font-bold \${p.pnl>=0?'text-green-500':'text-red-500'}">\${p.pnl.toFixed(2)}$</td> </tr>\`
                }).join(''); 
            }

            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['marginValue','maxGrids','stepSize','tpPercent','mode'].forEach(id => document.getElementById(id).value = d.state[id]); firstLoad = false; }
                    rawData = d.active; render();
                    
                    const si = document.getElementById('statusIndicator');
                    si.innerText = d.state.running ? "RUNNING" : "STOPPED";
                    si.className = "ml-4 px-3 py-1 rounded-full font-bold text-[10px] " + (d.state.running ? "bg-green-900 text-green-400" : "bg-red-900 text-red-400");

                    document.getElementById('levStats').innerHTML = Object.entries(d.levStats).map(([lev, val]) => \`
                        <div class="bg-[#1e2329] p-1 border border-gray-800 rounded text-center">
                            <div class="text-gray-500">X\${lev}</div>
                            <div class="text-green-400 font-bold">\${val.closed.toFixed(1)}</div>
                            <div class="\${val.roi>=0?'text-yellow-500':'text-red-400'} font-black">\${val.roi.toFixed(1)}%</div>
                        </div>\`).join('');
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

// Chạy khởi tạo
fetchActualLeverage().then(() => { 
    initWS(); 
    app.listen(PORT, '0.0.0.0', () => logger(`BOT READY: http://localhost:${PORT}/gui`)); 
});
