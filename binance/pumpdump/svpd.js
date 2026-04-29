const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 
const MAX_HOLD_MINUTES = 555555; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let pendingMap = new Map(); // Index O(1): symbol -> pendingObject
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 6.5, tradeMode = 'FOLLOW';
let reconnectDelay = 5000;

// --- QUEUE SYSTEM ---
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    actionQueue.sort((a, b) => a.priority - b.priority);
    const task = actionQueue.shift();
    try { task.action(); } catch(e) { console.error("Queue Error:", e); }
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

// --- DATA INITIALIZATION ---
if (fs.existsSync(LEVERAGE_FILE)) { 
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} 
}

if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => {
            historyMap.set(`${h.symbol}_${h.startTime}`, h);
            if (h.status === 'PENDING') {
                pendingMap.set(h.symbol, h); // Build index cho các lệnh đang treo
            }
        });
    } catch (e) {}
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

// --- CORE WEBSOCKET (OPTIMIZED) ---
function initWS() {
    console.log(`🚀 Khởi động Engine... Reconnect delay: ${reconnectDelay/1000}s`);
    
    const ws = new WebSocket('wss://fstream.binance.com/ws/!markPrice@arr', {
        family: 4,
        handshakeTimeout: 30000 
    });

    let lastMessageTime = Date.now();

    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 15000);

    const watchdog = setInterval(() => {
        if (Date.now() - lastMessageTime > 60000) {
            console.log('⚠️ Watchdog: Mất data quá 60s, terminate...');
            ws.terminate();
        }
    }, 10000);

    ws.on('open', () => {
        console.log('✅ WebSocket Connected!');
        lastMessageTime = Date.now();
        reconnectDelay = 5000; // Reset delay khi kết nối thành công
    });

    ws.on('pong', () => { lastMessageTime = Date.now(); });

    ws.on('message', (data) => {
        lastMessageTime = Date.now();
        let tickers;
        try {
            tickers = JSON.parse(data);
            if (!Array.isArray(tickers)) return;
        } catch (e) { return; }

        const now = Date.now();
        
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.p);
            
            // 1. Chỉ xử lý những coin có trong danh sách đòn bẩy (Tối ưu RAM/CPU)
            if (!symbolMaxLeverage[s]) return;

            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            // 2. Truy cập O(1) qua pendingMap thay vì loop historyMap
            const pending = pendingMap.get(s);

            if (pending && pending.status === 'PENDING') {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) {
                    pending.maxNegativeRoi = currentRoi;
                }

                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                const isTimeout = (now - pending.startTime) >= (MAX_HOLD_MINUTES * 60000);
                
                if (win || isTimeout) {
                    pending.status = win ? 'WIN' : 'TIMEOUT'; 
                    pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    
                    lastTradeClosed[s] = now; 
                    pendingMap.delete(s); // Xóa khỏi index khi đóng lệnh
                    
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }

                // Logic DCA
                const totalDiffFromEntry = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const nextDcaThreshold = (pending.dcaCount + 1) * pending.slTarget;
                const triggerDCA = pending.type === 'LONG' ? totalDiffFromEntry <= -nextDcaThreshold : totalDiffFromEntry >= nextDcaThreshold;
                
                if (triggerDCA && !actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 1, action: () => {
                        const newCount = pending.dcaCount + 1;
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (newCount + 1);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        setTimeout(() => {
                            pending.avgPrice = newAvg;
                            pending.dcaCount = newCount;
                        }, 200); 
                    }});
                }
            } else if (Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15)) >= currentMinVol) {
                // Kiểm tra Cooldown
                if (lastTradeClosed[s] && (now - lastTradeClosed[s] < COOLDOWN_MINUTES * 60000)) return;

                if (!actionQueue.find(q => q.id === s)) {
                    actionQueue.push({ id: s, priority: 2, action: () => {
                        const sumVol = c1 + c5 + c15;
                        let type = sumVol >= 0 ? 'LONG' : 'SHORT';
                        if (tradeMode === 'REVERSE') type = (type === 'LONG' ? 'SHORT' : 'LONG');

                        const newTrade = { 
                            symbol: s, startTime: Date.now(), snapPrice: p, avgPrice: p, type: type, status: 'PENDING', 
                            maxLev: symbolMaxLeverage[s] || 20, tpTarget: currentTP, slTarget: currentSL, snapVol: { c1, c5, c15 },
                            maxNegativeRoi: 0, dcaCount: 0, dcaHistory: [{ t: Date.now(), p: p, avg: p }]
                        };

                        historyMap.set(`${s}_${newTrade.startTime}`, newTrade);
                        pendingMap.set(s, newTrade); // Đưa vào index ngay khi mở
                    }});
                }
            }
        });
    });

    ws.on('close', () => {
        clearInterval(pingInterval);
        clearInterval(watchdog);
        console.log(`❌ Kết nối đóng. Reconnect sau ${reconnectDelay/1000}s...`);
        setTimeout(initWS, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); // Exponential backoff
    });

    ws.on('error', (err) => { ws.terminate(); });
}

// --- EXPRESS ENDPOINTS ---
app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp) || currentTP;
    currentSL = parseFloat(req.query.sl) || currentSL;
    currentMinVol = parseFloat(req.query.vol) || currentMinVol;
    tradeMode = req.query.mode || tradeMode;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const liveData = Object.entries(coinData)
        .filter(([_, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live }))
        .sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1));

    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live ? v.live.currentPrice : 0])),
        live: liveData, 
        pending: all.filter(h => h.status === 'PENDING').sort((a,b)=>b.startTime-a.startTime),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(-50)
    });
});

app.get('/gui', (req, res) => {
    // Trả về HTML Dashboard cũ của bạn
    res.sendFile(process.cwd() + '/index.html'); 
});

app.listen(PORT, '0.0.0.0', () => { 
    initWS(); 
    console.log(`Luffy Engine Pro running at http://localhost:${PORT}`); 
});
