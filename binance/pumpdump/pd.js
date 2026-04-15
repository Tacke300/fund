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
    maxDCA: 8,
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

// Hàm format số thập phân thông minh cho coin rác
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
                    res.on('end', () => { 
                        try { resolve(JSON.parse(d)); } catch (e) { reject(e); } 
                    });
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

// 🛡️ PHƯƠNG PHÁP ĐÓNG DỰ PHÒNG 3 LỚP
async function forceClose(symbol, side, qty) {
    addBotLog(`🚨 Đang kích hoạt Triple-Close cho ${symbol}...`, "warning");
    let success = false;
    let attempts = 0;

    while (!success && attempts < 5) {
        attempts++;
        try {
            const closeSide = side === 'LONG' ? 'sell' : 'buy';
            // Thử lệnh Market cơ bản (Không dùng reduceOnly để tránh lỗi -1106)
            const res = await exchange.createOrder(symbol, 'MARKET', closeSide, qty, undefined, {
                positionSide: side
            });
            if (res.id) {
                addBotLog(`✅ Đóng dự phòng ${symbol} thành công ở lần thử ${attempts}`, "success");
                success = true;
            }
        } catch (e) {
            addBotLog(`❌ Thử đóng ${symbol} lần ${attempts} lỗi: ${e.message}`, "error");
            await sleep(1000);
        }
    }
}

async function updateSànGiáp(symbol, side, posSide, tp, sl) {
    try {
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await sleep(500);
        const closeSide = posSide === 'LONG' ? 'sell' : 'buy';
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', closeSide, 0, undefined, {
            positionSide: posSide, stopPrice: tp, closePosition: true, workingType: 'MARK_PRICE'
        });
        await exchange.createOrder(symbol, 'STOP_MARKET', closeSide, 0, undefined, {
            positionSide: posSide, stopPrice: sl, closePosition: true, workingType: 'MARK_PRICE'
        });
    } catch (e) { addBotLog(`⚠️ Giáp sàn ${symbol} lỗi (Giá chạy quá nhanh): ${e.message}`, "warning"); }
}

async function openPosition(symbol, side, info, isReverse = false) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    if (blackListPool.has(symbol) && Date.now() < blackListPool.get(symbol)) return;

    try {
        const acc = await callBinance('/fapi/v2/account');
        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const currentPrice = parseFloat(ticker.price);
        
        const targetLev = info.maxLeverage || 20;
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        if (isReverse) margin *= 10; 

        let finalQty = (Math.floor(((margin * targetLev) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: targetLev });
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty });

        if (order.orderId) {
            await sleep(1000); 
            const posRisk = await callBinance('/fapi/v2/positionRisk');
            const myPos = posRisk.find(p => p.symbol === symbol && p.positionSide === posSide && parseFloat(p.positionAmt) !== 0);
            if (!myPos) return;

            const entry = parseFloat(myPos.entryPrice);
            const tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, 
                entryPrice: formatSmart(entry), 
                initialEntry: entry, 
                margin: formatSmart(parseFloat(myPos.isolatedMargin)),
                qty: Math.abs(parseFloat(myPos.positionAmt)), 
                tpPrice: formatSmart(parseFloat(tp)), 
                slPrice: formatSmart(parseFloat(sl)), 
                tpRaw: parseFloat(tp), slRaw: parseFloat(sl),
                dcaCount: 0, isClosing: false,
                snapshot: { c1: 0, c5: 0 } 
            });

            await updateSànGiáp(symbol, side, posSide, tp, sl);
            addBotLog(`✅ Mở ${symbol} x${targetLev} @${formatSmart(entry)}`, "success");
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
                const pnl = lastTrade?.realizedPnl || 0;
                
                status.history.unshift({ time: new Date().toLocaleTimeString('vi-VN'), symbol, side: data.side, pnl: formatSmart(parseFloat(pnl)), entry: data.entryPrice });
                if (status.history.length > 50) status.history.pop();
                
                blackListPool.set(symbol, Date.now() + 15 * 60 * 1000);
                activeOrdersTracker.delete(symbol);
                continue;
            }

            // KIỂM TRA ĐIỀU KIỆN ĐÓNG DỰ PHÒNG (LOCAL TRACKER)
            let isHitTP = (data.side === 'LONG' && price >= data.tpRaw) || (data.side === 'SHORT' && price <= data.tpRaw);
            let isHitSL = (data.side === 'LONG' && price <= data.slRaw) || (data.side === 'SHORT' && price >= data.slRaw);

            if (isHitTP || isHitSL) {
                data.isClosing = true;
                addBotLog(`🚨 LOCAL HIT ${isHitTP?'TP':'SL'} ${symbol}. Đang thực thi đóng khẩn cấp...`, "warning");
                await forceClose(symbol, data.side, data.qty);
                continue;
            }

            // LOGIC DCA
            const diff = ((price - data.initialEntry) / data.initialEntry) * 100;
            const isAgainst = (data.side === 'LONG' && diff <= -botSettings.dcaStep * (data.dcaCount + 1)) || 
                              (data.side === 'SHORT' && diff >= botSettings.dcaStep * (data.dcaCount + 1));

            if (isAgainst && data.dcaCount < botSettings.maxDCA) {
                data.dcaCount++;
                addBotLog(`📉 DCA ${symbol} lần ${data.dcaCount}`, "warning");
                await callBinance('/fapi/v1/order', 'POST', { symbol, side: data.side === 'LONG'?'BUY':'SELL', positionSide: data.side, type: 'MARKET', quantity: (data.qty/2).toFixed(status.exchangeInfo[symbol].quantityPrecision) });
                await sleep(2000);
                const newPos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === data.side);
                if (newPos) {
                    data.initialEntry = parseFloat(newPos.entryPrice);
                    data.entryPrice = formatSmart(data.initialEntry);
                    data.qty = Math.abs(parseFloat(newPos.positionAmt));
                    data.tpRaw = data.side === 'LONG' ? data.initialEntry * (1+botSettings.posTP/100) : data.initialEntry * (1-botSettings.posTP/100);
                    data.slRaw = data.side === 'LONG' ? data.initialEntry * (1-botSettings.posSL/100) : data.initialEntry * (1+botSettings.posSL/100);
                    data.tpPrice = formatSmart(data.tpRaw); data.slPrice = formatSmart(data.slRaw);
                    await updateSànGiáp(symbol, data.side==='LONG'?'BUY':'SELL', data.side, data.tpRaw.toFixed(status.exchangeInfo[symbol].pricePrecision), data.slRaw.toFixed(status.exchangeInfo[symbol].pricePrecision));
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
        addBotLog("👿 LUFFY v15.8 - READY", "success");
    } catch (e) {}
}

init(); 
setInterval(mainLoop, 3000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
