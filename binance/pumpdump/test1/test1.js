/**
 * BINANCE LUFFY PRO - PORT 7001 (HYBRID BOOTSTRAP)
 * - Tích hợp nạp nến lịch sử từ bản 9000
 * - Lưu botState vào file (không mất cấu hình khi restart PM2)
 * - Fix biến động nhảy số ngay lập tức sau khi khởi động
 */

const PORT = 7001; 
const HISTORY_FILE = './history_db.json';
const BOT_STATE_FILE = './bot_state_config.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

// Cấu hình mặc định (Sẽ bị ghi đè bởi file nếu có)
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

// 2. LOGIC BIẾN ĐỘNG CHUẨN (REVERSE SEARCH)
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

// 3. BOOTSTRAP DATA (LẤY TỪ BẢN 9000)
async function bootstrapData() {
    console.log("LOG: [PP3] Đang kéo nến lịch sử để tính biến động ngay lập tức...");
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 80); 
        for (let t of usdtPairs) {
            const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=30`);
            const kData = await kRes.json();
            if(!coinData[t.symbol]) coinData[t.symbol] = { symbol: t.symbol, prices: [] };
            coinData[t.symbol].prices = kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }));
        }
        console.log("LOG: [PP3] Hoàn tất nạp dữ liệu mồi.");
    } catch (e) { console.log("LOG: [PP3] Lỗi: " + e.message); }
}

// 4. CORE ENGINE
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

function updatePriceLogic(s, p, now) {
    if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
    coinData[s].prices.push({ p, t: now });
    if (coinData[s].prices.length > 1200) coinData[s].prices.shift();

    const c1 = calculateChange(coinData[s].prices, 1);
    const c5 = calculateChange(coinData[s].prices, 5);
    const c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };

    if (!botState.running) return;

    const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
    if (pending) {
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
        if (win || (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000)) {
            // Logic đóng lệnh... (giữ nguyên như bản cũ)
        }
        // Logic DCA (x1.03 margin đầu)...
        const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
        const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
        const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
        if (triggerDCA && !actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 1, action: () => {
                const newCount = pending.dcaCount + 1;
                const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                pending.avgPrice = newAvg; pending.dcaCount = newCount;
            }});
        }
    } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= botState.vol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
        if (!actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 2, action: () => {
                const sumVol = c1 + c5 + c15;
                let type = botState.mode === 'REVERSE' ? (sumVol >= 0 ? 'SHORT' : 'LONG') : (sumVol >= 0 ? 'LONG' : 'SHORT');
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: botState.tp, slTarget: botState.sl, 
                    snapVol: { c1, c5, c15 }, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }] 
                });
            }});
        }
    }
}

// 5. WEBSOCKET & FALLBACK (TỪ BẢN 9000)
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => updatePriceLogic(t.s, parseFloat(t.c), now));
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

async function fallbackAPI() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const data = await res.json();
        const now = Date.now();
        data.forEach(t => { if(t.symbol.endsWith('USDT')) updatePriceLogic(t.symbol, parseFloat(t.price), now); });
    } catch (e) {}
    setTimeout(fallbackAPI, 2500);
}

// 6. API & GUI (BẢN 7001)
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
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live ? v.live.currentPrice : 0])),
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 15), 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Pro 7001 Hybrid</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        input, select { background: #0b0e11 !important; border: 1px solid #474d57 !important; color: white !important; font-size: 12px; }
    </style></head><body class="p-4">
        <div class="max-w-5xl mx-auto">
            <div id="setupBox" class="bg-card p-4 rounded-lg mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><label class="text-[10px] text-gray-400 uppercase">Vốn ($)</label><input id="balanceInp" type="number" class="w-full p-2 rounded"></div>
                <div><label class="text-[10px] text-gray-400 uppercase">Margin</label><input id="marginInp" type="text" class="w-full p-2 rounded"></div>
                <div><label class="text-[10px] text-gray-400 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" class="w-full p-2 rounded"></div>
                <div><label class="text-[10px] text-gray-400 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" class="w-full p-2 rounded"></div>
                <div><label class="text-[10px] text-gray-400 uppercase">Min Vol (%)</label><input id="volInp" type="number" step="0.1" class="w-full p-2 rounded"></div>
                <div><label class="text-[10px] text-gray-400 uppercase">Mode</label>
                    <select id="modeInp" class="w-full p-2 rounded">
                        <option value="FOLLOW">FOLLOW</option><option value="REVERSE">REVERSE</option>
                    </select>
                </div>
                <div class="col-span-2 flex items-end">
                    <button id="mainBtn" onclick="toggleBot()" class="w-full py-2 rounded font-bold uppercase text-xs"></button>
                </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4 text-center">
                <div class="bg-card p-3 rounded-lg"><div class="text-[10px] text-gray-400">EQUITY</div><div id="eq" class="text-2xl font-bold">0.00</div></div>
                <div class="bg-card p-3 rounded-lg"><div class="text-[10px] text-gray-400">PNL LIVE</div><div id="unpnl" class="text-2xl font-bold">0.00</div></div>
            </div>

            <div class="bg-card p-4 rounded-lg mb-4">
                <div class="text-[11px] font-bold mb-3 uppercase text-yellow-500 italic">Vị thế đang mở</div>
                <table class="w-full text-[11px] text-left">
                    <thead class="text-gray-500 border-b border-gray-800"><tr><th>Pair</th><th>Type</th><th>DCA</th><th>Entry/Live</th><th>PnL</th></tr></thead>
                    <tbody id="pBody"></tbody>
                </table>
            </div>

            <div class="bg-card p-4 rounded-lg">
                <div class="text-[11px] font-bold mb-3 uppercase text-gray-400">Biến động Market (Top 15)</div>
                <div id="marketBody" class="grid grid-cols-2 md:grid-cols-5 gap-2"></div>
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
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    isRunning = d.config.running; updateBtn();
                    
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
                        let mNum = parseFloat(d.config.margin);
                        let marginBase = d.config.margin.includes('%') ? (d.config.balance * mNum / 100) : mNum;
                        let roi = (h.type === 'LONG' ? (cp-h.avgPrice)/h.avgPrice : (h.avgPrice-cp)/h.avgPrice) * 100 * h.maxLev;
                        let pnlVal = marginBase * (h.dcaCount + 1) * roi / 100; unpnl += pnlVal;
                        return \`<tr class="border-b border-gray-800"><td class="py-2">\${h.symbol}</td><td class="\${h.type==='LONG'?'up':'down'}">\${h.type}</td><td>\${h.dcaCount}</td><td>\${h.avgPrice.toFixed(4)}<br>\${cp.toFixed(4)}</td><td class="\${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</td></tr>\`;
                    }).join('');

                    document.getElementById('eq').innerText = (d.config.balance + unpnl).toFixed(2);
                    document.getElementById('unpnl').innerText = unpnl.toFixed(2);
                    document.getElementById('unpnl').className = 'text-2xl font-bold ' + (unpnl >= 0 ? 'up' : 'down');
                    
                    document.getElementById('marketBody').innerHTML = d.live.map(l => \`
                        <div class="bg-black/30 p-2 rounded border border-gray-800">
                            <div class="text-[9px] text-gray-500 font-bold">\${l.symbol}</div>
                            <div class="text-[11px] font-bold \${l.c1>=0?'up':'down'}">1m: \${l.c1}%</div>
                            <div class="text-[9px] text-gray-400">5m: \${l.c5}%</div>
                        </div>
                    \`).join('');
                } catch(e){}
            }
            setInterval(refresh, 1000);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    console.log(`Luffy V16.5 Hybrid: http://localhost:${PORT}/gui`);
    await bootstrapData(); 
    initWS(); 
    fallbackAPI();
});
