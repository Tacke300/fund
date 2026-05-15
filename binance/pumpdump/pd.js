import express from 'express';
import http from 'http';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// ==========================================
// CONFIG CỐ ĐỊNH
// ==========================================
const MAX_DCA_LEVEL = 3; 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Khởi tạo CCXT - Dùng cho mọi thao tác riêng tư (Private)
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, 
        recvWindow: 10000,
        adjustForTimeDifference: true 
    } 
});

// State hệ thống
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map();
let isProcessingDCA = new Set();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// --- MONITOR CHỈ QUẢN LÝ LỆNH BOT ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        // Dùng ccxt để lấy position để tránh lỗi API key
        const positions = await exchange.fapiPrivateGetPositionRisk();
        
        for (let [key, b] of botActivePositions) {
            const realP = positions.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;

                if (b.currentQty !== currentQty) { b.currentQty = currentQty; b.hitTime = null; }

                // Check đóng khẩn cấp nếu lệnh treo
                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;

                // Lấy PnL sau khi đóng
                const trades = await exchange.fapiPrivateGetUserTrades({ symbol: b.symbol, limit: 10 });
                const now = Date.now();
                const recent = trades.filter(t => (now - parseInt(t.time)) < 60000);
                let totalR = 0;
                recent.forEach(t => totalR += parseFloat(t.realizedPnl));
                
                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += totalR;

                if (totalR > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 CHỐT ${b.symbol} | PnL: ${totalR.toFixed(2)}$`);
                } else {
                    // Logic DCA cho lệnh SHORT
                    const ticker = await exchange.fapiPublicGetTickerPrice({ symbol: b.symbol });
                    const jump = Math.max(b.dcaCount + 1, Math.floor((parseFloat(ticker.price) - b.firstEntry) / (b.firstEntry * botSettings.posSL/100)));
                    if (jump <= botSettings.maxDCA) openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    else openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await exchange.fapiPrivateGetAccount();
        const botUnrealizedPnL = Array.from(botActivePositions.values()).reduce((s, p) => s + (p.pnl || 0), 0);
        
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()),
            status: {
                ...status,
                blackList: Object.fromEntries(Object.entries(status.blackList).map(([s, t]) => [s, Math.max(0, Math.floor((t - Date.now()) / 1000))]))
            }, 
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
                totalUnrealizedProfit: botUnrealizedPnL.toFixed(2)
            } 
        });
    } catch (e) {
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" } });
    }
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    res.json({ success: true }); 
});

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await exchange.fapiPrivateGetAccount();
        
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
        
        const ticker = await exchange.fapiPublicGetTickerPrice({ symbol });
        const price = parseFloat(ticker.price);
        let qty = Math.ceil(((margin * info.maxLeverage) / price) / info.stepSize) * info.stepSize;
        
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await exchange.fapiPrivateGetPositionRisk({ symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                let tp = (side === 'LONG') ? entry * 1.10 : entry * (1 - botSettings.posTP/100);
                let sl = (side === 'LONG') ? entry * 0.90 : firstE + (firstE * botSettings.posSL/100);
                
                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, 
                    dcaCount: dcaData ? dcaData.dcaCount : 0, 
                    leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), 
                    pnl: 0, priceDev: 0, hitTime: null 
                });
                addBotLog(`✅ Mở ${symbol} ${side}`);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi mở: ${e.message}`); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await exchange.fapiPrivateGetOpenOrders({ symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await exchange.fapiPrivateDeleteOrder({ symbol, orderId: o.orderId });
        }
        await new Promise(r => setTimeout(r, 600));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: tpPrice, sl: slPrice }; }
}

async function init() {
    try {
        addBotLog(`🔄 Đang khởi tạo kết nối...`);
        await exchange.loadMarkets();
        
        const info = await exchange.fapiPublicGetExchangeInfo();
        const brk = await exchange.fapiPrivateGetLeverageBracket();
        
        const temp = {};
        info.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lotFilter.stepSize), 
                maxLeverage: b?.brackets[0]?.initialLeverage || 20 
            };
        });
        status.exchangeInfo = temp; 
        status.isReady = true; 
        priceMonitor();
        addBotLog(`🚀 Bot đã chạy thành công!`);
    } catch (e) { 
        console.error("Init Error:", e.message);
        setTimeout(init, 5000); 
    }
}

init();

// Nhận dữ liệu từ scanner
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// Quét mở lệnh
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => Math.abs(c.c1) >= botSettings.minVol && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
        if (can) openPosition(can.symbol);
    }
}, 3000);

APP.listen(9001);
