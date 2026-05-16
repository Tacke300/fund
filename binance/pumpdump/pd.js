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
let openingSymbols = new Set();     // Isolated Symbol Lock (Phá bỏ Global Lock)
let symbolMutexes = new Map();      // Mutex Queue chống Race Condition cho từng Symbol
let serverTimeOffset = 0;
let listenKey = null;
let wsInstance = null;

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

// SYMBOL MUTEX QUEUE: Đảm bảo các tác vụ vào lệnh/DCA của cùng một Symbol chạy tuần tự tuyệt đối
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
// [CORE] NETWORKING & BINANCE CORE REQUEST
// ====================================================================
async function binanceRequest(method, endpoint, data = {}) {
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
// [WEBSOCKET] USER DATA STREAM & MARK PRICE STREAM
// ====================================================================
async function initWebSocketEngine() {
    try {
        if (wsInstance) {
            wsInstance.terminate();
            wsInstance = null;
        }

        // Khởi tạo listenKey qua REST API công khai
        const res = await binanceRequest('POST', '/fapi/v1/listenKey');
        listenKey = res.listenKey;

        // Kênh Stream kết hợp: Lắng nghe Account Update + Realtime Mark Price toàn sàn (3s đẩy 1 lần hoặc @1s tùy cấu hình)
        // Sử dụng stream !markPrice@arr để quét markPrice toàn sàn với tần suất cao mà không cần sub từng cặp
        wsInstance = new WebSocket(`wss://fstream.binance.com/stream?streams=${listenKey}/!markPrice@arr`);

        wsInstance.on('open', () => {
            console.log('🔌 [WEBSOCKET] Kết nối thành công Engine sự kiện Binance Futures.');
        });

        wsInstance.on('message', (rawData) => {
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
            console.log('🚨 WebSocket Engine bị đóng ngắt. Tiến hành tái khởi động sau 4 giây...');
            setTimeout(initWebSocketEngine, 4000);
        });

    } catch (e) {
        console.error('❌ Không thể kích hoạt WebSocket Engine, thử lại sau 5 giây...', e.message);
        setTimeout(initWebSocketEngine, 5000);
    }
}

// Gia hạn tuổi thọ listenKey định kỳ mỗi 20 phút tránh đứt kết nối ngầm
setInterval(async () => {
    if (listenKey) {
        await binanceRequest('PUT', '/fapi/v1/listenKey').catch(() => {
            console.log('⚠️ Gia hạn listenKey thất bại, ép re-init WS...');
            initWebSocketEngine();
        });
    }
}, 20 * 60 * 1000);

// XỬ LÝ SỰ KIỆN TÀI KHOẢN (EVENT-DRIVEN MONITORING)
function handleUserDataEvent(e) {
    // 1. Cập nhật trạng thái số dư và vị thế realtime khi có lệnh khớp hoặc dịch chuyển phí funding
    if (e.e === 'ACCOUNT_UPDATE') {
        const positions = e.a.P;
        for (const p of positions) {
            const key = `${p.s}_${p.ps}`;
            if (botActivePositions.has(key)) {
                const b = botActivePositions.get(key);
                const currentAmt = Math.abs(parseFloat(p.pa));
                
                if (currentAmt === 0) {
                    // Vị thế đã được triệt tiêu hoàn toàn trên sàn
                    console.log(`📡 [WS EVENT] Phát hiện vị thế của ${p.s} (${p.ps}) đã biến mất trên sàn.`);
                    executePositionClosureAccounting(p.s, p.ps, key, b);
                } else {
                    // Vị thế được update thêm khối lượng (Ví dụ dính DCA hoặc chốt gốc từng phần)
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
    
    // 2. Lắng nghe sự kiện Khớp lệnh để bắt trạng thái TP/SL treo sàn (NEW -> FILLED / EXPIRED)
    if (e.e === 'ORDER_TRADE_UPDATE') {
        const o = e.o;
        if (['FILLED', 'EXPIRED', 'CANCELED'].includes(o.X)) {
            const key = `${o.s}_${o.ps}`;
            if (botActivePositions.has(key) && ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.o)) {
                console.log(`📡 [WS EVENT] Lệnh bảo vệ dạng ${o.o} của token ${o.s} đã chuyển trạng thái sang [${o.X}]. Kích hoạt hậu kiểm tra...`);
                // Khi có 1 lệnh TP hoặc SL dính, tiến hành kiểm tra dọn dẹp hoặc đối soát lại ngay lập tức
                runLocked(o.s, async () => {
                    await verifyOpenOrdersOnChain(o.s, o.ps);
                });
            }
        }
    }
}

// XỬ LÝ SỰ KIỆN GIÁ CẬP NHẬT TOÀN DIỆN (Thay thế REST priceMonitor Loop)
function handleGlobalMarkPriceEvent(dataArr) {
    if (!status.isReady) return;
    
    for (const item of dataArr) {
        const symbol = item.s;
        const currentMarkPrice = parseFloat(item.p);
        
        // Quét nhanh xem trong danh sách quản lý có cặp nào khớp symbol không
        const longKey = `${symbol}_LONG`;
        const shortKey = `${symbol}_SHORT`;
        
        if (botActivePositions.has(longKey)) processSoftwareTriggerForPrice(longKey, currentMarkPrice);
        if (botActivePositions.has(shortKey)) processSoftwareTriggerForPrice(shortKey, currentMarkPrice);
    }
}

async function processSoftwareTriggerForPrice(key, markP) {
    const b = botActivePositions.get(key);
    if (!b || b.tpSlMode !== 3) return; // Chỉ áp dụng xử lý cho các vị thế đang kích hoạt tầng cứu hộ mềm PP3

    let triggerFailsafe = false;
    if (b.side === 'SHORT') {
        b.priceDev = ((b.entryPrice - markP) / b.entryPrice) * 100;
        if (markP <= b.tp || markP >= b.sl) triggerFailsafe = true;
    } else if (b.side === 'LONG') {
        b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
        if (markP >= b.tp || markP <= b.sl) triggerFailsafe = true;
    }

    if (triggerFailsafe) {
        // Chuyển tác vụ vào hàng đợi Mutex của Symbol tránh tranh chấp luồng dữ liệu dính DCA chéo
        runLocked(b.symbol, async () => {
            const stillExists = botActivePositions.get(key);
            if (stillExists && stillExists.tpSlMode === 3) {
                addBotLog(`🎯 [PP3 WS TRIGGER] Vị thế ${b.symbol} (${b.side}) chạm mốc cắt lỗ/chốt lời mềm tại giá Mark: ${markP}. Gọi khẩn cấp MARKET Close...`);
                const closed = await closePositionMarket(b, "PP3_WS_SOFTWARE_EXECUTION");
                if (closed) {
                    botActivePositions.delete(key);
                    saveBotStateToDisk();
                }
            }
        });
    }
}

// XỬ LÝ KẾT TOÁN TÀI KHOẢN SAU KHI VỊ THẾ BIẾN MẤT
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
            status.blackList[symbol] = Date.now() + (15 * 60 * 1000); // Phạt khóa 15 phút tránh fomo vào lại
            addBotLog(`💰 [KẾT QUẢ: WIN] Đã chốt lời ${symbol} [${b.side}] | PnL thực tế: ${totalR.toFixed(2)}$`, 'success');
        } else {
            addBotLog(`❌ [KẾT QUẢ: LOSS] Vị thế ${symbol} [${b.side}] dính SL lỗ: ${totalR.toFixed(2)}$`);
            
            // DÙNG MARK PRICE ĐỂ TÍNH TOÁN KHOẢNG CÁCH DCA CHUẨN XÁC, BỎ TICKER PRICE
            const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
            const targetRisk = freshRisk.find(x => x.positionSide === positionSideParam);
            const currentPrice = targetRisk ? parseFloat(targetRisk.markPrice) : b.entryPrice;
            
            const distance = b.side === 'SHORT' ? currentPrice - b.firstEntry : b.firstEntry - currentPrice;
            botActivePositions.delete(key);

            if (distance > 0) {
                const jump = Math.max(b.dcaCount + 1, Math.floor(distance / (b.firstEntry * botSettings.posSL / 100)));
                if (jump <= botSettings.maxDCA) {
                    addBotLog(`🔄 [HÀNH ĐỘNG DCA] Kích hoạt DCA Cấp [${jump}/${botSettings.maxDCA}] cho ${symbol} [${b.side}].`);
                    await openPosition(symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                } else {
                    // QUAY XE MỞ VỊ THẾ NGƯỢC LẠI HOÀN TOÀN TRONG CHẾ ĐỘ HEDGE MODE ĐỂ PHÒNG VỆ
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
// [CORE ACTION] EXECUTION FUNCTIONS (OPEN / CLOSE / RECONCILIATION)
// ====================================================================

// FIX TRIỆT ĐỂ LỖI FLOATING PRECISION & QUANTITY STALE TRONG SÀN THỰC CHIẾN PP4
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
        const finalExactQty = Number((Math.floor(freshQty / info.stepSize) * info.stepSize).toFixed(precision));

        if (finalExactQty <= 0) return true;

        const res = await binanceRequest('POST', '/fapi/v1/order', {
            symbol: pos.symbol,
            side: sideClose,
            positionSide: positionSideParam,
            type: 'MARKET',
            quantity: finalExactQty
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
    if (openingSymbols.has(symbol)) return; // Isolated Local Symbol Lock
    
    openingSymbols.add(symbol);
    
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
        
        // Quét lấy giá Mark chuẩn xác cho vị thế Futures
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
        const symbolRisk = freshRisk.find(x => x.positionSide === positionSideParam) || freshRisk[0];
        const price = symbolRisk ? parseFloat(symbolRisk.markPrice) : 0;
        
        if (price === 0) throw new Error("Không thể lấy Mark Price để tính toán cấu trúc khối lượng.");
        
        let rawQty = (margin * info.maxLeverage) / price;
        const precision = getPrecision(info.stepSize);
        let qty = Number((Math.floor(rawQty / info.stepSize) * info.stepSize).toFixed(precision));
        if (qty <= 0) qty = info.stepSize;

        if (!leverageCache.has(symbol)) {
            await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: info.maxLeverage }).catch(() => {});
            leverageCache.add(symbol);
        }
        
        console.log(`[1/3] Đẩy lệnh MARKET mở vị thế on-chain...`);
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol, side: orderSideParam, positionSide: positionSideParam, type: 'MARKET', quantity: qty });
        
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
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0, tpSlMode: null 
                };
                
                botActivePositions.set(`${symbol}_${positionSideParam}`, currentLocalPosition);
                saveBotStateToDisk();
                
                // Gọi quy trình đồng bộ hóa TP/SL đa tầng chống lỗi Engine rách lưới bảo vệ
                await cascadeSyncTPSL(symbol, side, info, tp, sl);
            }
        }
    } catch (e) { 
        addBotLog(`❌ [LỖI THỰC THI] Không thể mở vị thế ${symbol}: ${e.msg || e.message}`, 'error'); 
    } finally { 
        openingSymbols.delete(symbol); 
    }
}

// ENGINE ĐỒNG BỘ HÓA TP/SL ĐA TẦNG THỰC CHIẾN (PP0 -> PP1 -> PP2 -> VERIFY -> RECONCILIATION -> PP3)
async function cascadeSyncTPSL(symbol, side, info, tp, sl) {
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const sideClose = (side === 'SHORT') ? 'BUY' : 'SELL';
    const localPosKey = `${symbol}_${positionSideParam}`;
    
    let localData = botActivePositions.get(localPosKey);
    if (!localData) return;

    // DỌN SẠCH TOÀN BỘ LỆNH ĐIỀU KIỆN MỒ CÔI HOẶC TREO CŨ TRƯỚC KHI ĐỒNG BỘ
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

    // ====================================================================
    // [PP0] TẦNG 0 — BATCH ORDERS SYSTEM (ENCODE URL CHỐNG PARSE NGẦM)
    // ====================================================================
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

    // ====================================================================
    // [PP1] TẦNG 1 — NATIVE CLOSEPOSITION ĐƠN LẺ
    // ====================================================================
    if (!verifiedOnChain) {
        const marketParams = { symbol, side: sideClose, positionSide: positionSideParam, closePosition: 'true', workingType: 'CONTRACT_PRICE' };
        try {
            await binanceRequest('POST', '/fapi/v1/order', { ...marketParams, type: 'TAKE_PROFIT_MARKET', stopPrice: targetTPPrice }).catch(() => null);
            await binanceRequest('POST', '/fapi/v1/order', { ...marketParams, type: 'STOP_MARKET', stopPrice: targetSLPrice }).catch(() => null);
            
            verifiedOnChain = await verifyOpenOrdersOnChain(symbol, positionSideParam);
            if (verifiedOnChain) localData.tpSlMode = 1;
        } catch (err) {}
    }

    // ====================================================================
    // [PP2] TẦNG 2 — QUANTITY MARKET TRIGGER (BỎ HOÀN TOÀN REDUCEONLY)
    // ====================================================================
    if (!verifiedOnChain) {
        // Loại bỏ hoàn toàn bẫy lỗi -2022 bằng cách đồng bộ quantity chuẩn xác thay vì gài tham số giảm vị thế trong Hedge Mode
        const triggerParams = { symbol, side: sideClose, positionSide: positionSideParam, quantity: localData.currentQty, workingType: 'CONTRACT_PRICE' };
        try {
            await binanceRequest('POST', '/fapi/v1/order', { ...triggerParams, type: 'TAKE_PROFIT_MARKET', stopPrice: targetTPPrice }).catch(() => null);
            await binanceRequest('POST', '/fapi/v1/order', { ...triggerParams, type: 'STOP_MARKET', stopPrice: targetSLPrice }).catch(() => null);
            
            verifiedOnChain = await verifyOpenOrdersOnChain(symbol, positionSideParam);
            if (verifiedOnChain) localData.tpSlMode = 2;
        } catch (err) {}
    }

    // ====================================================================
    // ĐỐI SOÁT CUỐI - EMERGENCY CLEANUP & CHUYỂN SANG PP3 PHẦN MỀM BỀN VỮNG
    // ====================================================================
    if (!verifiedOnChain) {
        addBotLog(`🚨 [HẠ CẤP BẢO VỆ] Hệ thống API điều kiện lỗi/hủy ngầm. Tiến hành xóa dọn lệnh rách bảo hiểm cứu hộ vị thế ${symbol}...`, 'warning');
        try {
            const openOrders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
            const activeTriggers = openOrders.filter(o => o.positionSide === positionSideParam && ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.type));
            for (const o of activeTriggers) {
                await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId }).catch(() => null);
            }
        } catch (e) {}

        localData.tpSlMode = 3; // Kích hoạt RAM + WS Stream Realtime Protection 
        addBotLog(`🚨 Vị thế ${symbol} [${positionSideParam}] chuyển sang bảo vệ cấp 3 (Software Persistent)`, 'warning');
    }

    botActivePositions.set(localPosKey, localData);
    saveBotStateToDisk();

    // ====================================================================
    // TẦNG 4 — BIỆN PHÁP CUỐI CÙNG: CƯỠNG CHẾ ĐÓNG LỆNH MARKET (FIX LOGIC BẢO VỆ 0)
    // ====================================================================
    const finalVerify = botActivePositions.get(localPosKey);
    const safeModes = [0, 1, 2, 3]; // Mảng chế độ hợp lệ. Tuyệt đối không tự cắt bừa bãi lệnh của Tầng 0.

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
        // LỌC CHẶT CHẼ TRẠNG THÁI STATUS === NEW ĐỂ TRÁNH ENGINE SÀN REJECT NGẦM SAU KHI PHÁT HÀNH ID LỆNH
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

// POSITION RECONCILIATION ENGINE: Đối soát thực tế trạng thái tài khoản ngay khi khởi động lại bot
async function runPositionReconciliationEngine() {
    addBotLog("🔍 [RECONCILIATION] Bắt đầu kích hoạt tiến trình đối soát trạng thái thực tế toàn sàn...");
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        
        // Quét tất cả vị thế có khối lượng thực tế đang treo trên Binance
        const activeOnChainPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        for (const p of activeOnChainPositions) {
            const key = `${p.s}_${p.ps}`;
            const currentAmt = Math.abs(parseFloat(p.positionAmt));
            
            if (!botActivePositions.has(key)) {
                // Vị thế mồ côi trên sàn xuất hiện do bot tắt trong lúc dính DCA rách lưới
                addBotLog(`🚨 [ĐỐI SOÁT PHÁT HIỆN SAI LỆCH] Tìm thấy vị thế lạ mồ côi không có quản trị: ${p.s} [${p.ps}]. Thực thi Force Close...`, 'warning');
                const tempPos = { symbol: p.s, side: p.ps === 'BOTH' ? (parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT') : p.ps, currentQty: currentAmt };
                await closePositionMarket(tempPos, "RECONCILIATION_ORPHAN_FOUND");
            } else {
                // Vị thế có tồn tại trong File Persistent State, tiến hành hậu kiểm tra cặp TP/SL
                const b = botActivePositions.get(key);
                b.currentQty = currentAmt;
                b.entryPrice = parseFloat(p.entryPrice);
                botActivePositions.set(key, b);
                
                const info = status.exchangeInfo[p.s];
                if (info) {
                    console.log(`🛡️ [ĐỐI SOÁT SYSTEM] Khôi phục lưới bảo hiểm đa tầng thành công cho vị thế ${p.s}_${p.ps}`);
                    await cascadeSyncTPSL(p.s, b.side, info, b.tp, b.sl);
                }
            }
        }
        
        // Ngược lại: Nếu trong file cache RAM báo có vị thế nhưng đối soát trên sàn trống trơn
        for (const [key, b] of botActivePositions.entries()) {
            const match = activeOnChainPositions.find(p => `${p.s}_${p.ps}` === key);
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
    loadBotStateFromDisk(); // Nạp lại file lưu trữ trạng thái từ Disk
    
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
        
        // 1. Đồng bộ và đối soát cấu trúc thực tế giữa file Persistent và Sàn giao dịch
        await runPositionReconciliationEngine();
        
        // 2. Kích hoạt động cơ bắt sự kiện WebSocket Engine toàn diện thay thế REST cũ
        await initWebSocketEngine();
        
        addBotLog(`🚀 [PRODUCTION READY] Khởi tạo thành công! Hệ thống vận hành độc lập, chống lag, bảo vệ an toàn.`);
    } catch (e) { 
        console.error("❌ Hệ thống khởi tạo thất bại:", e.message); 
        setTimeout(init, 5000); 
    }
}
init();

// TÍN HIỆU QUÉT VÀO LỆNH (SCANNING ENGINE): 3 giây quét mảng Candidate 1 lần từ máy chủ phân tích
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size >= botSettings.maxPositions || openingSymbols.size > 0) return;

    const can = status.candidatesList.find(c => {
        const info = status.exchangeInfo[c.symbol];
        if (!info || info.maxLeverage < 20) return false;
        if (Math.abs(c.c1) < botSettings.minVol) return false;
        if (status.blackList[c.symbol]) return false;

        // TƯ DUY HEDGE MODE ĐÍNH THỰC: Cho phép mở LONG và SHORT cùng lúc độc lập trên một symbol
        // Chỉ cấm vào lệnh khi chính side đó (Ví dụ vị thế LONG của token đó) đang có lệnh treo sẵn
        const targetSideKey = `${c.symbol}_${c.c1 > 0 ? 'LONG' : 'SHORT'}`;
        return !botActivePositions.has(targetSideKey);
    });

    if (can) {
        const targetSide = can.c1 > 0 ? 'LONG' : 'SHORT';
        console.log(`🎯 [SIGNAL] Tìm thấy token phù hợp tiêu chí: ${can.symbol} [${targetSide}] (Vol: ${can.c1}). Điều phối luồng xử lý...`);
        // Đẩy thẳng vào hàng đợi Mutex độc lập của Symbol đó, không chiếm dụng tài nguyên hệ thống
        runLocked(can.symbol, async () => {
            await openPosition(can.symbol, targetSide === 'LONG' ? { isFinalLong: true, side: 'LONG', dcaCount: 0 } : null);
        });
    }
}, 3000);

// Giải phóng Blacklist định kỳ mỗi phút
setInterval(() => {
    const now = Date.now();
    for (const s in status.blackList) {
        if (status.blackList[s] < now) {
            delete status.blackList[s];
            console.log(`🧹 [CLEANUP] Giải phóng token ${s} ra khỏi Blacklist.`);
        }
    }
}, 60000);

// Đồng bộ mảng dữ liệu Candidate từ Local Analysis Node
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

APP.listen(9001);
