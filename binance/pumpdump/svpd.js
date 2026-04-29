const PORT = 9000;
const HISTORY_FILE = './history_db.json';
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

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    let s = p.toFixed(20);
    let match = s.match(/^-?\d+\.0*[1-9]/);
    if (!match) return p.toFixed(4);
    let index = match[0].length;
    return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
}

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}`, h));
    } catch (e) {}
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

async function bootstrapData() {
    console.log("LOG: [PP3] Bat dau lay du lieu nen lich su...");
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await res.json();
        const usdtPairs = tickers.filter(t => t.symbol.endsWith('USDT')).slice(0, 50);
        
        for (let t of usdtPairs) {
            const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=15`);
            const kData = await kRes.json();
            coinData[t.symbol] = { symbol: t.symbol, prices: kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) })) };
        }
        console.log("LOG: [PP3] Da nap xong du lieu nen. Bien dong se hien ngay lap tuc.");
    } catch (e) {
        console.log("LOG: [PP3] Loi bootstrap: " + e.message);
    }
}

function updatePriceLogic(s, p, now) {
    if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
    coinData[s].prices.push({ p, t: now });
    if (coinData[s].prices.length > 1000) coinData[s].prices.shift();

    const c1 = calculateChange(coinData[s].prices, 1);
    const c5 = calculateChange(coinData[s].prices, 5);
    const c15 = calculateChange(coinData[s].prices, 15);
    coinData[s].live = { c1, c5, c15, currentPrice: p };

    const pending = Array.from(historyMap.values()).find(h => h.symbol === s && h.status === 'PENDING');
    if (pending) {
        const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
        const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
        if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;
        const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
        const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);
        if (win || isTimeout) {
            pending.status = win ? 'WIN' : 'TIMEOUT'; 
            pending.finalPrice = p; pending.endTime = now;
            pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
            lastTradeClosed[s] = now; 
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
            return;
        }
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
    } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol && !(lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000))) {
        if (!actionQueue.find(q => q.id === s)) {
            actionQueue.push({ id: s, priority: 2, action: () => {
                const sumVol = c1 + c5 + c15;
                let type = sumVol >= 0 ? 'LONG' : 'SHORT';
                if (tradeMode === 'REVERSE') type = (type === 'LONG' ? 'SHORT' : 'LONG');
                historyMap.set(`${s}_${now}`, { 
                    symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                    maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                    maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                });
            }});
        }
    }
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('open', () => console.log("LOG: [PP1] WebSocket Da ket noi."));
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => updatePriceLogic(t.s, parseFloat(t.c), now));
    });
    ws.on('error', () => console.log("LOG: [PP1] Loi WebSocket."));
    ws.on('close', () => {
        console.log("LOG: [PP1] WebSocket Dong. Dang thu lai...");
        setTimeout(initWS, 3000);
    });
}

async function fallbackAPI() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const data = await res.json();
        const now = Date.now();
        data.forEach(t => {
            if (t.symbol.endsWith('USDT')) updatePriceLogic(t.symbol, parseFloat(t.price), now);
        });
        // console.log("LOG: [PP2] Da cap nhat gia tu API.");
    } catch (e) {}
    setTimeout(fallbackAPI, 2000);
}

app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl); currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode || 'FOLLOW';
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const topData = Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 15);
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).filter(([_,v])=>v.live).map(([s, v]) => [s, v.live.currentPrice])),
        live: topData, 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime)
    });
});

app.get('/gui', (req, res) => {
    res.send(fs.readFileSync('./gui.html', 'utf8')); 
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server: http://localhost:${PORT}/gui`);
    await bootstrapData(); // Chay PP3 truoc
    initWS();              // Chay PP1
    fallbackAPI();         // Chay PP2
});
