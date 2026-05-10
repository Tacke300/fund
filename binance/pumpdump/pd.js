import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// --- CONFIG DỄ SỬA ---
const FINAL_LONG_MULTIPLIER = 20; // Hệ số Margin cho lệnh Long cuối cùng
const SL_REENTRY_DELAY = 3500;   // Delay 1.5s sau khi dính SL
// ---------------------

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
let status = { 
    botLogs: [], 
    exchangeInfo: null, 
    candidatesList: [], 
    isReady: false, 
    blackList: {}, 
    permBlock: new Set(), // Chặn vĩnh viễn coin lev thấp trong phiên chạy này
    botClosedCount: 0, 
    botPnLClosed: 0 
};
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();
const BLACKLIST_DURATION = 15 * 60 * 1000;

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
    } catch (e) {
        throw new Error(e.response?.data?.msg || e.message);
    }
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

async function syncTPSL(symbol, side, entry, info, customTP = null, customSL = null) {
    const isShort = side === 'SHORT';
    const tpPrice = parseFloat(customTP).toFixed(info.pricePrecision);
    const slPrice = parseFloat(customSL).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    try {
        await clearOrders(symbol, side);
        await new Promise(r => setTimeout(r, 2500));

        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE'
        });

        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi cài TPSL: ${e.message}`, "error");
        return { tp: 0, sl: 0 };
    }
}

async function openPosition(symbol, dcaData = null) {
    const isFinalLong = dcaData?.isFinalLong || false;
    const side = isFinalLong ? 'LONG' : 'SHORT';
    const posKey = `${symbol}_${side}`;
    
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        
        // --- CHẶN COIN LEV THẤP VÀO PERM BLOCK ---
        if (info.maxLeverage < 20) {
            addBotLog(`🚫 [${symbol}] MaxLev ${info.maxLeverage} < 20. Chặn vĩnh viễn tới khi reset PM2.`, "warning");
            status.permBlock.add(symbol);
            return;
        }

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse;
        if (!dcaData) {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
        } else {
            marginToUse = dcaData.margin;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 5.5) qtyNum = Math.ceil(6.5 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const orderSide = isFinalLong ? 'BUY' : 'SELL';
        
        addBotLog(`🚀 [${symbol}] Mở ${side} | Margin: ${marginToUse.toFixed(2)} | Lev: ${info.maxLeverage}x`);
        const order = await exchange.createOrder(symbol, 'MARKET', orderSide, qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        if (order) {
            await new Promise(r => setTimeout(r, 2500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const entry = parseFloat(realP.entryPrice);
                const qty = Math.abs(parseFloat(realP.positionAmt));
                
                let tp, sl;
                if (isFinalLong) {
                    tp = entry * 1.10; // TP 10% cho Long
                    sl = entry * 0.90; // SL 10% cho Long
                } else {
                    const avgEntry = dcaData ? ( (dcaData.prevAvgEntry * dcaData.prevQty) + (entry * qty) ) / (dcaData.prevQty + qty) : entry;
                    tp = avgEntry * (1 - botSettings.posTP / 100);
                    sl = avgEntry * (1 + botSettings.posSL / 100);
                }

                const sync = await syncTPSL(symbol, side, entry, info, tp, sl);
                
                const posObj = { 
                    symbol, side, entryPrice: entry, qty, 
                    tp: sync.tp, sl: sync.sl, margin: marginToUse,
                    leverage: info.maxLeverage, 
                    firstMargin: dcaData ? dcaData.firstMargin : marginToUse,
                    dcaCount: dcaData ? dcaData.dcaCount : 0, 
                    historyEntries: dcaData ? [...dcaData.historyEntries, entry] : [entry],
                    pnl: 0, markPrice: currentPrice, priceDev: 0
                };

                botActivePositions.set(posKey, posObj);
                
                if (posObj.dcaCount > 0) {
                    addBotLog(`📝 [${symbol}] DCA Lần ${posObj.dcaCount} - Entry: ${entry} - Trung bình: ${((entry + posObj.historyEntries[0])/2).toFixed(info.pricePrecision)} - TP: ${sync.tp} SL: ${sync.sl}`);
                } else {
                    addBotLog(`✅ [${symbol}] ${side} OPEN - Entry: ${entry} - Margin: ${marginToUse.toFixed(2)} - TP: ${sync.tp} - SL: ${sync.sl}`, "success");
                }
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi Mở: ${e.message}`, "error");
    } finally {
        openingSymbols.delete(symbol);
    }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const exchangeKeys = new Set();
        posRisk.forEach(p => { if (Math.abs(parseFloat(p.positionAmt)) > 0) exchangeKeys.add(`${p.symbol}_${p.positionSide}`); });

        for (let [key, botPos] of botActivePositions) {
            const isShort = botPos.side === 'SHORT';
            if (!exchangeKeys.has(key)) {
                // ĐỢI 1.5S GIẢM LAG SÀN TRƯỚC KHI XỬ LÝ RE-ENTRY
                await new Promise(r => setTimeout(r, SL_REENTRY_DELAY));

                const userTrades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: botPos.symbol, limit: 5 });
                const lastTrade = userTrades.sort((a, b) => b.time - a.time)[0];
                const realPnl = parseFloat(lastTrade.realizedPnl);
                const fee = (botPos.qty * botPos.markPrice) * 0.001;
                const netPnl = realPnl - fee;

                status.botPnLClosed += netPnl;
                status.botClosedCount++;

                if (realPnl > 0) {
                    addBotLog(`💰 [${botPos.symbol}] Chốt lời: ${netPnl.toFixed(2)} USDT. Blacklist 15p.`, "success");
                    status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                    botActivePositions.delete(key);
                } else {
                    addBotLog(`📉 [${botPos.symbol}] Dính SL: ${netPnl.toFixed(2)} USDT. Đang chuẩn bị DCA...`, "warning");
                    
                    if (isShort && botPos.dcaCount < botSettings.maxDCA) {
                        const nextCount = botPos.dcaCount + 1;
                        const nextMargin = botPos.firstMargin * nextCount * 1.1;
                        botActivePositions.delete(key);
                        await openPosition(botPos.symbol, {
                            dcaCount: nextCount,
                            margin: nextMargin,
                            firstMargin: botPos.firstMargin,
                            historyEntries: botPos.historyEntries,
                            prevAvgEntry: botPos.entryPrice,
                            prevQty: botPos.qty,
                            isFinalLong: false
                        });
                    } else if (isShort && botPos.dcaCount >= botSettings.maxDCA) {
                        addBotLog(`🔥 [${botPos.symbol}] Max DCA - Đảo LONG x${FINAL_LONG_MULTIPLIER} Margin!`, "error");
                        const finalMargin = botPos.firstMargin * FINAL_LONG_MULTIPLIER;
                        botActivePositions.delete(key);
                        await openPosition(botPos.symbol, {
                            dcaCount: botPos.dcaCount + 1,
                            margin: finalMargin,
                            firstMargin: botPos.firstMargin,
                            historyEntries: botPos.historyEntries,
                            isFinalLong: true
                        });
                    } else {
                        botActivePositions.delete(key);
                    }
                }
            } else {
                const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
                botPos.markPrice = parseFloat(p.markPrice);
                botPos.pnl = parseFloat(p.unRealizedProfit);
                botPos.priceDev = isShort 
                    ? ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100
                    : ((botPos.entryPrice - botPos.markPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) { }
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const entry = status.candidatesList.find(c => {
                const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol || Math.abs(parseFloat(c.c5)) >= botSettings.minVol;
                // THÊM CHẶN PERMBLOCK VÀ BLACKLIST
                return volOK && !status.blackList[c.symbol] && !status.permBlock.has(c.symbol) && !botActivePositions.has(`${c.symbol}_SHORT`);
            });
            if (entry) await openPosition(entry.symbol);
        }
    } catch (e) { }
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
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog(`👿 LUFFY V22.1 - LONG x${FINAL_LONG_MULTIPLIER} & DELAY 1.5S READY`, "success");
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
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const blSecs = {}; const now = Date.now();
        Object.keys(status.blackList).forEach(s => { 
            const rem = Math.floor((status.blackList[s] - now) / 1000); 
            if (rem > 0) blSecs[s] = rem; else delete status.blackList[s]; 
        });
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status: { ...status, blackList: blSecs, permBlock: Array.from(status.permBlock) }, 
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2),
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2),
                botPnLClosed: status.botPnLClosed.toFixed(2)
            }
        });
    } catch (e) { res.json({ status }); }
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

APP.listen(9001);
