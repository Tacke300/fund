import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; 
import WebSocket from 'ws';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE_PATH = path.join(__dirname, 'bot_raw_debug.log');
const STATE_FILE_PATH = path.join(__dirname, 'bot_state_persistent.json');

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 10000, 
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } 
});

// SYSTEM STATES
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: 5 };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: {}, isReady: false, isHedgeMode: true };

let botActivePositions = new Map(); 
let openingSymbols = new Set();     
let symbolMutexes = new Map();      
let serverTimeOffset = 0;
let listenKey = null;

let userWsInstance = null;
let markWsInstance = null;
let lastUserWsTime = Date.now();
let lastMarkWsTime = Date.now();
const leverageCache = new Set();    

// ====================================================================
// UTILS & STORAGE
// ====================================================================
function getPrecision(stepSize) {
    const step = stepSize.toString();
    if (!step.includes('.')) return 0;
    return step.split('.')[1].replace(/0+$/, '').length;
}

function writeRawDebugLog(type, endpoint, payload, responseOrError, latency) {
    const logTime = new Date().toISOString();
    fs.appendFile(LOG_FILE_PATH, JSON.stringify({ time: logTime, type, endpoint, requestData: payload, latencyMs: latency, result: responseOrError }) + '\n', () => {});
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

function saveBotStateToDisk() {
    try {
        const stateToSave = {
            botActivePositions: Array.from(botActivePositions.entries()),
            blackList: status.blackList,
            botClosedCount: status.botClosedCount,
            botPnLClosed: status.botPnLClosed,
            botSettings
        };
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(stateToSave, null, 2), 'utf8');
    } catch (e) {}
}

// Bộ đếm ngược thời gian thực dạng văn bản gửi qua API status
function getReadableBlacklist() {
    const now = Date.now();
    let readable = {};
    for (const s in status.blackList) {
        const diff = status.blackList[s] - now;
        if (diff > 0) {
            const m = Math.floor(diff / 60000);
            const s_rem = Math.floor((diff % 60000) / 1000);
            readable[s] = `${m}p ${s_rem}s`;
        } else {
            delete status.blackList[s];
        }
    }
    return readable;
}

function loadBotStateFromDisk() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const rawData = fs.readFileSync(STATE_FILE_PATH, 'utf8');
            const parsed = JSON.parse(rawData);
            if (parsed.botActivePositions) botActivePositions = new Map(parsed.botActivePositions);
            if (parsed.blackList) status.blackList = parsed.blackList;
            if (parsed.botClosedCount) status.botClosedCount = parsed.botClosedCount;
            if (parsed.botPnLClosed) status.botPnLClosed = parsed.botPnLClosed;
            if (parsed.botSettings) botSettings = parsed.botSettings;
            addBotLog("💾 [RECOVERY] Trạng thái hệ thống đã được phục hồi thành công.");
        }
    } catch (e) {}
}

function runLocked(symbol, asyncTask) {
    if (!symbolMutexes.has(symbol)) symbolMutexes.set(symbol, Promise.resolve());
    const currentPromise = symbolMutexes.get(symbol);
    const nextPromise = currentPromise.then(async () => {
        try { await asyncTask(); } catch (e) { console.error(`❌ Lỗi Mutex ${symbol}:`, e); }
    });
    symbolMutexes.set(symbol, nextPromise);
    return nextPromise;
}

// ====================================================================
// RATE LIMIT NETWORK CONTROL
// ====================================================================
let lastRequestTime = Date.now();
async function binanceRequest(method, endpoint, data = {}) {
    const now = Date.now();
    const minInterval = 40; 
    if (now - lastRequestTime < minInterval) {
        await new Promise(r => setTimeout(r, minInterval - (now - lastRequestTime)));
    }
    lastRequestTime = Date.now();

    const startTime = Date.now();
    const timestamp = startTime + serverTimeOffset;
    const mergedData = { ...data, timestamp, recvWindow: 10000 };
    
    let queryString = '';
    if (endpoint === '/fapi/v1/batchOrders' && mergedData.batchOrders) {
        const baseQuery = `batchOrders=${encodeURIComponent(mergedData.batchOrders)}&timestamp=${mergedData.timestamp}&recvWindow=${mergedData.recvWindow}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(baseQuery).digest('hex');
        queryString = `${baseQuery}&signature=${signature}`;
    } else {
        const queryForSign = new URLSearchParams(mergedData).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryForSign).digest('hex');
        queryString = `${queryForSign}&signature=${signature}`;
    }

    const url = `${endpoint}?${queryString}`;
    try {
        const response = await binanceApi({ method, url });
        writeRawDebugLog('SUCCESS', endpoint, data, response.data, Date.now() - startTime);
        return response.data;
    } catch (e) {
        const errorPayload = e.response?.data || { message: e.message, code: 'NETWORK_ERROR' };
        writeRawDebugLog('ERROR', endpoint, data, errorPayload, Date.now() - startTime);
        
        if (errorPayload.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            serverTimeOffset = t.data.serverTime - Date.now();
            return binanceRequest(method, endpoint, data);
        }
        
        const errInstance = new Error(typeof errorPayload === 'object' ? JSON.stringify(errorPayload) : String(errorPayload));
        errInstance.raw = errorPayload;
        throw errInstance;
    }
}

// ====================================================================
// WEBSOCKET ENGINE
// ====================================================================
async function initWebSocketEngine() {
    try {
        if (userWsInstance) { try { userWsInstance.terminate(); } catch(e){} }
        const res = await binanceRequest('POST', '/fapi/v1/listenKey');
        listenKey = res.listenKey;

        userWsInstance = new WebSocket(`wss://fstream.binance.com/ws/${listenKey}`);
        lastUserWsTime = Date.now();

        userWsInstance.on('message', (rawData) => {
            lastUserWsTime = Date.now();
            try { handleUserDataEvent(JSON.parse(rawData)); } catch (e) {}
        });
        userWsInstance.on('close', () => setTimeout(initWebSocketEngine, 4000));

        if (markWsInstance) { try { markWsInstance.terminate(); } catch(e){} }
        markWsInstance = new WebSocket(`wss://fstream.binance.com/ws/!markPrice@arr`);
        lastMarkWsTime = Date.now();

        markWsInstance.on('message', (rawData) => {
            lastMarkWsTime = Date.now();
            try { handleGlobalMarkPriceEvent(JSON.parse(rawData)); } catch (e) {}
        });
    } catch (e) {
        setTimeout(initWebSocketEngine, 5000);
    }
}

setInterval(() => {
    if (!status.isReady) return;
    const now = Date.now();
    if (now - lastUserWsTime > 90000 || now - lastMarkWsTime > 90000) {
        addBotLog("🚨 [WATCHDOG] Trùng luồng stream mất kết nối ngầm. Đang reset lại WS...", "error");
        lastUserWsTime = now; lastMarkWsTime = now;
        initWebSocketEngine();
    }
}, 10000);

setInterval(async () => {
    if (listenKey) { await binanceRequest('PUT', '/fapi/v1/listenKey').catch(() => initWebSocketEngine()); }
}, 20 * 60 * 1000);

function handleUserDataEvent(e) {
    if (e.e === 'ACCOUNT_UPDATE') {
        for (const p of e.a.P) {
            const key = `${p.s}_${p.ps}`;
            if (botActivePositions.has(key)) {
                const b = botActivePositions.get(key);
                const currentAmt = Math.abs(parseFloat(p.pa));
                if (currentAmt === 0) {
                    executePositionClosureAccounting(p.s, p.ps, key, b);
                } else if (currentAmt !== b.currentQty) {
                    b.currentQty = currentAmt;
                    botActivePositions.set(key, b);
                    saveBotStateToDisk();
                }
            }
        }
    }
}

function handleGlobalMarkPriceEvent(dataArr) {
    if (!status.isReady || !botSettings.isRunning) return; 
    for (const item of dataArr) {
        const longKey = `${item.s}_LONG`; const shortKey = `${item.s}_SHORT`;
        if (botActivePositions.has(longKey)) checkPriceThresholdAndTriggerFailsafe(longKey, parseFloat(item.p));
        if (botActivePositions.has(shortKey)) checkPriceThresholdAndTriggerFailsafe(shortKey, parseFloat(item.p));
    }
}

async function checkPriceThresholdAndTriggerFailsafe(key, markP) {
    const b = botActivePositions.get(key);
    if (!b || b.isClosing) return; 

    let isPriceBreached = false;
    if (b.side === 'SHORT' && (markP <= b.tp || markP >= b.sl)) isPriceBreached = true;
    if (b.side === 'LONG' && (markP >= b.tp || markP <= b.sl)) isPriceBreached = true;

    if (isPriceBreached) {
        b.isClosing = true; 
        botActivePositions.set(key, b);
        
        setTimeout(() => {
            runLocked(b.symbol, async () => {
                const freshCheck = botActivePositions.get(key);
                if (freshCheck) {
                    addBotLog(`⏰ [FAILSAFE] Vị thế ${b.symbol} chạm vạch quá 10s chưa mất. Khớp lệnh MARKET dập đóng luôn!`, 'warning');
                    const ok = await closePositionMarket(freshCheck, "FAILSAFE_TIMEOUT");
                    if (ok) { botActivePositions.delete(key); saveBotStateToDisk(); } 
                    else { freshCheck.isClosing = false; botActivePositions.set(key, freshCheck); }
                }
            });
        }, 10000);
    }
}

async function executePositionClosureAccounting(symbol, positionSideParam, key, b) {
    try {
        const trades = await binanceRequest('GET', '/fapi/v1/userTrades', { symbol, limit: 30 }).catch(() => []);
        const recent = trades.filter(t => (Date.now() + serverTimeOffset - t.time) < 90000 && t.positionSide === positionSideParam);
        let totalR = 0; recent.forEach(t => totalR += parseFloat(t.realizedPnl));
        
        status.botClosedCount++; status.botPnLClosed += totalR;

        if (totalR > (-b.firstMargin * 0.05)) {
            botActivePositions.delete(key);
            status.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
            addBotLog(`💰 [PROFIT CHỐT LỜI] ${symbol} [${b.side}] | PnL: ${totalR.toFixed(2)}$ | Cách ly Blacklist 15 phút.`, 'success');
        } else {
            addBotLog(`❌ [LOSS DÍNH SL] Vị thế ${symbol} [${b.side}] cắt lỗ: ${totalR.toFixed(2)}$`);
            const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
            const targetRisk = freshRisk.find(x => x.positionSide === positionSideParam);
            const currentPrice = targetRisk ? parseFloat(targetRisk.markPrice) : b.entryPrice;
            
            const distance = b.side === 'SHORT' ? currentPrice - b.firstEntry : b.firstEntry - currentPrice;
            botActivePositions.delete(key);

            if (distance > 0 && botSettings.isRunning) { 
                const jump = Math.max(b.dcaCount + 1, Math.floor(distance / (b.firstEntry * botSettings.posSL / 100)));
                if (jump <= botSettings.maxDCA) {
                    const newMultiplier = Math.pow(2, jump);
                    addBotLog(`🔄 [DCA] Nâng cấp vốn lên mức [${jump}/${botSettings.maxDCA}] (Hệ số x${newMultiplier}) cho ${symbol}`);
                    await openPosition(symbol, { ...b, dcaCount: jump, margin: b.firstMargin * newMultiplier });
                } else {
                    const reverseSide = b.side === 'SHORT' ? 'LONG' : 'SHORT';
                    addBotLog(`🚨 [QUAY XE] Chạm trần maxDCA. Đảo ngược lệnh x20 margin gốc với ${symbol}`);
                    await openPosition(symbol, { ...b, side: reverseSide, isFinalLong: (reverseSide === 'LONG'), dcaCount: 0, margin: b.firstMargin * 20 });
                }
            }
        }
    } catch (e) { botActivePositions.delete(key); }
    finally { saveBotStateToDisk(); }
}

// ====================================================================
// ENGINE CORE TRADING
// ====================================================================
async function closePositionMarket(pos, reason = "FAILSAFE") {
    const sideClose = pos.side === 'SHORT' ? 'BUY' : 'SELL';
    const positionSideParam = status.isHedgeMode ? pos.side : 'BOTH';
    try {
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: pos.symbol });
        const realPos = freshRisk.find(p => p.positionSide === positionSideParam && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (!realPos) return true;

        const freshQty = Math.abs(parseFloat(realPos.positionAmt));
        const info = status.exchangeInfo[pos.symbol];
        const finalExactQty = Number(freshQty.toFixed(getPrecision(info.stepSize)));

        if (finalExactQty <= 0) return true;
        const systemClientOrderId = `bot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const res = await binanceRequest('POST', '/fapi/v1/order', {
            symbol: pos.symbol, side: sideClose, positionSide: positionSideParam,
            type: 'MARKET', quantity: finalExactQty, newClientOrderId: systemClientOrderId
        });
        if (res?.orderId) return true;
    } catch (e) {}
    return false;
}

// THAY THẾ TOÀN BỘ BẰNG HÀM ĐỒNG BỘ TP/SL BATCH ĐÃ TỐI ƯU HÓA
async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';

    try {
        const openOrders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol }).catch(() => []);
        const botOrdersToCancel = openOrders.filter(o => 
            o.positionSide === positionSideParam && 
            (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET')
        );

        if (botOrdersToCancel.length > 0) {
            const orderIdList = botOrdersToCancel.map(o => o.orderId);
            await binanceRequest('DELETE', '/fapi/v1/batchOrders', {
                symbol,
                orderIds: JSON.stringify(orderIdList)
            }).catch(() => {});
        }

        const batchParams = [
            { symbol, side: sideClose, positionSide: positionSideParam, type: 'TAKE_PROFIT_MARKET', stopPrice: Number(tpPrice.toFixed(info.pricePrecision)).toString(), closePosition: 'true', workingType: 'MARK_PRICE' },
            { symbol, side: sideClose, positionSide: positionSideParam, type: 'STOP_MARKET', stopPrice: Number(slPrice.toFixed(info.pricePrecision)).toString(), closePosition: 'true', workingType: 'MARK_PRICE' }
        ];

        await binanceRequest('POST', '/fapi/v1/batchOrders', { batchOrders: JSON.stringify(batchParams) });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) {
        return { tp: 0, sl: 0 };
    }
}

async function openPosition(symbol, dcaData = null) {
    if (!status.exchangeInfo[symbol] || !botSettings.isRunning) return;

    const isLong = dcaData ? (dcaData.isFinalLong || dcaData.side === 'LONG') : false;
    const side = isLong ? 'LONG' : 'SHORT';
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const orderSideParam = isLong ? 'BUY' : 'SELL';
    const currentDCALevel = dcaData ? dcaData.dcaCount : 0;
    
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        let margin = (dcaData && dcaData.margin) ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        
        if (margin * info.maxLeverage < info.minNotional) {
            margin = (info.minNotional + 0.5) / info.maxLeverage;
        }
        
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
        const symbolRisk = freshRisk.find(x => x.positionSide === positionSideParam) || freshRisk[0];
        if (!symbolRisk) return;
        
        const price = parseFloat(symbolRisk.markPrice);
        if (!price || price === 0) return;
        
        let qty = Number(((margin * info.maxLeverage) / price).toFixed(getPrecision(info.stepSize)));
        if (isNaN(qty) || qty <= 0) return;

        if (!leverageCache.has(symbol)) {
            await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: info.maxLeverage }).catch(() => {});
            leverageCache.add(symbol);
        }
        
        const systemClientOrderId = `bot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const order = await binanceRequest('POST', '/fapi/v1/order', { 
            symbol, side: orderSideParam, positionSide: positionSideParam, 
            type: 'MARKET', quantity: qty, newClientOrderId: systemClientOrderId
        });
        
        if (order?.orderId) {
            let p = null;
            await new Promise(r => setTimeout(r, 800));
            for (let i = 0; i < 3; i++) {
                const pRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
                p = pRisk.find(x => x.positionSide === positionSideParam && Math.abs(parseFloat(x.positionAmt)) > 0);
                if (p) break;
                await new Promise(r => setTimeout(r, 300));
            }
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = (dcaData && dcaData.firstEntry) ? dcaData.firstEntry : entry;
                let tp = isLong ? entry * (1 + botSettings.posTP / 100) : entry * (1 - botSettings.posTP / 100);
                let sl = isLong ? entry * (1 - botSettings.posSL / 100) : firstE + (firstE * botSettings.posSL / 100);
                
                const currentLocalPosition = { 
                    symbol, side, entryPrice: entry, tp, sl, dcaCount: currentDCALevel, 
                    leverage: info.maxLeverage, firstEntry: firstE, firstMargin: (dcaData && dcaData.firstMargin) ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0, tpSlMode: null, isClosing: false 
                };
                
                botActivePositions.set(`${symbol}_${positionSideParam}`, currentLocalPosition);
                saveBotStateToDisk();
                addBotLog(`🎬 Mở vị thế thành công: ${symbol} [${side}] | Qty: ${qty} | Khởi chạy cụm TP/SL.`);
                
                // Trực tiếp kích hoạt gọi hàm đồng bộ batch orders mới tối ưu tốc độ cao
                await syncTPSL(symbol, side, info, tp, sl);
            }
        }
    } catch (e) { 
        status.blackList[symbol] = Date.now() + (5 * 60 * 1000); 
        addBotLog(`🚨 [MỞ LỆNH LỖI] Đẩy ${symbol} vào Blacklist lỗi 5m để tránh nghẽn.`, 'error'); 
    }
}

// ====================================================================
// ĐỘC LẬP TUYỆT ĐỐI VỚI LỆNH TAY TRÊN SÀN
// ====================================================================
async function runPositionReconciliationEngine() {
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        const activeOnChainPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        for (const [key, localPos] of botActivePositions.entries()) {
            const existsOnChain = activeOnChainPositions.some(p => `${p.symbol}_${p.positionSide}` === key);
            if (!existsOnChain) {
                addBotLog(`🚨 [LỆCH VỊ THẾ KHẨN CẤP] Phát hiện ${localPos.symbol} của bot trên sàn đã biến mất, giải phóng bộ nhớ!`, 'warning');
                await executePositionClosureAccounting(localPos.symbol, key.split('_')[1], key, localPos);
            } else {
                const p = activeOnChainPositions.find(x => `${x.symbol}_${x.positionSide}` === key);
                if (p) {
                    const b = botActivePositions.get(key);
                    b.currentQty = Math.abs(parseFloat(p.positionAmt)); 
                    b.entryPrice = parseFloat(p.entryPrice);
                    botActivePositions.set(key, b);
                }
            }
        }
        // Loại bỏ hoàn toàn cơ chế can thiệp nạp bậy lệnh không tag hoặc kill nhầm vị thế tay
        saveBotStateToDisk();
    } catch (e) {}
}

// ====================================================================
// INIT SYSTEM
// ====================================================================
const APP = express(); 
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

APP.get('/api/status', async (req, res) => {
    let walletData = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
    try {
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        const botUnrealizedPnL = Array.from(botActivePositions.values()).reduce((s, p) => s + (p.pnl || 0), 0);
        walletData = { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: botUnrealizedPnL.toFixed(2) };
    } catch (e) {}
    
    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: { ...status, blackListReadable: getReadableBlacklist() }, 
        wallet: walletData 
    });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    saveBotStateToDisk(); 
    res.json({ success: true }); 
});

async function init() {
    loadBotStateFromDisk(); 
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        serverTimeOffset = t.data.serverTime - Date.now();
        
        const posMode = await binanceRequest('GET', '/fapi/v1/positionSide/dual');
        status.isHedgeMode = posMode.dualSidePosition;

        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const brk = await binanceRequest('GET', '/fapi/v2/leverageBracket').catch(() => []);
        
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const minNotionalValue = notionalFilter ? parseFloat(notionalFilter.notional || notionalFilter.minNotional) : 5.0;

            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), minNotional: minNotionalValue, maxLeverage: b?.brackets[0]?.initialLeverage || 20 };
        });
        
        status.exchangeInfo = temp; status.isReady = true; 
        await runPositionReconciliationEngine();
        await initWebSocketEngine();
        
        addBotLog(`🚀 [V3.9.8 FINAL] Đã tích hợp Batch TPSL tối ưu | Độc lập hoàn toàn lệnh mở tay trên sàn.`);
    } catch (e) { setTimeout(init, 5000); }
}
init();

setInterval(() => {
    if (status.isReady) runPositionReconciliationEngine();
}, 25000);

// ====================================================================
// TĂNG TỐC QUYẾT ĐỊNH VÀO LỆNH TRONG 1 GIÂY
// ====================================================================
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return; 
    if (botActivePositions.size >= botSettings.maxPositions || openingSymbols.size > 0) return;

    const can = status.candidatesList.find(c => {
        const info = status.exchangeInfo[c.symbol];
        // Bỏ hoàn toàn rào cản cũ, chỉ kiểm tra điều kiện căn bản để quét Vol 0.1% siêu nhạy
        if (!info || info.maxLeverage < 20 || Math.abs(c.c1) < botSettings.minVol || status.blackList[c.symbol]) return false;
        return !botActivePositions.has(`${c.symbol}_${c.c1 > 0 ? 'LONG' : 'SHORT'}`);
    });

    if (can) {
        const targetSide = can.c1 > 0 ? 'LONG' : 'SHORT';
        runLocked(can.symbol, async () => {
            if (botActivePositions.has(`${can.symbol}_${targetSide}`) || openingSymbols.has(can.symbol)) return;
            if (botActivePositions.size >= botSettings.maxPositions) return;

            openingSymbols.add(can.symbol);
            try { 
                await openPosition(can.symbol, { isFinalLong: (targetSide === 'LONG'), side: targetSide, dcaCount: 0 }); 
            } 
            finally { openingSymbols.delete(can.symbol); }
        });
    }
}, 1000); 

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 800);

setInterval(() => {
    const now = Date.now();
    for (const s in status.blackList) { if (status.blackList[s] < now) delete status.blackList[s]; }
}, 20000);

APP.listen(9001, () => {
    console.log('🌐 Web UI hoạt động tại địa chỉ: http://localhost:9001');
});
