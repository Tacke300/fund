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

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();

const positionLocks = new Map();
const BLACKLIST_DURATION = 15 * 60 * 1000;

// ============ LOGGING ============
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// ============ UTILITY ============
async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const res = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return res.data;
    } catch (e) { throw new Error(e.response?.data?.msg || e.message); }
}

async function acquirePositionLock(symbol) {
    const posKey = `${symbol}_SHORT`;
    while (positionLocks.has(posKey)) await new Promise(r => setTimeout(r, 200));
    positionLocks.set(posKey, true);
}
function releasePositionLock(symbol) { positionLocks.delete(`${symbol}_SHORT`); }

// ============ FIX: DỌN LỆNH CHỜ (PHẢI CÓ POSITIONSIDE) ============
async function forceClearAllOrders(symbol) {
    try {
        const openOrders = await exchange.fetchOpenOrders(symbol);
        const shortOrders = openOrders.filter(o => o.info.positionSide === 'SHORT');
        for (const order of shortOrders) {
            // Trong chế độ 2 chiều, khi hủy lệnh phải kèm params positionSide
            await exchange.cancelOrder(order.id, symbol, { positionSide: 'SHORT' });
        }
        if (shortOrders.length > 0) addBotLog(`🧹 [${symbol}] Đã dọn ${shortOrders.length} lệnh chờ SHORT.`);
        return true;
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi xóa lệnh: ${e.message}`, "error");
        return false;
    }
}

// ============ FIX: VERIFY LỆNH CHỜ ============
async function verifyTPSLOrders(symbol, side, maxAttempts = 5) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const openOrders = await exchange.fetchOpenOrders(symbol);
            const tpsl = openOrders.filter(o => o.info.positionSide === side && 
                ['TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(o.info.type || o.type));
            
            const hasTP = tpsl.some(o => (o.info.type || o.type).includes('TAKE_PROFIT'));
            const hasSL = tpsl.some(o => (o.info.type || o.type).includes('STOP'));

            if (hasTP && hasSL) return true;
            addBotLog(`⏳ [${symbol}] Đợi lệnh xuất hiện trên sàn... (${i+1}/${maxAttempts})`);
        } catch (e) { addBotLog(`⚠️ [${symbol}] Verify error: ${e.message}`); }
    }
    return false;
}

// ============ FIX: ĐÓNG VỊ THẾ KHẨN CẤP (CHẾ ĐỘ 2 CHIỀU) ============
async function emergencyClose(symbol, side, info) {
    try {
        addBotLog(`🚨 [${symbol}] KÍCH HOẠT ĐÓNG VỊ THẾ KHẨN CẤP...`, "error");
        await forceClearAllOrders(symbol);
        
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realPos = posRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        if (realPos) {
            const qty = Math.abs(parseFloat(realPos.positionAmt));
            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            
            // QUAN TRỌNG: Gửi lệnh ngược side kèm positionSide để sàn hiểu là ĐÓNG VỊ THẾ
            await exchange.createOrder(symbol, 'MARKET', sideClose, qty.toFixed(info.quantityPrecision), undefined, { 
                positionSide: side 
            });
            addBotLog(`🔥 [${symbol}] Đã đóng sạch vị thế ${side} bằng lệnh Market.`);
        }
    } catch (e) { addBotLog(`❌ [${symbol}] KHÔNG THỂ ĐÓNG VỊ THẾ: ${e.message}`, "error"); }
}

// ============ ĐẶT TP/SL MỚI ============
async function syncTPSL(symbol, side, entry, info) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    try {
        await forceClearAllOrders(symbol);
        await new Promise(r => setTimeout(r, 1000));

        // Đặt lệnh TP & SL
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE'
        });

        const ok = await verifyTPSLOrders(symbol, side);
        if (!ok) {
            addBotLog(`❌ [${symbol}] Không verify được lệnh chờ sau khi đặt!`, "error");
            await emergencyClose(symbol, side, info);
            return { success: false };
        }
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi syncTPSL: ${e.message}`, "error");
        await emergencyClose(symbol, side, info);
        return { success: false };
    }
}

// ============ MỞ VỊ THẾ & DCA ============
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    try {
        await acquirePositionLock(symbol);
        const info = status.exchangeInfo[symbol];
        if (!info) return;

        let cp = isDCA ? botActivePositions.get(posKey) : null;
        if (isDCA && (!cp || cp.isProcessing)) return;
        if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;

        if (isDCA) cp.isProcessing = true; else openingSymbols.add(symbol);

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = isDCA ? cp.firstMargin : (botSettings.invValue.toString().includes('%') 
            ? ((await binancePrivate('/fapi/v2/account')).availableBalance * parseFloat(botSettings.invValue) / 100) 
            : parseFloat(botSettings.invValue));

        let qtyNum = Math.max((marginToUse * info.maxLeverage) / currentPrice, 6/currentPrice);
        qtyNum = Math.ceil(qtyNum / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        
        // Mở vị thế (Lệnh SELL với positionSide: SHORT)
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { 
            positionSide: 'SHORT' 
        });

        if (order) {
            await new Promise(r => setTimeout(r, 3000));
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realPos = posRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realPos) {
                const finalEntry = parseFloat(realPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                
                if (sync.success) {
                    botActivePositions.set(posKey, { 
                        symbol, side: 'SHORT', entryPrice: finalEntry, originalEntry: isDCA ? cp.originalEntry : finalEntry,
                        qty: Math.abs(parseFloat(realPos.positionAmt)), tp: sync.tp, sl: sync.sl, 
                        firstMargin: isDCA ? cp.firstMargin : marginToUse, dcaCount: isDCA ? cp.dcaCount + 1 : 0, 
                        isProcessing: false, pnl: 0, priceDev: 0
                    });
                    status.blackList[symbol] = Date.now() + BLACKLIST_DURATION;
                    addBotLog(`🚀 [${symbol}] ${isDCA ? 'DCA' : 'OPEN'} thành công!`, "success");
                }
            }
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] OPEN ERROR: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); releasePositionLock(symbol); }
}

// ============ LOOP QUẢN LÝ ============
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                botActivePositions.delete(key);
                status.botClosedCount++;
                addBotLog(`✅ [${botPos.symbol}] Vị thế đã đóng.`, "success");
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1500);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        // Check DCA
        for (let [key, botPos] of botActivePositions) {
            if (!botPos.isProcessing && botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) {
                await openPosition(botPos.symbol, true);
            }
        }
        // Check Mở mới
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && 
                (Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol));
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: 20 };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY V21.0 - CHẾ ĐỘ 2 CHIỀU ĐÃ FIX", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 5000);
const APP = express();
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: acc.availableBalance });
    } catch(e) { res.json({ status }); }
});
APP.listen(9001);
