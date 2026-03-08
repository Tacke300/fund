import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
app.use(express.json());

const STATE_FILE = './bot_state_9022.json';
const LEVERAGE_FILE = './leverage_cache.json';
const HISTORY_FILE = './pnl_history.json';
const PORT = 9022; // Đã đổi sang 9022 theo ý ông

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

// Load dữ liệu cũ
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

// LẤY LEVERAGE TỪ BINANCE - KHÔNG TỰ GÁN X20
async function fetchActualLeverage() {
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
                    brackets.forEach(item => {
                        symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                    });
                    fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                    logger(`Nạp Max Lev thành công cho ${brackets.length} cặp`, "WIN");
                } else if (brackets.code) {
                    logger(`Binance Reject: ${brackets.msg}`, "ERR");
                }
            } catch (e) { logger("Lỗi giải mã dữ liệu đòn bẩy", "ERR"); }
        });
    }).on('error', (err) => { logger("Kết nối Binance lấy Lev thất bại: " + err.message, "ERR"); });
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
                    const currentIdx = pos.grids.length - 1;
                    const lastGrid = pos.grids[currentIdx];

                    // TP THEO MỐC LƯỚI TRÊN (Chuẩn lưới sàn)
                    let targetTP;
                    if (pos.grids.length > 1) {
                        targetTP = pos.grids[currentIdx - 1].price;
                    } else {
                        targetTP = pos.side === 'LONG' ? lastGrid.price * (1 + botState.tpPercent/100) : lastGrid.price * (1 - botState.tpPercent/100);
                    }

                    const isTP = pos.side === 'LONG' ? (price >= targetTP) : (price <= targetTP);

                    if (isTP) {
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
                    // CHỈ VÀO LỆNH NẾU CÓ LEV TRONG CACHE (KHÔNG TỰ GÁN 20)
                    const mLev = symbolMaxLeverage[t.s];
                    if (mLev) {
                        activePositions[t.s] = {
                            symbol: t.s, side: botState.mode, maxLev: mLev,
                            tsOpen: Date.now(),
                            grids: [{ price, qty: botState.marginValue, time: Date.now() }]
                        };
                    }
                }
            });
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

// API VÀ GUI (GIỮ NGUYÊN GIAO DIỆN LUFFY CỦA ÔNG)
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
        return { ...p, pnl, totalClosedPnl: coinHistory.reduce((s, h) => s + h.pnl, 0), currentPrice: currentP, closedCount: coinHistory.length };
    });

    res.json({ 
        state: botState, active: activeData, logs, history: pnlHistory,
        stats: { today: getFilteredPnL(0), d7: getFilteredPnL(7), closedPnl: botState.closedPnl, unrealizedPnl, totalGridsMatched } 
    });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) botState.running = req.body.running;
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { activePositions = {}; botState.closedPnl = 0; logs = []; pnlHistory = []; saveAll(); res.json({ status: 'ok' }); });

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix 9022</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} #logBox{background:#000;padding:10px;height:180px;overflow-y:auto;font-size:11px;border:1px solid #333;color:#00ff41}</style>
    </head><body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-yellow-500/20 flex flex-wrap items-end gap-3 shadow-xl">
            <div class="w-[100px]">MARGIN ($)<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">MAX DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">HƯỚNG<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-2 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-10 py-3 rounded font-black text-sm hover:scale-105 transition-all">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-10 py-3 rounded font-black text-sm hover:scale-105 transition-all">STOP</button>
            </div>
        </div>
        <div class="grid grid-cols-4 gap-1 mb-2 text-center font-bold">
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800"><div class="text-gray-500 text-[8px]">HÔM NAY</div><div id="pnlToday" class="text-green-400 text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800"><div class="text-gray-500 text-[8px]">TỔNG CHỐT</div><div id="statClosedPnl" class="text-yellow-500 text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800"><div class="text-gray-500 text-[8px]">ĐANG GỒNG</div><div id="statUnreal" class="text-white text-lg">0.00$</div></div>
            <div class="bg-[#1e2329] p-2 rounded border border-gray-800"><div class="text-gray-500 text-[8px]">LƯỚI KHỚP</div><div id="statGridsMatched" class="text-orange-400 text-lg">0</div></div>
        </div>
        <div class="bg-[#1e2329] rounded border border-gray-800 mb-2 overflow-hidden shadow-2xl">
            <table class="w-full text-left"><thead class="bg-[#161a1e]"><tr><th class="p-2">COIN</th><th class="text-center">VÒNG</th><th class="text-center">LEV</th><th class="text-center">TẦNG</th><th class="text-right">GỒNG PNL</th><th class="text-right pr-4">TỔNG PNL</th></tr></thead>
            <tbody id="activeBody"></tbody></table>
        </div>
        <div id="logBox"></div>
        <script>
            let firstLoad = true;
            async function sendCtrl(run){ const body = { running: run, marginValue: Number(document.getElementById('marginValue').value), maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['marginValue','maxGrids','stepSize','tpPercent','mode'].forEach(id => document.getElementById(id).value = d.state[id]); firstLoad = false; }
                    document.getElementById('activeBody').innerHTML = d.active.map(p => \`<tr class="border-b border-gray-800"><td class="p-2 font-bold text-yellow-500">\${p.symbol}</td><td class="text-center text-blue-400">\${p.closedCount}</td><td class="text-center text-purple-400">x\${p.maxLev}</td><td class="text-center text-orange-400">\${p.grids.length}</td><td class="text-right font-bold \${p.pnl>=0?'text-green-500':'text-red-500'}">\${p.pnl.toFixed(2)}$</td><td class="text-right pr-4 text-emerald-400">\${p.totalClosedPnl.toFixed(2)}$</td></tr>\`).join('');
                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('statClosedPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    document.getElementById('statGridsMatched').innerText = d.stats.totalGridsMatched;
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

// Khởi động
initSymbols().then(() => { 
    initWS(); 
    app.listen(PORT, '0.0.0.0', () => logger(`DASHBOARD 9022: http://localhost:${PORT}/gui`)); 
    fetchActualLeverage(); 
    setInterval(fetchActualLeverage, 600000); 
});
