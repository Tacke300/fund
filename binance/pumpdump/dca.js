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
                        return;
                    }

                    // TÍNH TOÁN THEO CHUẨN SÀN
                    const totalSize = pos.grids.reduce((sum, g) => sum + g.size, 0);
                    const totalValue = pos.grids.reduce((sum, g) => sum + (g.size * g.price), 0);
                    const avgPrice = totalValue / totalSize;
                    
                    // PnL tính theo giá trị vị thế
                    const currentPnL = pos.side === 'LONG' ? (price - avgPrice) * totalSize : (avgPrice - price) * totalSize;
                    const roi = (currentPnL / pos.grids.reduce((sum, g) => sum + g.margin, 0)) * 100;

                    // CHỐT LỜI (Theo % TP dựa trên giá trung bình)
                    const isWin = pos.side === 'LONG' ? (price >= avgPrice * (1 + botState.tpPercent/100)) : (price <= avgPrice * (1 - botState.tpPercent/100));

                    if (isWin) {
                        botState.closedPnl += currentPnL;
                        botState.totalClosedGrids++;
                        pnlHistory.push({ ts: Date.now(), pnl: currentPnL, lev: pos.maxLev });
                        logger(`WIN: ${t.s} | +${currentPnL.toFixed(2)}$`, "WIN");
                        pos.status = 'WAITING';
                        pos.grids = []; 
                        saveAll();
                    } 
                    // DCA (Theo khoảng cách Gap % so với giá trung bình)
                    else if (pos.grids.length < botState.maxGrids) {
                        const lastEntryPrice = pos.grids[pos.grids.length - 1].price;
                        const gap = pos.side === 'LONG' ? (lastEntryPrice - price) / lastEntryPrice : (price - lastEntryPrice) / lastEntryPrice;
                        
                        if (gap * 100 >= botState.stepSize) {
                            const nextMargin = pos.grids[pos.grids.length-1].margin * botState.multiplier;
                            const nextSize = (nextMargin * pos.maxLev) / price;
                            pos.grids.push({ price, margin: nextMargin, size: nextSize, time: Date.now() });
                            logger(`DCA: ${t.s} (Tầng ${pos.grids.length})`, "DCA");
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
    const levStats = {};

    const activeData = Object.values(activePositions).map(p => {
        const currentP = marketPrices[p.symbol] || 0;
        let pnl = 0, avgPrice = 0, totalMargin = 0, totalSize = 0;
        
        if (p.status !== 'WAITING' && currentP > 0) {
            totalMargin = p.grids.reduce((sum, g) => sum + g.margin, 0);
            totalSize = p.grids.reduce((sum, g) => sum + g.size, 0);
            avgPrice = p.grids.reduce((sum, g) => sum + (g.size * g.price), 0) / totalSize;
            
            pnl = p.side === 'LONG' ? (currentP - avgPrice) * totalSize : (avgPrice - currentP) * totalSize;
            
            gridsGong += p.grids.length;
            unrealizedPnl += pnl;
        }

        return { 
            ...p, avgPrice, totalMargin, totalSize, currentGrid: p.grids.length, 
            pnl, currentPrice: currentP,
            capital: totalMargin * p.maxLev
        };
    });

    pnlHistory.forEach(h => {
        if(!levStats[h.lev]) levStats[h.lev] = { pnl: 0, count: 0 };
        levStats[h.lev].pnl += h.pnl;
        levStats[h.lev].count++;
    });

    res.json({ 
        state: botState, active: activeData, logs, levStats,
        stats: { 
            today: getFilteredPnL(0), d7: getFilteredPnL(7),
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
    ['marginValue', 'maxGrids', 'stepSize', 'tpPercent', 'mode', 'multiplier'].forEach(f => { if(req.body[f] !== undefined) botState[f] = req.body[f]; });
    saveAll(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = []; pnlHistory = [];
    saveAll(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix DCA</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;text-transform:uppercase;font-size:10px} #logBox{background:#000;padding:10px;height:250px;overflow-y:auto;font-size:11px;border:1px solid #333}
    .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); }
    .modal-content { background: #1e2329; margin: 10% auto; padding: 20px; border: 1px solid #f0b90b; width: 85%; border-radius: 8px; }</style>
    </head><body class="p-4 text-[11px]">
        <div id="gridModal" class="modal"><div class="modal-content">
            <div class="flex justify-between border-b border-gray-700 pb-2 mb-4"><h2 id="modalTitle" class="text-xl font-bold text-yellow-500 italic"></h2><button onclick="closeModal()" class="text-2xl text-red-500">&times;</button></div>
            <table class="w-full text-center text-[10px]">
                <thead class="bg-black"><tr><th>TẦNG</th><th>MARGIN ($)</th><th>GIÁ VÀO</th><th>SIZE (COIN)</th></tr></thead>
                <tbody id="modalBody"></tbody>
            </table>
        </div></div>

        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-gray-800 flex flex-wrap items-end gap-3 shadow-lg">
            <div class="w-[110px]">MARGIN<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[80px]">BỘI SỐ<input id="multiplier" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[60px]">DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[60px]">GAP%<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[60px]">TP%<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">MODE<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 ml-auto">
                <button onclick="sendCtrl(true)" class="bg-green-600 px-5 py-2 rounded font-bold">START</button>
                <button onclick="sendCtrl(false)" class="bg-red-600 px-5 py-2 rounded font-bold">STOP</button>
                <button onclick="resetBot()" class="bg-gray-700 px-3 py-2 rounded text-[9px]">RESET</button>
            </div>
            <div class="border-l border-gray-700 pl-4 ml-2 text-right"><div id="uptime" class="text-yellow-500 font-bold text-sm">0d 00:00:00</div><div id="botStatus" class="font-bold text-[9px] text-red-500">OFFLINE</div></div>
        </div>

        <div id="levStatsContainer" class="flex gap-2 overflow-x-auto mb-2 text-[10px]"></div>

        <div class="bg-[#1e2329] p-3 rounded-t-lg border-x border-t border-gray-800 flex justify-between gap-2 shadow-inner">
            <div class="text-center flex-1 text-gray-400">HÔM NAY (7AM)<div id="pnlToday" class="text-lg font-bold text-green-400">0.00$</div></div>
            <div class="text-center flex-1 border-x border-gray-800 text-gray-400">7 NGÀY QUA<div id="pnl7d" class="text-lg font-bold text-green-500">0.00$</div></div>
            <div class="text-center flex-1 text-yellow-500 font-bold border-r border-gray-800">LỢI NHUẬN CHỐT<div id="pnlAll" class="text-2xl font-black">0.00$</div></div>
            <div class="text-center flex-1 text-gray-400 font-bold">PNL GỒNG HIỆN TẠI<div id="statUnreal" class="text-2xl font-black text-white">0.00$</div></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800 mb-4 overflow-hidden shadow-xl"><table class="w-full text-left">
            <thead class="bg-[#161a1e]"><tr>
                <th>SYMBOL (XEM CHI TIẾT)</th>
                <th class="text-right">VỐN (VAL)</th>
                <th class="text-center">TẦNG</th>
                <th class="text-right">GIÁ HIỆN TẠI / TB</th>
                <th class="text-right pr-2">PNL GỒNG ($)</th>
            </tr></thead>
            <tbody id="activeBody"></tbody>
        </table></div>
        <div id="logBox"></div>

        <script>
            let rawData = [], firstLoad = true;
            async function sendCtrl(run){ const body = { running: run, marginValue: Number(document.getElementById('marginValue').value), multiplier: Number(document.getElementById('multiplier').value), maxGrids: Number(document.getElementById('maxGrids').value), stepSize: Number(document.getElementById('stepSize').value), tpPercent: Number(document.getElementById('tpPercent').value), mode: document.getElementById('mode').value }; await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
            async function resetBot(){ if(confirm('RESET DATA?')) await fetch('/api/reset',{method:'POST'}); }
            
            function openDetail(symbol){
                const p = rawData.find(x => x.symbol === symbol);
                if(!p || p.status === 'WAITING') return;
                document.getElementById('modalTitle').innerText = symbol + ' (Max Lev: x' + p.maxLev + ')';
                document.getElementById('modalBody').innerHTML = p.grids.map((g, i) => \`
                    <tr class="border-b border-gray-800"><td class="p-2 text-yellow-400 font-bold">TẦNG #\${i+1}</td><td class="font-mono">\${g.margin.toFixed(2)}$</td><td class="font-mono">\${g.price.toFixed(5)}</td><td class="text-blue-400">\${g.size.toFixed(4)}</td></tr>\`).join('');
                document.getElementById('gridModal').style.display = "block";
            }
            function closeModal(){ document.getElementById('gridModal').style.display = "none"; }

            function render(){ 
                const sorted = [...rawData].sort((a,b)=> b.maxLev - a.maxLev); 
                document.getElementById('activeBody').innerHTML = sorted.map(p=>{
                    if(p.status === 'WAITING') return '';
                    return \`<tr class="border-b border-gray-800 hover:bg-[#2b3139]"> 
                        <td onclick="openDetail('\${p.symbol}')" class="p-2 font-bold text-yellow-500 font-mono cursor-pointer underline decoration-dotted">\${p.symbol} <span class="text-gray-500 text-[9px]">x\${p.maxLev}</span></td> 
                        <td class="text-right font-bold text-blue-400">\${p.capital.toFixed(2)}$</td> 
                        <td class="text-center font-bold text-yellow-400">\${p.currentGrid}</td> 
                        <td class="text-right text-[10px]"><div>HIỆN TẠI: \${p.currentPrice.toFixed(5)}</div><div class="text-gray-500 italic">TRUNG BÌNH: \${p.avgPrice.toFixed(5)}</div></td> 
                        <td class="text-right pr-2 font-bold \${p.pnl>=0?'text-green-500':'text-red-500'} font-mono">\${p.pnl.toFixed(2)}$</td> </tr>\`
                }).join(''); 
            }

            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    if(firstLoad) { ['marginValue','maxGrids','stepSize','tpPercent','mode','multiplier'].forEach(id => document.getElementById(id).value = d.state[id]); firstLoad = false; }
                    rawData = d.active; render();
                    document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                    document.getElementById('pnl7d').innerText = d.stats.d7.toFixed(2) + '$';
                    document.getElementById('pnlAll').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnreal').innerText = d.stats.unrealizedPnl.toFixed(2) + '$';

                    let levHtml = '';
                    Object.keys(d.levStats).sort((a,b)=>b-a).forEach(lev => {
                        const s = d.levStats[lev];
                        levHtml += \`<div class="bg-[#1e2329] p-2 border border-gray-800 rounded">x\${lev}: <span class="\${s.pnl>=0?'text-green-400':'text-red-400'}">\${s.pnl.toFixed(2)}$</span></div>\`;
                    });
                    document.getElementById('levStatsContainer').innerHTML = levHtml;

                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    document.getElementById('botStatus').innerText = d.state.running ? "RUNNING" : "STOPPED";
                    document.getElementById('botStatus').className = "font-bold text-[9px] " + (d.state.running ? "text-green-500" : "text-red-500");
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`READY: http://localhost:${PORT}/gui`));
});
