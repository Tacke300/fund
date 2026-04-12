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

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    timeout: 30000, 
    options: { defaultType: 'future', dualSidePosition: true }
});

// ============================================================================
// ⚙️ CẤU HÌNH HỆ THỐNG
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
    maxDCA: 9, // Mặc định cho Long
    botSLValue: 0,
    botSLType: 'fixed'
};

let status = { 
    initialBalance: 0, 
    dayStartBalance: 0, 
    currentBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [], 
    history: [] 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let blackListPool = new Map();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatSmart(num) {
    if (!num || isNaN(num)) return "0.00";
    if (num >= 1) return num.toFixed(4);
    const s = num.toString();
    if (s.includes('e')) return num.toFixed(10);
    const match = s.match(/0\.0*[1-9]/);
    if (!match) return num.toFixed(4);
    const zeroCount = match[0].length - 2;
    return num.toFixed(zeroCount + 5); 
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 500) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
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
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
                });
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

async function forceClose(symbol, side, qty) {
    let success = false; let attempts = 0;
    while (!success && attempts < 5) {
        attempts++;
        try {
            const closeSide = side === 'LONG' ? 'sell' : 'buy';
            const res = await exchange.createOrder(symbol, 'MARKET', closeSide, qty, undefined, { positionSide: side });
            if (res.id) success = true;
        } catch (e) { await sleep(1000); }
    }
}

async function updateSànGiáp(symbol, side, posSide, tp, sl) {
    try {
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await sleep(500);
        const closeSide = posSide === 'LONG' ? 'sell' : 'buy';
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', closeSide, 0, undefined, { positionSide: posSide, stopPrice: tp, closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', closeSide, 0, undefined, { positionSide: posSide, stopPrice: sl, closePosition: true, workingType: 'MARK_PRICE' });
    } catch (e) {}
}

async function openPosition(symbol, side, info) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    if (blackListPool.has(symbol) && Date.now() < blackListPool.get(symbol)) return;

    try {
        const acc = await callBinance('/fapi/v2/account');
        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const currentPrice = parseFloat(ticker.price);
        const targetLev = info.maxLeverage || 20;
        
        let marginReq = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        let finalQty = (Math.floor(((marginReq * targetLev) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: targetLev });
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty });

        if (order.orderId) {
            await sleep(1000);
            const posRisk = await callBinance('/fapi/v2/positionRisk');
            const myPos = posRisk.find(p => p.symbol === symbol && p.positionSide === posSide && parseFloat(p.positionAmt) !== 0);
            if (!myPos) return;

            const entry = parseFloat(myPos.entryPrice);
            const actualMargin = parseFloat(myPos.isolatedMargin);
            const tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entryPrice: formatSmart(entry), initialEntry: entry, 
                initialQty: parseFloat(finalQty), // Lưu qty gốc để DCA
                margin: formatSmart(actualMargin), qty: Math.abs(parseFloat(myPos.positionAmt)), 
                tpPrice: formatSmart(parseFloat(tp)), slPrice: formatSmart(parseFloat(sl)), 
                tpRaw: parseFloat(tp), slRaw: parseFloat(sl), dcaCount: 0, isClosing: false, lev: targetLev
            });

            await updateSànGiáp(symbol, side, posSide, tp, sl);
            addBotLog(`✅ Mở ${symbol} ${posSide} | Margin: ${formatSmart(actualMargin)}$ | Lev: x${targetLev}`, "success");
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
            data.markPrice = formatSmart(price);
            const floorPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side && parseFloat(p.positionAmt) !== 0);

            if (!floorPos) {
                data.isClosing = true;
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const lastTrade = trades.find(t => t.symbol === symbol && t.positionSide === data.side);
                status.history.unshift({ time: new Date().toLocaleTimeString('vi-VN'), symbol, side: data.side, pnl: formatSmart(parseFloat(lastTrade?.realizedPnl || 0)), entry: data.entryPrice });
                blackListPool.set(symbol, Date.now() + 15 * 60 * 1000);
                activeOrdersTracker.delete(symbol);
                continue;
            }

            if ((data.side === 'LONG' && price >= data.tpRaw) || (data.side === 'SHORT' && price <= data.tpRaw) || (data.side === 'LONG' && price <= data.slRaw) || (data.side === 'SHORT' && price >= data.slRaw)) {
                data.isClosing = true;
                addBotLog(`🚨 Local Hit TP/SL ${symbol}. Đóng khẩn cấp...`, "warning");
                await forceClose(symbol, data.side, data.qty);
                continue;
            }

            // LOGIC DCA MỚI
            const diff = ((price - data.initialEntry) / data.initialEntry) * 100;
            const isAgainst = (data.side === 'LONG' && diff <= -botSettings.dcaStep * (data.dcaCount + 1)) || 
                              (data.side === 'SHORT' && diff >= botSettings.dcaStep * (data.dcaCount + 1));

            if (isAgainst) {
                let canDCA = false;
                let dcaQty = data.initialQty; // Mặc định DCA bằng qty lần đầu

                if (data.side === 'LONG' && data.dcaCount < 9) {
                    canDCA = true;
                } else if (data.side === 'SHORT') {
                    canDCA = true;
                    if (data.dcaCount >= 9) {
                        // Sau tầng 9, Short DCA 25% tổng volume hiện tại
                        dcaQty = data.qty * 0.25;
                    }
                }

                if (canDCA) {
                    data.dcaCount++;
                    const info = status.exchangeInfo[symbol];
                    const finalDcaQty = (Math.floor(dcaQty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
                    
                    addBotLog(`📉 DCA ${symbol} Tầng ${data.dcaCount} | Đang nhồi...`, "warning");
                    
                    const res = await callBinance('/fapi/v1/order', 'POST', { 
                        symbol, side: data.side === 'LONG' ? 'BUY' : 'SELL', 
                        positionSide: data.side, type: 'MARKET', quantity: finalDcaQty 
                    });

                    if (res.orderId) {
                        await sleep(3000);
                        const newPos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === data.side);
                        if (newPos) {
                            const oldMargin = data.margin;
                            const newEntry = parseFloat(newPos.entryPrice);
                            const newTotalMargin = parseFloat(newPos.isolatedMargin);
                            const dcaMargin = newTotalMargin - parseFloat(oldMargin);

                            data.initialEntry = newEntry;
                            data.entryPrice = formatSmart(newEntry);
                            data.qty = Math.abs(parseFloat(newPos.positionAmt));
                            data.margin = formatSmart(newTotalMargin);
                            data.tpRaw = data.side === 'LONG' ? newEntry * (1 + botSettings.posTP/100) : newEntry * (1 - botSettings.posTP/100);
                            data.slRaw = data.side === 'LONG' ? newEntry * (1 - botSettings.posSL/100) : newEntry * (1 + botSettings.posSL/100);
                            data.tpPrice = formatSmart(data.tpRaw); 
                            data.slPrice = formatSmart(data.slRaw);

                            addBotLog(`📊 ${symbol} DCA ${data.dcaCount}: Gốc ${oldMargin}$ + Nhồi ${formatSmart(dcaMargin)}$ = Tổng ${data.margin}$ | Giá DCA: ${formatSmart(price)}`, "success");
                            await updateSànGiáp(symbol, data.side === 'LONG' ? 'BUY' : 'SELL', data.side, data.tpRaw.toFixed(info.pricePrecision), data.slRaw.toFixed(info.pricePrecision));
                        }
                    }
                }
            }
        }

        if (activeOrdersTracker.size < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (!activeOrdersTracker.has(coin.symbol) && !pendingSymbols.has(coin.symbol) && !blackListPool.has(coin.symbol) && coin.maxV >= botSettings.minVol) {
                    pendingSymbols.add(coin.symbol);
                    await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol]);
                    setTimeout(() => pendingSymbols.delete(coin.symbol), 5000);
                    break;
                }
            }
        }
    } catch (e) {}
}

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({ symbol: c.symbol, c1: c.c1, c5: c.c5, maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5)) })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = status.currentBalance = parseFloat(acc.totalWalletBalance);
        const info = await callBinance('/fapi/v1/exchangeInfo');
        const brackets = await callBinance('/fapi/v1/leverageBracket');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const bracket = brackets.find(b => b.symbol === s.symbol);
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: bracket ? bracket.brackets[0].initialLeverage : 20 };
        });
        await exchange.loadMarkets(); 
        addBotLog("👿 LUFFY v16.0 - INFINITY DCA SHORT READY", "success");
    } catch (e) {}
}

init(); 
setInterval(mainLoop, 3000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
