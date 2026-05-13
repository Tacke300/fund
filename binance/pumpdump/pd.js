import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

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

// SỬ DỤNG CCXT CHO CÁC TÁC VỤ PRIVATE ĐỂ ĐẢM BẢO CHÍNH XÁC SỐ DƯ
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.234, posSL: 10.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, permBlock: new Set(), botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let isProcessingDCA = new Set(); 
let walletInfo = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// HÀM LẤY SỐ DƯ DÙNG CCXT CHO CHUẨN
async function updateWallet() {
    if (!status.isReady) return;
    try {
        const balance = await exchange.fetchBalance();
        const info = balance.info; // Dữ liệu gốc từ Binance Futures
        walletInfo = { 
            totalWalletBalance: parseFloat(info.totalWalletBalance).toFixed(2), 
            availableBalance: parseFloat(info.availableBalance).toFixed(2), 
            totalUnrealizedProfit: parseFloat(info.totalCrossUnPnl).toFixed(2) 
        };
    } catch (e) { 
        console.error("Wallet Update Error:", e.message); 
    }
}

async function clearOrders(symbol, side = 'SHORT') {
    try {
        const orders = await exchange.fapiPrivateGetOpenOrders({ symbol });
        const filtered = orders.filter(o => o.positionSide === side);
        for (const o of filtered) { 
            await exchange.fapiPrivateDeleteOrder({ symbol, orderId: o.orderId }); 
        }
    } catch (e) { addBotLog(`🚨 Lỗi xóa lệnh ${symbol}: ${e.message}`, "error"); }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    const tpStr = parseFloat(tpPrice).toFixed(info.pricePrecision);
    const slStr = parseFloat(slPrice).toFixed(info.pricePrecision);
    try {
        await clearOrders(symbol, side);
        await new Promise(r => setTimeout(r, 1000));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpStr, closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slStr, closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: parseFloat(tpStr), sl: parseFloat(slStr) };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

async function openPosition(symbol, dcaData = null) {
    const isFinalLong = dcaData?.isFinalLong || false;
    const side = isFinalLong ? 'LONG' : 'SHORT';
    const posKey = `${symbol}_${side}`;
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await exchange.fetchTicker(symbol);
        const currentPrice = ticker.last;
        
        let marginToUse = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(walletInfo.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) : parseFloat(botSettings.invValue));
        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 5.5) qtyNum = Math.ceil(6.5 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const orderSide = isFinalLong ? 'BUY' : 'SELL';
        const order = await exchange.createOrder(symbol, 'MARKET', orderSide, qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const positions = await exchange.fetchPositions([symbol]);
            const realP = positions.find(p => p.symbol === symbol && p.side === (side === 'SHORT' ? 'short' : 'long') && p.contracts > 0);

            if (realP) {
                const entryActual = realP.entryPrice;
                const firstEntry = dcaData ? dcaData.firstEntry : entryActual;
                let historyEntries = dcaData ? [...dcaData.historyEntries] : [];
                if (dcaData?.isJump) {
                    const priceStep = firstEntry * (botSettings.posSL / 100);
                    for (let i = dcaData.prevCount + 1; i < dcaData.dcaCount; i++) { historyEntries.push(firstEntry + (i * priceStep)); }
                }
                historyEntries.push(entryActual);
                const avgEntry = historyEntries.reduce((a, b) => a + b, 0) / historyEntries.length;

                let tp = isFinalLong ? entryActual * 1.10 : avgEntry * (1 - (botSettings.posTP / 100));
                let sl = isFinalLong ? entryActual * 0.90 : entryActual + (firstEntry * (botSettings.posSL / 100));

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(posKey, { 
                    symbol, side, entryPrice: entryActual, qty: realP.contracts, 
                    tp: sync.tp, sl: sync.sl, margin: marginToUse, firstEntry, firstMargin: dcaData ? dcaData.firstMargin : marginToUse,
                    dcaCount: dcaData ? dcaData.dcaCount : 0, historyEntries, pnl: realP.unrealizedPnl, priceDev: 0, leverage: info.maxLeverage
                });
                addBotLog(`✅ [${symbol}] VÀO LỆNH THÀNH CÔNG`, "success");
            }
        }
    } catch (e) { addBotLog(`🚨 Lỗi: ${e.message}`, "error"); } 
    finally { isProcessingDCA.delete(symbol); }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const positions = await exchange.fetchPositions();
        const activeKeys = new Set();
        
        positions.forEach(p => {
            if (p.contracts > 0) {
                const sideStr = p.side === 'short' ? 'SHORT' : 'LONG';
                const key = `${p.symbol}_${sideStr}`;
                activeKeys.add(key);
                if (botActivePositions.has(key)) {
                    let bPos = botActivePositions.get(key);
                    bPos.pnl = p.unrealizedPnl;
                    const markPrice = p.markPrice;
                    bPos.priceDev = bPos.side === 'SHORT' ? ((bPos.entryPrice - markPrice) / bPos.entryPrice * 100) : ((markPrice - bPos.entryPrice) / bPos.entryPrice * 100);
                }
            }
        });

        for (let [key, botPos] of botActivePositions) {
            if (!activeKeys.has(key)) {
                if (isProcessingDCA.has(botPos.symbol)) continue;
                await new Promise(r => setTimeout(r, SL_REENTRY_DELAY));
                const trades = await exchange.fetchMyTrades(botPos.symbol, undefined, 5);
                const last = trades.sort((a,b) => b.timestamp - a.timestamp)[0];
                if (!last) continue;

                const rPnl = last.fee ? last.info.realizedPnl : 0; 
                status.botPnLClosed += parseFloat(rPnl); 
                status.botClosedCount++;

                if (parseFloat(rPnl) > 0) {
                    addBotLog(`💰 [${botPos.symbol}] LÃI: ${rPnl}$`, "success");
                    status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                    botActivePositions.delete(key);
                } else {
                    if (botPos.side === 'SHORT') {
                        const ticker = await exchange.fetchTicker(botPos.symbol);
                        const nowP = ticker.last;
                        const step = botPos.firstEntry * (botSettings.posSL / 100);
                        let jumpStep = Math.max(botPos.dcaCount + 1, Math.floor((nowP - botPos.firstEntry) / step));
                        
                        if (jumpStep <= botSettings.maxDCA) {
                            botActivePositions.delete(key);
                            await openPosition(botPos.symbol, { 
                                dcaCount: jumpStep, prevCount: botPos.dcaCount, margin: botPos.firstMargin * (jumpStep + 1) * 1.1,
                                firstMargin: botPos.firstMargin, firstEntry: botPos.firstEntry, historyEntries: botPos.historyEntries,
                                isJump: jumpStep > (botPos.dcaCount + 1)
                            });
                        } else {
                            botActivePositions.delete(key);
                            await openPosition(botPos.symbol, { isFinalLong: true, margin: botPos.firstMargin * FINAL_LONG_MULTIPLIER, firstMargin: botPos.firstMargin, firstEntry: botPos.firstEntry, historyEntries: botPos.historyEntries });
                        }
                    } else { botActivePositions.delete(key); }
                }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function init() {
    try {
        await exchange.loadMarkets();
        const info = await exchange.fapiPublicGetExchangeInfo();
        const brk = await exchange.fapiPrivateGetLeverageBracket();
        const temp = {};
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const b = brk.find(x => x.symbol === s.symbol);
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: b ? b.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = temp; status.isReady = true;
        addBotLog("🚀 BOT DASHBOARD RESTORED");
        
        await updateWallet(); 
        setInterval(updateWallet, 5000);
        priceMonitorLoop();
    } catch (e) { 
        console.log("Init Error:", e.message);
        setTimeout(init, 5000); 
    }
}

init(); 
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const candidate = status.candidatesList.find(c => Math.abs(parseFloat(c.c1)) >= botSettings.minVol && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
        if (candidate) openPosition(candidate.symbol);
    }
}, 5000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => {
    const bl = {}; const now = Date.now();
    Object.keys(status.blackList).forEach(s => { const r = Math.floor((status.blackList[s] - now) / 1000); if (r > 0) bl[s] = r; else delete status.blackList[s]; });
    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: { ...status, blackList: bl, candidatesList: status.candidatesList }, 
        wallet: walletInfo 
    });
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
