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
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 20000, headers: { 'X-MBX-APIKEY': API_KEY } });

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

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function syncTime() { try { const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); timestampOffset = res.data.serverTime - Date.now(); } catch (e) {} }

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) await syncTime();
        throw new Error(error.response?.data?.msg || error.message);
    }
}

// HÀM ĐỒNG BỘ TPSL - FIX LỖI TREO VÒNG LẶP
async function syncTPSL(symbol, side, qty, entry, info) {
    let success = false;
    let attempt = 0;
    const maxAttempts = 5; 
    const isShort = (side === 'SHORT');
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'buy' : 'sell';

    addBotLog(`🔄 [${symbol}] Đang xử lý Sync TPSL...`);

    while (!success && attempt < maxAttempts) {
        attempt++;
        try {
            await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
            await new Promise(r => setTimeout(r, 3000));
            
            const currentOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
            const myOrders = currentOrders.filter(o => o.symbol === symbol && o.positionSide === side);

            if (myOrders.length > 0) {
                addBotLog(`⚠️ [${symbol}] Lệnh cũ vẫn còn, thử hủy lại lần ${attempt}...`, "warning");
                continue;
            }

            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true });
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true });
            
            success = true;
            addBotLog(`✅ [${symbol}] Đã cập nhật xong TP:${tpPrice} SL:${slPrice}`, "success");
        } catch (e) {
            addBotLog(`❌ [${symbol}] Lỗi Sync lần ${attempt}: ${e.message}`, "error");
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!success) addBotLog(`🚨 [${symbol}] Sync thất bại sau ${maxAttempts} lần. Cần check sàn gấp!`, "error");
    return success ? { tp: Number(tpPrice), sl: Number(slPrice) } : { tp: 0, sl: 0 };
}

// MỞ LỆNH PHÒNG HỘ LONG VỚI MARGIN GẤP 50 LẦN ENTRY 1
async function openHedgeLong(symbol, info, firstMargin) {
    try {
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(priceRes.data.price);
        const lev = info.maxLeverage;
        await exchange.setLeverage(lev, symbol);
        
        const hedgeMargin = firstMargin * 50; 
        let qtyNum = Math.ceil(((hedgeMargin * lev) / price) / info.stepSize) * info.stepSize;
        while ((qtyNum * price) < 5.5) qtyNum += info.stepSize;

        addBotLog(`🛡️ HEDGE: Mở LONG ${symbol} | Margin: ${hedgeMargin.toFixed(2)}$ (x50)`, "warning");
        const order = await exchange.createOrder(symbol, 'market', 'buy', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'LONG' });

        if (order) {
            const tpP = (price * 1.10).toFixed(info.pricePrecision);
            const slP = (price * 0.90).toFixed(info.pricePrecision);
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'LONG', stopPrice: tpP, closePosition: true });
            await exchange.createOrder(symbol, 'STOP_MARKET', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'LONG', stopPrice: slP, closePosition: true });
            addBotLog(`✅ Đã set TP/SL 10% cho Hedge Long ${symbol}`);
        }
    } catch (e) { addBotLog(`❌ Lỗi Hedge: ${e.message}`, "error"); }
}

async function openPosition(symbol, isDCA = false, candidateData = null) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binancePrivate('/fapi/v2/account');
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(priceRes.data.price);
        
        let marginToUse = 0, currentDCA = 0, historyEntries = [], firstMargin = 0;
        if (isDCA) {
            const current = botActivePositions.get(posKey);
            firstMargin = current.firstMargin;
            marginToUse = firstMargin * 1.03; 
            current.isProcessing = true; currentDCA = current.dcaCount + 1;
            historyEntries = [...(current.historyEntries || [])];
        } else {
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / price) / info.stepSize) * info.stepSize;
        while ((qtyNum * price) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(upPos.entryPrice);
            const totalQty = Math.abs(parseFloat(upPos.positionAmt));
            historyEntries.push(price);

            if (isDCA) {
                addBotLog(`⚠️ DCA ${symbol} : Lần ${currentDCA} | Dùng Margin: ${marginToUse.toFixed(2)}$ | Avg:${avgEntry}`, "warning");
            } else {
                addBotLog(`🚀 OPEN ${symbol} | Entry: ${price} | Margin: ${marginToUse.toFixed(2)}$`, "success");
            }

            const sync = await syncTPSL(symbol, 'SHORT', totalQty, avgEntry, info);
            botActivePositions.set(posKey, { 
                symbol, side: 'SHORT', entryPrice: avgEntry, historyEntries, qty: totalQty, tp: sync.tp, sl: sync.sl, 
                margin: (totalQty * avgEntry / info.maxLeverage), firstMargin, dcaCount: currentDCA, isProcessing: false, hedgeOpened: false
            });
        }
    } catch (e) { if (isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false; }
    finally { openingSymbols.delete(symbol); }
}

async function trackClosedPnL(symbol, closedTime, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
        const relevantTrades = trades.filter(t => Math.abs(t.time - closedTime) < 30000 && t.positionSide === lastBotPos.side);
        const rawPnL = relevantTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        const finalPnL = rawPnL - (lastBotPos.qty * lastBotPos.entryPrice * 0.001);
        status.botClosedCount++; status.botPnLClosed += finalPnL;
        addBotLog(`✅ CHỐT ${symbol} (${lastBotPos.side}) | PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? "success" : "error");
    } catch (e) {}
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (realPos && Math.abs(parseFloat(realPos.positionAmt)) > 0) {
                botPos.markPrice = parseFloat(realPos.markPrice); botPos.pnl = parseFloat(realPos.unRealizedProfit);
            } else {
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                trackClosedPnL(botPos.symbol, now, botPos); botActivePositions.delete(key);
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeRealPos = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing || botPos.side !== 'SHORT') continue;
            const realPos = activeRealPos.find(p => p.symbol === botPos.symbol && p.positionSide === 'SHORT');
            if (!realPos) continue;
            const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
            if (priceDev >= botSettings.dcaStep) {
                if (botPos.dcaCount < botSettings.maxDCA) { await openPosition(botPos.symbol, true); } 
                else if (botPos.dcaCount === botSettings.maxDCA && !botPos.hedgeOpened) {
                    await openHedgeLong(botPos.symbol, status.exchangeInfo[botPos.symbol], botPos.firstMargin);
                    botPos.hedgeOpened = true;
                }
            }
        }
        if (activeRealPos.filter(p => p.positionSide === 'SHORT').length < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = [c.c1, c.c5].some(v => Math.abs(parseFloat(v)) >= parseFloat(botSettings.minVol));
                return info && info.maxLeverage >= 20 && (status.blackList[c.symbol] || 0) < Date.now() && !activeRealPos.some(p => p.symbol === c.symbol && p.positionSide === 'SHORT') && hasVol;
            });
            if (keo) await openPosition(keo.symbol, false, keo);
        }
    } catch (e) {}
}

async function init() {
    try {
        await syncTime(); await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY READY - HEDGE MARGIN x50 MODE", "success"); priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); setInterval(mainLoop, 3000);
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
        const bl = {}; Object.entries(status.blackList).forEach(([s, t]) => { if(t > Date.now()) bl[s] = Math.ceil((t-Date.now())/1000); });
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status: { ...status, blackList: bl }, wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) } });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
