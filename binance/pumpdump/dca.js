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

function logger(msg, type = 'INFO') {
    const color = type === 'ERR' ? 'text-red-500' : (type === 'WIN' ? 'text-green-400' : (type === 'DCA' ? 'text-orange-400' : 'text-emerald-400'));
    logs.unshift(`<span class="${color}">[${new Date().toLocaleTimeString()}] [${type}] ${msg}</span>`);
    if (logs.length > 100) logs.pop();
}

// Load dữ liệu cũ
if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}

const saveAll = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
};

// Hàm lấy leverage chuẩn - Fix triệt để lỗi resolve
async function fetchActualLeverage() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        
        const req = https.get({
            hostname: 'fapi.binance.com',
            path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY },
            timeout: 10000
        }, (res) => {
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
                        logger(`Nạp ${allSymbols.length} cặp coin.`);
                    }
                } catch (e) {
                    logger("Lỗi parse leverage, sử dụng dữ liệu cũ.", "ERR");
                }
                resolve(); // Kết thúc promise ở đây
            });
        });

        req.on('error', (e) => {
            logger("Lỗi kết nối Binance: " + e.message, "ERR");
            resolve(); // Vẫn resolve để bot tiếp tục chạy
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
                if (!allSymbols.includes(t.s)) return;
                marketPrices[t.s] = parseFloat(t.c);
                const price = marketPrices[t.s];

                if (!activePositions[t.s]) {
                    activePositions[t.s] = {
                        symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                        grids: [{ price, qty: botState.marginValue, time: Date.now() }], status: 'TRADING'
                    };
                } else {
                    const pos = activePositions[t.s];
                    if (pos.status === 'WAITING') return;

                    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                    const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                    // Check Chốt lời
                    if (diffPct * 100 >= botState.tpPercent) {
                        const pnl = totalMargin * (diffPct * pos.maxLev);
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        logger(`WIN: ${t.s} | +${pnl.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                        // Chờ 5s sau mới cho vào lại lệnh mới
                        setTimeout(() => { delete activePositions[t.s]; }, 5000);
                    } 
                    // Check DCA Nhồi lệnh
                    else if (pos.grids.length < botState.maxGrids) {
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
            avgPrice = p.grids.reduce((sum, g) => sum + (p.grids.reduce((acc, grid) => acc + (grid.price * grid.qty), 0) / totalMargin)); // Fix logic avg
            avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
            const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
            pnl = totalMargin * diff * p.maxLev;
            unrealizedPnl += pnl;
        }
        return { 
            ...p, avgPrice, totalMargin, currentGrid: p.grids.length, 
            pnl, currentPrice: currentP, 
            coinVốn: botState.marginValue * p.maxLev * botState.maxGrids
        };
    });
    res.json({ state: botState, active: activeData, logs, stats: { closedPnl: botState.closedPnl, totalClosedGrids: botState.totalClosedGrids, unrealizedPnl, totalSystemPnl: botState.closedPnl + unrealizedPnl } });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) botState.running = req.body.running;
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = [];
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy DCA v47</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;font-size:10px}
    #logBox{background:#000;padding:10px;height:250px;overflow-y:auto;font-size:11px;border:1px solid #333}</style></head>
    <body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 flex flex-wrap items-end gap-3 shadow-lg border border-gray-800">
            <div>VỐN ($)<input id="marginValue" type="number" class="w-20 bg-black text-yellow-500 p-2 rounded border border-gray-700 block mt-1"></div>
            <div>DCA<input id="maxGrids" type="number" class="w-16 bg-black text-yellow-500 p-2 rounded border border-gray-700 block mt-1"></div>
            <div>GAP%<input id="stepSize" type="number" step="0.1" class="w-16 bg-black text-yellow-500 p-2 rounded border border-gray-700 block mt-1"></div>
            <div>TP%<input id="tpPercent" type="number" step="0.1" class="w-16 bg-black text-yellow-500 p-2 rounded border border-gray-700 block mt-1"></div>
            <div>MODE<select id="mode" class="w-24 bg-black p-2 rounded border border-gray-700 block mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <button onclick="sendCtrl(true)" class="bg-green-600 px-4 py-2 rounded font-bold">START</button>
            <button onclick="sendCtrl(false)" class="bg-red-600 px-4 py-2 rounded font-bold">STOP</button>
            <button onclick="resetBot()" class="bg-gray-700 px-4 py-2 rounded font-bold">RESET</button>
            <div id="status" class="ml-auto font-bold uppercase">OFFLINE</div>
        </div>
        <div class="grid grid-cols-3 gap-4 mb-4">
            <div class="bg-[#1e2329] p-3 rounded border border-gray-800 text-center"><div class="text-gray-400">ĐÃ CHỐT</div><div id="closedPnl" class="text-xl font-bold text-green-400">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded border border-gray-800 text-center"><div class="text-gray-400">ĐANG GỒNG</div><div id="unPnl" class="text-xl font-bold text-red-500">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded border border-gray-800 text-center"><div class="text-gray-400">TỔNG PNL</div><div id="totalPnl" class="text-xl font-bold text-yellow-500">0.00$</div></div>
        </div>
        <div class="bg-[#1e2329] rounded border border-gray-800 overflow-hidden mb-4">
            <table class="w-full text-left">
                <thead><tr><th>SYMBOL</th><th class="text-right">PNL</th><th class="text-center">DCA</th><th class="text-right">VỐN COIN</th><th class="text-right pr-2">AVG PRICE</th></tr></thead>
                <tbody id="list"></tbody>
            </table>
        </div>
        <div id="logBox"></div>
        <script>
            let first = true;
            async function sendCtrl(run){
                const data = {
                    running: run,
                    marginValue: Number(document.getElementById('marginValue').value),
                    maxGrids: Number(document.getElementById('maxGrids').value),
                    stepSize: Number(document.getElementById('stepSize').value),
                    tpPercent: Number(document.getElementById('tpPercent').value),
                    mode: document.getElementById('mode').value
                };
                await fetch('/api/control', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
            }
            async function resetBot(){ if(confirm('Reset?')) await fetch('/api/reset', {method:'POST'}); }
            async function update(){
                try {
                    const r = await fetch('/api/data'); const d = await r.json();
                    if(first){
                        document.getElementById('marginValue').value = d.state.marginValue;
                        document.getElementById('maxGrids').value = d.state.maxGrids;
                        document.getElementById('stepSize').value = d.state.stepSize;
                        document.getElementById('tpPercent').value = d.state.tpPercent;
                        document.getElementById('mode').value = d.state.mode;
                        first = false;
                    }
                    document.getElementById('status').innerText = d.state.running ? "RUNNING" : "STOPPED";
                    document.getElementById('status').style.color = d.state.running ? "#10b981" : "#ef4444";
                    document.getElementById('closedPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('unPnl').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    document.getElementById('totalPnl').innerText = d.stats.totalSystemPnl.toFixed(2) + '$';
                    let h = "";
                    d.active.sort((a,b)=>b.pnl - a.pnl).forEach(p => {
                        if(p.status === 'WAITING') return;
                        const c = p.pnl >= 0 ? 'text-green-400' : 'text-red-500';
                        h += '<tr class="border-b border-gray-800"><td class="p-2 font-bold text-yellow-500">'+p.symbol+' (x'+p.maxLev+')</td><td class="text-right font-bold '+c+'">'+p.pnl.toFixed(2)+'$</td><td class="text-center text-yellow-400">'+p.currentGrid+'/'+d.state.maxGrids+'</td><td class="text-right text-blue-400">'+p.coinVốn.toFixed(1)+'$</td><td class="text-right pr-2">'+p.avgPrice.toFixed(5)+'</td></tr>';
                    });
                    document.getElementById('list').innerHTML = h;
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

// Chạy khởi động
fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Bot running at http://localhost:${PORT}/gui`);
        logger("Hệ thống đã sẵn sàng.");
    });
});
