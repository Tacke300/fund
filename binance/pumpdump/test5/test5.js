// ============================================================================
// 1. KHAI BÁO THƯ VIỆN & CẤU HÌNH HỆ THỐNG
// ============================================================================
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MIN_NOTIONAL_FORCE = 5.5; 
const ANTI_LIQUIDATION_LIMIT = 15; 
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  

function formatPrice(num) {
    if (!num) return "0";
    let n = parseFloat(num);
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.01) return n.toFixed(5);
    return n.toPrecision(5).replace(/0+$/, '').replace(/\.$/, ''); 
}

let walletCache = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    masterLogs: []
};

let systemSettings = {
    isRunning: false,
    invValue: "1",
    maxPositions: 3,
    minVol: 7,
    diangucvol: 0,
    gridStepPercent: 1.0,
    heSoDCA: 1,
    tpPercent: 1.0,
    maxDcaBaseLevels: 100 
};

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        if (['tpPercent', 'gridStepPercent', 'heSoDCA', 'minVol', 'maxPositions', 'maxDcaBaseLevels'].includes(key)) {
            normalizedBody[key] = parseFloat(reqBody[key]);
        } else {
            normalizedBody[key] = reqBody[key];
        }
    }
    return { ...currentSettings, ...normalizedBody };
}

let systemBot = {
    id: "MASTER_BOT", startTime: Date.now(),
    status: { botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    activePairs: new Map(), 
    isProcessingLogic: new Set(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 60000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };
    sharedState.masterLogs.unshift(logItem);
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    console.log(`[${time}][${type.toUpperCase()}] ${msg}`);
}

function getPairProgressStr(pair, currentUnrealizedPnL) {
    const closedPnL = pair.closedNotesPnL;
    const totalPnL = closedPnL + currentUnrealizedPnL;
    const profitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;
    const progressPercent = profitTargetUSD > 0 ? (totalPnL / profitTargetUSD) * 100 : 0;
    return `[📊 PnL Đã Chốt: ${closedPnL.toFixed(2)}$ | Chưa Chốt: ${currentUnrealizedPnL.toFixed(2)}$ | Tổng: ${totalPnL.toFixed(2)}$ / T.G: ${profitTargetUSD.toFixed(2)}$ | Đạt: ${progressPercent.toFixed(1)}%]`;
}

// ============================================================================
// 2. KẾT NỐI API BINANCE PRIVATES
// ============================================================================
async function binancePrivate(endpoint, method = 'GET', data = {}, retryCount = 0) {
    try {
        const timestamp = Date.now() + systemBot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await systemBot.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021 && retryCount < 10) {
            try {
                const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
                systemBot.timestampOffset = t.data.serverTime - Date.now();
                return await binancePrivate(endpoint, method, data, retryCount + 1);
            } catch (syncError) { throw e; }
        }
        throw e;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const symbol in sharedState.blackList) {
        if (now > sharedState.blackList[symbol]) delete sharedState.blackList[symbol];
    }
}, 1000);

function checkAndAddBlacklist(symbol) {
    sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
    addLog(`🚫 Đã đưa ${symbol} vào Blacklist 15 phút. Giải tỏa vị thế...`, "warn");
    forceCloseSymbol(symbol, "ĐÓNG BLACKLIST").catch(() => {});
}

// ============================================================================
// 3. THỰC THI LỆNH VÀ ĐÓNG VỊ THẾ KHẨN CẤP
// ============================================================================
async function executeBatchOrder(symbol, positionSide, marginUSD, action, customQty = null) {
    if (marginUSD <= 0 && !customQty) return 0;
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return 0;

    try {
        const premiumIndex = await systemBot.binanceApi.get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
        const currentPrice = parseFloat(premiumIndex.data.markPrice);
        
        let qty = 0;
        if (customQty !== null) {
            qty = customQty;
        } else {
            qty = (marginUSD * info.maxLeverage) / currentPrice;
            qty = Math.floor(qty / info.stepSize) * info.stepSize;
            
            const actualMinNotional = Math.max(info.minNotional, MIN_NOTIONAL_FORCE);
            if (action === 'OPEN' && qty * currentPrice < actualMinNotional) {
                qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
        }
        
        if (qty <= 0) return 0;

        const orderSide = positionSide === 'LONG' ? (action === 'OPEN' ? 'BUY' : 'SELL') : (action === 'OPEN' ? 'SELL' : 'BUY');

        await systemBot.exchange.createOrder(symbol, 'MARKET', orderSide, qty.toFixed(info.quantityPrecision), undefined, { positionSide });
        return (qty * currentPrice) / info.maxLeverage;
    } catch (e) {
        addLog(`❌ Lệnh Market lỗi ${symbol}: ${e.message}`, "error");
        return 0;
    }
}

async function forceCloseSymbol(symbol, reasonStr) {
    let pairData = systemBot.activePairs.get(symbol);
    systemBot.activePairs.delete(symbol);

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => null);
        if (!posRisk) return;

        const closePromises = [];
        for (const p of posRisk) {
            const amt = parseFloat(p.positionAmt);
            if (Math.abs(amt) > 0) {
                const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                const pOrder = systemBot.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide })
                    .then(async (orderRes) => {
                        let closedPnL = 0;
                        for (let attempt = 1; attempt <= 5; attempt++) {
                            await new Promise(r => setTimeout(r, 400 * attempt));
                            try {
                                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, orderId: orderRes.id });
                                if (trades && trades.length > 0) {
                                    closedPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                                    break;
                                }
                            } catch {}
                        }
                        return closedPnL;
                    })
                    .catch((err) => {
                        addLog(`❌ Lỗi đóng ${p.positionSide} của ${symbol}: ${err.message}`, "error");
                        return 0;
                    });
                closePromises.push(pOrder);
            }
        }
        
        const settledResults = await Promise.all(closePromises);
        const totalRealizedPnL = settledResults.reduce((sum, val) => sum + val, 0);

        systemBot.status.botClosedCount++;
        systemBot.status.botPnLClosed += totalRealizedPnL;

        if (pairData) {
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG TỔNG ${symbol} | PnL Thực Tế: ${totalRealizedPnL.toFixed(2)}$`, totalRealizedPnL >= 0 ? "success" : "sl");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addLog(`❌ Lỗi đóng khẩn cấp tổng ${symbol}: ${e.message}`, "error");
    }
}

async function panicCloseAll(reasonLog) {
    try {
        const activeSymbols = Array.from(systemBot.activePairs.keys());
        for(let sym of activeSymbols) {
            await forceCloseSymbol(sym, reasonLog);
        }
        addLog(`⚠️ ĐÓNG TOÀN BỘ HỆ THỐNG: ${reasonLog}`, "warn");
        return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
}

// ============================================================================
// 4. ĐỘNG CƠ MONITOR CHÍNH: KHÓA TRÙNG ĐIỂM MỞ & ĐIỂM TP CỦA RIÊNG NOTE
// ============================================================================
async function priceMonitor() {
    if (!systemBot.status.isReady) return setTimeout(priceMonitor, 500);
    try {
        if (!systemSettings.isRunning) return setTimeout(priceMonitor, 500);
        
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(priceMonitor, 400);
        
        for (let [symbol, pair] of systemBot.activePairs) {
            if (systemBot.isProcessingLogic.has(symbol)) continue;
            
            if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol]) {
                systemBot.activePairs.delete(symbol);
                continue;
            }

            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide && Math.abs(parseFloat(p.positionAmt)) > 0);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide && Math.abs(parseFloat(p.positionAmt)) > 0);

            if (!gridPos && !dcaPos) {
                systemBot.activePairs.delete(symbol);
                checkAndAddBlacklist(symbol);
                continue;
            }

            systemBot.isProcessingLogic.add(symbol);

            try {
                const markP = parseFloat((gridPos || dcaPos).markPrice);
                const info = sharedState.exchangeInfo[symbol];

                // ----------------------------------------------------------------
                // LUỒNG 1: THỐNG KÊ VÀ TP TỔNG CẶP
                // ----------------------------------------------------------------
                let currentUnrealizedPnL = 0;
                if (gridPos) currentUnrealizedPnL += parseFloat(gridPos.unRealizedProfit || 0);
                if (dcaPos) currentUnrealizedPnL += parseFloat(dcaPos.unRealizedProfit || 0);

                const targetCheckCombinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
                const activeProfitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;
                if (targetCheckCombinedPnL >= activeProfitTargetUSD) {
                    addLog(`⚡ [TP TỔNG CẶP] ĐẠT MỤC TIÊU | ${symbol} | PnL: ${targetCheckCombinedPnL.toFixed(2)}$ >= Target: ${activeProfitTargetUSD.toFixed(2)}$`, "success");
                    systemBot.activePairs.delete(symbol);
                    sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                    forceCloseSymbol(symbol, `⚡ CHỐT LỜI TỔNG CẶP LỆNH (${targetCheckCombinedPnL.toFixed(2)}$)`).catch(()=>{});
                    systemBot.isProcessingLogic.delete(symbol);
                    continue;
                }

                // ----------------------------------------------------------------
                // LUỒNG 2: ĐỘNG CƠ GRID TOÁN HỌC (MỞ NOTE & LOCK ĐIỂM MỞ + TP)
                // ----------------------------------------------------------------
                const priceDiff = pair.firstEntryPrice - markP;
                const mathematicalTargetLevel = priceDiff >= 0 ? Math.floor(priceDiff / pair.stepUSD) : Math.ceil(priceDiff / pair.stepUSD);
                const requiredGridOrdersCount = Math.max(0, mathematicalTargetLevel) + 1; 

                // GIÁ XUỐNG: MỞ THÊM LƯỚI GỐC & TẠO NOTE KHÔNG GIỚI HẠN
                if (pair.currentGridCount < requiredGridOrdersCount) {
                    const diffCount = requiredGridOrdersCount - pair.currentGridCount;
                    for (let i = 0; i < diffCount; i++) {
                        pair.currentGridCount++;
                        
                        // Mở thêm 1 lưới Grid gốc
                        await executeBatchOrder(symbol, pair.gridSide, 0, 'OPEN', pair.baseQty);
                        pair.gridTotalMargin += pair.initialMargin;

                        const initialNoteMargin = pair.initialMargin * 5;
                        const initialNoteQty = pair.baseQty * 5;
                        await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', initialNoteQty);
                        pair.dcaTotalMargin += initialNoteMargin;

                        pair.totalNotesCreated++;

                        // Điểm TP ban đầu khi mới tạo Note
                        const initTpPrice = pair.dcaSide === 'LONG' ? markP + pair.stepUSD : markP - pair.stepUSD;

                        // Khởi tạo thực thể Note -> LOCK đồng thời cả Điểm mở ban đầu & Điểm TP ban đầu
                        const newNoteInstance = {
                            id: `Note_ID_${pair.totalNotesCreated}_${Date.now()}`,
                            noteIndex: pair.totalNotesCreated,
                            openPrice: markP,
                            dcaNoteAvg: markP,
                            lastDcaExecutedPrice: markP, 
                            dcaNoteQty: initialNoteQty,
                            dcaNoteMargin: initialNoteMargin,
                            dcaCount: 1,
                            isProcessing: false,
                            
                            // KHÓA ĐIỂM THEO YÊU CẦU:
                            lockedOpenPrice: markP,          // Lock cứng vùng giá mở ban đầu
                            lockedTpPrice: initTpPrice       // Lock cứng vùng giá TP ban đầu
                        };

                        pair.activeNotes.push(newNoteInstance);
                        addLog(`[GRID MỞ TẦNG] Tạo Note ${newNoteInstance.noteIndex} cho ${symbol} | Lock Điểm Mở: ${formatPrice(newNoteInstance.lockedOpenPrice)} | Lock Điểm TP: ${formatPrice(newNoteInstance.lockedTpPrice)}`, "open");
                    }
                }

                // GIÁ LÊN: ĐÓNG GIẢI PHÓNG LƯỚI GRID GỐC ĐỘC LẬP 
                if (pair.currentGridCount > requiredGridOrdersCount) {
                    const diffCount = pair.currentGridCount - requiredGridOrdersCount;
                    for (let i = 0; i < diffCount; i++) {
                        await executeBatchOrder(symbol, pair.gridSide, 0, 'CLOSE', pair.baseQty);
                        pair.gridTotalMargin = Math.max(pair.initialMargin, pair.gridTotalMargin - pair.initialMargin);
                        pair.currentGridCount--;
                        addLog(`[GRID THU HỒI] Giá hồi tăng -> Tự động đóng bớt 1 lưới Grid gốc của ${symbol}`, "warn");
                    }
                }

                // ----------------------------------------------------------------
                // LUỒNG 3: ĐỘNG CƠ QUẢN LÝ ĐA NOTE DCA (HỦY LOCK TP CŨ - LOCK LẠI THEO TP MỚI)
                // ----------------------------------------------------------------
                let notesToClose = [];
                let totalCloseQty = 0;

                for (let note of pair.activeNotes) {
                    if (note.isProcessing) continue;

                    // KIỂM TRA TP NOTE: Giá chạm điểm lockedTpPrice đang được Lock -> Đóng Note và giải phóng Lock
                    const isNoteHitTp = pair.dcaSide === 'LONG' ? markP >= note.lockedTpPrice : markP <= note.lockedTpPrice;
                    if (isNoteHitTp) {
                        note.isProcessing = true;
                        notesToClose.push(note);
                        totalCloseQty += note.dcaNoteQty;
                        continue;
                    }

                    // KIỂM TRA ĐI NGƯỢC HƯỚNG ĐỂ DCA NOTE ĐỀU: Tính khoảng cách từ điểm dca gần nhất (lastDcaExecutedPrice)
                    const isNoteGoingWrong = pair.dcaSide === 'LONG' 
                        ? (note.lastDcaExecutedPrice - markP >= pair.stepUSD) 
                        : (markP - note.lastDcaExecutedPrice >= pair.stepUSD);
                        
                    if (isNoteGoingWrong) {
                        note.isProcessing = true;

                        const dcaMarginAdded = note.dcaNoteMargin;
                        const dcaQtyAdded = note.dcaNoteQty;

                        await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQtyAdded);
                        pair.dcaTotalMargin += dcaMarginAdded;

                        // Tính toán lại giá trung bình thực tế của riêng Note
                        note.dcaNoteAvg = ((note.dcaNoteAvg * note.dcaNoteMargin) + (markP * dcaMarginAdded)) / (note.dcaNoteMargin + dcaMarginAdded);
                        
                        // Cập nhật lại điểm chặn dca gần nhất bằng giá thị trường vừa khớp thực tế
                        note.lastDcaExecutedPrice = markP; 
                        
                        note.dcaNoteMargin += dcaMarginAdded;
                        note.dcaNoteQty += dcaQtyAdded;
                        note.dcaCount++;

                        // SAU KHI DCA: Điểm mở ban đầu không còn lock -> Tiến hành HỦY Lock TP cũ và LOCK LẠI theo điểm TP mới
                        note.lockedTpPrice = pair.dcaSide === 'LONG' ? note.dcaNoteAvg + pair.stepUSD : note.dcaNoteAvg - pair.stepUSD;

                        addLog(`[DCA NOTE ĐỀU] Note ${note.noteIndex} của ${symbol} DCA lần ${note.dcaCount} tại giá ${formatPrice(markP)} | Giải phóng Lock cũ -> LOCK LẠI điểm TP dịch chuyển mới: ${formatPrice(note.lockedTpPrice)}`, "warn");

                        note.isProcessing = false;
                    }
                }

                // Khớp lệnh chốt gộp các Note đã giải phóng Lock TP thành công
                if (notesToClose.length > 0) {
                    const orderData = {
                        symbol: symbol,
                        side: pair.dcaSide === 'LONG' ? 'SELL' : 'BUY',
                        positionSide: pair.dcaSide,
                        type: 'MARKET',
                        quantity: totalCloseQty.toFixed(info.quantityPrecision)
                    };

                    const resDca = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch(e => {
                        addLog(`❌ Lệnh thanh khoản chốt Note lỗi ${symbol}: ${e.message}`, "error");
                        notesToClose.forEach(n => n.isProcessing = false);
                        return null;
                    });

                    if (resDca && resDca.orderId) {
                        const closedIds = notesToClose.map(n => n.id);
                        pair.activeNotes = pair.activeNotes.filter(n => !closedIds.includes(n.id));
                        pair.closedNotesCount += notesToClose.length;

                        (async () => {
                            let realPnL = 0;
                            for (let checkCount = 1; checkCount <= 5; checkCount++) {
                                await new Promise(r => setTimeout(r, 300 * checkCount));
                                try {
                                    const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, orderId: resDca.orderId });
                                    if (trades && trades.length > 0) {
                                        realPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                                        break;
                                    }
                                } catch {}
                            }
                            
                            pair.closedNotesPnL += realPnL;
                            const progressStr = getPairProgressStr(pair, currentUnrealizedPnL);
                            addLog(`[MỞ KHÓA THÀNH CÔNG] Đã chốt lời giải phóng Lock cho ${notesToClose.length} Note của ${symbol} | Thu về PnL: ${realPnL.toFixed(2)}$ | ${progressStr}`, "success");
                        })();
                    }
                }

                if (mathematicalTargetLevel >= systemSettings.maxDcaBaseLevels) {
                    await forceCloseSymbol(symbol, `CHẠM GIỚI HẠN TẦNG TỐI ĐA ${mathematicalTargetLevel}`);
                    checkAndAddBlacklist(symbol);
                }

            } catch(e) {
                addLog(`❌ Lỗi vòng lặp xử lý ${symbol}: ${e.message}`, "error");
            } finally {
                systemBot.isProcessingLogic.delete(symbol);
            }
        }
    } catch (e) { 
        addLog(`❌ Lỗi hàm toàn cục priceMonitor: ${e.message}`, "error");
    }
    setTimeout(priceMonitor, 400); 
}

// ============================================================================
// ĐỘNG CƠ FAST TP MONITOR SIÊU TỐC ĐỘ 250MS
// ============================================================================
async function fastTpMonitor() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return setTimeout(fastTpMonitor, 250);

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(fastTpMonitor, 250);

        for (let [symbol, pair] of systemBot.activePairs) {
            if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol]) continue;

            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide);

            let currentUnrealizedPnL = 0;
            if (gridPos && Math.abs(parseFloat(gridPos.positionAmt || 0)) > 0) {
                currentUnrealizedPnL += parseFloat(gridPos.unRealizedProfit || 0);
            }
            if (dcaPos && Math.abs(parseFloat(dcaPos.positionAmt || 0)) > 0) {
                currentUnrealizedPnL += parseFloat(dcaPos.unRealizedProfit || 0);
            }

            const combinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
            const profitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;

            if (combinedPnL >= profitTargetUSD) {
                addLog(`⚡ [FAST TP] KÍCH HOẠT TỔNG PNL ĐẠT MỤC TIÊU | ${symbol} | PnL: ${combinedPnL.toFixed(2)}$ >= Target: ${profitTargetUSD.toFixed(2)}$`, "success");
                systemBot.activePairs.delete(symbol); 
                sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
                forceCloseSymbol(symbol, `⚡ FAST TP CHỐT TỔNG CẶP (${combinedPnL.toFixed(2)}$)`).catch(()=>{});
            }
        }
    } catch (e) {}
    
    setTimeout(fastTpMonitor, 250);
}

async function checkMarginLimits() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return;
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc && parseFloat(acc.totalMarginBalance) > 0) {
        const availPercent = (parseFloat(acc.availableBalance) / parseFloat(acc.totalMarginBalance)) * 100;
        if (availPercent <= ANTI_LIQUIDATION_LIMIT) { 
            await panicCloseAll(`KÍCH HOẠT CHỐNG THANH LÝ AN TOÀN TẠI MỨC KÝ QUỸ ${ANTI_LIQUIDATION_LIMIT}%`); 
            systemBot.isMarginProtected = false; 
            return; 
        }
        if (!systemBot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
            systemBot.isMarginProtected = true; addLog(`⚠️ Khả dụng hệ thống dưới ${MARGIN_PROTECT_LIMIT}%. Tạm dừng quét cặp mới!`, "warn");
        } else if (systemBot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            systemBot.isMarginProtected = false; addLog(`✅ Khả dụng khôi phục trên ${MARGIN_RECOVER_LIMIT}%. Tiếp tục mở quét cặp.`, "info");
        }
    }
}

// ============================================================================
// 5. MÁY CHỦ WEB API GIAO TIẾP VỚI DASHBOARD UI (PORT 1997)
// ============================================================================
function allowCors(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

const appServer = express(); 
appServer.use(allowCors); 
appServer.use(express.json()); 
appServer.use(express.static(__dirname, { index: false })); 

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'sever.html')));

async function buildStatusResponse() {
    const now = Date.now();
    if (now - walletCache.lastUpdate > 3000) {
        const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
        if (acc) {
            walletCache.data = { totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) };
            walletCache.lastUpdate = now;
        }
    }
    const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => []);
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }

    const activePairsFormatted = Array.from(systemBot.activePairs.values()).map(pair => {
        let pnl = 0;
        posRisk.forEach(pr => { if (pr.symbol === pair.symbol && Math.abs(parseFloat(pr.positionAmt)) > 0) pnl += parseFloat(pr.unRealizedProfit || 0); });
        return {
            ...pair,
            leverage: pair.leverage, 
            firstEntryPriceFormat: formatPrice(pair.firstEntryPrice),
            unrealizedPnL: pnl.toFixed(2),
            activeNotesCount: pair.activeNotes.length
        };
    });

    return { 
        botSettings: systemSettings, 
        activePositions: activePairsFormatted, 
        exchangePositions: posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => ({...p, entryPriceFormat: formatPrice(p.entryPrice)})), 
        status: { botLogs: sharedState.masterLogs, botClosedCount: systemBot.status.botClosedCount, botPnLClosed: systemBot.status.botPnLClosed, isReady: systemBot.status.isReady, candidatesList: sharedState.candidatesList, blackList: formattedBlacklist }, 
        wallet: walletCache.data
    };
}

appServer.post('/api/settings', (req, res) => {
    systemSettings = parseNormalizedSettings(req.body, systemSettings);
    res.json({ success: true, msg: "Cập nhật cấu hình thành công!" });
});

appServer.get('/api/status', async (req, res) => {
    res.json(await buildStatusResponse());
});

appServer.post('/api/close_all', async (req, res) => res.json(await panicCloseAll("PANIC CLOSE TỪ DASHBOARD UI")));

appServer.post('/api/close_position', async (req, res) => { 
    const { symbol } = req.body; 
    await forceCloseSymbol(symbol, "ĐÓNG THỦ CÔNG TỪ UI");
    res.json({ success: true });
});

// ============================================================================
// 6. KHỞI CHẠY HỆ THỐNG VÀ VÒNG LẶP SỰ KIỆN CHÍNH (LỌC LEVERAGE >= 20)
// ============================================================================
async function init() {
    try {
        await systemBot.exchange.loadMarkets();
        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(()=>{});

        const info = await systemBot.binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol); 
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            
            if (maxLev < 20) { sharedState.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        systemBot.status.isReady = true;
        priceMonitor(); 
        fastTpMonitor(); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(async () => {
    await checkMarginLimits();
    if (!systemBot.status.isReady || !systemSettings.isRunning || systemBot.isMarginProtected) return;
    if (systemBot.activePairs.size >= systemSettings.maxPositions) return;

    let entrySignal = null;
    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
        if (systemBot.activePairs.has(c.symbol)) continue;

        const m1 = parseFloat(c.c1 || 0);
        const m5 = parseFloat(c.c5 || 0);
        if (Math.abs(m1) >= systemSettings.minVol || Math.abs(m5) >= systemSettings.minVol) {
            entrySignal = { symbol: c.symbol, gridSide: 'LONG', dcaSide: 'SHORT' };
            break;
        }
    }

    if (entrySignal) {
        const symbol = entrySignal.symbol;
        if (systemBot.isProcessingLogic.has(symbol)) return;

        const info = sharedState.exchangeInfo[symbol];
        if (!info) return;

        const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
        if (!acc) return; 
        const snapshotAvailable = parseFloat(acc.availableBalance || 0);

        const marginSetting = systemSettings.invValue;
        let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

        systemBot.isProcessingLogic.add(symbol);
        try {
            try { await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }); } catch (e) {}

            await systemBot.exchange.setLeverage(info.maxLeverage, symbol).catch(()=>{});

            const premiumIndex = await systemBot.binanceApi.get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
            const startPrice = parseFloat(premiumIndex.data.markPrice);

            const actualMinNotional = Math.max(info.minNotional, MIN_NOTIONAL_FORCE);
            let targetQty = (calculatedMargin * info.maxLeverage) / startPrice;
            targetQty = Math.floor(targetQty / info.stepSize) * info.stepSize;
            
            if (targetQty * startPrice < actualMinNotional) {
                targetQty = Math.ceil((actualMinNotional / startPrice) / info.stepSize) * info.stepSize;
            }

            const gridMargin = await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'OPEN', targetQty);
            const dcaMargin = await executeBatchOrder(symbol, entrySignal.dcaSide, 0, 'OPEN', targetQty);

            if (gridMargin <= 0 || dcaMargin <= 0) {
                throw new Error("Không khởi tạo được vị thế phân bổ từ sàn.");
            }

            systemBot.activePairs.set(symbol, {
                symbol: symbol,
                gridSide: entrySignal.gridSide,
                dcaSide: entrySignal.dcaSide,
                firstEntryPrice: startPrice,
                initialMargin: gridMargin, 
                baseQty: targetQty, 
                leverage: info.maxLeverage, 
                stepUSD: startPrice * (systemSettings.gridStepPercent / 100),
                currentGridCount: 1, 
                activeNotes: [],
                totalNotesCreated: 0, 
                closedNotesCount: 0,
                closedNotesPnL: 0,
                gridTotalMargin: gridMargin,
                dcaTotalMargin: dcaMargin,
                createdAt: Date.now()
            });

            addLog(`🚀 HỆ THỐNG VÀO LỆNH GỐC CẶP | ${symbol} | Đòn bẩy: x${info.maxLeverage} | Vốn Grid: ${gridMargin.toFixed(2)}$`, "open");
        } catch (e) {
            addLog(`❌ Lỗi vào lệnh gốc ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1997, () => console.log('🚀 [HEDGE SYSTEM V5] Khởi chạy hoàn chỉnh trên Port 1997!'));
