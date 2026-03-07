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
    const color = type === 'ERR' ? 'text-red-500' : (type === 'WIN' ? 'text-green-400' : (type === 'DCA' ? 'text-yellow-400' : 'text-emerald-400'));
    logs.unshift(`<span class="${color}">[${new Date().toLocaleTimeString()}] [${type}] ${msg}</span>`);
    if (logs.length > 100) logs.pop();
}

if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); allSymbols = Object.keys(symbolMaxLeverage); } catch(e){}
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
                        logger(`Hệ thống: Đã nạp ${allSymbols.length} coin.`, "SYS");
                    }
                    resolve();
                } catch (e) { resolve(); }
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
                    if (pos.status === 'WAITING') {
                        const size = (botState.marginValue * pos.maxLev) / price;
                        pos.grids = [{ price, margin: botState.marginValue, size: size, time: Date.now() }];
                        pos.status = 'TRADING';
                        logger(`Mở lệnh: ${t.s} | Giá: ${price}`, "SYS");
                        return;
                    }

                    // TÍNH TOÁN THEO CHUẨN SÀN (Sử dụng Size coin)
                    const totalSize = pos.grids.reduce((sum, g) => sum + g.size, 0);
                    const totalValue = pos.grids.reduce((sum, g) => sum + (g.size * g.price), 0);
                    const avgPrice = totalValue / totalSize;
                    
                    const pnl = pos.side === 'LONG' ? (price - avgPrice) * totalSize : (avgPrice - price) * totalSize;
                    const diffPct = (pnl / pos.grids.reduce((sum, g) => sum + g.margin, 0)) / pos.maxLev * 100;

                    // Check Chốt Lời (Dựa trên giá trung bình + %TP cài đặt)
                    const targetPrice = pos.side === 'LONG' ? avgPrice * (1 + botState.tpPercent/100) : avgPrice * (1 - botState.tpPercent/100);
                    const isWin = pos.side === 'LONG' ? price >= targetPrice : price <= targetPrice;

                    if (isWin) {
                        botState.closedPnl += pnl;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: pnl, lev: pos.maxLev });
                        logger(`WIN: ${t.s} | +${pnl.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                    } 
                    // Check DCA (Dựa trên khoảng cách Gap % so với lệnh cuối)
                    else if (pos.grids.length < botState.maxGrids) {
                        const lastPrice = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastPrice - price) / lastPrice : (price - lastPrice) / lastPrice;
                        if (gap * 100 >= botState.stepSize) {
                            const nextMargin = pos.grids[pos.grids.length-1].margin * botState.multiplier;
                            const nextSize = (nextMargin * pos.maxLev) / price;
                            pos.grids.push({ price, margin: nextMargin, size: nextSize, time: Date.now() });
                            logger(`DCA: ${t.s} Tầng ${pos.grids.length}`, "DCA");
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
    ws.on('close', () => setTimeout(initWS, 3000));
}

app.get('/api/data', (req, res) => {
    let gridsGong = 0;
    let unrealizedPnl = 0;
    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, avgPrice = 0, totalMargin = 0, totalSize = 0;
        if (p.status !== 'WAITING' && currentP > 0) {
            totalSize = p.grids.reduce((sum, g) => sum + g.size, 0);
            totalMargin = p.grids.reduce((sum, g) => sum + g.margin, 0);
            avgPrice = p.grids.reduce((sum, g) => sum + (g.size * g.price), 0) / totalSize;
            pnl = p.side === 'LONG' ? (currentP - avgPrice) * totalSize : (avgPrice - currentP) * totalSize;
            gridsGong += p.grids.length;
            unrealizedPnl += pnl;
        }
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, pnl, currentPrice: currentP, capital: totalMargin * p.maxLev };
    });
    res.json({ state: botState, active: activeData, logs, stats: { today: getFilteredPnL(0), closedPnl: botState.closedPnl, totalClosedGrids: botState.totalClosedGrids, unrealizedPnl, gridsGong } });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running !== undefined) {
        botState.running = req.body.running;
        if (botState.running) { botState.startTime = Date.now(); logger("Bot Bắt Đầu Chạy...", "SYS"); }
        else { logger("Bot Đã Dừng.", "SYS"); }
    }
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode', 'multiplier'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = [];
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;overflow-x:hidden}
        th{background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;text-transform:uppercase;font-size:10px;text-align:left}
        #logBox{background:#000;padding:10px;height:250px;overflow-y:auto;font-size:11px;border:1px solid #333;box-shadow:inset 0 0 10px #00ff0033}
        .matrix-text{text-shadow: 0 0 5px #f0b90b}
        input, select { background: #000 !important; border: 1px solid #333 !important; color: #f0b90b !important; }
    </style></head><body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-xl">
            <div class="w-[100px]">MARGIN ($)<input id="marginValue" type="number" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[80px]">BỘI SỐ<input id="multiplier" type="number" step="0.1" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[60px]">DCA<input id="maxGrids" type="number" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[60px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[60px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full p-2 rounded mt-1"></div>
            <div class="w-[90px]">MODE<select id="mode" class="w-full p-2 rounded mt-1"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-6 py-2 rounded font-bold hover:bg-green-500 shadow-lg">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-6 py-2 rounded font-bold hover:bg-red-500 shadow-lg">STOP</button>
                <button onclick="resetBot()" class="bg-gray-700 px-3 py-2 rounded text-[9px] hover:bg-gray-600">RESET</button>
            </div>
            <div class="border-l border-gray-700 pl-4 ml-2 text-right">
                <div id="botStatus" class="font-bold text-red-500 italic">OFFLINE</div>
            </div>
        </div>

        <div class="bg-[#1e2329] p-3 rounded-t-lg border-x border-t border-gray-800 flex justify-between gap-2">
            <div class="text-center flex-1 text-gray-400">PNL HÔM NAY (7AM)<div id="pnlToday" class="text-lg font-bold text-green-400">0.00$</div></div>
            <div class="text-center flex-1 border-x border-gray-800 text-yellow-500 font-bold">TỔNG LÃI ĐÃ CHỐT<div id="pnlAll" class="text-2xl font-black">0.00$</div></div>
            <div class="text-center flex-1 text-gray-400 font-bold">PNL GỒNG HIỆN TẠI<div id="statUnreal" class="text-2xl font-black text-white">0.00$</div></div>
        </div>
        <div class="bg-[#161a1e] p-2 flex justify-around border-x border-b border-gray-800 text-[10px] font-bold mb-4 text-gray-400">
            <div>TỔNG TẦNG GỒNG: <span id="statGrids" class="text-orange-400">0</span></div>
            <div>LƯỚI ĐÃ CHỐT: <span id="statClosedGrids" class="text-purple-400">0</span></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-4 overflow-hidden shadow-2xl">
            <table class="w-full">
                <thead><tr>
                    <th>SYMBOL (DETAIL)</th>
                    <th class="text-right">VỐN (CAPITAL)</th>
                    <th class="text-center">TẦNG</th>
                    <th class="text-right">GIÁ HIỆN TẠI / AVG</th>
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
                    marginValue: Number(document.getElementById('marginValue').value), 
                    multiplier: Number(document.getElementById('multiplier').value), 
                    maxGrids: Number(document.getElementById('maxGrids').value), 
                    stepSize: Number(document.getElementById('stepSize').value), 
                    tpPercent: Number(document.getElementById('tpPercent').value), 
                    mode: document.getElementById('mode').value 
                };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetBot(){ if(confirm('RESET TOÀN BỘ DỮ LIỆU?')) await fetch('/api/reset',{method:'POST'}); }
            
            async function update(){
                try {
                    const res = await fetch('/api/data'); 
                    const d = await res.json();
                    if(firstLoad) { 
                        ['marginValue','maxGrids','stepSize','tpPercent','mode','multiplier'].forEach(id => document.getElementById(id).value = d.state[id]); 
                        firstLoad = false; 
                    }
                    
                    document.getElementById('activeBody').innerHTML = d.active.filter(p=>p.currentGrid>0).sort((a,b)=>b.pnl - a.pnl).map(p=>`
                        <tr class="border-b border-gray-800 hover:bg-[#2b3139]">
                            <td class="p-2 font-bold text-yellow-500 font-mono">${p.symbol} <span class="text-gray-500 text-[9px]">x${p.maxLev}</span></td>
                            <td class="text-right font-bold text-blue-400">${p.capital.toFixed(2)}$</td>
                            <td class="text-center font-bold text-yellow-400">${p.currentGrid}</td>
                            <td class="text-right text-[10px]"><div>${p.currentPrice.toFixed(5)}</div><div class="text-gray-500 italic">AVG: ${p.avgPrice.toFixed(5)}</div></td>
                            <td class="text-right pr-2 font-bold ${p.pnl>=0?'text-green-500':'text-red-500'} font-mono">${p.pnl.toFixed(2)}$</td>
                        </tr>`).join('');

                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('pnlAll').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';
                    document.getElementById('statGrids').innerText = d.stats.gridsGong;
                    document.getElementById('statClosedGrids').innerText = d.stats.totalClosedGrids;
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    document.getElementById('botStatus').innerText = d.state.running ? "RUNNING" : "OFFLINE";
                    document.getElementById('botStatus').className = "font-bold " + (d.state.running ? "text-green-500" : "text-red-500");
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => console.log(`Bot running at http://localhost:${PORT}/gui`));
});
