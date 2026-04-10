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
    dcaStep: 10.0, 
    maxDCA: 8
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
    // Chống spam log trùng lặp liên tục
    if (status.botLogs.length > 0 && status.botLogs[0].msg === msg) return;

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

// 🛡️ HÀM THIẾT LẬP GIÁP SÀN 2 LỚP (ALGO & FAP)
async function updateSànGiáp(symbol, side, posSide, tp, sl, qty) {
    try {
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

        // Lớp 1: ALGO (TAKE_PROFIT_LIMIT - Khớp giá mượt hơn)
        await callBinance('/fapi/v1/order', 'POST', { 
            symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT', 
            stopPrice: tp, price: tp, quantity: qty, reduceOnly: 'true', workingType: 'MARK_PRICE' 
        });

        // Lớp 2: FAP (STOP_MARKET - Giáp sàn bảo hiểm)
        await callBinance('/fapi/v1/order', 'POST', { 
            symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', 
            stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE' 
        });

        addBotLog(`🛡️ [${symbol}] Đã set Giáp Lớp 1 (Algo TP) & Lớp 2 (FAP SL)`, "info");
    } catch (e) { addBotLog(`❌ Lỗi set giáp ${symbol}: ${e.message}`, "error"); }
}

// 🚀 MỞ VỊ THẾ
async function openPosition(symbol, side, info, isReverse = false) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    try {
        const acc = await callBinance('/fapi/v2/account');
        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const currentPrice = parseFloat(ticker.price);
        
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        if (isReverse) margin *= 10; 

        let finalQty = (Math.floor(((margin * 20) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty });

        if (order.orderId) {
            await sleep(2000); 
            const posRisk = await callBinance('/fapi/v2/positionRisk');
            const myPos = posRisk.find(p => p.symbol === symbol && p.positionSide === posSide && parseFloat(p.positionAmt) !== 0);
            if (!myPos) return;

            const entry = parseFloat(myPos.entryPrice);
            const qtyOnFloor = Math.abs(parseFloat(myPos.positionAmt));
            
            let tp, sl;
            if (isReverse) {
                tp = (posSide === 'LONG' ? entry * 1.5 : entry * 0.5).toFixed(info.pricePrecision);
                sl = (posSide === 'LONG' ? entry * 0.5 : entry * 1.5).toFixed(info.pricePrecision);
                addBotLog(`🔥 REVERSE x10 ${symbol} @${entry}. TP: ${tp} | SL: ${sl}`, "warning");
            } else {
                tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
                sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);
                addBotLog(`✅ OPEN ${symbol} @${entry}. TP: ${tp} | SL: ${sl}`, "success");
            }

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entry, initialEntry: entry, 
                qty: qtyOnFloor, tp: parseFloat(tp), sl: parseFloat(sl), 
                dcaCount: 0, isClosing: false 
            });

            await updateSànGiáp(symbol, side, posSide, tp, sl, qtyOnFloor);
        }
    } catch (e) { addBotLog(`❌ Lỗi mở: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        // CẬP NHẬT SỐ DƯ LIÊN TỤC (Sửa lỗi không cập nhật)
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);
        if (status.initialBalance === 0) status.initialBalance = status.currentBalance;

        const posRisk = await callBinance('/fapi/v2/positionRisk');

        for (let [symbol, data] of activeOrdersTracker) {
            if (data.isClosing) continue; 

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const price = parseFloat(ticker.price);
            const floorPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side && parseFloat(p.positionAmt) !== 0);

            // 1. KIỂM TRA ĐÃ ĐÓNG (LỊCH SỬ PNL)
            if (!floorPos) {
                data.isClosing = true;
                const trades = await callBinance('/fapi/v1/userTrades', { symbol, limit: 10 });
                const relevantTrades = trades.filter(t => t.positionSide === data.side);
                const totalPnl = relevantTrades.reduce((s, t) => s + parseFloat(t.realizedPnl), 0);
                
                addBotLog(`💰 DONE ${symbol}. PnL: ${totalPnl.toFixed(2)}$ | Lý do: Sàn khớp TP/SL`, "success");
                activeOrdersTracker.delete(symbol);
                setTimeout(() => callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }), 5000);
                continue;
            }

            // 2. LỚP 3: BOT MONITOR (FAILSAFE - THEO DÕI)
            let hitLocal = (data.side === 'LONG' && (price >= data.tp || price <= data.sl)) || 
                           (data.side === 'SHORT' && (price <= data.tp || price >= data.sl));

            if (hitLocal) {
                data.isClosing = true; 
                addBotLog(`🚨 LỚP 3: BOT đóng khẩn cấp ${symbol} @${price} (Lớp 1/2 chậm)`, "warning");
                const res = await callBinance('/fapi/v1/order', 'POST', { symbol, side: data.side === 'LONG' ? 'SELL' : 'BUY', positionSide: data.side, type: 'MARKET', quantity: data.qty, reduceOnly: 'true' });
                if (res.orderId) addBotLog(`✅ Bot xử lý đóng ${symbol} thành công.`, "success");
                continue;
            }

            // 3. CHIẾN THUẬT DCA 8 TẦNG
            const diff = ((price - data.initialEntry) / data.initialEntry) * 100;
            const isAgainst = (data.side === 'LONG' && diff <= -botSettings.dcaStep * (data.dcaCount + 1)) || 
                              (data.side === 'SHORT' && diff >= botSettings.dcaStep * (data.dcaCount + 1));

            if (isAgainst) {
                if (data.dcaCount < botSettings.maxDCA) {
                    data.dcaCount++;
                    addBotLog(`📉 DCA TẦNG ${data.dcaCount}: ${symbol} (Ngược ${diff.toFixed(2)}%)`, "warning");
                    const dcaQty = (data.qty).toFixed(status.exchangeInfo[symbol].quantityPrecision); // DCA bằng qty hiện tại
                    
                    const resDCA = await callBinance('/fapi/v1/order', 'POST', { 
                        symbol, side: data.side === 'LONG' ? 'BUY' : 'SELL', 
                        positionSide: data.side, type: 'MARKET', quantity: dcaQty 
                    });

                    if (resDCA.orderId) {
                        await sleep(3000);
                        const newPos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === data.side);
                        data.entry = parseFloat(newPos.entryPrice);
                        data.qty = Math.abs(parseFloat(newPos.positionAmt));
                        data.tp = (data.side === 'LONG' ? data.entry * (1 + botSettings.posTP/100) : data.entry * (1 - botSettings.posTP/100)).toFixed(status.exchangeInfo[symbol].pricePrecision);
                        data.sl = (data.side === 'LONG' ? data.entry * (1 - botSettings.posSL/100) : data.entry * (1 + botSettings.posSL/100)).toFixed(status.exchangeInfo[symbol].pricePrecision);
                        
                        // Cập nhật lại Giáp Algo & FAP cho khối lượng mới
                        await updateSànGiáp(symbol, data.side === 'LONG' ? 'BUY' : 'SELL', data.side, data.tp, data.sl, data.qty);
                    }
                } else {
                    data.isClosing = true;
                    addBotLog(`💀 DCA CHÁY TẦNG 8. REVERSE x10 ${symbol}!`, "error");
                    await callBinance('/fapi/v1/order', 'POST', { symbol, side: data.side === 'LONG' ? 'SELL' : 'BUY', positionSide: data.side, type: 'MARKET', quantity: data.qty, reduceOnly: 'true' });
                    await sleep(3000);
                    await openPosition(symbol, data.side === 'LONG' ? 'SELL' : 'BUY', status.exchangeInfo[symbol], true);
                }
            }
        }

        // TÌM KÈO MỚI
        if (activeOrdersTracker.size < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (!activeOrdersTracker.has(coin.symbol) && !pendingSymbols.has(coin.symbol) && coin.maxV >= botSettings.minVol) {
                    pendingSymbols.add(coin.symbol);
                    addBotLog(`🔍 Phát hiện kèo: ${coin.symbol} (Vol: ${coin.maxV})`, "entry");
                    await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol]);
                    setTimeout(() => pendingSymbols.delete(coin.symbol), 5000);
                    break;
                }
            }
        }
    } catch (e) { console.error(e); }
}

// --- CÁC HÀM CƠ BẢN ---
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({ 
                    symbol: c.symbol, c1: c.c1, c5: c.c5, c15: c.c15 || 0, 
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15 || 0)) 
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
        });
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = status.dayStartBalance = status.currentBalance = parseFloat(acc.totalWalletBalance);
        
        addBotLog("👿 LUFFY v15.8 - FIXED: 3-LAYER TP/SL & BALANCE UPDATED", "success");
        botSettings.isRunning = true;
    } catch (e) { console.log(e); }
}

init(); 
setInterval(mainLoop, 3500);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
