import https from 'https';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ⚙️ CẤU HÌNH CCXT - FIX LỖI -4061 (HEDGE MODE)
// ============================================================================
const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    options: { 
        defaultType: 'future', 
        dualSidePosition: true 
    }
});

// ============================================================================
// ⚙️ CẤU HÌNH HỆ THỐNG (GIỮ NGUYÊN 100%)
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

// 🛡️ HÀM CẬP NHẬT GIÁP SÀN (TP/SL) - DÙNG CCXT CHO PHÒNG HỘ
async function updateSànGiáp(symbol, side, posSide, tp, sl) {
    try {
        await exchange.cancelAllOrders(symbol);
        const closeSide = side === 'BUY' ? 'sell' : 'buy';
        
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', closeSide, 0, undefined, {
            positionSide: posSide,
            stopPrice: tp,
            closePosition: true,
            workingType: 'MARK_PRICE'
        });

        await exchange.createOrder(symbol, 'STOP_MARKET', closeSide, 0, undefined, {
            positionSide: posSide,
            stopPrice: sl,
            closePosition: true,
            workingType: 'MARK_PRICE'
        });
    } catch (e) {
        addBotLog(`❌ Lỗi đặt TP/SL CCXT: ${e.message}`, "error");
    }
}

// 🚀 MỞ VỊ THẾ (GIỮ NGUYÊN LOGIC GỐC)
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
            await sleep(2500); 
            const posRisk = await callBinance('/fapi/v2/positionRisk');
            const myPos = posRisk.find(p => p.symbol === symbol && p.positionSide === posSide && parseFloat(p.positionAmt) !== 0);
            if (!myPos) return;

            const entry = parseFloat(myPos.entryPrice);
            const qtyOnFloor = Math.abs(parseFloat(myPos.positionAmt));
            
            let tp, sl;
            if (isReverse) {
                tp = (posSide === 'LONG' ? entry * 1.5 : entry * 0.5).toFixed(info.pricePrecision);
                sl = (posSide === 'LONG' ? entry * 0.5 : entry * 1.5).toFixed(info.pricePrecision);
                addBotLog(`🔥 REVERSE x10 ${symbol} @${entry}. Giáp 50% giá: TP ${tp} | SL ${sl}`, "warning");
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

            await updateSànGiáp(symbol, side, posSide, tp, sl);
        }
    } catch (e) { addBotLog(`❌ Lỗi mở: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);
        const posRisk = await callBinance('/fapi/v2/positionRisk');

        for (let [symbol, data] of activeOrdersTracker) {
            if (data.isClosing) continue; 

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const price = parseFloat(ticker.price);
            const floorPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side && parseFloat(p.positionAmt) !== 0);

            if (!floorPos) {
                data.isClosing = true;
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const lastTrade = trades.find(t => t.symbol === symbol && t.positionSide === data.side);
                addBotLog(`💰 DONE ${symbol}. PnL: ${lastTrade?.realizedPnl || 0}$`, "success");
                activeOrdersTracker.delete(symbol);
                setTimeout(() => callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }), 10000);
                continue;
            }

            let hitLocal = (data.side === 'LONG' && (price >= data.tp || price <= data.sl)) || 
                           (data.side === 'SHORT' && (price <= data.tp || price >= data.sl));

            if (hitLocal) {
                data.isClosing = true; 
                addBotLog(`🚨 FAILSAFE ${symbol} @${price}. Vã Market...`, "warning");
                
                try {
                    const closeSide = data.side === 'LONG' ? 'sell' : 'buy';
                    const res = await exchange.createMarketOrder(symbol, closeSide, data.qty, {
                        positionSide: data.side,
                        reduceOnly: true
                    });
                    if (res.id) addBotLog(`✅ Gửi lệnh đóng ${symbol} thành công.`, "success");
                } catch (err) {
                    addBotLog(`❌ Lỗi vã Market CCXT: ${err.message}`, "error");
                }
                continue;
            }

            const diff = ((price - data.initialEntry) / data.initialEntry) * 100;
            const isAgainst = (data.side === 'LONG' && diff <= -botSettings.dcaStep * (data.dcaCount + 1)) || 
                              (data.side === 'SHORT' && diff >= botSettings.dcaStep * (data.dcaCount + 1));

            if (isAgainst) {
                if (data.dcaCount < botSettings.maxDCA) {
                    data.dcaCount++;
                    addBotLog(`📉 DCA TẦNG ${data.dcaCount}: ${symbol} ngược ${diff.toFixed(2)}%`, "warning");
                    await callBinance('/fapi/v1/order', 'POST', { 
                        symbol, side: data.side === 'LONG' ? 'BUY' : 'SELL', 
                        positionSide: data.side, type: 'MARKET', quantity: (data.qty / data.dcaCount).toFixed(status.exchangeInfo[symbol].quantityPrecision) 
                    });
                    await sleep(3000);
                    const newPos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === data.side);
                    data.entry = parseFloat(newPos.entryPrice);
                    data.qty = Math.abs(parseFloat(newPos.positionAmt));
                    data.tp = (data.side === 'LONG' ? data.entry * (1 + botSettings.posTP/100) : data.entry * (1 - botSettings.posTP/100)).toFixed(status.exchangeInfo[symbol].pricePrecision);
                    data.sl = (data.side === 'LONG' ? data.entry * (1 - botSettings.posSL/100) : data.entry * (1 + botSettings.posSL/100)).toFixed(status.exchangeInfo[symbol].pricePrecision);
                    await updateSànGiáp(symbol, data.side === 'LONG' ? 'BUY' : 'SELL', data.side, data.tp, data.sl);
                } else {
                    data.isClosing = true;
                    addBotLog(`💀 DCA CHÁY TẦNG 8. KILL & REVERSE x10 ${symbol}!`, "error");
                    await exchange.createMarketOrder(symbol, data.side === 'LONG' ? 'sell' : 'buy', data.qty, { positionSide: data.side, reduceOnly: true });
                    await sleep(3000);
                    await openPosition(symbol, data.side === 'LONG' ? 'SELL' : 'BUY', status.exchangeInfo[symbol], true);
                }
            }
        }

        // --- TÌM KÈO MỚI + ĐIỀU KIỆN LEVERAGE >= 20 ---
        if (activeOrdersTracker.size < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                const info = status.exchangeInfo[coin.symbol];
                
                // Kiểm tra: Chưa có lệnh, vol đạt chuẩn VÀ max leverage phải >= 20
                if (!activeOrdersTracker.has(coin.symbol) && !pendingSymbols.has(coin.symbol) && coin.maxV >= botSettings.minVol) {
                    
                    if (info && info.maxLeverage >= 20) {
                        pendingSymbols.add(coin.symbol);
                        await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', info);
                        setTimeout(() => pendingSymbols.delete(coin.symbol), 5000);
                        break;
                    } else {
                        // Log nhẹ để biết là bỏ qua do lev thấp (có thể xóa dòng này nếu muốn sạch log)
                        // console.log(`⏭️ Bỏ qua ${coin.symbol} do Max Lev chỉ x${info?.maxLeverage || '?'}`);
                    }
                }
            }
        }
    } catch (e) {}
}

// --- CÁC HÀM CƠ BẢN ---
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
        
        // Lấy exchangeInfo bao gồm cả bracket (leverage)
        const info = await callBinance('/fapi/v1/exchangeInfo');
        const brackets = await callBinance('/fapi/v1/leverageBracket');

        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const bracket = brackets.find(b => b.symbol === s.symbol);
            const maxLev = bracket ? bracket.brackets[0].initialLeverage : 0;

            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize),
                maxLeverage: maxLev 
            };
        });
        addBotLog("👿 LUFFY v15.8 - READY (FIXED CCXT & LEV FILTER)", "success");
    } catch (e) { console.log(e); }
}

init(); 
setInterval(mainLoop, 3500);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
