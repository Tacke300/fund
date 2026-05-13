import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// --- Cấu hình hằng số hệ thống ---
const FINAL_LONG_MULTIPLIER = 20; 
const SL_REENTRY_DELAY = 3000;   
const BLACKLIST_DURATION = 15 * 60 * 1000;

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

// --- Khởi tạo State ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: "1%", 
    minVol: 6.5, 
    posTP: 1.234, 
    posSL: 10.0, 
    dcaStep: 10.0, 
    maxDCA: 4 
};

// GIỮ NGUYÊN CÁC BIẾN ĐỂ DASHBOARD HIỂN THỊ
let status = { 
    botLogs: [], 
    exchangeInfo: null, 
    candidatesList: [], 
    isReady: false, 
    blackList: {}, 
    permBlock: new Set(), 
    botClosedCount: 0,    // Số lệnh đã chốt
    botPnLClosed: 0      // Tổng PnL đã chốt
};

let botActivePositions = new Map();
let isProcessingDCA = new Set(); 
let timestampOffset = 0; 
let walletInfo = { totalWalletBalance: "0.00", availableBalance: "0.00" }; // Biến đệm wallet

// --- Helper Functions ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) { throw new Error(e.response?.data?.msg || e.message); }
}

// Hàm cập nhật ví riêng để không làm treo bot
async function updateWalletData() {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        walletInfo.totalWalletBalance = parseFloat(acc.totalWalletBalance).toFixed(2);
        walletInfo.availableBalance = parseFloat(acc.availableBalance).toFixed(2);
    } catch (e) {}
}

async function clearOrders(symbol, side = 'SHORT') {
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        const filtered = orders.filter(o => o.positionSide === side);
        for (const o of filtered) { 
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }); 
        }
    } catch (e) { addBotLog(`🚨 Lỗi xóa lệnh ${symbol}: ${e.message}`, "error"); }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    const tpStr = parseFloat(tpPrice).toFixed(info.pricePrecision);
    const slStr = parseFloat(slPrice).toFixed(info.pricePrecision);
    try {
        await clearOrders(symbol, side);
        await new Promise(r => setTimeout(r, 1500));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: tpStr, closePosition: true, workingType: 'MARK_PRICE' 
        });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: slStr, closePosition: true, workingType: 'MARK_PRICE' 
        });
        return { tp: parseFloat(tpStr), sl: parseFloat(slStr) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi TPSL: ${e.message}`, "error");
        return { tp: 0, sl: 0 };
    }
}

// --- Logic Mở Lệnh & DCA ---
async function openPosition(symbol, dcaData = null) {
    const isFinalLong = dcaData?.isFinalLong || false;
    const side = isFinalLong ? 'LONG' : 'SHORT';
    const posKey = `${symbol}_${side}`;
    
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse;
        if (!dcaData) {
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(walletInfo.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
        } else {
            marginToUse = dcaData.margin;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 5.5) qtyNum = Math.ceil(6.5 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const orderSide = isFinalLong ? 'BUY' : 'SELL';
        
        const order = await exchange.createOrder(symbol, 'MARKET', orderSide, qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);

            if (realP) {
                const entryActual = parseFloat(realP.entryPrice);
                const qty = Math.abs(parseFloat(realP.positionAmt));
                const firstEntry = dcaData ? dcaData.firstEntry : entryActual;
                
                let historyEntries = dcaData ? [...dcaData.historyEntries] : [];
                if (dcaData && dcaData.isJump) {
                    const priceStep = firstEntry * (botSettings.posSL / 100);
                    for (let i = dcaData.prevCount + 1; i < dcaData.dcaCount; i++) {
                        historyEntries.push(firstEntry + (i * priceStep));
                    }
                }
                historyEntries.push(entryActual);

                const avgEntry = historyEntries.reduce((a, b) => a + b, 0) / historyEntries.length;
                const priceStepVal = firstEntry * (botSettings.posSL / 100);

                let tp, sl;
                if (isFinalLong) {
                    tp = entryActual * 1.10; sl = entryActual * 0.90; 
                } else {
                    tp = avgEntry * (1 - (botSettings.posTP / 100));
                    sl = entryActual + priceStepVal; 
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                
                botActivePositions.set(posKey, { 
                    symbol, side, entryPrice: entryActual, qty, 
                    tp: sync.tp, sl: sync.sl, margin: marginToUse,
                    firstEntry: firstEntry, firstMargin: dcaData ? dcaData.firstMargin : marginToUse,
                    dcaCount: dcaData ? dcaData.dcaCount : 0, 
                    historyEntries: historyEntries, markPrice: currentPrice,
                    pnl: 0 // Khởi tạo pnl
                });

                addBotLog(`✅ [${symbol}] DCA ${dcaData?.dcaCount || 0} | TBC: ${avgEntry.toFixed(info.pricePrecision)}`, "success");
            }
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] Lỗi Mở: ${e.message}`, "error"); } 
    finally { 
        setTimeout(() => { isProcessingDCA.delete(symbol); }, 1000); 
    }
}

// --- Monitor Loop ---
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const exchangeKeys = new Set();
        
        posRisk.forEach(p => { 
            const amt = Math.abs(parseFloat(p.positionAmt));
            if (amt > 0) {
                const key = `${p.symbol}_${p.positionSide}`;
                exchangeKeys.add(key);
                if (botActivePositions.has(key)) {
                    let bPos = botActivePositions.get(key);
                    bPos.markPrice = parseFloat(p.markPrice);
                    bPos.pnl = parseFloat(p.unRealizedProfit);
                }
            }
        });

        for (let [key, botPos] of botActivePositions) {
            if (!exchangeKeys.has(key)) {
                if (isProcessingDCA.has(botPos.symbol)) continue;
                
                await new Promise(r => setTimeout(r, SL_REENTRY_DELAY));
                const userTrades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: botPos.symbol, limit: 5 });
                const lastTrade = userTrades.sort((a, b) => b.time - a.time)[0];
                if (!lastTrade) continue;

                const realPnl = parseFloat(lastTrade.realizedPnl);
                
                // CẬP NHẬT BIẾN TOÀN CỤC CHO DASHBOARD
                status.botPnLClosed += realPnl;
                status.botClosedCount++;

                if (realPnl > 0) {
                    addBotLog(`💰 [${botPos.symbol}] Chốt lời: ${realPnl.toFixed(2)}$`, "success");
                    status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                    botActivePositions.delete(key);
                } else {
                    if (botPos.side === 'SHORT') {
                        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${botPos.symbol}`);
                        const nowPrice = parseFloat(ticker.data.price);
                        const priceStep = botPos.firstEntry * (botSettings.posSL / 100);
                        
                        let targetStep = Math.floor((nowPrice - botPos.firstEntry) / priceStep);
                        let nextCount = Math.max(botPos.dcaCount + 1, targetStep);
                        
                        if (nextCount <= botSettings.maxDCA) {
                            const nextMargin = botPos.firstMargin * (nextCount + 1) * 1.1; 
                            botActivePositions.delete(key);
                            await openPosition(botPos.symbol, {
                                dcaCount: nextCount, prevCount: botPos.dcaCount,
                                margin: nextMargin, firstMargin: botPos.firstMargin,
                                firstEntry: botPos.firstEntry, historyEntries: botPos.historyEntries,
                                isJump: nextCount > (botPos.dcaCount + 1),
                                isFinalLong: false
                            });
                        } else {
                            addBotLog(`🔥 [${botPos.symbol}] Max DCA -> ĐẢO LONG`, "error");
                            botActivePositions.delete(key);
                            await openPosition(botPos.symbol, {
                                dcaCount: botSettings.maxDCA + 1,
                                margin: botPos.firstMargin * FINAL_LONG_MULTIPLIER,
                                firstMargin: botPos.firstMargin,
                                firstEntry: botPos.firstEntry,
                                historyEntries: botPos.historyEntries,
                                isFinalLong: true
                            });
                        }
                    } else {
                        botActivePositions.delete(key);
                    }
                }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

// --- Khởi động & API ---
async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const entry = status.candidatesList.find(c => {
            const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol;
            const hasPos = botActivePositions.has(`${c.symbol}_SHORT`) || botActivePositions.has(`${c.symbol}_LONG`);
            return volOK && !status.blackList[c.symbol] && !hasPos && !isProcessingDCA.has(c.symbol);
        });
        if (entry) await openPosition(entry.symbol);
    }
}

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = brkRes.find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        
        await updateWalletData();
        setInterval(updateWalletData, 5000); // Cập nhật ví mỗi 5s
        
        addBotLog(`👹 LUFFY BOT - RESTORED & READY`, "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); 
setInterval(mainLoop, 5000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => {
    // Trả về đúng cấu trúc Dashboard cần
    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status,
        wallet: walletInfo 
    });
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
