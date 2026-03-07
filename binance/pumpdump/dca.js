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

// BotState: Ẩn totalBalance, tập trung vào Margin và các tham số DCA
let botState = { 
    running: false, startTime: null, marginValue: 10, marginType: '$',
    maxGrids: 20, stepSize: 1.0, multiplier: 1.0, tpPercent: 1.0, mode: 'LONG', 
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
                        pos.grids = [{ price, qty: botState.marginValue, time: Date.now() }];
                        pos.status = 'TRADING';
                        return;
                    }

                    // Logic DCA: Tính giá trung bình và TP
                    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                    const tpPrice = pos.side === 'LONG' ? avgPrice * (1 + botState.tpPercent/100) : avgPrice * (1 - botState.tpPercent/100);
                    
                    const isWin = pos.side === 'LONG' ? price >= tpPrice : price <= tpPrice;

                    if (isWin) {
                        const diffPct = Math.abs(price - avgPrice) / avgPrice;
                        const pnl = totalMargin * diffPct * pos.maxLev;
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: pnl, lev: pos.maxLev });
                        logger(`WIN: ${t.s} | Lưới: ${pos.grids.length} | +${pnl.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                    } else if (pos.grids.length < botState.maxGrids) {
                        const lastPrice = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastPrice - price) / lastPrice : (price - lastPrice) / lastPrice;
                        if (gap * 100 >= botState.stepSize) {
                            const nextQty = pos.grids[pos.grids.length-1].qty * botState.multiplier;
                            pos.grids.push({ price, qty: nextQty, time: Date.now() });
                            logger(`DCA: ${t.s} | Tầng: ${pos.grids.length}`, "DCA");
                        }
                    }
                } else if (allSymbols.includes(t.s)) {
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                        grids: [{ price, qty: botState.marginValue, time: Date.now() }], status: 'TRADING'
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
    
    // Thống kê theo đòn bẩy
    const levStats = {};

    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, avgPrice = 0, totalMargin = 0, tpPrice = 0;
        
        if (p.status !== 'WAITING' && currentP > 0) {
            totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
            avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
            const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
            pnl = totalMargin * diff * p.maxLev;
            tpPrice = p.side === 'LONG' ? avgPrice * (1 + botState.tpPercent/100) : avgPrice * (1 - botState.tpPercent/100);
            
            gridsGong += p.grids.length;
            unrealizedPnl += pnl;
        }

        return { 
            ...p, avgPrice, totalMargin, tpPrice, currentGrid: p.grids.length, 
            pnl, currentPrice: currentP
        };
    });

    // Gom nhóm PnL theo Leverage
    pnlHistory.forEach(h => {
        if(!levStats[h.lev]) levStats[h.lev] = { pnl: 0, count: 0 };
        levStats[h.lev].pnl += h.pnl;
        levStats[h.lev].count++;
    });

    res.json({ 
        state: botState, active: activeData, logs, levStats,
        stats: { 
            today: getFilteredPnL(0), d7: getFilteredPnL(7), d30: getFilteredPnL(30),
            closedPnl: botState.closedPnl, totalClosedGrids: botState.totalClosedGrids,
            unrealizedPnl: unrealizedPnl,
            runningCoins: activeData.filter(x => x.status !== 'WAITING').length,
            gridsGong
        }
    });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) {
        if (req.body.running && !botState.running) botState.startTime = Date.now();
        botState.running = req.body.running;
    }
    ['marginValue', 'marginType', 'maxGrids', 'stepSize', 'tpPercent', 'mode', 'multiplier'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = [];
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy DCA Matrix</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;overflow-x:hidden} 
        th{cursor:pointer;background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;text-transform:uppercase;font-size:10px} 
        th:hover{color:#f0b90b} 
        #logBox{background:#000;padding:10px;height:200px;overflow-y:auto;font-size:11px;border:1px solid #333;border-radius:4px}
        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); backdrop-filter: blur(4px); }
        .modal-content { background: #1e2329; margin: 5% auto; padding: 20px; border: 1px solid #f0b90b; width: 90%; max-width: 1000px; border-radius: 8px; }
        .lev-card { background: #1e2329; border: 1px solid #333; padding: 10px; border-radius: 4px; min-width: 100px; text-align: center; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-thumb { background: #333; }
    </style></head><body class="p-4 text-[11px]">
        
        <div id="gridModal" class="modal"><div class="modal-content shadow-2xl">
            <div class="flex justify-between border-b border-gray-700 pb-2 mb-4">
                <div>
                    <h2 id="modalTitle" class="text-xl font-bold text-yellow-500 italic"></h2>
                    <p id="modalSub" class="text-gray-400 text-[10px]"></p>
                </div>
                <button onclick="closeModal()" class="text-3xl text-red-500">&times;</button>
            </div>
            <table class="w-full text-center text-[11px]">
                <thead class="bg-black text-gray-400">
                    <tr><th>TẦNG DCA</th><th>MARGIN ($)</th><th>GIÁ KHỚP</th><th>THỜI GIAN</th></tr>
                </thead>
                <tbody id="modalBody"></tbody>
            </table>
            <div class="mt-4 p-3 bg-black rounded border border-gray-800 flex justify-between">
                <div class="text-blue-400">GIÁ TRUNG BÌNH: <span id="modalAvg" class="font-bold"></span></div>
                <div class="text-green-400">MỤC TIÊU TP: <span id="modalTp" class="font-bold"></span></div>
            </div>
        </div></div>

        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-lg">
            <div class="w-[120px]">MARGIN KHỞI ĐẦU<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">BỘI SỐ DCA<input id="multiplier" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">MAX DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">KHOẢNG CÁCH%<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">CHỐT LỜI%<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">CHẾ ĐỘ<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG Only</option><option value="SHORT">SHORT Only</option></select></div>
            <div class="flex gap-1 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-6 py-2 rounded font-bold hover:bg-green-500 shadow-lg">BẮT ĐẦU</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-6 py-2 rounded font-bold hover:bg-red-500 shadow-lg">DỪNG</button>
                <button onclick="resetBot()" class="bg-gray-700 px-3 py-2 rounded font-bold text-[9px]">LÀM MỚI</button>
            </div>
            <div class="border-l border-gray-700 pl-4 text-right"><div id="uptime" class="text-yellow-500 font-bold text-sm">0d 00:00:00</div><div id="botStatus" class="font-bold text-[9px] italic text-red-500">OFFLINE</div></div>
        </div>

        <div id="levStatsContainer" class="flex gap-2 overflow-x-auto mb-2 pb-2"></div>

        <div class="bg-[#1e2329] p-3 rounded-t-lg border-x border-t border-gray-800 flex justify-between gap-2 shadow-inner">
            <div class="text-center flex-1 text-gray-400">HÔM NAY (7AM)<div id="pnlToday" class="text-lg font-bold text-green-400">0.00$</div></div>
            <div class="text-center flex-1 border-x border-gray-800 text-gray-400">7 NGÀY<div id="pnl7d" class="text-lg font-bold text-green-500">0.00$</div></div>
            <div class="text-center flex-1 text-yellow-500 font-bold border-r border-gray-800">TỔNG LỢI NHUẬN ĐÃ CHỐT<div id="pnlAll" class="text-2xl font-black">0.00$</div></div>
            <div class="text-center flex-1 text-gray-400 font-bold">LƯỚI ĐÃ CHỐT<div id="statClosedGrids" class="text-2xl font-black text-purple-400">0</div></div>
        </div>

        <div class="bg-[#161a1e] p-2 flex justify-around border-x border-b border-gray-800 text-[10px] font-bold mb-4 text-gray-300">
            <div>ĐANG CHẠY: <span id="statCoins" class="text-blue-400">0</span> COINS</div>
            <div>TỔNG TẦNG DCA: <span id="statGrids" class="text-orange-400">0</span></div>
            <div>PNL TẠM TÍNH (GỒNG): <span id="statUnreal" class="text-red-400">0.00$</span></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-4 overflow-hidden shadow-xl">
            <table class="w-full text-left">
                <thead class="bg-[#161a1e]"><tr>
                    <th onclick="setSort('maxLev')">SYMBOL | MAX LEV ↕</th>
                    <th class="text-right">GIÁ HIỆN TẠI</th>
                    <th class="text-center" onclick="setSort('currentGrid')">TẦNG HIỆN TẠI ↕</th>
                    <th class="text-right">GIÁ TB / TP</th>
                    <th class="text-right pr-2" onclick="setSort('pnl')">PNL GỒNG ($) ↕</th>
                </tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>
        <div id="logBox"></div>

        <script>
            let sortKey = 'maxLev', sortDir = -1, rawData = [], firstLoad = true;
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            
            async function sendCtrl(run){ 
                const body = { 
                    running: run, 
                    marginValue: Number(document.getElementById('marginValue').value), 
                    multiplier: Number(document.getElementById('multiplier').value),
                    maxGrids: Number(document.getElementById('maxGrids').value), 
                    stepSize: Number(document.getElementById('stepSize').value), 
                    tpPercent: Number(document.getElementById('tpPercent').value), 
                    mode: document.getElementById('mode').value 
                }; 
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); 
            }

            async function resetBot(){ if(confirm('XÓA TẤT CẢ DỮ LIỆU?')) await fetch('/api/reset',{method:'POST'}); }
            
            function openDetail(symbol){
                const p = rawData.find(x => x.symbol === symbol);
                if(!p || p.status === 'WAITING') return;
                document.getElementById('modalTitle').innerText = symbol + " (MAX LEV: x" + p.maxLev + ")";
                document.getElementById('modalSub').innerText = "Vị thế " + p.side + " - Tổng Margin: " + p.totalMargin.toFixed(2) + "$";
                document.getElementById('modalAvg').innerText = p.avgPrice.toFixed(5);
                document.getElementById('modalTp').innerText = p.tpPrice.toFixed(5);
                document.getElementById('modalBody').innerHTML = p.grids.map((g, i) => \`
                    <tr class="border-b border-gray-800">
                        <td class="p-3 text-yellow-500 font-bold">TẦNG #\${i+1}</td>
                        <td class="font-mono">\${g.qty.toFixed(2)}$</td>
                        <td class="font-mono text-white">\${g.price.toFixed(5)}</td>
                        <td class="text-gray-500">\${new Date(g.time).toLocaleTimeString()}</td>
                    </tr>\`).join('');
                document.getElementById('gridModal').style.display = "block";
            }
            function closeModal(){ document.getElementById('gridModal').style.display = "none"; }

            function render(){ 
                const sorted = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir); 
                document.getElementById('activeBody').innerHTML = sorted.map(p=>{
                    if(p.status==='WAITING') return '';
                    return \`<tr class="border-b border-gray-800 hover:bg-[#2b3139]"> 
                        <td onclick="openDetail('\${p.symbol}')" class="p-3 font-bold text-yellow-500 font-mono cursor-pointer">
                            <span class="underline decoration-dotted">\${p.symbol}</span> 
                            <span class="ml-2 text-gray-500 text-[9px]">x\${p.maxLev}</span>
                        </td> 
                        <td class="text-right font-mono">\${p.currentPrice.toFixed(5)}</td> 
                        <td class="text-center font-bold \${p.currentGrid > 5 ? 'text-red-400' : 'text-yellow-400'}">\${p.currentGrid}</td> 
                        <td class="text-right text-[10px] text-gray-400">
                            <div>TB: \${p.avgPrice.toFixed(5)}</div>
                            <div class="text-green-500">TP: \${p.tpPrice.toFixed(5)}</div>
                        </td> 
                        <td class="text-right pr-2 font-bold \${p.pnl>=0?'text-green-500':'text-red-500'} font-mono">\${p.pnl.toFixed(2)}$</td> </tr>\`
                }).join(''); 
            }

            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { 
                        ['marginValue','maxGrids','stepSize','tpPercent','mode','multiplier'].forEach(id => {
                            if(d.state[id] !== undefined) document.getElementById(id).value = d.state[id];
                        }); 
                        firstLoad = false; 
                    }
                    rawData = d.active; render();
                    
                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('pnl7d').innerText = d.stats.d7.toFixed(2) + '$';
                    document.getElementById('pnlAll').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statClosedGrids').innerText = d.stats.totalClosedGrids;
                    document.getElementById('statCoins').innerText = d.stats.runningCoins;
                    document.getElementById('statGrids').innerText = d.stats.gridsGong;
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    
                    // Render Lev Stats
                    let levHtml = '';
                    Object.keys(d.levStats).sort((a,b)=>b-a).forEach(lev => {
                        const s = d.levStats[lev];
                        levHtml += \`<div class="lev-card shadow-md border-yellow-900/30">
                            <div class="text-[9px] text-gray-500">LEVERAGE x\${lev}</div>
                            <div class="text-sm font-bold \${s.pnl>=0?'text-green-400':'text-red-400'}">\${s.pnl.toFixed(2)}$</div>
                            <div class="text-[8px] text-purple-400">\${s.count} Lệnh</div>
                        </div>\`;
                    });
                    document.getElementById('levStatsContainer').innerHTML = levHtml;

                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    document.getElementById('botStatus').innerText = d.state.running ? "BOT ĐANG CHẠY" : "BOT ĐANG DỪNG";
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

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`SYSTEM READY: http://localhost:${PORT}/gui`));
});
