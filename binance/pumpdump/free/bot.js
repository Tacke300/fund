import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; 
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MARGIN_PROTECT_LIMIT = 60;    
const MARGIN_RECOVER_LIMIT = 70;    

// 🔥 FIX TRIỆT ĐỂ REFERENCEERROR: Đẩy khai báo __dirname lên trước khi dùng SETTINGS_FILE
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, 'bot_settings.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
});

let botSettings = { isRunning: false, capital: "1%", volVolatility: 6.5, maxPos: 3, maxDca: 2, tp: 1.2, sl: 10.0, longTp: 15.0, longSl: 15.0 };

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            botSettings = JSON.stringify(data) !== '{}' ? JSON.parse(data) : botSettings;
            console.log("💾 [SETTINGS] Đã tải thành công cấu hình bot_settings.json");
        } else { saveSettings(); }
    } catch (e) { console.error("❌ Lỗi đọc file cấu hình:", e.message); }
}

function saveSettings() {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 4), 'utf8'); } catch (e) { console.error("❌ Lỗi ghi file cấu hình:", e.message); }
}
loadSettings();

let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 

let globalExchangePositions = [];

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

// Luồng lấy vị thế định kỳ từ sàn
setInterval(async () => {
    if (!status.isReady) return;
    try {
        const res = await binancePrivate('/fapi/v2/positionRisk');
        if (res && Array.isArray(res)) {
            globalExchangePositions = res;
        }
    } catch (e) {
        console.error("❌ Lỗi lấy vị thế từ sàn:", e.message);
    }
}, 2500);

setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Unban Blacklist: ${symbol}`, "success");
        }
    }
}, 1000);

async function handlePositionCloseCheck(key, b, lastMarkPrice) {
    if (isProcessingDCA.has(b.symbol)) return;
    isProcessingDCA.add(b.symbol);

    try {
        const priceHitTP = (b.side === 'SHORT' && lastMarkPrice <= b.tp) || (b.side === 'LONG' && lastMarkPrice >= b.tp);
        const priceHitSL = (b.side === 'SHORT' && lastMarkPrice >= b.sl) || (b.side === 'LONG' && lastMarkPrice <= b.sl);

        if (!priceHitTP && !priceHitSL) { isProcessingDCA.delete(b.symbol); return; }

        await new Promise(r => setTimeout(r, 1200));
        const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 8 }).catch(() => []);
        const closedById = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED' && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));

        if (!closedById) { isProcessingDCA.delete(b.symbol); return; }

        let reasonOfClose = closedById.type === 'STOP_MARKET' ? "SL_MARKET" : "TP_MARKET";
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 }).catch(() => []);
        const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 60000));
        
        if (recent.length === 0) { isProcessingDCA.delete(b.symbol); return; }

        let totalR = 0, totalV = 0;
        recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); });
        const netPnl = totalR - (totalV * 0.0005);

        try {
            const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
            for (const o of openOrders.filter(o => o.positionSide === b.side)) {
                await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
            }
        } catch(e){}

        botActivePositions.delete(key);
        status.botClosedCount++; 
        status.botPnLClosed += netPnl;

        status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000); 

        const logType = netPnl > 0 ? "💰 [CHỐT LỜI]" : "📉 [CẮT LỖ]";
        addBotLog(`${logType} ${b.symbol} | ${b.side} | DCA: ${b.dcaCount}/${botSettings.maxDca} | PnL: ${netPnl.toFixed(4)}$ | Type: ${reasonOfClose}`, netPnl > 0 ? "success" : "error");

        if (netPnl < 0 && b.side === 'SHORT' && botSettings.isRunning) { 
            const jump = b.dcaCount + 1;
            const currentAccumulatedLoss = (b.totalLossAccumulated || 0) + Math.abs(netPnl);

            if (jump <= botSettings.maxDca) {
                openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * Math.pow(2, jump), totalLossAccumulated: currentAccumulatedLoss });
            } else {
                openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 10 });
            }
        }
    } catch (err) { console.error(err); } finally { isProcessingDCA.delete(b.symbol); }
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (botActivePositions.size > 0) {
            const currentCandidates = status.candidatesList;

            for (let [key, b] of botActivePositions) {
                const realP = globalExchangePositions.find(p => `${p.symbol}_${p.positionSide}` === key);
                const hasPositionReal = realP && Math.abs(parseFloat(realP.positionAmt)) > 0;

                const candData = currentCandidates.find(c => c.symbol === b.symbol);
                let markP = hasPositionReal ? parseFloat(realP.markPrice) : (candData ? candData.price : b.currentPrice);

                if (!markP || markP <= 0) continue;

                b.currentPrice = markP;
                
                if (hasPositionReal) {
                    const currentQty = Math.abs(parseFloat(realP.positionAmt));
                    b.currentQty = currentQty;
                    b.currentMargin = (currentQty * markP) / b.leverage;
                } else {
                    b.currentMargin = (b.currentQty * markP) / b.leverage;
                }

                if (b.side === 'SHORT') {
                    b.pnl = (b.entryPrice - markP) * b.currentQty;
                    b.priceDev = ((b.entryPrice - markP) / b.entryPrice) * 100;
                } else {
                    b.pnl = (markP - b.entryPrice) * b.currentQty;
                    b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
                }

                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    addBotLog(`🚨 [BẢO HIỂM] Ép đóng MARKET cho ${b.symbol}!`, "warn");
                    try {
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
                        handlePositionCloseCheck(key, b, markP);
                    } catch (err) { console.error(`Lỗi ép đóng: ${err.message}`); }
                } else if (!hasPositionReal && realP) {
                    handlePositionCloseCheck(key, b, markP);
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 400); 
}

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol); 
    const isDCAorLong = dcaData !== null;
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    
    try {
        if (!isDCAorLong && globalExchangePositions.length > 0) {
            const existingPos = globalExchangePositions.filter(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (existingPos.length > 0) {
                status.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                addBotLog(`⚠️ Phát hiện ${symbol} đang có vị thế sẵn trên sàn! Cho vào Blacklist 15 phút.`, "warn");
                return;
            }
        }

        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 400));
        const acc = await binancePrivate('/fapi/v2/account');
        const availableUsdt = parseFloat(acc.availableBalance || 0);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);

        let qty = 0, margin = 0;
        if (isDCAorLong) {
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 5.5) margin = 5.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            margin = botSettings.capital.toString().includes('%') ? (availableUsdt * parseFloat(botSettings.capital) / 100) : parseFloat(botSettings.capital);
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        }

        // 🔥 CHẶN MIN 5.5 USD ĐÃ NHÂN ĐÒN BẨY (NOTIONAL VALUE) ĐỂ TRÁNH LỖI -4164 BINANCE
        let notionalValue = qty * currentPrice;
        if (notionalValue < 5.5) {
            qty = Math.ceil((5.5 / currentPrice) / info.stepSize) * info.stepSize;
        }

        if (qty < info.stepSize) qty = info.stepSize;
        
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1200));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const actualQty = Math.abs(parseFloat(p.positionAmt));
                const actualMarginUsed = (actualQty * entry) / info.maxLeverage; 

                const firstE = dcaData ? dcaData.firstEntry : entry;
                const dcaCount = dcaData ? dcaData.dcaCount : 0;
                const dcaHistory = dcaData ? [...dcaData.dcaHistory, entry] : [entry];
                const simpleAvgEntry = dcaHistory.reduce((s, p) => s + p, 0) / dcaHistory.length;

                let tp = 0, sl = 0;
                let firstQty = dcaData ? dcaData.firstQty : actualQty;
                let firstProfitUsdt = dcaData ? dcaData.firstProfitUsdt : (actualQty * entry * (botSettings.tp / 100));
                let accumulatedLoss = dcaData ? dcaData.totalLossAccumulated : 0;

                if (side === 'LONG') {
                    tp = entry * (1 + (botSettings.longTp / 100));
                    sl = entry * (1 - (botSettings.longSl / 100));
                } else {
                    const totalTargetGrossProfit = accumulatedLoss + ((dcaCount + 1) * firstProfitUsdt);
                    tp = simpleAvgEntry - (totalTargetGrossProfit / actualQty);
                    sl = firstE + (firstE * (botSettings.sl * (dcaCount + 1)) / 100);
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, currentPrice: currentPrice,
                    dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: actualMarginUsed, 
                    currentQty: actualQty, dcaHistory, isFinalLong: dcaData?.isFinalLong || false,
                    pnl: 0, priceDev: 0, firstQty, firstProfitUsdt, totalLossAccumulated: accumulatedLoss
                });
                
                // 🔥 Giữ nguyên định dạng log gốc của ông
                addBotLog(`📡 [${side}] ${symbol} | Margin: ${actualMarginUsed.toFixed(2)}$ | Entry: ${entry} | TP: ${sync.tp.toFixed(info.pricePrecision)} | SL: ${sync.sl.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi vào vị thế ${symbol}: ${e.message}`, "error"); } finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        await new Promise(r => setTimeout(r, 400));
        
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, triggerPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, triggerPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { 
        addBotLog(`❌ Lỗi đồng bộ lệnh bảo vệ cho ${symbol}: ${e.message}`, "error");
        return { tp: tpPrice, sl: slPrice }; 
    }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    const visualBlacklist = {};
    const now = Date.now();
    for (const s in status.blackList) {
        if (status.blackList[s] > now) visualBlacklist[s] = true;
    }
    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: { ...status, blackList: visualBlacklist }, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
        } : { totalWalletBalance: "0.00", availableBalance: "ERR", totalUnrealizedProfit: "0.00" } 
    });
});

APP.post('/api/settings', async (req, res) => { 
    const oldRunningState = botSettings.isRunning;
    botSettings = { ...botSettings, ...req.body }; 
    botSettings.maxDca = parseInt(botSettings.maxDca);
    botSettings.maxPos = parseInt(botSettings.maxPos);
    botSettings.volVolatility = parseFloat(botSettings.volVolatility);
    saveSettings(); 

    if (!oldRunningState && botSettings.isRunning && status.isReady) {
        addBotLog("🔄 [HỆ THỐNG] Khởi động lại Bot. Kiểm tra vị thế cũ...", "warn");
        try {
            const positions = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
            if (positions) {
                const activeOnExchange = positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
                
                for (const p of activeOnExchange) {
                    const key = `${p.symbol}_${p.positionSide}`;
                    const currentQty = Math.abs(parseFloat(p.positionAmt));
                    const entryPrice = parseFloat(p.entryPrice);
                    
                    if (botActivePositions.has(key)) {
                        const localData = botActivePositions.get(key);
                        localData.currentQty = currentQty;
                        localData.currentMargin = (currentQty * entryPrice) / localData.leverage;
                        botActivePositions.set(key, localData);
                        addBotLog(`⚡ Nuôi tiếp chuỗi quản lý cũ thành công: ${p.symbol} [${p.positionSide}]`, "success");
                    } else {
                        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${p.symbol}`).catch(() => null);
                        const currentPrice = ticker ? parseFloat(ticker.data.price) : entryPrice;
                        const info = status.exchangeInfo[p.symbol];
                        
                        let tp = entryPrice, sl = entryPrice;
                        if (p.positionSide === 'LONG') {
                            tp = entryPrice * (1 + (botSettings.longTp / 100));
                            sl = entryPrice * (1 - (botSettings.longSl / 100));
                        } else {
                            tp = entryPrice * (1 - (botSettings.tp / 100));
                            sl = entryPrice * (1 + (botSettings.sl / 100));
                        }

                        botActivePositions.set(key, {
                            symbol: p.symbol, side: p.positionSide, entryPrice, tp, sl, currentPrice,
                            dcaCount: 0, leverage: parseInt(p.leverage), firstEntry: entryPrice,
                            firstMargin: (currentQty * entryPrice) / p.leverage, currentMargin: (currentQty * entryPrice) / p.leverage,
                            currentQty, dcaHistory: [entryPrice], isFinalLong: false, pnl: 0, priceDev: 0,
                            firstQty: currentQty, firstProfitUsdt: (currentQty * entryPrice * (botSettings.tp / 100)), totalLossAccumulated: 0
                        });
                        addBotLog(`🔗 Tạo mới liên kết quản lý vị thế dở: ${p.symbol} [${p.positionSide}]`, "info");
                    }
                }

                for (let key of botActivePositions.keys()) {
                    const match = activeOnExchange.find(p => `${p.symbol}_${p.positionSide}` === key);
                    if (!match) botActivePositions.delete(key);
                }
            }
        } catch (err) { console.error(err); }
    }
    res.json({ success: true }); 
});

APP.post('/api/panic-close-all', async (req, res) => {
    if (botSettings.isRunning) {
        return res.status(400).json({ success: false, error: "Vui lòng tắt Bot (STOP BOT) trước khi thực hiện dọn dẹp sàn!" });
    }
    addBotLog("🚨 [PANIC CLOSE] Đang tiến hành quét dọn sạch toàn bộ sàn Binance...", "warn");
    try {
        const positions = await binancePrivate('/fapi/v2/positionRisk');
        const activePositionsOnExchange = positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

        for (const p of activePositionsOnExchange) {
            const symbol = p.symbol;
            const amt = parseFloat(p.positionAmt);
            const side = p.positionSide;
            const closeSide = amt > 0 ? 'SELL' : 'BUY';
            const qty = Math.abs(amt);

            try {
                const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
                for (const o of orders) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
                await exchange.createOrder(symbol, 'MARKET', closeSide, qty, undefined, { positionSide: side });
                addBotLog(`✅ Đã đóng cưỡng bức vị thế: ${symbol} [${side}]`, "success");
            } catch (err) {
                addBotLog(`❌ Không thể đóng ${symbol}: ${err.message}`, "error");
            }
        }
        
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE').catch(() => {});
        botActivePositions.clear();
        isProcessingDCA.clear();
        addBotLog("⚡ Đã dọn dẹp hoàn tất: Toàn bộ vị thế bằng 0, không còn lệnh treo!", "success");
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

async function init() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { status.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp; status.isReady = true; priceMonitor();
        addBotLog(`🌍 IP START: 171.224.178.88`, "success");
    } catch (e) { setTimeout(init, 5000); }
}
init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning) return; 
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0);
        const availableUsdt = parseFloat(acc.availableBalance || 0);
        if (totalWallet > 0) {
            const availPercent = (availableUsdt / totalWallet) * 100;
            if (!isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) isMarginProtected = true;
            else if (isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) isMarginProtected = false;
        }
    }
    if (isMarginProtected || botActivePositions.size >= botSettings.maxPos || isProcessingDCA.size > 0) return;

    const can = status.candidatesList.find(c => 
        (Math.abs(c.c1) >= botSettings.volVolatility || Math.abs(c.c5) >= botSettings.volVolatility) && 
        !status.blackList[c.symbol] && !status.permanentBlacklist[c.symbol] && 
        !botActivePositions.has(`${c.symbol}_SHORT`) && !botActivePositions.has(`${c.symbol}_LONG`)
    );
    if (can) openPosition(can.symbol);
}, 3000);

APP.listen(1111, () => { console.log("⚡ Server running at http://localhost:1111"); });
