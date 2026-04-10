import https from 'https';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ⚙️ CẤU HÌNH HỆ THỐNG
// ============================================================================
let botSettings = { 
    isRunning: false,
    maxPositions: 3,            
    invValue: 1,               
    invType: 'percent',          
    minVol: 6.5,                
    posTP: 0.5,                 
    posSL: 5.0,                 
    maxHoldTime: 1,            
    dailyLossLimit: 50.0,       
    maxConsecutiveLosses: 5,    
    riskLoopSpeed: 500          
};

let status = { 
    initialBalance: 0, dayStartBalance: 0, currentBalance: 0, 
    botLogs: [], exchangeInfo: {}, candidatesList: [], 
    globalCooldown: 0, consecutiveLosses: 0 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 500) status.botLogs.pop();
    let color = '\x1b[36m'; 
    if (type === 'success') color = '\x1b[32m'; 
    if (type === 'error') color = '\x1b[31m';   
    if (type === 'warning') color = '\x1b[33m'; 
    if (type === 'entry') color = '\x1b[35m';   
    console.log(`${color}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const timestamp = Date.now() + serverTimeOffset;
            const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
            const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
            const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;
            const res = await new Promise((resolve, reject) => {
                const req = https.request(url, { method, timeout: 4000, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { 
                        if (d.startsWith('<')) return reject(new Error("HTML response"));
                        try { resolve(JSON.parse(d)); } catch (e) { reject(e); } 
                    });
                });
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                req.on('error', reject);
                req.end();
            });
            if (res.code === -1021) { 
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now();
                continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(400); }
    }
}

// 🚀 MỞ VỊ THẾ & CÀI GIÁP 3 LỚP
async function openPosition(symbol, side, info, signals) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    try {
        addBotLog(`🚀 [TÍN HIỆU] ${symbol} vã MARKET!`, "entry");
        const accForEntry = await callBinance('/fapi/v2/account');
        const currentPriceEntry = parseFloat((await callBinance('/fapi/v1/ticker/price', 'GET', { symbol })).price);
        
        let margin = botSettings.invType === 'percent' ? (parseFloat(accForEntry.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        let finalQty = (Math.floor(((margin * 20) / currentPriceEntry) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        pendingSymbols.add(symbol);
        
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty });

        if (order.orderId) {
            await sleep(2500); 
            const posRisk = await callBinance('/fapi/v2/positionRisk');
            const myPos = posRisk.find(p => p.symbol === symbol && p.positionSide === posSide && parseFloat(p.positionAmt) !== 0);
            if (!myPos) return;

            const realEntry = parseFloat(myPos.entryPrice);
            const qtyOnFloor = Math.abs(parseFloat(myPos.positionAmt));
            const tp = (posSide === 'LONG' ? realEntry * (1 + botSettings.posTP/100) : realEntry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? realEntry * (1 - botSettings.posSL/100) : realEntry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            addBotLog(`✅ KHỚP ${symbol} @${realEntry}. Monitor: TP ${tp} | SL ${sl}`, "success");
            activeOrdersTracker.set(symbol, { symbol, side: posSide, entry: realEntry, qty: qtyOnFloor, tp: parseFloat(tp), sl: parseFloat(sl) });

            // LỚP 1: CLOSEPOSITION: TRUE
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'true' });
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'true' });
        }
    } catch (e) { addBotLog(`❌ Lỗi mở lệnh ${symbol}: ${e.message}`, "error"); }
    finally { setTimeout(() => pendingSymbols.delete(symbol), 3000); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        // --- CẬP NHẬT SỐ DƯ VÀ PNL LIÊN TỤC CHO UI ---
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);
        
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activePositionsOnFloor = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);

        for (let [symbol, data] of activeOrdersTracker) {
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const priceNow = parseFloat(ticker.price);
            
            // --- LỚP 3: BOT MONITOR LOCAL (FAILSAFE) ---
            let hitLocal = (data.side === 'LONG' && (priceNow >= data.tp || priceNow <= data.sl)) || (data.side === 'SHORT' && (priceNow <= data.tp || priceNow >= data.sl));
            const floorPos = activePositionsOnFloor.find(p => p.symbol === symbol && p.positionSide === data.side);
            
            if (hitLocal && floorPos) {
                addBotLog(`🚨 LỚP 3 KÍCH HOẠT: ${symbol} @${priceNow}. Vã MARKET!`, "warning");
                await callBinance('/fapi/v1/order', 'POST', { symbol, side: data.side === 'LONG' ? 'SELL' : 'BUY', positionSide: data.side, type: 'MARKET', closePosition: 'true' });
            }

            // --- KIỂM TRA ĐÓNG LỆNH ĐỂ CẬP NHẬT LỊCH SỬ (LOGS) ---
            if (!floorPos) {
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const lastTrade = trades.find(t => t.symbol === symbol && t.positionSide === data.side);
                const pnlValue = parseFloat(lastTrade?.realizedPnl || 0);
                
                addBotLog(`💰 ĐÃ ĐÓNG: ${symbol} | PnL: ${pnlValue.toFixed(2)}$`, pnlValue >= 0 ? "success" : "error");
                
                activeOrdersTracker.delete(symbol);
                setTimeout(() => callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).then(() => addBotLog(`🧹 Clean ${symbol}`)), 15000);
            }
        }

        // --- TÌM CƠ HỘI MỚI ---
        if (activeOrdersTracker.size >= botSettings.maxPositions) return;
        for (const coin of status.candidatesList) {
            if (!activeOrdersTracker.has(coin.symbol) && !pendingSymbols.has(coin.symbol) && coin.maxV >= botSettings.minVol) {
                openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol], coin);
                break; 
            }
        }
    } catch (e) {}
}

// FETCH DỮ LIỆU TỪ SCANNER (CANDIDATES)
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({ symbol: c.symbol, c1: c.c1, c5: c.c5, c15: c.c15 || 0, maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15 || 0)) })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = status.dayStartBalance = status.currentBalance = parseFloat(acc.totalWalletBalance);
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
        });
        addBotLog("👿 LUFFY v15.7 - ĐÃ KẾT NỐI VÍ & DATA", "success");
    } catch (e) { console.log("Init Error:", e.message); }
}

init(); 
setInterval(mainLoop, 3500);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ 
    botSettings, 
    activePositions: Array.from(activeOrdersTracker.values()), 
    status: {
        ...status,
        currentBalance: status.currentBalance // Đảm bảo số dư mới nhất luôn được gửi lên UI
    } 
}));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
