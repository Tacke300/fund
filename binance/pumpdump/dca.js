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
    const color = type === 'ERR' ? 'text-red-500' : (type === 'WIN' ? 'text-green-400' : (type === 'SYS' ? 'text-blue-400' : 'text-emerald-400'));
    logs.unshift(`<span class="${color}">[${new Date().toLocaleTimeString()}] [${type}] ${msg}</span>`);
    if (logs.length > 100) logs.pop();
    console.log(`[${type}] ${msg}`); // Đẩy ra console để debug trực tiếp
}

// Tải dữ liệu cũ
if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); allSymbols = Object.keys(symbolMaxLeverage); } catch(e){}
if (fs.existsSync(HISTORY_FILE)) try { pnlHistory = JSON.parse(fs.readFileSync(HISTORY_FILE)); } catch(e){}

const saveAll = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(pnlHistory));
};

// Lấy danh sách Symbol và Leverage từ Binance
async function fetchActualLeverage() {
    logger("Đang kết nối Binance lấy danh sách Coin...", "SYS");
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
                            symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                            allSymbols.push(item.symbol);
                        });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        logger(`Thành công: Đã nạp ${allSymbols.length} cặp giao dịch.`, "SYS");
                    } else {
                        logger("Binance trả về dữ liệu trống. Kiểm tra API Key.", "ERR");
                    }
                    resolve();
                } catch (e) { 
                    logger("Lỗi parse dữ liệu Binance.", "ERR");
                    resolve(); 
                }
            });
        }).on('error', (e) => {
            logger("Không thể kết nối API Binance: " + e.message, "ERR");
            resolve();
        });
    });
}

function initWS() {
    logger("Đang khởi tạo WebSocket...", "SYS");
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');

    ws.on('open', () => logger("WebSocket đã kết nối thành công.", "SYS"));

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
                        const size = (botState.marginValue * pos.maxLev) / price;
                        pos.grids = [{ price, margin: botState.marginValue, size: size, time: Date.now() }];
                        pos.status = 'TRADING';
                        logger(`Mở vị thế: ${t.s} | Giá: ${price}`, "SYS");
                        return;
                    }

                    const totalSize = pos.grids.reduce((sum, g) => sum + g.size, 0);
                    const totalValue = pos.grids.reduce((sum, g) => sum + (g.size * g.price), 0);
                    const avgPrice = totalValue / totalSize;
                    const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                    // Check Win
                    if (diffPct * 100 >= botState.tpPercent) {
                        const pnl = pos.side === 'LONG' ? (price - avgPrice) * totalSize : (avgPrice - price) * totalSize;
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: pnl, lev: pos.maxLev });
                        logger(`CHỐT LỜI: ${t.s} | +${pnl.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                    } 
                    // Check DCA
                    else if (pos.grids.length < botState.maxGrids) {
                        const lastEntry = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastEntry - price) / lastEntry : (price - lastEntry) / lastEntry;
                        
                        if (gap * 100 >= botState.stepSize) {
                            const nextMargin = pos.grids[pos.grids.length-1].margin * botState.multiplier;
                            const nextSize = (nextMargin * pos.maxLev) / price;
                            pos.grids.push({ price, margin: nextMargin, size: nextSize, time: Date.now() });
                            logger(`DCA ${t.s}: Tầng ${pos.grids.length} | Giá: ${price}`, "DCA");
                        }
                    }
                } else if (allSymbols.includes(t.s)) {
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                        grids: [], status: 'WAITING'
                    };
                }
            });
        } catch(e) {}
    });

    ws.on('error', (e) => logger("Lỗi WebSocket: " + e.message, "ERR"));
    ws.on('close', () => {
        logger("WebSocket bị đóng. Đang thử lại...", "ERR");
        setTimeout(initWS, 3000);
    });
}

// API Routes
app.get('/api/data', (req, res) => {
    let unrealizedPnl = 0;
    const levStats = {};

    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, avgPrice = 0, totalMargin = 0, totalSize = 0;
        
        if (p.status !== 'WAITING' && currentP > 0) {
            totalSize = p.grids.reduce((sum, g) => sum + g.size, 0);
            totalMargin = p.grids.reduce((sum, g) => sum + g.margin, 0);
            avgPrice = p.grids.reduce((sum, g) => sum + (g.size * g.price), 0) / totalSize;
            pnl = p.side === 'LONG' ? (currentP - avgPrice) * totalSize : (avgPrice - currentP) * totalSize;
            unrealizedPnl += pnl;
        }

        return { ...p, avgPrice, totalMargin, pnl, currentPrice: currentP, capital: totalMargin * p.maxLev, currentGrid: p.grids.length };
    });

    pnlHistory.forEach(h => {
        if(!levStats[h.lev]) levStats[h.lev] = { pnl: 0, count: 0 };
        levStats[h.lev].pnl += h.pnl;
        levStats[h.lev].count++;
    });

    res.json({ state: botState, active: activeData, logs, levStats, stats: { today: getFilteredPnL(0), closedPnl: botState.closedPnl, unrealizedPnl } });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) {
        botState.running = req.body.running;
        if (botState.running) {
            botState.startTime = Date.now();
            logger("BOT BẮT ĐẦU CHẠY...", "SYS");
        } else {
            logger("BOT ĐÃ DỪNG.", "SYS");
        }
    }
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode', 'multiplier'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = [];
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy DCA Matrix</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{background:#161a1e;padding:10px;font-size:10px;text-align:left;border-bottom:1px solid #333} #logBox{background:#000;padding:10px;height:300px;overflow-y:auto;font-size:11px;border:1px solid #333;margin-top:10px}
    .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); }
    .modal-content { background: #1e2329; margin: 10% auto; padding: 20px; border: 1px solid #f0b90b; width: 85%; border-radius: 8px; }</style>
    </head><body class="p-4">
        <div id="gridModal" class="modal"><div class="modal-content"><div class="flex justify-between mb-4"><h2 id="modalTitle" class="text-xl font-bold text-yellow-500"></h2><button onclick="closeModal()" class="text-red-500 text-2xl">&times;</button></div><table class="w-full text-center text-[10px]"><thead class="bg-black"><tr><th>TẦNG</th><th>MARGIN ($)</th><th>GIÁ VÀO</th><th>SIZE</th></tr></thead><tbody id="modalBody"></tbody></table></div></div>
        
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-lg">
            <div>MARGIN<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700"></div>
            <div>BỘI SỐ<input id="multiplier" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700"></div>
            <div>DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700"></div>
            <div>GAP%<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700"></div>
            <div>TP%<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700"></div>
            <div>MODE<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto"><button onclick="sendCtrl(true)" class="bg-green-600 px-6 py-2 rounded font-bold hover:bg-green-500">START</button><button onclick="sendCtrl(false)" class="bg-red-600 px-6 py-2 rounded font-bold hover:bg-red-500">STOP</button></div>
            <div class="ml-4 text-right"><div id="botStatus" class="font-bold text-red-500">OFFLINE</div></div>
        </div>

        <div id="levStatsContainer" class="flex gap-2 overflow-x-auto mb-2 text-[10px]"></div>

        <div class="bg-[#1e2329] p-4 rounded border border-gray-800 flex justify-between gap-4 mb-4">
            <div class="text-center">HÔM NAY<div id="pnlToday" class="text-xl font-bold text-green-400">0.00$</div></div>
            <div class="text-center">TỔNG LÃI ĐÃ CHỐT<div id="pnlAll" class="text-2xl font-black text-yellow-500">0.00$</div></div>
            <div class="text-center">PNL GỒNG<div id="statUnreal" class="text-xl font-bold text-white">0.00$</div></div>
        </div>

        <div class="bg-[#1e2329] rounded border border-gray-800 overflow-hidden"><table class="w-full"><thead class="bg-[#161a1e]"><tr><th>SYMBOL (DETAIL)</th><th class="text-right">VỐN (VAL)</th><th class="text-center">TẦNG</th><th class="text-right">GIÁ HIỆN TẠI / TB</th><th class="text-right">PNL GỒNG</th></tr></thead><tbody id="activeBody"></tbody></table></div>
        <div id="logBox"></div>

        <script>
            let rawData = [], firstLoad = true;
            async function sendCtrl(run){ const body = { running: run, marginValue: Number(document.getElementById('marginValue').value), multiplier: Number(document.getElementById('multiplier').value), maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            function openDetail(s){ const p = rawData.find(x => x.symbol === s); if(!p) return; document.getElementById('modalTitle').innerText = s; document.getElementById('modalBody').innerHTML = p.grids.map((g,i)=>\`<tr><td>#\${i+1}</td><td>\${g.margin.toFixed(2)}$</td><td>\${g.price}</td><td>\${g.size.toFixed(4)}</td></tr>\`).join(''); document.getElementById('gridModal').style.display='block'; }
            function closeModal(){ document.getElementById('gridModal').style.display='none'; }
            
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['marginValue','maxGrids','stepSize','tpPercent','mode','multiplier'].forEach(id => document.getElementById(id).value = d.state[id]); firstLoad = false; }
                    rawData = d.active;
                    document.getElementById('activeBody').innerHTML = d.active.filter(p=>p.currentGrid>0).sort((a,b)=>b.maxLev-a.maxLev).map(p=>\`<tr class="border-b border-gray-800">
                        <td onclick="openDetail('\${p.symbol}')" class="p-2 text-yellow-500 font-bold cursor-pointer underline">\${p.symbol} x\${p.maxLev}</td>
                        <td class="text-right text-blue-400">\${p.capital.toFixed(2)}$</td>
                        <td class="text-center text-yellow-400">\${p.currentGrid}</td>
                        <td class="text-right text-[10px]">HIỆN TẠI: \${p.currentPrice}<br>AVG: \${p.avgPrice.toFixed(5)}</td>
                        <td class="text-right font-bold \${p.pnl>=0?'text-green-500':'text-red-500'}">\${p.pnl.toFixed(2)}$</td>
                    </tr>\`).join('');
                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('pnlAll').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    document.getElementById('botStatus').innerText = d.state.running ? "RUNNING" : "STOPPED";
                    document.getElementById('botStatus').className = "font-bold " + (d.state.running ? "text-green-500" : "text-red-500");
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`HỆ THỐNG SẴN SÀNG TẠI CỔNG ${PORT}`, "SYS"));
});
