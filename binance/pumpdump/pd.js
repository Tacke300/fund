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
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true } 
});

// Khởi tạo đúng cấu trúc khớp với HTML script
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

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 30) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
    return response.data;
}

// Logic đặt TPSL đồng bộ với lệnh hiện tại
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
    } catch (e) { return { tp: 0, sl: 0 }; }
}

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';

    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        const acc = await binancePrivate('/fapi/v2/account');
        
        let marginToUse = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        let qty = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const orderSide = side === 'SHORT' ? 'SELL' : 'BUY';
        const order = await exchange.createOrder(symbol, 'MARKET', orderSide, qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        if (order) {
            await new Promise(r => setTimeout(r, 1200));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const entryActual = parseFloat(realP.entryPrice);
                const firstEntry = dcaData ? dcaData.firstEntry : entryActual;
                const dcaCount = dcaData ? dcaData.dcaCount : 0;
                
                let tp = side === 'SHORT' ? entryActual * (1 - botSettings.posTP/100) : entryActual * 1.05;
                let sl = side === 'SHORT' ? firstEntry + (firstEntry * botSettings.posSL/100) : entryActual * 0.90;

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, {
                    symbol, side, entryPrice: entryActual, tp: sync.tp, sl: sync.sl,
                    dcaCount, leverage: info.maxLeverage, pnl: 0, priceDev: 0, firstEntry, 
                    firstMargin: dcaData ? dcaData.firstMargin : marginToUse
                });
                addBotLog(`✅ ${dcaData ? 'DCA' : 'OPEN'} ${symbol} ${side}`, "success");
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi ${symbol}: ${e.message}`, "error"); }
    finally { isProcessingDCA.delete(symbol); }
}

// Hàm quan trọng nhất để đẩy dữ liệu lên HTML
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeInExchange = new Set();

        posRisk.forEach(p => {
            if (Math.abs(parseFloat(p.positionAmt)) > 0) {
                const key = `${p.symbol}_${p.positionSide}`;
                activeInExchange.add(key);
                if (botActivePositions.has(key)) {
                    let b = botActivePositions.get(key);
                    b.pnl = parseFloat(p.unRealizedProfit);
                    const mark = parseFloat(p.markPrice);
                    b.priceDev = ((mark - b.entryPrice) / b.entryPrice) * 100;
                }
            }
        });

        // Xử lý lệnh đã đóng (Chốt lãi hoặc dính SL để DCA)
        for (let [key, b] of botActivePositions) {
            if (!activeInExchange.has(key)) {
                if (isProcessingDCA.has(b.symbol)) continue;
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 5 });
                const last = trades.sort((a,b) => b.time - a.time)[0];
                const rPnl = last ? parseFloat(last.realizedPnl) : 0;
                
                status.botPnLClosed += rPnl;
                status.botClosedCount++;

                if (rPnl > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    botActivePositions.delete(key);
                    addBotLog(`💰 CHỐT LÃI ${b.symbol}: ${rPnl.toFixed(2)}$`, "success");
                } else {
                    // Logic DCA / Đảo Long
                    const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${b.symbol}`);
                    const nowP = parseFloat(ticker.data.price);
                    const step = b.firstEntry * (botSettings.posSL / 100);
                    let jumpStep = Math.max(b.dcaCount + 1, Math.floor((nowP - b.firstEntry) / step));

                    if (jumpStep <= botSettings.maxDCA) {
                        botActivePositions.delete(key);
                        openPosition(b.symbol, { dcaCount: jumpStep, margin: b.firstMargin * (jumpStep + 1), firstMargin: b.firstMargin, firstEntry: b.firstEntry });
                    } else {
                        botActivePositions.delete(key);
                        openPosition(b.symbol, { isFinalLong: true, margin: b.firstMargin * 20, firstEntry: b.firstEntry });
                    }
                }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitor, 1000);
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const bl = {}; const now = Date.now();
        Object.keys(status.blackList).forEach(s => {
            const sec = Math.floor((status.blackList[s] - now) / 1000);
            if (sec > 0) bl[s] = sec; else delete status.blackList[s];
        });

        res.json({
            botSettings,
            activePositions: Array.from(botActivePositions.values()),
            status: { ...status, blackList: bl },
            wallet: {
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2),
                availableBalance: parseFloat(acc.availableBalance).toFixed(2),
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2)
            }
        });
    } catch (e) { res.json({ status, wallet: { totalWalletBalance: "0.00", availableBalance: "Error" } }); }
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

// Lấy danh sách kèo từ port 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 1500);

async function init() {
    try {
        const time = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = time.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const temp = {};
        info.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: 20 };
        });
        status.exchangeInfo = temp; status.isReady = true;
        addBotLog("🚀 LUFFY BOT READY");
        priceMonitor();
    } catch (e) { setTimeout(init, 5000); }
}

init(); 
setInterval(() => {
    if (status.isReady && botSettings.isRunning && botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => {
            return Math.abs(parseFloat(c.c1)) >= botSettings.minVol && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`);
        });
        if (can) openPosition(can.symbol);
    }
}, 3000);

APP.listen(9001);
