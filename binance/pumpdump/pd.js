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
// [FIX 4] BẢNG MULTIPLIER CHUẨN TOÁN HỌC MARTINGALE (Cấp 0: Gốc, Cấp 1: x2, Cấp 2: x4, Cấp 3: x8)
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

let botActivePositions = new Map(); // Key: symbol_positionSide
let openingSymbols = new Set();     // Isolated Symbol Set
let symbolMutexes = new Map();      // Mutex Queue
let serverTimeOffset = 0;
let listenKey = null;
let wsInstance = null;
const leverageCache = new Set();    // Khởi tạo đầy đủ biến bộ đệm

// [FIX 7] BIẾN WATCHDOG CHỐNG CHẾT LÂM SÀNG WEBSOCKET
let lastWsMessageTime = Date.now();

// ====================================================================
// [CORE] UTILS & LOCAL PERSISTENCE SYSTEM (RECOVERY BOOT)
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
            addBotLog("💾 [RECOVERY] Đã nạp và khôi phục thành công trạng thái hệ thống từ Disk Persistent.");
        }
    } catch (e) {
        console.error('⚠️ Không thể khôi phục trạng thái cũ:', e.message);
    }
}

function runLocked(symbol, asyncTask) {
    if (!symbolMutexes.has(symbol)) {
        symbolMutexes.set(symbol, Promise.resolve());
    }
    const currentPromise = symbolMutexes.get(symbol);
    const nextPromise = currentPromise.then(async () => {
        try {
            await asyncTask();
        } catch (e) {
            console.error(`❌ Lỗi thực thi tác vụ Mutex cho ${symbol}:`, e);
        }
    });
    symbolMutexes.set(symbol, nextPromise);
    return nextPromise;
}

// ====================================================================
// [CORE] NETWORKING & RATE LIMIT CONTROL WITH QUEUE LOCK
// ====================================================================
let lastRequestTime = Date.now();
async function binanceRequest(method, endpoint, data = {}) {
    // [FIX 6] RATE LIMITER CONTROL: Tự động delay tuyến tính chống lỗi -1003 hoặc dính nến lỗi 429
    const now = Date.now();
    const minInterval = 60; // Giãn cách tối thiểu 60ms giữa mọi request REST thủ công
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
        throw errorPayload;
    }
}

// ====================================================================
// [WEBSOCKET] USER DATA STREAM & ENGINE
// ====================================================================
async function initWebSocketEngine() {
    try {
        if (wsInstance) {
            wsInstance.terminate();
            wsInstance = null;
        }

        const res = await binanceRequest('POST', '/fapi/v1/listenKey');
        listenKey = res.listenKey;

        wsInstance = new WebSocket(`wss://fstream.binance.com/stream?streams=${listenKey}/!markPrice@arr`);
        lastWsMessageTime = Date.now(); // Reset mốc kiểm tra

        wsInstance.on('open', () => {
            console.log('🔌 [WEBSOCKET] Kết nối thành công Engine sự kiện Binance Futures.');
        });

        wsInstance.on('message', (rawData) => {
            lastWsMessageTime = Date.now(); // [FIX 7 OK] Đánh dấu thời gian nhận packet thực tế realtime
            try {
                const packet = JSON.parse(rawData);
                const streamName = packet.stream;
                const eventData = packet.data;

                if (streamName === listenKey) {
                    handleUserDataEvent(eventData);
                } else if (streamName === '!markPrice@arr') {
                    handleGlobalMarkPriceEvent(eventData);
                }
            } catch (e) {
                console.error('❌ Lỗi xử lý bản tin WebSocket:', e.message);
            }
        });

        wsInstance.on('error', (err) => {
            console.error('⚠️ Lỗi kết nối WebSocket Engine:', err.message);
        });

        wsInstance.on('close', () => {
            console.log('🚨 WebSocket Engine bị đóng ngắt. Tiến hành tái khởi động...');
            setTimeout(initWebSocketEngine, 4000);
        });

    } catch (e) {
        console.error('❌ Không thể kích hoạt WebSocket Engine, thử lại sau 5 giây...', e.message);
        setTimeout(initWebSocketEngine, 5000);
    }
}

// [FIX 7] ENGINE WATCHDOG: Kiểm tra định kỳ mỗi 10s. Nếu > 30s không có dữ liệu, ép khởi động lại
setInterval(() => {
    if (status.isReady && (Date.now() - lastWsMessageTime > 30000)) {
        addBotLog("🚨 [WATCHDOG CRITICAL] Phát hiện trạng thái CHẾT LÂM SÀNG WebSocket (Quá 30s không có tin). Ép terminate để khôi phục luồng!", "error");
        lastWsMessageTime = Date.now(); // Tránh loop kích hoạt liên tục trong lúc đợi kết nối lại
        if (wsInstance) {
            try { wsInstance.terminate(); } catch (e) {}
        } else {
            initWebSocketEngine();
        }
    }
}, 10000);

setInterval(async () => {
    if (listenKey) {
        await binanceRequest('PUT', '/fapi/v1/listenKey').catch(() => {
            initWebSocketEngine();
        });
    }
}, 20 * 60 * 1000);

function handleUserDataEvent(e) {
    if (e.e === 'ACCOUNT_UPDATE') {
        const positions = e.a.P;
        for (const p of positions) {
            const key = `${p.s}_${p.ps}`;
            if (botActivePositions.has(key)) {
                const b = botActivePositions.get(key);
                const currentAmt = Math.abs(parseFloat(p.pa));
                
                if (currentAmt === 0) {
                    console.log(`📡 [WS EVENT] Phát hiện vị thế của ${p.s} (${p.ps}) đã biến mất trên sàn.`);
                    executePositionClosureAccounting(p.s, p.ps, key, b);
                } else {
                    if (currentAmt !== b.currentQty) {
                        console.log(`📡 [WS EVENT] Đồng bộ lại khối lượng thực tế cho ${p.s}_${p.ps}: ${b.currentQty} -> ${currentAmt}`);
                        b.currentQty = currentAmt;
                        botActivePositions.set(key, b);
                        saveBotStateToDisk();
                    }
                }
            }
        }
    }
    
    if (e.e === 'ORDER_TRADE_UPDATE') {
        const o = e.o;
        if (['FILLED', 'EXPIRED', 'CANCELED'].includes(o.X)) {
            const key = `${o.s}_${o.ps}`;
            if (botActivePositions.has(key) && ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.o)) {
                console.log(`📡 [WS EVENT] Lệnh bảo vệ dạng ${o.o} của token ${o.s} đã chuyển trạng thái sang [${o.X}]. Kích hoạt hậu kiểm tra...`);
                runLocked(o.s, async () => {
                    await verifyOpenOrdersOnChain(o.s, o.ps);
                });
            }
        }
    }
}

function handleGlobalMarkPriceEvent(dataArr) {
    if (!status.isReady) return;
    for (const item of dataArr) {
        const symbol = item.s;
        const currentMarkPrice = parseFloat(item.p);
        const longKey = `${symbol}_LONG`;
        const shortKey = `${symbol}_SHORT`;
        
        if (botActivePositions.has(longKey)) processSoftwareTriggerForPrice(longKey, currentMarkPrice);
        if (botActivePositions.has(shortKey)) processSoftwareTriggerForPrice(shortKey, currentMarkPrice);
    }
}

async function processSoftwareTriggerForPrice(key, markP) {
    const b = botActivePositions.get(key);
    // [FIX 3 OK] CHẶN SPAM ĐÓNG LỆNH TRÙNG: Nếu flag b.isClosing đã dựng lên, chặn đứng luồng xử lý
    if (!b || b.tpSlMode !== 3 || b.isClosing) return; 

    let triggerFailsafe = false;
    if (b.side === 'SHORT') {
        b.priceDev = ((b.entryPrice - markP) / b.entryPrice) * 100;
        if (markP <= b.tp || markP >= b.sl) triggerFailsafe = true;
    } else if (b.side === 'LONG') {
        b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
        if (markP >= b.tp || markP <= b.sl) triggerFailsafe = true;
    }

    if (triggerFailsafe) {
        b.isClosing = true; // Khóa cục bộ ngay lập tức tại luồng đồng bộ
        botActivePositions.set(key, b);

        runLocked(b.symbol, async () => {
            const stillExists = botActivePositions.get(key);
            if (stillExists && stillExists.tpSlMode === 3) {
                addBotLog(`🎯 [PP3 WS TRIGGER] Vị thế ${b.symbol} (${b.side}) chạm mốc mềm tại giá Mark: ${markP}. Gọi khẩn cấp MARKET Close...`);
                const closed = await closePositionMarket(b, "PP3_WS_SOFTWARE_EXECUTION");
                if (closed) {
                    botActivePositions.delete(key);
                    saveBotStateToDisk();
                } else {
                    b.isClosing = false; // Nhả lock nếu thực thi lệnh sàn thất bại để luồng sau cứu hộ tiếp
                    botActivePositions.set(key, b);
                }
            }
        });
    }
}

async function executePositionClosureAccounting(symbol, positionSideParam, key, b) {
    addBotLog(`⚠️ Vị thế ${symbol} (${positionSideParam}) xác thực đã đóng hoàn toàn. Đang tính toán PnL kết toán...`);
    try {
        const trades = await binanceRequest('GET', '/fapi/v1/userTrades', { symbol: symbol, limit: 30 }).catch(() => []);
        const recent = trades.filter(t => (Date.now() + serverTimeOffset - t.time) < 90000 && t.positionSide === positionSideParam);
        let totalR = 0; 
        recent.forEach(t => totalR += parseFloat(t.realizedPnl));
        
        status.botClosedCount++; 
        status.botPnLClosed += totalR;

        if (totalR > (-b.firstMargin * 0.05)) {
            botActivePositions.delete(key);
            status.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
            addBotLog(`💰 [KẾT QUẢ: WIN] Đã chốt lời ${symbol} [${b.side}] | PnL thực tế: ${totalR.toFixed(2)}$`, 'success');
        } else {
            addBotLog(`❌ [KẾT QUẢ: LOSS] Vị thế ${symbol} [${b.side}] dính SL lỗ: ${totalR.toFixed(2)}$`);
            
            const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
            const targetRisk = freshRisk.find(x => x.positionSide === positionSideParam);
            const currentPrice = targetRisk ? parseFloat(targetRisk.markPrice) : b.entryPrice;
            
            const distance = b.side === 'SHORT' ? currentPrice - b.firstEntry : b.firstEntry - currentPrice;
            botActivePositions.delete(key);

            if (distance > 0) {
                const jump = Math.max(b.dcaCount + 1, Math.floor(distance / (b.firstEntry * botSettings.posSL / 100)));
                if (jump <= botSettings.maxDCA) {
                    addBotLog(`🔄 [HÀNH ĐỘNG DCA] Kích hoạt DCA Cấp [${jump}/${botSettings.maxDCA}] cho ${symbol} [${b.side}].`);
                    // [FIX 4 OK] TÍNH TOÁN VỐN THEO BẢNG MULTIPLIER MARTINGALE CHUẨN XÁC CHỐNG LỆCH PHƯƠNG TRÌNH
                    const nextMargin = b.firstMargin * DCA_SCALE[jump];
                    await openPosition(symbol, { ...b, dcaCount: jump, margin: nextMargin });
                } else {
                    const reverseSide = b.side === 'SHORT' ? 'LONG' : 'SHORT';
                    addBotLog(`🚨 [HÀNH ĐỘNG MỤC 6 - QUAY XE] Chạm trần DCA. Tiến hành hủy diệt hướng cũ, QUAY XE mở vị thế ${reverseSide} x20 vốn cho ${symbol}.`);
                    await openPosition(symbol, { ...b, side: reverseSide, isFinalLong: (reverseSide === 'LONG'), dcaCount: 0, margin: b.firstMargin * 20 });
                }
            } else {
                addBotLog(`⚠️ [CẢNH BÁO CAO ĐỘ] Vị thế biến mất khi đang có lãi (Trượt giá nến râu). Ngăn chặn hành vi DCA sai lệch!`);
            }
        }
    } catch (e) {
        console.error("❌ Lỗi trong quy trình kết toán vị thế:", e.message);
        botActivePositions.delete(key);
    } finally {
        saveBotStateToDisk();
    }
}

// ====================================================================
// [CORE ACTION] EXECUTION FUNCTIONS
// ====================================================================

async function closePositionMarket(pos, reason = "FAILSAFE") {
    const sideClose = pos.side === 'SHORT' ? 'BUY' : 'SELL';
    const positionSideParam = status.isHedgeMode ? pos.side : 'BOTH';
    
    try {
        addBotLog(`🚨 [MILI-GIÂY KHẨN CẤP] Gọi REST lấy khối lượng thực tế on-chain giải cứu vị thế ${pos.symbol}...`);
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: pos.symbol });
        const realPos = freshRisk.find(p => p.positionSide === positionSideParam && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        if (!realPos) {
            console.log(`🛡️ Vị thế ${pos.symbol}_${positionSideParam} thực tế đã trống sạch trên sàn. Bỏ qua lệnh Market Close.`);
            return true;
        }

        const freshQty = Math.abs(parseFloat(realPos.positionAmt));
        const info = status.exchangeInfo[pos.symbol];
        const precision = getPrecision(info.stepSize);
        
        // [FIX 2 OK] TOÀN DIỆN HÓA LÀM TRÒN: Đưa về hàm toFixed(precision) nguyên mẫu để triệt tiêu hoàn toàn khối lượng rác dạng 0.000999
        const finalExactQty = Number(freshQty.toFixed(precision));

        if (finalExactQty <= 0) return true;

        // [FIX 5] GÀI TAG NHẬN DIỆN CLIENT ORDER ID ĐỂ PHỤC VỤ ENGINE ĐỐI SOÁT CHỐNG ĐÓNG NHẦM LỆNH TAY
        const systemClientOrderId = `bot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const res = await binanceRequest('POST', '/fapi/v1/order', {
            symbol: pos.symbol,
            side: sideClose,
            positionSide: positionSideParam,
            type: 'MARKET',
            quantity: finalExactQty,
            newClientOrderId: systemClientOrderId
        });
        
        if (res?.orderId) {
            console.log(`✅ [THÀNH CÔNG] Đã cưỡng chế giải phóng hoàn toàn vị thế ${pos.symbol} [${positionSideParam}] qua lệnh MARKET.`);
            return true;
        }
    } catch (e) {
        console.error(`❌ [THẤT BẠI CHÍ MẠNG] Force Market Close bị từ chối cho ${pos.symbol}:`, e);
    }
    return false;
}

async function openPosition(symbol, dcaData = null) {
    if (!status.exchangeInfo[symbol]) return;
    
    // Logic biến động bên trong core giờ chỉ thực thi khi đã lấy được tài nguyên an toàn
    const isLong = dcaData ? dcaData.isFinalLong || dcaData.side === 'LONG' : false;
    const side = isLong ? 'LONG' : 'SHORT';
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const orderSideParam = isLong ? 'BUY' : 'SELL';
    const currentDCALevel = dcaData ? dcaData.dcaCount : 0;
    
    console.log(`\n=================== THAO TÁC VÀO LỆNH: ${symbol} ===================`);
    addBotLog(`🎬 Khởi động luồng mở vị thế độc lập cho ${symbol} [${side}] - DCA Cấp: ${currentDCALevel}`);
    
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        
        const orderNotional = margin * info.maxLeverage;
        if (orderNotional < info.minNotional) {
            margin = (info.minNotional + 0.5) / info.maxLeverage;
        }
        
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
        const symbolRisk = freshRisk.find(x => x.positionSide === positionSideParam) || freshRisk[0];
        const price = symbolRisk ? parseFloat(symbolRisk.markPrice) : 0;
        
        if (price === 0) throw new Error("Không thể lấy Mark Price để tính toán cấu trúc khối lượng.");
        
        let rawQty = (margin * info.maxLeverage) / price;
        const precision = getPrecision(info.stepSize);
        let qty = Number(rawQty.toFixed(precision));
        if (qty <= 0) qty = info.stepSize;

        if (!leverageCache.has(symbol)) {
            await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: info.maxLeverage }).catch(() => {});
            leverageCache.add(symbol);
        }
        
        console.log(`[1/3] Đẩy lệnh MARKET mở vị thế on-chain...`);
        const systemClientOrderId = `bot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const order = await binanceRequest('POST', '/fapi/v1/order', { 
            symbol, 
            side: orderSideParam, 
            positionSide: positionSideParam, 
            type: 'MARKET', 
            quantity: qty,
            newClientOrderId: systemClientOrderId
        });
        
        if (order?.orderId) {
            let p = null;
            for (let i = 0; i < 6; i++) {
                await new Promise(r => setTimeout(r, 250));
                const pRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
                p = pRisk.find(x => x.positionSide === positionSideParam && Math.abs(parseFloat(x.positionAmt)) > 0);
                if (p) break;
            }
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                
                let tp = isLong ? entry * (1 + botSettings.posTP / 100) : entry * (1 - botSettings.posTP / 100);
                let sl = isLong ? entry * (1 - botSettings.posSL / 100) : firstE + (firstE * botSettings.posSL / 100);
                
                addBotLog(`📊 [MỞ LỆNH OK] ${symbol} | Entry: ${entry} | TP: ${tp.toFixed(info.pricePrecision)} | SL: ${sl.toFixed(info.pricePrecision)}`);
                
                const currentLocalPosition = { 
                    symbol, side, entryPrice: entry, tp, sl, dcaCount: currentDCALevel, 
                    leverage: info.maxLeverage, firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0, tpSlMode: null, isClosing: false 
                };
                
                botActivePositions.set(`${symbol}_${positionSideParam}`, currentLocalPosition);
                saveBotStateToDisk();
                
                await cascadeSyncTPSL(symbol, side, info, tp, sl);
            }
        }
    } catch (e) { 
        addBotLog(`❌ [LỖI THỰC THI] Không thể mở vị thế ${symbol}: ${e.msg || e.message}`, 'error'); 
    }
}

async function cascadeSyncTPSL(symbol, side, info, tp, sl) {
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const sideClose = (side === 'SHORT') ? 'BUY' : 'SELL';
    const localPosKey = `${symbol}_${positionSideParam}`;
    
    let localData = botActivePositions.get(localPosKey);
    if (!localData) return;

    try {
        const orders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
        const targetOrders = orders.filter(o => o.positionSide === positionSideParam && ['TAKE_PROFIT', 'STOP', 'TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(o.type));
        for (const o of targetOrders) {
            await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId }).catch(() => null);
        }
    } catch (e) {}

    const targetTPPrice = Number(tp.toFixed(info.pricePrecision));
    const targetSLPrice = Number(sl.toFixed(info.pricePrecision));
    let verifiedOnChain = false;

    try {
        const batchParams = [
            { symbol, side: sideClose, positionSide: positionSideParam, type: 'TAKE_PROFIT_MARKET', stopPrice: targetTPPrice.toString(), closePosition: 'true', workingType: 'CONTRACT_PRICE' },
            { symbol, side: sideClose, positionSide: positionSideParam, type: 'STOP_MARKET', stopPrice: targetSLPrice.toString(), closePosition: 'true', workingType: 'CONTRACT_PRICE' }
        ];

        const resBatch = await binanceRequest('POST', '/fapi/v1/batchOrders', { batchOrders: JSON.stringify(batchParams) });
        if (Array.isArray(resBatch) && resBatch.length === 2 && resBatch[0].orderId && resBatch[1].orderId) {
            verifiedOnChain = await verifyOpenOrdersOnChain(symbol, positionSideParam);
            if (verifiedOnChain) localData.tpSlMode = 0;
        }
    } catch (err) {}

    if (!verifiedOnChain) {
        const marketParams = { symbol, side: sideClose, positionSide: positionSideParam, closePosition: 'true', workingType: 'CONTRACT_PRICE' };
        try {
            await binanceRequest('POST', '/fapi/v1/order', { ...marketParams, type: 'TAKE_PROFIT_MARKET', stopPrice: targetTPPrice }).catch(() => null);
            await binanceRequest('POST', '/fapi/v1/order', { ...marketParams, type: 'STOP_MARKET', stopPrice: targetSLPrice }).catch(() => null);
            
            verifiedOnChain = await verifyOpenOrdersOnChain(symbol, positionSideParam);
            if (verifiedOnChain) localData.tpSlMode = 1;
        } catch (err) {}
    }

    if (!verifiedOnChain) {
        const triggerParams = { symbol, side: sideClose, positionSide: positionSideParam, quantity: localData.currentQty, workingType: 'CONTRACT_PRICE' };
        try {
            await binanceRequest('POST', '/fapi/v1/order', { ...triggerParams, type: 'TAKE_PROFIT_MARKET', stopPrice: targetTPPrice }).catch(() => null);
            await binanceRequest('POST', '/fapi/v1/order', { ...triggerParams, type: 'STOP_MARKET', stopPrice: targetSLPrice }).catch(() => null);
            
            verifiedOnChain = await verifyOpenOrdersOnChain(symbol, positionSideParam);
            if (verifiedOnChain) localData.tpSlMode = 2;
        } catch (err) {}
    }

    if (!verifiedOnChain) {
        addBotLog(`🚨 [HẠ CẤP BẢO VỆ] Hệ thống API điều kiện lỗi/hủy ngầm. Tiến hành xóa dọn lệnh rách bảo hiểm cứu hộ vị thế ${symbol}...`, 'warning');
        try {
            const openOrders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
            const activeTriggers = openOrders.filter(o => o.positionSide === positionSideParam && ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.type));
            for (const o of activeTriggers) {
                await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId }).catch(() => null);
            }
        } catch (e) {}

        localData.tpSlMode = 3; 
        addBotLog(`🚨 Vị thế ${symbol} [${positionSideParam}] chuyển sang bảo vệ cấp 3 (Software Persistent)`, 'warning');
    }

    botActivePositions.set(localPosKey, localData);
    saveBotStateToDisk();

    const finalVerify = botActivePositions.get(localPosKey);
    const safeModes = [0, 1, 2, 3]; 

    if (!finalVerify || !safeModes.includes(finalVerify.tpSlMode)) { 
        addBotLog(`🚨 [THẢM HỌA HỆ THỐNG TẦNG 4] Vị thế ${symbol} mất cấu trúc an toàn. ĐÓNG KHẨN CẤP TRÁNH NAKED POSITION!`, 'error');
        const forceClosed = await closePositionMarket(localData, "PP4_CRITICAL_DATA_LEAK");
        if (forceClosed) {
            botActivePositions.delete(localPosKey);
            saveBotStateToDisk();
        }
    }
}

async function verifyOpenOrdersOnChain(symbol, positionSideParam) {
    try {
        const openOrders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
        const activeTriggers = openOrders.filter(o => 
            o.positionSide === positionSideParam && 
            ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.type) &&
            o.status === 'NEW'
        );
        return activeTriggers.length === 2;
    } catch (e) {
        return false;
    }
}

async function runPositionReconciliationEngine() {
    addBotLog("🔍 [RECONCILIATION] Bắt đầu kích hoạt tiến trình đối soát trạng thái thực tế toàn sàn...");
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        const activeOnChainPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        for (const p of activeOnChainPositions) {
            const key = `${p.symbol}_${p.positionSide}`;
            const currentAmt = Math.abs(parseFloat(p.positionAmt));
            
            if (!botActivePositions.has(key)) {
                // [FIX 5 OK] PHÒNG VỆ CHỐNG ĐÓNG LỆNH TAY: Quét lịch sử lệnh để tìm kiếm Tag nhận diện của Bot
                const lastOrders = await binanceRequest('GET', '/fapi/v1/allOrders', { symbol: p.symbol, limit: 10 }).catch(() => []);
                const hasBotTag = lastOrders.some(o => o.clientOrderId && o.clientOrderId.startsWith('bot-'));

                if (!hasBotTag) {
                    addBotLog(`🛡️ [RECONCILIATION] Phát hiện vị thế thủ công ${p.symbol} [${p.positionSide}] tự mở ngoài sàn. Giữ nguyên quyền quản trị cho User.`, 'info');
                    continue; // Bỏ qua không quét khẩn cấp băm nát vị thế tay của ông nữa
                }

                addBotLog(`🚨 [ĐỐI SOÁT PHÁT HIỆN SAI LỆCH] Tìm thấy vị thế lạ mồ côi của bot: ${p.symbol} [${p.positionSide}]. Thực thi Force Close...`, 'warning');
                const tempPos = { 
                    symbol: p.symbol, 
                    side: p.positionSide === 'BOTH' ? (parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT') : p.positionSide, 
                    currentQty: currentAmt 
                };
                await closePositionMarket(tempPos, "RECONCILIATION_ORPHAN_FOUND");
            } else {
                const b = botActivePositions.get(key);
                b.currentQty = currentAmt;
                b.entryPrice = parseFloat(p.entryPrice);
                botActivePositions.set(key, b);
                
                const info = status.exchangeInfo[p.symbol];
                if (info) {
                    console.log(`🛡️ [ĐỐI SOÁT SYSTEM] Khôi phục lưới bảo hiểm đa tầng thành công cho vị thế ${p.symbol}_${p.positionSide}`);
                    await cascadeSyncTPSL(p.symbol, b.side, info, b.tp, b.sl);
                }
            }
        }
        
        for (const [key, b] of botActivePositions.entries()) {
            const match = activeOnChainPositions.find(p => `${p.symbol}_${p.positionSide}` === key);
            if (!match) {
                console.log(`🧹 [ĐỐI SOÁT SYSTEM] Xóa bỏ vị thế ảo trong bộ nhớ cache của token: ${key}`);
                botActivePositions.delete(key);
            }
        }
        saveBotStateToDisk();
    } catch (e) {
        console.error("❌ Lỗi nghiêm trọng trong tiến trình đối soát Reconciliation:", e.message);
    }
}

// ====================================================================
// [CORE SYSTEM INITS] INITIALIZATION & SIGNAL LISTENER
// ====================================================================
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    let walletData = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
    try {
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        const botUnrealizedPnL = Array.from(botActivePositions.values()).reduce((s, p) => s + (p.pnl || 0), 0);
        walletData = { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: botUnrealizedPnL.toFixed(2) };
    } catch (e) {}
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: walletData });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; saveBotStateToDisk(); res.json({ success: true }); });

async function init() {
    console.log(`[${new Date().toLocaleTimeString()}] 🔄 Khởi chạy hệ thống lõi hướng sự kiện...`);
    loadBotStateFromDisk(); 
    
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        serverTimeOffset = t.data.serverTime - Date.now();
        
        const posMode = await binanceRequest('GET', '/fapi/v1/positionSide/dual');
        status.isHedgeMode = posMode.dualSidePosition;

        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const brk = await binanceRequest('GET', '/fapi/v1/leverageBracket').catch(() => []);
        
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const minNotionalValue = notionalFilter ? parseFloat(notionalFilter.notional || notionalFilter.minNotional) : 5.0;

            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), minNotional: minNotionalValue, maxLeverage: b?.brackets[0]?.initialLeverage || 20 };
        });
        
        status.exchangeInfo = temp; 
        status.isReady = true; 
        
        await runPositionReconciliationEngine();
        await initWebSocketEngine();
        
        addBotLog(`🚀 [PRODUCTION READY] Khởi tạo thành công! Hệ thống vận hành độc lập, chống lag, bảo vệ an toàn.`);
    } catch (e) { 
        console.error("❌ Hệ thống khởi tạo thất bại:", e.message); 
        setTimeout(init, 5000); 
    }
}
init();

// [FIX 1 OK] CHUYỂN TOÀN BỘ LOGIC ATOMIC LOCK VÀO TRONG MUTEX QUEUE CỦA SYMBOL ĐỂ PHÁT HÀNH AN TOÀN TUYỆT ĐỐI
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size >= botSettings.maxPositions || openingSymbols.size > 0) return;

    const can = status.candidatesList.find(c => {
        const info = status.exchangeInfo[c.symbol];
        if (!info || info.maxLeverage < 20) return false;
        if (Math.abs(c.c1) < botSettings.minVol) return false;
        if (status.blackList[c.symbol]) return false;

        const targetSideKey = `${c.symbol}_${c.c1 > 0 ? 'LONG' : 'SHORT'}`;
        return !botActivePositions.has(targetSideKey);
    });

    if (can) {
        const targetSide = can.c1 > 0 ? 'LONG' : 'SHORT';
        
        // Bao bọc toàn diện, check và đóng dấu chiếm dụng tài nguyên bất đối xứng tại đây
        runLocked(can.symbol, async () => {
            const targetSideKey = `${can.symbol}_${targetSide}`;
            if (botActivePositions.has(targetSideKey) || openingSymbols.has(can.symbol)) return;
            
            if (botActivePositions.size >= botSettings.maxPositions) return;

            openingSymbols.add(can.symbol);
            console.log(`🎯 [ATOMIC TRIGGER] Tiến trình khóa Symbol và phân phối lệnh cho ${can.symbol} [${targetSide}]`);
            try {
                await openPosition(can.symbol, targetSide === 'LONG' ? { isFinalLong: true, side: 'LONG', dcaCount: 0 } : null);
            } finally {
                openingSymbols.delete(can.symbol);
            }
        });
    }
}, 3000);

setInterval(() => {
    const now = Date.now();
    for (const s in status.blackList) {
        if (status.blackList[s] < now) {
            delete status.blackList[s];
            console.log(`🧹 [CLEANUP] Giải phóng token ${s} ra khỏi Blacklist.`);
        }
    }
}, 60000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

APP.listen(9001);
