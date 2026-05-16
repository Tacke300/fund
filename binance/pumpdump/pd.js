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

// ====================================================================
// SYSTEM STATES (TRẠNG THÁI HỆ THỐNG TOÀN CỤC)
// ====================================================================
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: "1%", 
    minVol: 6.5, 
    posTP: 1.2, 
    posSL: 10.0, 
    maxDCA: 5 
};

let status = { 
    botLogs: [], 
    candidatesList: [], 
    blackList: {}, 
    botClosedCount: 0, 
    botPnLClosed: 0, 
    exchangeInfo: {}, 
    isReady: false, 
    isHedgeMode: true 
};

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
// UTILS & STORAGE (TIỆN ÍCH VÀ LƯU TRỮ DỮ LIỆU)
// ====================================================================
function getPrecision(stepSize) {
    const step = stepSize.toString();
    if (!step.includes('.')) return 0;
    return step.split('.')[1].replace(/0+$/, '').length;
}

function writeRawDebugLog(type, endpoint, payload, responseOrError, latency) {
    const logTime = new Date().toISOString();
    fs.appendFile(LOG_FILE_PATH, JSON.stringify({ 
        time: logTime, 
        type, 
        endpoint, 
        requestData: payload, 
        latencyMs: latency, 
        result: responseOrError 
    }) + '\n', () => {});
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
            addBotLog("💾 [RECOVERY] Trạng thái hệ thống đã được phục hồi thành công từ đĩa.");
        }
    } catch (e) {}
}

function runLocked(symbol, asyncTask) {
    if (!symbolMutexes.has(symbol)) symbolMutexes.set(symbol, Promise.resolve());
    const currentPromise = symbolMutexes.get(symbol);
    const nextPromise = currentPromise.then(async () => {
        try { await asyncTask(); } catch (e) { console.error(`❌ Lỗi Hàng đợi Mutex ${symbol}:`, e); }
    });
    symbolMutexes.set(symbol, nextPromise);
    return nextPromise;
}

// ====================================================================
// NETWORK CONTROL & RATE LIMIT (KIỂM SOÁT LUỒNG MẠNG TRÁNH BAN IP)
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
    if ((endpoint === '/fapi/v1/batchOrders' || endpoint === '/fapi/v1/algo/order') && mergedData.batchOrders) {
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
// WEBSOCKET CORE ENGINE & WATCHDOG (ĐỘNG CƠ ĐỒNG BỘ DỮ LIỆU)
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
        addBotLog("🚨 [WATCHDOG] Stream mất kết nối ngầm (Ping/Pong Drop). Đang tái khởi động lại WS...", "error");
        lastUserWsTime = now; lastMarkWsTime = now;
        initWebSocketEngine();
    }
}, 10000);

setInterval(async () => {
    if (listenKey) { await binanceRequest('PUT', '/fapi/v1/listenKey').catch(() => initWebSocketEngine()); }
}, 20 * 60 * 1000);

// TẦNG 5 (RECOVERY ENGINE - GIÁO ÁN 4): ACCOUNT_UPDATE WEBSOCKET SYNC
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

// TẦNG 3 (LOCAL TPSL ENGINE - GIÁO ÁN 1): GIÁM SÁT REALTIME MARK PRICE WEBSOCKET
function handleGlobalMarkPriceEvent(dataArr) {
    if (!status.isReady || !botSettings.isRunning) return; 
    for (const item of dataArr) {
        const longKey = `${item.s}_LONG`; 
        const shortKey = `${item.s}_SHORT`;
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
        
        // Nếu vị thế đang chạy thuần trên nền tảng Local Core do sàn lỗi chặn đặt lệnh
        // Thì nổ súng ép dập ngay lập tức (100ms), ngược lại tạo trễ 9.5s xem sàn tự khớp được lệnh T1/T2 không
        const dynamicDelay = b.deployedArchitecture === 'T3_LOCAL_ENGINE' ? 100 : 9500;

        setTimeout(() => {
            runLocked(b.symbol, async () => {
                const freshCheck = botActivePositions.get(key);
                if (freshCheck) {
                    const symbolInfo = status.exchangeInfo[b.symbol];
                    const infoParam = {
                        pricePrecision: symbolInfo.pricePrecision,
                        quantityPrecision: getPrecision(symbolInfo.stepSize),
                        isHedgeMode: status.isHedgeMode
                    };

                    addBotLog(`⏰ [T3 EXECUTOR] Ngưỡng giá vi phạm quá hạn mức an toàn. Kích hoạt TẦNG 4 dập vị thế!`, 'warning');
                    const ok = await runFailsafeEmergencyClose(b.symbol, freshCheck.side, freshCheck.currentQty, infoParam);
                    if (ok) { 
                        botActivePositions.delete(key); 
                        saveBotStateToDisk(); 
                    } else { 
                        freshCheck.isClosing = false; 
                        botActivePositions.set(key, freshCheck); 
                    }
                }
            });
        }, dynamicDelay);
    }
}

// TẦNG 5 (RECOVERY ENGINE - GIÁO ÁN 3): QUÉT TRADES HÒA MẠNG QUYẾT TOÁN SỐ LIỆU THỰC TẾ
async function executePositionClosureAccounting(symbol, positionSideParam, key, b) {
    try {
        const trades = await binanceRequest('GET', '/fapi/v1/userTrades', { symbol, limit: 30 }).catch(() => []);
        const recent = trades.filter(t => (Date.now() + serverTimeOffset - t.time) < 90000 && t.positionSide === positionSideParam);
        let totalR = 0; 
        recent.forEach(t => totalR += parseFloat(t.realizedPnl));
        
        status.botClosedCount++; 
        status.botPnLClosed += totalR;

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
                const jump = Math.max(b.dcaCount + 1, Math.ceil(distance / (b.firstEntry * botSettings.posSL / 100)));
                if (jump <= botSettings.maxDCA) {
                    const newMultiplier = Math.pow(2, jump);
                    addBotLog(`🔄 [DCA] Nâng cấp vốn lên mức [${jump}/${botSettings.maxDCA}] (Hệ số x${newMultiplier}) cho ${symbol}`);
                    await openPosition(symbol, { ...b, dcaCount: jump, margin: b.firstMargin * newMultiplier });
                } else {
                    const reverseSide = b.side === 'SHORT' ? 'LONG' : 'SHORT';
                    addBotLog(`🚨 [QUAY XE] Chạm trần maxDCA. Đảo ngược lệnh x20 vốn gốc với ${symbol}`);
                    await openPosition(symbol, { ...b, side: reverseSide, isFinalLong: (reverseSide === 'LONG'), dcaCount: 0, margin: b.firstMargin * 20 });
                }
            }
        }
    } catch (e) { 
        botActivePositions.delete(key); 
    } finally { 
        saveBotStateToDisk(); 
    }
}

// ====================================================================
// ARCHITECTURE LEVEL 1: NORMAL ORDER ROUTER BACKBONE
// ====================================================================
async function executeBackboneT1(symbol, sideClose, positionSideParam, info, price, type) {
    const formattedPrice = Number(price.toFixed(info.pricePrecision));
    const isTP = type === 'TAKE_PROFIT';
    
    const syllabusPool = [
        // Giáo án 1 & 6: TAKE_PROFIT / STOP (Limit Trigger kiểu mới) + Mark Price + Price Protect đầy đủ
        {
            type: isTP ? 'TAKE_PROFIT' : 'STOP',
            price: formattedPrice, stopPrice: formattedPrice,
            workingType: 'MARK_PRICE', priceProtect: 'TRUE', timeInForce: 'GTC'
        },
        // Giáo án 2 & 8: TAKE_PROFIT_MARKET / STOP_MARKET + closePosition=true + priceProtect=true
        {
            type: isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            stopPrice: formattedPrice, closePosition: 'true',
            workingType: 'MARK_PRICE', priceProtect: 'TRUE'
        },
        // Giáo án 3 & 9: Loại bỏ PriceProtect hoàn toàn (Tránh sàn từ chối do quét giá mạnh chênh lệch)
        {
            type: isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            stopPrice: formattedPrice, closePosition: 'true'
        },
        // Giáo án 4 & 5: Dạng Quantity mode thủ công kết hợp ReduceOnly (Hỗ trợ tài khoản chạy chế độ One-Way)
        {
            type: isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            stopPrice: formattedPrice, reduceOnly: 'true'
        },
        // Giáo án 7: Ép sử dụng CONTRACT_PRICE (Last Price) thay thế hoàn toàn cho MARK_PRICE cục bộ
        {
            type: isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            stopPrice: formattedPrice, closePosition: 'true', workingType: 'CONTRACT_PRICE'
        }
    ];

    for (let index = 0; index < syllabusPool.length; index++) {
        try {
            const basePayload = {
                symbol,
                side: sideClose,
                positionSide: positionSideParam,
                ...syllabusPool[index]
            };
            
            // Nếu giáo án yêu cầu khai báo khối lượng rõ ràng thay vì đóng tự động
            if (!basePayload.closePosition && !basePayload.reduceOnly) {
                basePayload.quantity = info.currentQty;
            }

            const res = await binanceRequest('POST', '/fapi/v1/order', basePayload);
            if (res.orderId) {
                addBotLog(`[TẦNG 1 OK] Khớp Giáo án ${index + 1} cho ${symbol} (${type})`, 'success');
                return true;
            }
        } catch (err) {
            addBotLog(`[⚠️ TẦNG 1 FAIL] Giáo án ${index + 1} bị Reject: ${err.message}`, 'warning');
        }
    }
    return false;
}

// ====================================================================
// ARCHITECTURE LEVEL 2: ALGO ORDER ENGINE BACKBONE
// ====================================================================
async function executeBackboneT2(symbol, sideClose, positionSideParam, info, price, type) {
    const formattedPrice = Number(price.toFixed(info.pricePrecision));
    const isTP = type === 'TAKE_PROFIT';

    const algoSyllabus = [
        // Giáo án 1, 3, 5, 6: Cổng thuật toán Algo chuẩn hóa sử dụng MARK_PRICE trigger kết hợp giảm vị thế tự động
        {
            algoType: isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            triggerPrice: formattedPrice,
            workingType: 'MARK_PRICE',
            reduceOnly: 'true'
        },
        // Giáo án 2 & 4: Kịch bản rẽ nhánh Algo sử dụng LAST_PRICE (CONTRACT_PRICE) làm điểm kích hoạt
        {
            algoType: isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            triggerPrice: formattedPrice,
            workingType: 'CONTRACT_PRICE',
            reduceOnly: 'true'
        }
    ];

    for (let index = 0; index < algoSyllabus.length; index++) {
        try {
            const payload = {
                symbol,
                side: sideClose,
                positionSide: positionSideParam,
                quantity: info.currentQty,
                ...algoSyllabus[index]
            };

            const res = await binanceRequest('POST', '/fapi/v1/algo/order', payload);
            if (res.algoId) {
                addBotLog(`[TẦNG 2 ALGO OK] Kích hoạt thành công Giáo án Algo ${index + 1} cho ${symbol}`, 'success');
                return true;
            }
        } catch (err) {
            addBotLog(`[⚠️ TẦNG 2 FAIL] Giáo án Algo ${index + 1} bị loại bỏ: ${err.message}`, 'warning');
        }
    }
    return false;
}

// ====================================================================
// ARCHITECTURE LEVEL 4: FAILSAFE DESTRUCTION ENGINE
// ====================================================================
async function runFailsafeEmergencyClose(symbol, side, currentQty, info) {
    addBotLog(`🚨🚨 [KÍCH HOẠT T4 FAILSAFE] Bắt đầu tổng tấn công đóng vị thế cưỡng chế cho ${symbol}`, 'error');
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    const positionSideParam = info.isHedgeMode ? side : 'BOTH';
    const cleanQty = Number(currentQty.toFixed(info.quantityPrecision));

    if (cleanQty <= 0) return true;

    // Giáo án 1: Ném thẳng lệnh MARKET hủy diệt vị thế bất chấp trượt giá
    try {
        const marketRes = await binanceRequest('POST', '/fapi/v1/order', {
            symbol, side: sideClose, positionSide: positionSideParam,
            type: 'MARKET', quantity: cleanQty
        });
        if (marketRes.orderId) { 
            addBotLog(`💥 [FAILSAFE T4-G1] San phẳng vị thế bằng lệnh MARKET thành công!`, 'success'); 
            return true; 
        }
    } catch (e) { 
        addBotLog(`❌ [FAILSAFE T4-G1] Lệnh MARKET thất bại: ${e.message}`, 'error'); 
    }

    // Giáo án 2: Quét giá nhanh qua cấu trúc lệnh LIMIT - IOC (Immediate Or Cancel) với Slippage 1%
    try {
        const currentPriceRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
        const markPrice = parseFloat(currentPriceRisk[0]?.markPrice || 0);
        if (markPrice > 0) {
            const slippageFactor = sideClose === 'BUY' ? 1.01 : 0.99;
            const iocPrice = Number((markPrice * slippageFactor).toFixed(info.pricePrecision));

            const iocRes = await binanceRequest('POST', '/fapi/v1/order', {
                symbol, side: sideClose, positionSide: positionSideParam,
                type: 'LIMIT', quantity: cleanQty, price: iocPrice,
                timeInForce: 'IOC'
            });
            if (iocRes.orderId) { 
                addBotLog(`💥 [FAILSAFE T4-G2] Ép đóng vị thế bằng cấu trúc lệnh IOC thành công!`, 'success'); 
                return true; 
            }
        }
    } catch (e) { 
        addBotLog(`❌ [FAILSAFE T4-G2] Lệnh IOC thất bại: ${e.message}`, 'error'); 
    }

    // Giáo án 3: Lệnh LIMIT - FOK (Fill Or Kill) ép khớp toàn bộ khối lượng hoặc tự hủy lập tức với Slippage 1.5%
    try {
        const currentPriceRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
        const markPrice = parseFloat(currentPriceRisk[0]?.markPrice || 0);
        if (markPrice > 0) {
            const slippageFactor = sideClose === 'BUY' ? 1.015 : 0.985;
            const fokPrice = Number((markPrice * slippageFactor).toFixed(info.pricePrecision));

            const fokRes = await binanceRequest('POST', '/fapi/v1/order', {
                symbol, side: sideClose, positionSide: positionSideParam,
                type: 'LIMIT', quantity: cleanQty, price: fokPrice,
                timeInForce: 'FOK'
            });
            if (fokRes.orderId) { 
                addBotLog(`💥 [FAILSAFE T4-G3] Hấp thụ toàn bộ thanh khoản qua lệnh FOK thành công!`, 'success'); 
                return true; 
            }
        }
    } catch (e) { 
        addBotLog(`❌ [FAILSAFE T4-G4] Lệnh FOK thất bại: ${e.message}`, 'error'); 
    }

    // Giáo án 4: Kỹ thuật Xẻ nhỏ cấu trúc khối lượng thành 4 mảnh (Slicing Position) xử lý nghẽn lệnh lớn
    try {
        addBotLog(`⚡ [FAILSAFE T4-G4] Phân rã khối lượng tổng thể thành 4 phần nhỏ nhằm xả hàng cứu trợ...`, 'warning');
        const sliceQty = Number((cleanQty / 4).toFixed(info.quantityPrecision));
        if (sliceQty > 0) {
            for (let chunk = 1; chunk <= 4; chunk++) {
                await binanceRequest('POST', '/fapi/v1/order', {
                    symbol, side: sideClose, positionSide: positionSideParam,
                    type: 'MARKET', quantity: sliceQty
                }).catch(() => addBotLog(`Lỗi thanh khoản khi xả mảnh thứ ${chunk}`));
            }
            return true;
        }
    } catch (e) {}

    return false;
}

// ROUTER ĐIỀU PHỐI ĐA KIẾN TRÚC TOÀN DIỆN THAY THẾ TOÀN BỘ BẢN CŨ
async function syncTPSLMultiArchitecture(symbol, side, info, tpPrice, slPrice, currentQty) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    const positionSideParam = info.isHedgeMode ? side : 'BOTH';

    const payloadInfo = {
        currentQty,
        pricePrecision: info.pricePrecision,
        quantityPrecision: info.quantityPrecision
    };

    try {
        // TẦNG 5 (RECOVERY ENGINE - GIÁO ÁN 2): ĐỒNG BỘ VÀ XOÁ TOÀN BỘ LỆNH ĐIỀU KIỆN MA ĐANG TREO TRÊN SÀN
        const openOrders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol }).catch(() => []);
        const oldOrders = openOrders.filter(o => o.positionSide === positionSideParam && (o.type.includes('TAKE_PROFIT') || o.type.includes('STOP')));
        
        for (const o of oldOrders) {
            await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId }).catch(() => {});
        }

        addBotLog(`🔄 Triển khai cấu trúc bảo vệ đa nền tảng cho ${symbol} | Khối lượng: ${currentQty}`);

        // --------------------------------------------------------------------
        // TẦNG 1: KIẾN TRÚC HỆ THỐNG CỔNG LỆNH THƯỜNG (NORMAL ORDER ENGINE)
        // --------------------------------------------------------------------
        addBotLog(`[TUYẾN 1] Kích hoạt Tầng 1: Normal Conditional API Router...`);
        const t1TpOk = await executeBackboneT1(symbol, sideClose, positionSideParam, payloadInfo, tpPrice, 'TAKE_PROFIT');
        const t1SlOk = await executeBackboneT1(symbol, sideClose, positionSideParam, payloadInfo, slPrice, 'STOP');

        if (t1TpOk && t1SlOk) {
            addBotLog(`🎯 [HOÀN THÀNH V1] Lưới bảo hiểm vị thế cấu hình AN TOÀN trên cổng T1.`, 'success');
            return { tp: tpPrice, sl: slPrice, architecture: 'T1_NORMAL' };
        }

        // --------------------------------------------------------------------
        // TẦNG 2: KIẾN TRÚC CỔNG THUẬT TOÁN ĐỘC LẬP (ALGO API ENGINE)
        // --------------------------------------------------------------------
        addBotLog(`🚨 [MẤT BẢO VỆ T1] Chuyển đổi cơ sở hạ tầng sang TẦNG 2: Algo Order API Core...`, 'error');
        const t2TpOk = await executeBackboneT2(symbol, sideClose, positionSideParam, payloadInfo, tpPrice, 'TAKE_PROFIT');
        const t2SlOk = await executeBackboneT2(symbol, sideClose, positionSideParam, payloadInfo, slPrice, 'STOP');

        if (t2TpOk && t2SlOk) {
            addBotLog(`🎯 [HOÀN THÀNH V2] Trục vớt vị thế thành công thông qua hạ tầng T2 ALGO.`, 'success');
            return { tp: tpPrice, sl: slPrice, architecture: 'T2_ALGO' };
        }

        // --------------------------------------------------------------------
        // TẦNG 3: KIẾN TRÚC GIÁM SÁT ĐƠN TUYẾN NỘI BỘ (LOCAL WS CORE)
        // --------------------------------------------------------------------
        addBotLog(`🚨🚨 [SẬP GÃY TOÀN BỘ CỔNG ĐIỀU KIỆN CỦA SÀN] Khởi động chế độ phòng vệ TẦNG 3.`, 'error');
        addBotLog(`🎯 [CẤT CÁNH T3] Chuyển giao toàn quyền giám sát cho Local Websocket Core Engine. Bot tự quản lý ngưỡng giá va chạm nội bộ!`, 'warning');
        
        return { tp: tpPrice, sl: slPrice, architecture: 'T3_LOCAL_ENGINE' };

    } catch (globalError) {
        addBotLog(`💥 Hệ thống phòng vệ Đa kiến trúc bị đứt gãy nghiêm trọng: ${globalError.message}`, 'error');
        return { tp: 0, sl: 0, architecture: 'BROKEN' };
    }
}

// ====================================================================
// CORE POSITION OPENING ENGINE (CƠ CHẾ MỞ LỆNH VÀ KIỂM TRA ON-CHAIN)
// ====================================================================
async function openPosition(symbol, dcaData = null) {
    if (!status.exchangeInfo[symbol] || !botSettings.isRunning) return;

    const isLong = dcaData ? (dcaData.isFinalLong || dcaData.side === 'LONG') : false;
    const side = isLong ? 'LONG' : 'SHORT';
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const orderSideParam = isLong ? 'BUY' : 'SELL';
    
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
            // ÉP TRỄ PHÒNG THỦ TRÊN 2S ĐỒNG BỘ DỮ LIỆU ON-CHAIN TOÀN DIỆN LÊN SÀN (800ms gốc + 4 vòng x 300ms = 2000ms thực tế)
            await new Promise(r => setTimeout(r, 800));
            for (let i = 0; i < 4; i++) {
                const pRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
                p = pRisk.find(x => x.positionSide === positionSideParam && Math.abs(parseFloat(x.positionAmt)) > 0);
                if (p) break;
                await new Promise(r => setTimeout(r, 300));
            }
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = (dcaData && dcaData.firstEntry) ? dcaData.firstEntry : entry;
                const dcaLevel = dcaData ? dcaData.dcaCount : 0;

                let tp;
                let sl;

                if (isLong) {
                    tp = entry * (1 + botSettings.posTP / 100);
                    sl = firstE - (firstE * (((dcaLevel + 1) * botSettings.posSL) / 100));
                } else {
                    tp = entry * (1 - botSettings.posTP / 100);
                    sl = firstE + (firstE * (((dcaLevel + 1) * botSettings.posSL) / 100));
                }

                const currentLocalPosition = { 
                    symbol,
                    side,
                    entryPrice: entry,
                    tp,
                    sl,
                    dcaCount: dcaLevel,
                    leverage: info.maxLeverage,
                    firstEntry: firstE,
                    firstMargin: (dcaData && dcaData.firstMargin) ? dcaData.firstMargin : margin,
                    currentQty: Math.abs(parseFloat(p.positionAmt)),
                    pnl: 0,
                    priceDev: 0,
                    tpSlMode: "FIRST_ENTRY_DYNAMIC",
                    isClosing: false,
                    deployedArchitecture: 'NONE'
                };
                
                const extendedInfoParam = {
                    pricePrecision: info.pricePrecision,
                    quantityPrecision: getPrecision(info.stepSize),
                    isHedgeMode: status.isHedgeMode
                };

                // KÍCH HOẠT QUÉT ĐA KIẾN TRÚC ĐA TẦNG CHO COIN MỚI/CŨ/LAUNCHPOOL/SPECIAL PAIR
                const protectionStatus = await syncTPSLMultiArchitecture(
                    symbol, 
                    side, 
                    extendedInfoParam, 
                    tp, 
                    sl, 
                    Math.abs(parseFloat(p.positionAmt))
                );

                // Đồng bộ hóa trạng thái hạ tầng thực tế vào cấu trúc lưu trữ của bot
                currentLocalPosition.deployedArchitecture = protectionStatus.architecture;

                botActivePositions.set(`${symbol}_${positionSideParam}`, currentLocalPosition);
                saveBotStateToDisk();
                addBotLog(`🎬 Giám sát thành công vị thế: ${symbol} [${side}] (DCA ${dcaLevel}) | Cơ sở hạ tầng bảo vệ: ${protectionStatus.architecture}`);
            }
        }
    } catch (e) { 
        status.blackList[symbol] = Date.now() + (5 * 60 * 1000); 
        addBotLog(`🚨 [MỞ LỆNH LỖI VỊ THẾ] Đẩy ngay ${symbol} vào Blacklist 5m tránh nghẽn vòng lặp.`, 'error'); 
    }
}

// ====================================================================
// TẦNG 5: RECOVERY ENGINE - GIÁO ÁN 1 & 2 (HÒA MẠNG DỮ LIỆU ĐỘC LẬP)
// ====================================================================
async function runPositionReconciliationEngine() {
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        const activeOnChainPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        for (const [key, localPos] of botActivePositions.entries()) {
            const existsOnChain = activeOnChainPositions.some(p => `${p.symbol}_${p.positionSide}` === key);
            if (!existsOnChain) {
                addBotLog(`🚨 [RECOVERY CẮT LỆNH MA] Phát hiện vị thế ${localPos.symbol} trên sàn đã biến mất, giải phóng bộ nhớ!`, 'warning');
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
        saveBotStateToDisk();
    } catch (e) {}
}

// ====================================================================
// WEB UI & ENDPOINTS (GIAO DIỆN QUẢN LÝ HTTP VÀ REALTIME MONITOR)
// ====================================================================
const APP = express(); 
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'index.html')); 
});

APP.get('/api/status', async (req, res) => {
    let walletData = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
    try {
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        const botUnrealizedPnL = Array.from(botActivePositions.values()).reduce((s, p) => s + (p.pnl || 0), 0);
        walletData = { 
            totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
            totalUnrealizedProfit: botUnrealizedPnL.toFixed(2) 
        };
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

// ====================================================================
// INITIALIZATION KICKSTART (KÍCH HOẠT HỆ THỐNG TOÀN DIỆN)
// ====================================================================
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

            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                minNotional: minNotionalValue, 
                maxLeverage: b?.brackets[0]?.initialLeverage || 20 
            };
        });
        
        status.exchangeInfo = temp; 
        status.isReady = true; 
        
        await runPositionReconciliationEngine();
        await initWebSocketEngine();
        
        addBotLog(`🚀 [ENTERPRISE COMPLETE] Toàn bộ hạ tầng phòng thủ 5 Tầng 24 Giáo án đã hoạt động.`);
    } catch (e) { 
        setTimeout(init, 5000); 
    }
}
init();

// HỆ THỐNG ĐỒNG BỘ ĐỊNH KỲ CHỐNG LỆCH TRẠNG THÁI ON-CHAIN (TẦNG 5)
setInterval(() => {
    if (status.isReady) runPositionReconciliationEngine();
}, 25000);

// VÒNG LẶP QUÉT TÌM KIẾM CƠ HỘI VÀ VÀO LỆNH THẦN TỐC
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return; 
    if (botActivePositions.size >= botSettings.maxPositions || openingSymbols.size > 0) return;

    const can = status.candidatesList.find(c => {
        const info = status.exchangeInfo[c.symbol];
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
            } finally { 
                openingSymbols.delete(can.symbol); 
            }
        });
    }
}, 1000); 

// TẦNG 3 (LOCAL ENGINE - GIÁO ÁN 4): REST POLLING FALLBACK GIÁM SÁT KHI WEBSOCKET TRỄ HOẶC ĐỨT NGHẼN
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; 
        res.on('data', c => d += c);
        res.on('end', () => { 
            try { 
                status.candidatesList = JSON.parse(d).live || []; 
            } catch(e){} 
        });
    }).on('error', () => {});
}, 800);

// GIẢI PHÓNG KÝ TỰ KHỎI DANH SÁCH BLACKLIST ĐỊNH KỲ
setInterval(() => {
    const now = Date.now();
    for (const s in status.blackList) { if (status.blackList[s] < now) delete status.blackList[s]; }
}, 20000);

APP.listen(9001, () => {
    console.log('🌐 Giao diện Web Monitor hoạt động tại: http://localhost:9001');
});
