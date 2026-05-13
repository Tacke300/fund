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
    timeout: 15000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true } 
});

// --- BIẾN TOÀN CỤC ---
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: 4 };
let status = { 
    botLogs: [], 
    candidatesList: [], 
    blackList: {}, 
    botClosedCount: 0, 
    botPnLClosed: 0,
    exchangeInfo: null,
    isReady: false 
};

let botActivePositions = new Map();
let isProcessingDCA = new Set();
let timestampOffset = 0;

// --- HÀM LOG CHI TIẾT ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// Hàm log bảng thông số vị thế
function logPositionDetail(type, symbol, side, margin, lev, entry, tp, sl) {
    const notional = (margin * lev).toFixed(2);
    const line = "------------------------------------------";
    console.log(`\n${line}`);
    console.log(`🚀 [${type.toUpperCase()}] ${symbol} | ${side}`);
    console.log(`🔹 Margin: ${margin.toFixed(2)}$ | Lev: x${lev} | Notional: ${notional}$`);
    console.log(`🔹 Entry: ${entry} | TP: ${tp.toFixed(5)} | SL: ${sl.toFixed(5)}`);
    console.log(`${line}\n`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
    return response.data;
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
        await new Promise(r => setTimeout(r, 500));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' 
        });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' 
        });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) {
        console.error(`Lỗi TPSL ${symbol}:`, e.message);
        return { tp: 0, sl: 0 };
    }
}

// --- LOGIC MỞ LỆNH ---
async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    const opType = dcaData ? (dcaData.isFinalLong ? 'Đảo Long' : `DCA #${dcaData.dcaCount}`) : 'Mở Gốc';
    
    try {
        const info = status.exchangeInfo[symbol];
        if (!info || info.maxLeverage < 20) return;

        await new Promise(r => setTimeout(r, 1000));
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        const acc = await binancePrivate('/fapi/v2/account');
        const avail = parseFloat(acc.availableBalance);
        
        let marginToUse = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (avail * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));

        // Fix Min Notional $6
        if ((marginToUse * info.maxLeverage) < 6) {
            marginToUse = 6 / info.maxLeverage;
        }

        if (avail < marginToUse) {
            addBotLog(`❌ Hết tiền cho ${symbol}: Cần ${marginToUse.toFixed(2)}$`, "error");
            return;
        }

        let qty = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        await exchange.setLeverage(info.maxLeverage, symbol);
        const orderSide = side === 'SHORT' ? 'SELL' : 'BUY';
        
        const order = await exchange.createOrder(symbol, 'MARKET', orderSide, qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const entryActual = parseFloat(realP.entryPrice);
                const firstEntry = dcaData ? dcaData.firstEntry : entryActual;
                
                let tp, sl;
                if (side === 'LONG') {
                    tp = entryActual * 1.10; // ĐÃ SỬA: TP LONG 10%
                    sl = entryActual * 0.90; // SL LONG 10%
                } else {
                    tp = entryActual * (1 - botSettings.posTP/100);
                    sl = firstEntry + (firstEntry * botSettings.posSL/100);
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                
                // GHI LOG CHI TIẾT RA CONSOLE
                logPositionDetail(opType, symbol, side, marginToUse, info.maxLeverage, entryActual, sync.tp, sync.sl);

                botActivePositions.set(`${symbol}_${side}`, {
                    symbol, side, entryPrice: entryActual, tp: sync.tp, sl: sync.sl,
                    dcaCount: dcaData ? dcaData.dcaCount : 0, leverage: info.maxLeverage,
                    firstEntry, firstMargin: dcaData ? dcaData.firstMargin : marginToUse
                });
                addBotLog(`✅ ${opType} ${symbol} thành công.`);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi ${opType} ${symbol}: ${e.message}`, "error"); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => []);
        const activeInExchange = new Set();

        posRisk.forEach(p => {
            if (Math.abs(parseFloat(p.positionAmt)) > 0) {
                const key = `${p.symbol}_${p.positionSide}`;
                activeInExchange.add(key);
                if (botActivePositions.has(key)) {
                    let b = botActivePositions.get(key);
                    b.pnl = parseFloat(p.unRealizedProfit);
                    b.priceDev = ((parseFloat(p.markPrice) - b.entryPrice) / b.entryPrice) * 100;
                }
            }
        });

        for (let [key, b] of botActivePositions) {
            if (!activeInExchange.has(key)) {
                if (isProcessingDCA.has(b.symbol)) continue;
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 5 }).catch(() => []);
                const rPnl = trades.sort((a,b) => b.time - a.time)[0]?.realizedPnl || 0;
                
                status.botPnLClosed += parseFloat(rPnl);
                status.botClosedCount++;

                if (parseFloat(rPnl) > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    botActivePositions.delete(key);
                    addBotLog(`💰 CHỐT LÃI ${b.symbol}: ${parseFloat(rPnl).toFixed(2)}$`, "success");
                } else {
                    const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${b.symbol}`);
                    const currentP = parseFloat(ticker.data.price);
                    const jumpStep = Math.max(b.dcaCount + 1, Math.floor((currentP - b.firstEntry) / (b.firstEntry * botSettings.posSL/100)));

                    botActivePositions.delete(key);
                    if (jumpStep <= botSettings.maxDCA) {
                        openPosition(b.symbol, { dcaCount: jumpStep, margin: b.firstMargin * (jumpStep + 1), firstMargin: b.firstMargin, firstEntry: b.firstEntry });
                    } else {
                        openPosition(b.symbol, { isFinalLong: true, margin: b.firstMargin * 20, firstEntry: b.firstEntry });
                    }
                }
            }
        }
    } catch (e) { }
    setTimeout(priceMonitor, 1000);
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    res.json({
        botSettings,
        activePositions: Array.from(botActivePositions.values()),
        status,
        wallet: acc ? { availableBalance: parseFloat(acc.availableBalance).toFixed(2) } : { availableBalance: "Err" }
    });
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
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const b = brk.find(x => x.symbol === s.symbol);
            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), maxLeverage: b?.brackets[0]?.initialLeverage || 20 
            };
        });
        status.exchangeInfo = temp; status.isReady = true;
        addBotLog("🚀 LUFFY BOT READY | TP LONG: 10%");
        priceMonitor();
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
