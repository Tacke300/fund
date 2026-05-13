import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true } });

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: 4 };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map();
let isProcessingDCA = new Set();
let timestampOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

function logPositionStatus(b, opType = "MONITOR") {
    const line = "------------------------------------------";
    console.log(`\n${line}`);
    console.log(`📌 [${opType}] ${b.symbol} | ${b.side} | DCA: #${b.dcaCount}`);
    console.log(`💰 Margin: ${b.currentMargin.toFixed(2)}$ | Lev: x${b.leverage} | Size: ${b.currentQty} Units`);
    console.log(`📍 Entry Gốc: ${b.firstEntry} | Entry Hiện Tại: ${b.entryPrice}`);
    if (b.dcaHistory.length > 0) console.log(`📜 Lịch sử Entry: ${b.dcaHistory.join(' -> ')}`);
    console.log(`🎯 TP: ${b.tp.toFixed(6)} | SL: ${b.sl.toFixed(6)}`);
    console.log(`📈 PnL: ${b.pnl.toFixed(2)}$ (${b.priceDev.toFixed(2)}%)`);
    console.log(`${line}\n`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
    return response.data;
}

// --- QUẢN LÝ VỊ THẾ & CHỐT CHẶN THÔNG MINH ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeInExchange = new Map();
        posRisk.forEach(p => { if (Math.abs(parseFloat(p.positionAmt)) > 0) activeInExchange.set(`${p.symbol}_${p.positionSide}`, p); });

        for (let [key, b] of botActivePositions) {
            const realP = activeInExchange.get(key);
            
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                // 1. CẬP NHẬT THÔNG SỐ
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;

                // 2. CHECK BIẾN ĐỘNG SIZE (Nếu size thay đổi -> vừa DCA xong -> Reset bộ đếm 30s)
                if (b.currentQty !== currentQty) {
                    b.currentQty = currentQty;
                    b.hitTime = null; 
                    addBotLog(`🔄 ${b.symbol} phát hiện thay đổi Volume, reset bộ đếm an toàn.`);
                }

                // 3. LOGIC CHỐT CHẶN 30S
                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ ${b.symbol} kẹt lệnh chờ > 30s. Đóng Market khẩn cấp!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else {
                    b.hitTime = null;
                }
            } else {
                // VỊ THẾ ĐÃ ĐÓNG (HOẶC ĐANG TRONG QUÁ TRÌNH DCA)
                if (isProcessingDCA.has(b.symbol)) continue;

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });
                const recentTrades = trades.filter(t => t.time > (Date.now() + timestampOffset - 15000));
                
                let totalRealized = 0; let totalVolume = 0;
                recentTrades.forEach(t => {
                    totalRealized += parseFloat(t.realizedPnl);
                    totalVolume += (parseFloat(t.price) * parseFloat(t.qty));
                });

                const fee = totalVolume * 0.001;
                const netPnl = totalRealized - fee;

                botActivePositions.delete(key);
                status.botClosedCount++;
                status.botPnLClosed += netPnl;

                if (netPnl > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 CHỐT LÃI ${b.symbol} | Net: ${netPnl.toFixed(2)}$ (Fee: ${fee.toFixed(2)}$)`);
                } else {
                    const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${b.symbol}`);
                    const currP = parseFloat(ticker.data.price);
                    const step = b.firstEntry * (botSettings.posSL / 100);
                    let jump = Math.max(b.dcaCount + 1, Math.floor((currP - b.firstEntry) / step));

                    if (jump <= botSettings.maxDCA) {
                        addBotLog(`🔄 ${b.symbol} SL -> Chạy DCA #${jump}`);
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    } else {
                        addBotLog(`🔥 ${b.symbol} MAX DCA -> ĐẢO LONG x20`);
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
                    }
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// --- CÁC HÀM CÒN LẠI GIỮ NGUYÊN LOGIC ---
async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    try {
        const info = status.exchangeInfo[symbol];
        if (!info || info.maxLeverage < 20) return;
        await new Promise(r => setTimeout(r, 1000));
        const acc = await binancePrivate('/fapi/v2/account');
        let marginToUse = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        if ((marginToUse * info.maxLeverage) < 6) marginToUse = 6 / info.maxLeverage;
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let qty = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const entryActual = parseFloat(realP.entryPrice);
                const firstEntry = dcaData ? dcaData.firstEntry : entryActual;
                const dcaHistory = dcaData ? [...dcaData.dcaHistory, entryActual] : [entryActual];
                let tp = (side === 'LONG') ? entryActual * 1.10 : entryActual * (1 - botSettings.posTP/100);
                let sl = (side === 'LONG') ? entryActual * 0.90 : firstEntry + (firstEntry * botSettings.posSL/100);
                const sync = await syncTPSL(symbol, side, info, tp, sl);
                const posObj = { symbol, side, entryPrice: entryActual, tp: sync.tp, sl: sync.sl, dcaCount: dcaData ? dcaData.dcaCount : 0, leverage: info.maxLeverage, firstEntry, firstMargin: dcaData ? dcaData.firstMargin : marginToUse, currentMargin: marginToUse, currentQty: Math.abs(parseFloat(realP.positionAmt)), dcaHistory, pnl: 0, priceDev: 0, hitTime: null };
                botActivePositions.set(`${symbol}_${side}`, posObj);
                logPositionStatus(posObj, dcaData ? "DCA/REVERSE" : "NEW OPEN");
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi mở lệnh: ${e.message}`, "error"); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        await new Promise(r => setTimeout(r, 500));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: acc ? { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) } : { availableBalance: "ERR" } });
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

async function init() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: b?.brackets[0]?.initialLeverage || 20 };
        });
        status.exchangeInfo = temp; status.isReady = true; priceMonitor();
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => Math.abs(c.c1) >= botSettings.minVol && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
        if (can) openPosition(can.symbol);
    }
}, 3000);
APP.listen(9001);
