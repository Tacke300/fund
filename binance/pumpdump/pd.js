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

// ============ TPSL VERIFY & LOG ID ============
async function verifyTPSLOrders(symbol, side) {
    try {
        await new Promise(r => setTimeout(r, 2000)); 
        const openOrders = await exchange.fetchOpenOrders(symbol);
        const tpslOrders = openOrders.filter(o => {
            const type = (o.info?.type || o.type || '').toUpperCase();
            const posSide = o.info?.positionSide;
            return ['TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(type) && posSide === side;
        });

        tpslOrders.forEach(o => {
            addBotLog(`📌 [${symbol}] Xác nhận lệnh chờ: ${o.info.type} | ID: ${o.id} | StopPrice: ${o.info.stopPrice}`, "success");
        });

        return tpslOrders.length >= 2;
    } catch (e) { return false; }
}

async function syncTPSL(symbol, side, entry, info) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    try {
        // Dọn lệnh cũ
        const openOrders = await exchange.fetchOpenOrders(symbol);
        for (const o of openOrders) await exchange.cancelOrder(o.id, symbol, { positionSide: side });

        // Đặt TP
        const orderTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        addBotLog(`🎯 [${symbol}] Đặt TP thành công | ID: ${orderTP.id} | Giá: ${tpPrice}`);

        // Đặt SL
        const orderSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        addBotLog(`🛑 [${symbol}] Đặt SL thành công | ID: ${orderSL.id} | Giá: ${slPrice}`);

        await verifyTPSLOrders(symbol, side);
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi Sync TPSL: ${e.message}`, "error");
        return { success: false };
    }
}

// ============ OPEN / DCA POSITION ============
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let cp = botActivePositions.get(posKey);
        let marginToUse = 0;

        if (isDCA) {
            if (!cp || cp.isProcessing) return;
            cp.isProcessing = true;
            marginToUse = cp.firstMargin;
            addBotLog(`💎 [${symbol}] Đang DCA lần ${cp.dcaCount + 1}...`);
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            addBotLog(`🚀 [${symbol}] Đang mở vị thế mới | Margin: ${marginToUse.toFixed(2)}$`);
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 5.1) qtyNum = Math.ceil(5.5 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`✅ [${symbol}] Khớp lệnh Market | ID: ${order.id} | Qty: ${qtyNum}`);
            await new Promise(r => setTimeout(r, 3000));
            
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const finalEntry = parseFloat(realP.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', 
                    entryPrice: finalEntry, 
                    qty: Math.abs(parseFloat(realP.positionAmt)), 
                    tp: sync.tp, sl: sync.sl, 
                    firstMargin: isDCA ? cp.firstMargin : marginToUse,
                    dcaCount: isDCA ? cp.dcaCount + 1 : 0, 
                    isProcessing: false, pnl: 0, priceDev: 0
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi lệnh: ${e.message}`, "error");
        if (isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    } finally {
        openingSymbols.delete(symbol);
    }
}

// ============ MONITOR LOOP ============
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeOnExchange = new Set();

        for (const realPos of posRisk) {
            const amount = Math.abs(parseFloat(realPos.positionAmt));
            if (amount > 0) {
                const key = `${realPos.symbol}_${realPos.positionSide}`;
                activeOnExchange.add(key);
                
                const botPos = botActivePositions.get(key);
                if (botPos) {
                    botPos.markPrice = parseFloat(realPos.markPrice);
                    botPos.pnl = parseFloat(realPos.unRealizedProfit);
                    botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;

                    // FAIL-SAFE: Giá vượt TP/SL mà lệnh chưa đóng
                    const hitTP = botPos.markPrice <= botPos.tp;
                    const hitSL = botPos.markPrice >= botPos.sl;
                    if (hitTP || hitSL) {
                        addBotLog(`⚠️ [${botPos.symbol}] Giá vượt ngưỡng (${botPos.markPrice}), tự đóng Market!`, "warning");
                        const info = status.exchangeInfo[botPos.symbol];
                        await exchange.createOrder(botPos.symbol, 'MARKET', 'BUY', botPos.qty.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
                    }
                }
            }
        }

        // Kiểm tra vị thế nào đã đóng
        for (let [key, botPos] of botActivePositions) {
            if (!activeOnExchange.has(key)) {
                addBotLog(`📉 [${botPos.symbol}] Đã đóng vị thế. Cho vào Blacklist 15p.`);
                status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                botActivePositions.delete(key);
                // Track PnL
                setTimeout(async () => {
                    const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: botPos.symbol, limit: 5 });
                    const pnl = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                    status.botPnLClosed += pnl;
                    status.botClosedCount++;
                }, 5000);
            }
        }
    } catch (e) { }
    setTimeout(priceMonitorLoop, 1000);
}

// ============ MAIN LOOP ============
async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const now = Date.now();
        // Clear blacklist
        Object.keys(status.blackList).forEach(s => { if (status.blackList[s] < now) delete status.blackList[s]; });

        // Check DCA
        for (let [key, botPos] of botActivePositions) {
            if (!botPos.isProcessing && botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) {
                await openPosition(botPos.symbol, true);
            }
        }

        // Check Open New
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const candidates = status.candidatesList.filter(c => {
                const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol || Math.abs(parseFloat(c.c5)) >= botSettings.minVol;
                return volOK && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`);
            });

            if (candidates.length > 0) {
                await openPosition(candidates[0].symbol, false);
            }
        }
    } catch (e) { }
}

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), maxLeverage: 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY V21.0 - LOG ID & FAIL-SAFE READY", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); 
setInterval(mainLoop, 5000);

// Lấy dữ liệu từ tín hiệu 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

// API SERVER
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status, 
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2),
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2)
            }
        });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
