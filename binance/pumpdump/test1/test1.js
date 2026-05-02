/**
 * BINANCE LUFFY PRO - VERSION 16.5 (PREMIUM)
 * - Fix biến động chuẩn xác (Back-searching logic)
 * - Lưu cấu hình vĩnh viễn (File-based config)
 * - Giữ trạng thái Start/Stop khi F5
 */

const PORT = 7001; 
const HISTORY_FILE = './history_db.json';
const BOT_STATE_FILE = './bot_state_config.json'; // File lưu thông số cấu hình
const LEVERAGE_FILE = '../leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

// Cấu hình mặc định
let botState = {
    running: false,
    tp: 0.5,
    sl: 10.0,
    vol: 6.5,
    mode: 'FOLLOW',
    balance: 1000,
    margin: "10%"
};

// 1. LOAD DỮ LIỆU CŨ
if (fs.existsSync(BOT_STATE_FILE)) {
    try { botState = { ...botState, ...JSON.parse(fs.readFileSync(BOT_STATE_FILE)) }; } catch(e){}
}
if (fs.existsSync(LEVERAGE_FILE)) { 
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} 
}
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

// 2. LOGIC BIẾN ĐỘNG CHUẨN
function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    const targetTime = now - min * 60000;
    
    let startPrice = pArr[0].p;
    for (let i = pArr.length - 1; i >= 0; i--) {
        if (pArr[i].t <= targetTime) {
            startPrice = pArr[i].p;
            break;
        }
    }
    const lastPrice = pArr[pArr.length - 1].p;
    return parseFloat((((lastPrice - startPrice) / startPrice) * 100).toFixed(2));
}

// 3. CORE ENGINE
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 300); 
}
setInterval(processQueue, 50);

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            
            // Giữ mảng giá đủ lớn để tính biến động 15p (900 ticks)
            if (coinData[s].prices.length > 1000) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            if (!botState.running) return;

            const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
            if (pending) {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) { 
                    pending.maxNegativeRoi = currentRoi;
                    pending.maxNegativeTime = now;
                }

                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[s] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }

                // DCA Logic (x1.03 theo margin đầu)
                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
                
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        pending.avgPrice = newAvg; pending.dcaCount = newCount;
                    }});
                }
            } else if ([c1, c5].some(v => Math.abs(v) >= botState.vol) && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = botState.mode === 'REVERSE' ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                        if (botState.mode === 'LONG_ONLY') type = 'LONG';
                        if (botState.mode === 'SHORT_ONLY') type = 'SHORT';

                        historyMap.set(`${s}_${now}`, { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: botState.tp, slTarget: botState.sl, 
                            snapVol: { c1, c5, c15 }, maxNegativeRoi: 0, maxNegativeTime: null, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }] 
                        });
                    }});
                }
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// 4. API & GUI
app.get('/api/config', (req, res) => {
    botState = {
        running: req.query.run === 'true',
        tp: parseFloat(req.query.tp),
        sl: parseFloat(req.query.sl),
        vol: parseFloat(req.query.vol),
        mode: req.query.mode,
        balance: parseFloat(req.query.balance),
        margin: req.query.margin
    };
    fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(botState));
    res.json(botState);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        config: botState,
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    // Trả về giao diện Luffy Pro Neon (Đã tối ưu để hiển thị biến động live)
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Pro V16.5</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input, select { background: #0b0e11 !important; border: 1px solid #474d57 !important; color: white !important; }
    </style></head><body class="p-4">
        <div class="max-w-5xl mx-auto">
            <div id="setupBox" class="bg-card p-4 rounded-lg mb-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                <div><label class="text-xs text-gray-400">Vốn ($)</label><input id="balanceInp" type="number" class="w-full p-2 rounded"></div>
                <div><label class="text-xs text-gray-400">Margin</label><input id="marginInp" type="text" class="w-full p-2 rounded"></div>
                <div><label class="text-xs text-gray-400">TP (%)</label><input id="tpInp" type="number" step="0.1" class="w-full p-2 rounded"></div>
                <div><label class="text-xs text-gray-400">DCA (%)</label><input id="slInp" type="number" step="0.1" class="w-full p-2 rounded"></div>
                <div><label class="text-xs text-gray-400">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="w-full p-2 rounded"></div>
                <div><label class="text-xs text-gray-400">Chế độ</label>
                    <select id="modeInp" class="w-full p-2 rounded">
                        <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option>
                    </select>
                </div>
                <div class="col-span-2 flex items-end">
                    <button id="mainBtn" onclick="toggleBot()" class="w-full py-2 rounded font-bold uppercase"></button>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div class="bg-card p-4 rounded-lg"><div class="text-xs text-gray-400">EQUITY</div><div id="eq" class="text-3xl font-bold">0.00</div></div>
                <div class="bg-card p-4 rounded-lg"><div class="text-xs text-gray-400">PNL LIVE</div><div id="unpnl" class="text-3xl font-bold">0.00</div></div>
                <div class="bg-card p-4 rounded-lg"><div class="text-xs text-gray-400">WIN/LOSS</div><div id="wl" class="text-3xl font-bold text-green-500">0/0</div></div>
            </div>

            <div class="bg-card p-4 rounded-lg mb-4">
                <div class="text-sm font-bold mb-2 uppercase text-yellow-500">Vị thế đang mở</div>
                <table class="w-full text-xs text-left">
                    <thead><tr class="text-gray-500 border-b border-gray-700"><th>Pair</th><th>Type</th><th>DCA</th><th>Entry/Live</th><th>PnL</th></tr></thead>
                    <tbody id="pBody"></tbody>
                </table>
            </div>

            <div class="bg-card p-4 rounded-lg">
                <div class="text-sm font-bold mb-2 uppercase text-gray-400">Biến động thị trường (Live)</div>
                <div id="liveVol" class="grid grid-cols-2 md:grid-cols-5 gap-2"></div>
            </div>
        </div>

        <script>
            let isRunning = false;
            async function toggleBot() {
                isRunning = !isRunning;
                const url = \`/api/config?run=\${isRunning}&tp=\${document.getElementById('tpInp').value}&sl=\${document.getElementById('slInp').value}&vol=\${document.getElementById('volInp').value}&mode=\${document.getElementById('modeInp').value}&balance=\${document.getElementById('balanceInp').value}&margin=\${document.getElementById('marginInp').value}\`;
                await fetch(url);
                updateBtn();
            }

            function updateBtn() {
                const btn = document.getElementById('mainBtn');
                btn.innerText = isRunning ? 'STOP ENGINE' : 'START ENGINE';
                btn.className = isRunning ? 'w-full py-2 rounded font-bold bg-red-600 text-white' : 'w-full py-2 rounded font-bold bg-yellow-500 text-black';
            }

            async function refresh() {
                const res = await fetch('/api/data'); const d = await res.json();
                isRunning = d.config.running; updateBtn();
                
                // Load config to UI
                if(!document.activeElement.tagName.includes('INPUT')) {
                    document.getElementById('tpInp').value = d.config.tp;
                    document.getElementById('slInp').value = d.config.sl;
                    document.getElementById('volInp').value = d.config.vol;
                    document.getElementById('modeInp').value = d.config.mode;
                    document.getElementById('balanceInp').value = d.config.balance;
                    document.getElementById('marginInp').value = d.config.margin;
                }

                let unpnl = 0;
                document.getElementById('pBody').innerHTML = d.pending.map(h => {
                    let cp = d.allPrices[h.symbol] || h.avgPrice;
                    let roi = (h.type === 'LONG' ? (cp-h.avgPrice)/h.avgPrice : (h.avgPrice-cp)/h.avgPrice) * 100 * h.maxLev;
                    unpnl += (d.config.balance * parseFloat(d.config.margin)/100) * (h.dcaCount+1) * roi / 100;
                    return \`<tr class="border-b border-gray-800"><td>\${h.symbol}</td><td class="\${h.type==='LONG'?'up':'down'}">\${h.type}</td><td>\${h.dcaCount}</td><td>\${h.avgPrice.toFixed(4)}<br>\${cp.toFixed(4)}</td><td class="\${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</td></tr>\`;
                }).join('');

                document.getElementById('eq').innerText = (d.config.balance + unpnl).toFixed(2);
                document.getElementById('unpnl').innerText = unpnl.toFixed(2);
                document.getElementById('unpnl').className = 'text-3xl font-bold ' + (unpnl >= 0 ? 'up' : 'down');
                
                // Hiển thị Top 10 biến động
                document.getElementById('liveVol').innerHTML = d.live.slice(0, 10).map(l => \`
                    <div class="bg-black/20 p-2 rounded">
                        <div class="text-[10px] text-gray-500">\${l.symbol}</div>
                        <div class="text-xs font-bold \${l.c1>=0?'up':'down'}">1m: \${l.c1}%</div>
                        <div class="text-[10px] text-gray-400">5m: \${l.c5}%</div>
                    </div>
                \`).join('');
            }
            setInterval(refresh, 1000);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Luffy V16.5 Engine: http://localhost:${PORT}/gui`); });
