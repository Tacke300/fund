import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; 
import WebSocket from 'ws';
import { API_KEY, SECRET_KEY } from './config.js';

const MAX_DCA_LEVEL = 3; 
const DCA_SCALE = [1, 2, 4, 8]; 

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
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
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
// CORE UTILS & LOCAL PERSISTENCE SYSTEM
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
    } catch (e) {
        console.error('❌ Lỗi ghi file persistent state:', e.message);
    }
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
            addBotLog("💾 [RECOVERY] Đã nạp trạng thái hệ thống ổn định cũ.");
        }
    } catch (e) {
        console.error('⚠️ Không thể khôi phục trạng thái cũ:', e.message);
    }
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
// NETWORKING CONTROL WITH RATE LIMIT
// ====================================================================
let lastRequestTime = Date.now();
async function binanceRequest(method, endpoint, data = {}) {
    const now = Date.now();
    const minInterval = 60; 
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

        userWsInstance.on('open', () => console.log('🔌 [USER WS] Đã kết nối luồng dữ liệu Tài Khoản.'));
        userWsInstance.on('message', (rawData) => {
            lastUserWsTime = Date.now();
            try { handleUserDataEvent(JSON.parse(rawData)); } catch (e) {}
        });
        userWsInstance.on('close', () => {
            console.log('🚨 [USER WS] Bị ngắt kết nối. Đang tái khởi động...');
            setTimeout(initWebSocketEngine, 4000);
        });
        userWsInstance.on('error', (err) => console.error('⚠️ [USER WS] Lỗi:', err.message));

        if (markWsInstance) { try { markWsInstance.terminate(); } catch(e){} }
        markWsInstance = new WebSocket(`wss://fstream.binance.com/ws/!markPrice@arr`);
        lastMarkWsTime = Date.now();

        markWsInstance.on('open', () => console.log('📊 [MARK WS] Đã kết nối luồng giá Mark Toàn Sàn.'));
        markWsInstance.on('message', (rawData) => {
            lastMarkWsTime = Date.now();
            try { handleGlobalMarkPriceEvent(JSON.parse(rawData)); } catch (e) {}
        });
        markWsInstance.on('close', () => {
            console.log('🚨 [MARK WS] Bị ngắt kết nối. Đang hồi phục stream...');
        });
        markWsInstance.on('error', (err) => console.error('⚠️ [MARK WS] Lỗi:', err.message));

    } catch (e) {
        console.error('❌ Thất bại khi kích hoạt động cơ Websocket, thử lại sau 5 giây...', e.message);
        setTimeout(initWebSocketEngine, 5000);
    }
}

setInterval(() => {
    if (!status.isReady) return;
    const now = Date.now();
    if (now - lastUserWsTime > 90000 || now - lastMarkWsTime > 90000) {
        addBotLog("🚨 [WATCHDOG] Phát hiện luồng WS mất tín hiệu ngầm > 90s. Thực thi reset!", "error");
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

// ====================================================================
// CORE TRIGGERS & WATCHDOG 10S FAILSAFE FOR POSITION CLOSURE
// ====================================================================
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
        addBotLog(`⚠️ [🚨 TOUCH TRIGGER] Phát hiện giá ${b.symbol} chạm vạch (${markP}). Kích hoạt bộ đếm Failsafe Watchdog 10 giây...`);
        
        setTimeout(() => {
            runLocked(b.symbol, async () => {
                const freshCheck = botActivePositions.get(key);
                if (freshCheck) {
                    addBotLog(`⏰ [FAILSAFE TIMEOUT] Quá 10 giây vị thế ${b.symbol} chưa biến mất. Tiến hành dập thẳng lệnh MARKET để giải thoát!`, 'warning');
                    const ok = await closePositionMarket(freshCheck, "FAILSAFE_10S_TIMEOUT");
                    if (ok) { 
                        botActivePositions.delete(key); 
                        saveBotStateToDisk(); 
                    } else {
                        freshCheck.isClosing = false;
                        botActivePositions.set(key, freshCheck);
                    }
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
            addBotLog(`💰 [WIN CHỐT LỜI] ${symbol} [${b.side}] | PnL: ${totalR.toFixed(2)}$ | Đã đẩy vào Blacklist 15m.`, 'success');
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
                    addBotLog(`🔄 [DCA ENGINE] Tăng cấp bổ sung vốn lên mức [${jump}/${botSettings.maxDCA}] cho ${symbol}`);
                    await openPosition(symbol, { ...b, dcaCount: jump, margin: b.firstMargin * DCA_SCALE[jump] });
                } else {
                    const reverseSide = b.side === 'SHORT' ? 'LONG' : 'SHORT';
                    addBotLog(`🚨 [QUAY XE] Kích hoạt lệnh đảo hướng cực hạn x20 margin bảo vệ tài khoản với ${symbol}`);
                    await openPosition(symbol, { ...b, side: reverseSide, isFinalLong: (reverseSide === 'LONG'), dcaCount: 0, margin: b.firstMargin * 20 });
                }
            }
        }
    } catch (e) { botActivePositions.delete(key); }
    finally { saveBotStateToDisk(); }
}

// ====================================================================
// CORE ACTION EXECUTION FUNCTIONS
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
        const precision = getPrecision(info.stepSize);
        const finalExactQty = Number(freshQty.toFixed(precision));

        if (finalExactQty <= 0) return true;
        const systemClientOrderId = `bot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const res = await binanceRequest('POST', '/fapi/v1/order', {
            symbol: pos.symbol, side: sideClose, positionSide: positionSideParam,
            type: 'MARKET', quantity: finalExactQty, newClientOrderId: systemClientOrderId
        });
        if (res?.orderId) return true;
    } catch (e) { console.error(`❌ Cưỡng chế đóng lệnh Market thất bại cho ${pos.symbol}:`, e.message || e); }
    return false;
}

async function openPosition(symbol, dcaData = null) {
    if (!status.exchangeInfo[symbol]) return;
    if (!botSettings.isRunning) return;

    const isLong = dcaData ? dcaData.isFinalLong || dcaData.side === 'LONG' : false;
    const side = isLong ? 'LONG' : 'SHORT';
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const orderSideParam = isLong ? 'BUY' : 'SELL';
    const currentDCALevel = dcaData ? dcaData.dcaCount : 0;
    
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        
        if (margin * info.maxLeverage < info.minNotional) {
            margin = (info.minNotional + 0.5) / info.maxLeverage;
        }
        
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
        const symbolRisk = freshRisk.find(x => x.positionSide === positionSideParam) || freshRisk[0];
        if (!symbolRisk) return;
        
        const price = parseFloat(symbolRisk.markPrice);
        if (!price || price === 0) return;
        
        let qty = Number(((margin * info.maxLeverage) / price).toFixed(getPrecision(info.stepSize)));
        
        // [FIX - Chặn đứng SPAM LỖI 1102]: Kiểm tra nếu số lượng không đủ điều kiện tối thiểu, hủy bỏ luôn luồng bắn lệnh
        if (isNaN(qty) || qty <= 0) {
            console.log(`[BỎ QUA TÍN HIỆU] ${symbol} khối lượng tính toán (${qty}) quá bé, không thể vào lệnh.`);
            return;
        }

        addBotLog(`🎬 Kích hoạt mở vị thế thực tế cho ${symbol} [${side}] - Qty: ${qty}`);

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
            await new Promise(r => setTimeout(r, 1000));
            for (let i = 0; i < 3; i++) {
                const pRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
                p = pRisk.find(x => x.positionSide === positionSideParam && Math.abs(parseFloat(x.positionAmt)) > 0);
                if (p) break;
                await new Promise(r => setTimeout(r, 400));
            }
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                let tp = isLong ? entry * (1 + botSettings.posTP / 100) : entry * (1 - botSettings.posTP / 100);
                let sl = isLong ? entry * (1 - botSettings.posSL / 100) : firstE + (firstE * botSettings.posSL / 100);
                
                const currentLocalPosition = { 
                    symbol, side, entryPrice: entry, tp, sl, dcaCount: currentDCALevel, 
                    leverage: info.maxLeverage, firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0, tpSlMode: null, isClosing: false 
                };
                
                botActivePositions.set(`${symbol}_${positionSideParam}`, currentLocalPosition);
                saveBotStateToDisk();
                await cascadeSyncTPSLEngine(symbol, side, info, tp, sl);
            }
        }
    } catch (e) { 
        addBotLog(`❌ Lỗi luồng vào lệnh ${symbol}: ${e.message || JSON.stringify(e)}`, 'error'); 
    }
}

// ====================================================================
// [BOMBER MODE] PHỆT THẲNG SỐNG SONG 3 CÁCH KHÔNG ĐIỀU KIỆN
// ====================================================================
async function cascadeSyncTPSLEngine(symbol, side, info, tp, sl) {
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const sideClose = (side === 'SHORT') ? 'BUY' : 'SELL';
    const localPosKey = `${symbol}_${positionSideParam}`;
    
    let localData = botActivePositions.get(localPosKey);
    if (!localData) return;
    if (!botSettings.isRunning) return;

    try {
        const orders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol }).catch(() => []);
        const targetOrders = orders.filter(o => o.positionSide === positionSideParam && ['TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(o.type));
        for (const o of targetOrders) { 
            await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId }).catch(() => null); 
        }
    } catch (e) { console.error(`⚠️ Không dọn được lệnh cũ cho ${symbol}:`, e.message); }

    const targetTPPrice = Number(tp.toFixed(info.pricePrecision));
    const targetSLPrice = Number(sl.toFixed(info.pricePrecision));

    const batchParams = [
        { symbol, side: sideClose, positionSide: positionSideParam, type: 'TAKE_PROFIT_MARKET', stopPrice: targetTPPrice.toString(), closePosition: 'true', workingType: 'MARK_PRICE' },
        { symbol, side: sideClose, positionSide: positionSideParam, type: 'STOP_MARKET', stopPrice: targetSLPrice.toString(), closePosition: 'true', workingType: 'MARK_PRICE' }
    ];
    const singleBase = { symbol, side: sideClose, positionSide: positionSideParam, closePosition: 'true', workingType: 'MARK_PRICE' };

    addBotLog(`🚀 [BOMBER MODE] Phệt song song TP(${targetTPPrice})/SL(${targetSLPrice}) cho ${symbol}...`);

    const tasks = [
        binanceRequest('POST', '/fapi/v1/batchOrders', { batchOrders: JSON.stringify(batchParams) }).then(() => true).catch(() => false),
        binanceRequest('POST', '/fapi/v1/order', { ...singleBase, type: 'TAKE_PROFIT_MARKET', stopPrice: targetTPPrice.toString() }).then(() => true).catch(() => false),
        binanceRequest('POST', '/fapi/v1/order', { ...singleBase, type: 'STOP_MARKET', stopPrice: targetSLPrice.toString() }).then(() => true).catch(() => false)
    ];

    const results = await Promise.all(tasks);
    localData.tpSlMode = results[0] ? 0 : (results[1] && results[2] ? 1 : 2);
    botActivePositions.set(localPosKey, localData);
    saveBotStateToDisk();
}

// ====================================================================
// POSITION RECONCILIATION ENGINE (FIX KẸT VỊ THẾ)
// ====================================================================
async function runPositionReconciliationEngine() {
    addBotLog("🔍 [RECONCILIATION] Thực thi rà soát trạng thái đối soát sàn...");
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        const activeOnChainPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        // Quét tất cả các vị thế đang lưu cục bộ trong bộ nhớ RAM của Bot
        for (const [key, localPos] of botActivePositions.entries()) {
            // [FIX CHÍNH]: Nếu bộ nhớ RAM đang giữ vị thế, nhưng sàn báo vị thế này ĐÃ ĐÓNG (không có trên OnChain)
            const existsOnChain = activeOnChainPositions.some(p => `${p.symbol}_${p.positionSide}` === key);
            if (!existsOnChain) {
                addBotLog(`🚨 [ĐỒNG BỘ KHẨN CẤP] Phát hiện ${localPos.symbol} đã đóng trên sàn nhưng bot vẫn giữ. Đẩy vào luồng tính toán chốt sổ!`, 'warning');
                // Gọi thẳng hàm xử lý đóng tài khoản để xóa RAM, ghi log kế toán và tự động ném vào Blacklist 15 phút
                await executePositionClosureAccounting(localPos.symbol, key.split('_')[1], key, localPos);
            }
        }

        for (const p of activeOnChainPositions) {
            const key = `${p.symbol}_${p.positionSide}`;
            const currentAmt = Math.abs(parseFloat(p.positionAmt));
            
            if (!botActivePositions.has(key)) {
                const lastOrders = await binanceRequest('GET', '/fapi/v1/allOrders', { symbol: p.symbol, limit: 10 }).catch(() => []);
                const hasBotTag = lastOrders.some(o => o.clientOrderId && o.clientOrderId.startsWith('bot-'));
                if (!hasBotTag) continue; 

                if (botSettings.isRunning) { 
                    const tempPos = { symbol: p.symbol, side: p.positionSide === 'BOTH' ? (parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT') : p.positionSide, currentQty: currentAmt };
                    await closePositionMarket(tempPos, "RECONCILIATION_ORPHAN");
                }
            } else {
                const b = botActivePositions.get(key);
                b.currentQty = currentAmt; b.entryPrice = parseFloat(p.entryPrice);
                botActivePositions.set(key, b);
                
                const info = status.exchangeInfo[p.symbol];
                if (info && botSettings.isRunning) await cascadeSyncTPSLEngine(p.symbol, b.side, info, b.tp, b.sl);
            }
        }
        saveBotStateToDisk();
    } catch (e) {}
}

// ====================================================================
// SYSTEM INITS, ROUTES & SERVE HTML STATIC FILES
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
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: walletData });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    saveBotStateToDisk(); 
    addBotLog(`🎛️ Cập nhật trạng thái chạy = ${botSettings.isRunning.toString().toUpperCase()}`);
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
        
        addBotLog(`🚀 [PRODUCTION V3.8 WORKED] Đã vá kẹt vị thế & Triệt tiêu spam log.`);
    } catch (e) { setTimeout(init, 5000); }
}
init();

// Luồng rà soát định kỳ 15s/lần tự động giải quyết các xung đột
setInterval(() => {
    if (status.isReady) runPositionReconciliationEngine();
}, 15000);

// Quét mở lệnh từ danh sách tín hiệu candidatesList
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return; 
    if (botActivePositions.size >= botSettings.maxPositions || openingSymbols.size > 0) return;

    const can = status.candidatesList.find(c => {
        const info = status.exchangeInfo[c.symbol];
        if (!info || info.maxLeverage < 20 || Math.abs(c.c1) < botSettings.minVol || status.blackList[c.symbol]) return false;
        if (c.spreadPct > 0.15 || (c.openInterest && c.openInterest < 5000000)) return false; 
        return !botActivePositions.has(`${c.symbol}_${c.c1 > 0 ? 'LONG' : 'SHORT'}`);
    });

    if (can) {
        const targetSide = can.c1 > 0 ? 'LONG' : 'SHORT';
        runLocked(can.symbol, async () => {
            if (botActivePositions.has(`${can.symbol}_${targetSide}`) || openingSymbols.has(can.symbol)) return;
            if (botActivePositions.size >= botSettings.maxPositions) return;

            openingSymbols.add(can.symbol);
            try { await openPosition(can.symbol, targetSide === 'LONG' ? { isFinalLong: true, side: 'LONG', dcaCount: 0 } : null); } 
            finally { openingSymbols.delete(can.symbol); }
        });
    }
}, 3000);

// Xử lý bộ đếm Blacklist
setInterval(() => {
    const now = Date.now();
    for (const s in status.blackList) { if (status.blackList[s] < now) delete status.blackList[s]; }
}, 60000);

// Lấy tín hiệu thời gian thực từ cục quét chính ở cổng 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

APP.listen(9001, () => {
    console.log('🌐 Giao diện điều khiển Web UI hoạt động tại địa chỉ: http://localhost:9001');
});
