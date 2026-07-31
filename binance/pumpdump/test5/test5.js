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
const ANTI_LIQUIDATION_LIMIT = 10; 
const FEE_RATE = 0.0005;

// Cấu hình tạm dừng theo Margin (Yêu cầu 5 & 7)
const NOTE_PAUSE_THRESHOLD = 25;   // Dưới 25% dừng mở note mới
const NOTE_RESUME_THRESHOLD = 35;  // Trên 35% mở note trở lại
const DCA_PAUSE_THRESHOLD = 20;    // Dưới 20% dừng nhồi note
const DCA_RESUME_THRESHOLD = 25;   // Trên 25% cho nhồi note trở lại

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
    invValue: "0.1%",
    maxPositions: 9999,
    minVol: 1,
    gridStepPercent: 1.0,
    heSoDCA: 1,
    tpPercent: 3.0,
    maxDcaBaseLevels: 100,
    heSoMoNote: 5,          
    heSoNhoiNote: 0.2,        
    stopLossMulti: 100,     
    marginProtect: 60,      
    marginRecover: 70       
};

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        if (['tpPercent', 'gridStepPercent', 'heSoDCA', 'minVol', 'maxPositions', 'maxDcaBaseLevels', 'heSoMoNote', 'heSoNhoiNote', 'stopLossMulti', 'marginProtect', 'marginRecover'].includes(key)) {
            normalizedBody[key] = parseFloat(reqBody[key]);
        } else {
            normalizedBody[key] = reqBody[key];
        }
    }
    return { ...currentSettings, ...normalizedBody };
}

let systemBot = {
    id: "MASTER_BOT", 
    startTime: Date.now(),
    pauseUntil: 0,
    status: { botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    activePairs: new Map(), 
    isProcessingLogic: new Set(), 
    timestampOffset: 0, 
    isMarginProtected: false,
    isNotePaused: false, // Flag cờ dừng Note
    isDcaPaused: false,  // Flag cờ dừng DCA
    globalPosRisk: [], 
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
    const profitTargetUSD = (parseFloat(systemSettings.tpPercent) * pair.initialMargin) + pair.accumulatedFees;
    const progressPercent = profitTargetUSD > 0 ? (totalPnL / profitTargetUSD) * 100 : 0;
    return `[Lãi: ${closedPnL.toFixed(2)}$ | Treo: ${currentUnrealizedPnL.toFixed(2)}$ | TỔNG: ${totalPnL.toFixed(2)}$/${profitTargetUSD.toFixed(2)}$ (${progressPercent.toFixed(1)}%)]`;
}

// ============================================================================
// CÁC HÀM QUẢN LÝ LOCK NOTE RIÊNG BIỆT (YÊU CẦU 1 & 4)
// ============================================================================
function checkLock(pair, side, level) {
    const lockObj = side === 'LONG' ? pair.lockedLevelsLong : pair.lockedLevelsShort;
    const lockVal = lockObj[level];
    if (!lockVal) return false; // Không có lock
    if (lockVal === true) return true; // Đang lock vĩnh viễn (khi vừa mở)
    if (Date.now() < lockVal) return true; // Đang trong thời gian 5s delay
    
    // Nếu quá hạn 5s thì xóa lock và trả về false
    delete lockObj[level];
    return false;
}

function setLock(pair, side, level) {
    const lockObj = side === 'LONG' ? pair.lockedLevelsLong : pair.lockedLevelsShort;
    lockObj[level] = true;
}

function setUnlockDelay(pair, side, level) {
    const lockObj = side === 'LONG' ? pair.lockedLevelsLong : pair.lockedLevelsShort;
    lockObj[level] = Date.now() + 5000; // Đánh dấu 5s sau mới mở
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
    addLog(`🚫 [${symbol}] Đã đưa vào Blacklist 15 phút. Giải tỏa vị thế...`, "warn");
    forceCloseSymbol(symbol, "ĐÓNG BLACKLIST").catch(() => {});
}

// ============================================================================
// 3. THỰC THI LỆNH VÀ ĐÓNG VỊ THẾ KHẨN CẤP
// ============================================================================
async function getNetPnLFromOrder(symbol, orderId) {
    if (!orderId) return { realPnL: 0, customFee: 0, netPnL: 0, totalQtyExecuted: 0, execVol: 0 };
    let realPnL = 0;
    let totalVol = 0;
    let totalQtyExecuted = 0;
    let execVol = 0;
    for (let checkCount = 1; checkCount <= 8; checkCount++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, orderId });
            if (trades && trades.length > 0) {
                realPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                execVol = trades.reduce((sum, t) => sum + (parseFloat(t.qty) * parseFloat(t.price)), 0);
                totalQtyExecuted = trades.reduce((sum, t) => sum + parseFloat(t.qty), 0);
                totalVol = execVol * 2;
                break;
            }
        } catch (e) {}
    }
    let customFee = totalVol * 0.0005; 
    return { realPnL, customFee, netPnL: realPnL - customFee, totalQtyExecuted, execVol };
}

async function executeBatchOrder(symbol, positionSide, marginUSD, action, customQty = null) {
    if (marginUSD <= 0 && !customQty) return { qty: 0, margin: 0, price: 0, orderId: null };
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return { qty: 0, margin: 0, price: 0, orderId: null };

    try {
        const premiumIndex = await systemBot.binanceApi.get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
        const currentPrice = parseFloat(premiumIndex.data.markPrice);
        
        let qty = 0;
        if (customQty !== null) {
            qty = customQty;
            const actualMinNotional = Math.max(info.minNotional, MIN_NOTIONAL_FORCE);
            if (action === 'OPEN' && qty * currentPrice < actualMinNotional) {
                qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
        } else {
            qty = (marginUSD * info.maxLeverage) / currentPrice;
            qty = Math.floor(qty / info.stepSize) * info.stepSize;
            
            const actualMinNotional = Math.max(info.minNotional, MIN_NOTIONAL_FORCE);
            if (action === 'OPEN' && qty * currentPrice < actualMinNotional) {
                qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
        }
        
        if (qty <= 0) return { qty: 0, margin: 0, price: 0, orderId: null };

        const orderSide = positionSide === 'LONG' ? (action === 'OPEN' ? 'BUY' : 'SELL') : (action === 'OPEN' ? 'SELL' : 'BUY');
        const orderRes = await systemBot.exchange.createOrder(symbol, 'MARKET', orderSide, qty.toFixed(info.quantityPrecision), undefined, { positionSide });
        
        const actualMargin = (qty * currentPrice) / info.maxLeverage;
        return { qty: qty, margin: actualMargin, price: currentPrice, orderId: orderRes.id };
    } catch (e) {
        addLog(`❌ [${symbol}] Lệnh Market lỗi: ${e.message}`, "error");
        return { qty: 0, margin: 0, price: 0, orderId: null };
    }
}

async function forceCloseSymbol(symbol, reasonStr) {
    let pairData = systemBot.activePairs.get(symbol);
    systemBot.activePairs.delete(symbol);
    let totalNetPnL = 0;

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => null);
        if (!posRisk) return 0;

        const closePromises = [];
        for (const p of posRisk) {
            const amt = parseFloat(p.positionAmt);
            if (Math.abs(amt) > 0) {
                const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                const pOrder = systemBot.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide })
                    .then(async (orderRes) => {
                        const { netPnL } = await getNetPnLFromOrder(symbol, orderRes.id);
                        return netPnL;
                    })
                    .catch((err) => {
                        addLog(`❌ [${symbol}] Lỗi đóng ${p.positionSide}: ${err.message}`, "error");
                        return 0;
                    });
                closePromises.push(pOrder);
            }
        }
        
        const settledResults = await Promise.all(closePromises);
        totalNetPnL = settledResults.reduce((sum, val) => sum + val, 0);

        systemBot.status.botClosedCount++;
        systemBot.status.botPnLClosed += totalNetPnL;

        if (pairData) {
            addLog(`💲💲💲 [${symbol}] [${reasonStr}] ĐÓNG TỔNG | Lãi Thực Tế (Net PnL): ${totalNetPnL.toFixed(4)}$`, totalNetPnL >= 0 ? "success" : "error");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addLog(`❌ [${symbol}] Lỗi đóng khẩn cấp tổng: ${e.message}`, "error");
    }
    return totalNetPnL;
}

// Yêu cầu 6: Lock bot 1 phút, sau 15s quét sót vị thế
async function panicCloseAll(reasonLog) {
    try {
        let totalClosedPnL = 0;
        const activeSymbols = Array.from(systemBot.activePairs.keys());
        
        for (let sym of activeSymbols) {
            const pnl = await forceCloseSymbol(sym, reasonLog);
            totalClosedPnL += pnl;
            sharedState.blackList[sym] = Date.now() + (15 * 60 * 1000); 
        }

        systemBot.pauseUntil = Date.now() + 60000; // Tạm dừng 1 phút
        addLog(`⚠️ [CHỐNG THANH LÝ] ĐÃ ĐÓNG TOÀN BỘ HỆ THỐNG: ${reasonLog} | Tổng PnL Chốt: ${totalClosedPnL.toFixed(4)}$ | Tạm dừng bot 60s | Đã Blacklist toàn bộ ${activeSymbols.length} coin vừa đóng!`, "warn");
        
        // Quét lại vị thế sót sau 15s
        setTimeout(async () => {
            addLog(`🧹 Đang tiến hành quét kiểm tra vị thế sót sau Panic Close...`, "info");
            for (let sym of activeSymbols) {
                const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol: sym }).catch(() => null);
                if (posRisk) {
                    const hasLeftover = posRisk.some(p => Math.abs(parseFloat(p.positionAmt)) > 0);
                    if (hasLeftover) {
                        addLog(`⚠️ [${sym}] Phát hiện vị thế sót sau 15s Panic Close. Đang gửi lại lệnh đóng!`, "warn");
                        forceCloseSymbol(sym, "ĐÓNG VÉT VỊ THẾ SÓT").catch(()=>{});
                    }
                }
            }
        }, 15000);

        return { success: true, totalPnL: totalClosedPnL };
    } catch (e) { 
        return { success: false, msg: e.message }; 
    }
}

// ============================================================================
// 4. ĐỘNG CƠ MONITOR CHÍNH
// ============================================================================
async function priceMonitor() {
    if (!systemBot.status.isReady) return setTimeout(priceMonitor, 500);
    try {
        if (!systemSettings.isRunning) return setTimeout(priceMonitor, 500);
        if (systemBot.pauseUntil && Date.now() < systemBot.pauseUntil) return setTimeout(priceMonitor, 500);
        
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(priceMonitor, 400);
        
        systemBot.globalPosRisk = posRisk; 

        for (let [symbol, pair] of systemBot.activePairs) {
            if (systemBot.isProcessingLogic.has(symbol)) continue;
            
            if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol]) {
                systemBot.activePairs.delete(symbol);
                continue;
            }

            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide);

            const gridAmt = gridPos ? parseFloat(gridPos.positionAmt) : 0;
            const dcaAmt = dcaPos ? parseFloat(dcaPos.positionAmt) : 0;

            if (Math.abs(gridAmt) === 0 && Math.abs(dcaAmt) === 0) {
                systemBot.activePairs.delete(symbol);
                checkAndAddBlacklist(symbol);
                continue; 
            }

            systemBot.isProcessingLogic.add(symbol);

            try {
                const markP = parseFloat((gridPos && gridPos.markPrice) || (dcaPos && dcaPos.markPrice) || 0);
                if (markP === 0) {
                    systemBot.isProcessingLogic.delete(symbol);
                    continue;
                }

                let currentUnrealizedPnL = (gridPos ? parseFloat(gridPos.unRealizedProfit || 0) : 0) + (dcaPos ? parseFloat(dcaPos.unRealizedProfit || 0) : 0);
                const targetCheckCombinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
                let progressStr = getPairProgressStr(pair, currentUnrealizedPnL);

                // --- KIỂM TRA STOP LOSS ---
                const maxLossThreshold = -(systemSettings.stopLossMulti * pair.initialMargin);
                if (targetCheckCombinedPnL <= maxLossThreshold) {
                    addLog(`🛑 [${symbol}] [CẮT LỖ] PnL Tổng ${targetCheckCombinedPnL.toFixed(2)}$ chạm mức SL ${maxLossThreshold.toFixed(2)}$ (Lỗ x${systemSettings.stopLossMulti} lần margin)!`, "error");
                    systemBot.activePairs.delete(symbol);
                    sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                    forceCloseSymbol(symbol, `🛑 CẮT LỖ VỊ THẾ (${targetCheckCombinedPnL.toFixed(2)}$)`).catch(()=>{});
                    systemBot.isProcessingLogic.delete(symbol);
                    continue;
                }

                // --- 1. LUỒNG CHỐT LỜI TỔNG ---
                if (!pair.pnlLockUntil || Date.now() > pair.pnlLockUntil) {
                    const activeProfitTargetUSD = (parseFloat(systemSettings.tpPercent) * pair.initialMargin) + pair.accumulatedFees;
                    if (targetCheckCombinedPnL >= activeProfitTargetUSD) {
                        addLog(`⚡ [${symbol}] [TP TỔNG] PnL Đạt: ${targetCheckCombinedPnL.toFixed(2)}$ >= Mục Tiêu: ${activeProfitTargetUSD.toFixed(2)}$`, "success");
                        systemBot.activePairs.delete(symbol);
                        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                        forceCloseSymbol(symbol, `⚡ CHỐT TỔNG CẶP LỆNH (${targetCheckCombinedPnL.toFixed(2)}$)`).catch(()=>{});
                        systemBot.isProcessingLogic.delete(symbol);
                        continue;
                    }
                }

                // === 2. LUỒNG ĐỘNG CƠ THEO HƯỚNG DI CHUYỂN TẦNG (YÊU CẦU 3) ===
                const deviation = markP - pair.firstEntryPrice;
                let levelStr = 0;
                
                if (deviation > 0) {
                    levelStr = Math.floor(deviation / pair.stepUSD);
                } else if (deviation < 0) {
                    levelStr = -Math.floor(Math.abs(deviation) / pair.stepUSD);
                }
                
                // So sánh tầng hiện tại với tầng đã process trước đó
                if (levelStr !== 0 && levelStr !== pair.lastProcessedLevel) {
                    const direction = levelStr > pair.lastProcessedLevel ? 'UP' : 'DOWN';
                    pair.lastProcessedLevel = levelStr; // Cập nhật ngay
                    
                    // Giá tăng tầng -> Mở Note LONG, Grid SHORT (Ngược lại)
                    const noteSide = direction === 'UP' ? 'LONG' : 'SHORT';
                    const gridSide = direction === 'UP' ? 'SHORT' : 'LONG';
                    const devPct = (((markP - pair.firstEntryPrice) / pair.firstEntryPrice) * 100).toFixed(2);

                    if (systemBot.isNotePaused) {
                        addLog(`⏸️ [${symbol}] Đang tạm dừng mở Note do Available < ${NOTE_PAUSE_THRESHOLD}%. Bỏ qua mở Tầng ${levelStr}!`, "warn");
                    } else if (!checkLock(pair, noteSide, levelStr)) {
                        // Check lock xong thì khóa ngay lập tức (Yêu cầu 1)
                        setLock(pair, noteSide, levelStr);

                        const gridQty = pair.baseQty * systemSettings.heSoDCA;
                        const resGrid = await executeBatchOrder(symbol, gridSide, 0, 'OPEN', gridQty);
                        if (resGrid.margin > 0) {
                            const gridKey = `${levelStr}_${Date.now()}`;
                            if (gridSide === 'LONG') {
                                pair.executedGridLongs[gridKey] = { level: levelStr, price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                            } else {
                                pair.executedGridShorts[gridKey] = { level: levelStr, price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                            }
                            pair.accumulatedFees += (resGrid.qty * resGrid.price) * FEE_RATE;
                            addLog(`🟫 [${symbol}] GRID ${gridSide} MỞ | Tầng ${levelStr} (Hướng ${direction}) | Giá: ${formatPrice(resGrid.price)} | Độ lệch: ${devPct}% | Margin: ${resGrid.margin.toFixed(2)}$`, "brown");
                        }

                        const noteQty = pair.baseQty * systemSettings.heSoMoNote;
                        const resNote = await executeBatchOrder(symbol, noteSide, 0, 'OPEN', noteQty);
                        if (resNote.margin > 0) {
                            pair.accumulatedFees += (resNote.qty * resNote.price) * FEE_RATE;
                            pair.activeNotes.push({
                                id: `Note_${levelStr}_${Date.now()}`,
                                level: levelStr,
                                noteSide: noteSide,
                                openPrice: resNote.price,
                                dcaNoteAvg: resNote.price,
                                lastDcaExecutedPrice: resNote.price,
                                initialDcaNoteQty: resNote.qty,
                                dcaNoteQty: resNote.qty,
                                dcaNoteMargin: resNote.margin,
                                dcaCount: 0,
                                isProcessing: false,
                                targetTpPrice: noteSide === 'LONG' ? resNote.price + pair.stepUSD : resNote.price - pair.stepUSD
                            });
                            addLog(`🟧 [${symbol}] NOTE ${noteSide} MỞ | Tầng ${levelStr} (Hướng ${direction}) | Giá: ${formatPrice(resNote.price)} | Độ lệch: ${devPct}% | Margin: ${resNote.margin.toFixed(2)}$`, "orange");
                        } else {
                            // Mở Note lỗi thì nhả lock
                            const lockObj = noteSide === 'LONG' ? pair.lockedLevelsLong : pair.lockedLevelsShort;
                            delete lockObj[levelStr];
                        }
                    }
                }
                
                // === 3, 4. LUỒNG CHỐT LỜI CHUNG GRID + NOTE THEO AVG (YÊU CẦU 2) ===
                const processCombinedTP = async (sideStr) => {
                    let totalQty = 0;
                    let totalExecVol = 0;
                    let gridsToClose = [];
                    let notesToClose = [];

                    // 1. Gom Grid cùng phe
                    const gridObj = sideStr === 'LONG' ? pair.executedGridLongs : pair.executedGridShorts;
                    for (const k in gridObj) {
                        totalQty += gridObj[k].qty;
                        totalExecVol += (gridObj[k].qty * gridObj[k].price);
                        gridsToClose.push(k);
                    }

                    // 2. Gom Note cùng phe
                    const notes = pair.activeNotes.filter(n => n.noteSide === sideStr && !n.isProcessing);
                    for (const n of notes) {
                        totalQty += n.dcaNoteQty;
                        totalExecVol += (n.dcaNoteQty * n.dcaNoteAvg);
                        notesToClose.push(n);
                    }

                    if (totalQty > 0) {
                        const combinedAvg = totalExecVol / totalQty;
                        const closeTarget = sideStr === 'LONG' ? combinedAvg + pair.stepUSD : combinedAvg - pair.stepUSD;
                        const isHit = sideStr === 'LONG' ? markP >= closeTarget : markP <= closeTarget;

                        if (isHit) {
                            notesToClose.forEach(n => n.isProcessing = true); // Khóa để tránh DCA chui vào

                            const resClose = await executeBatchOrder(symbol, sideStr, 0, 'CLOSE', totalQty);
                            
                            if (resClose && resClose.orderId) {
                                const pnlData = await getNetPnLFromOrder(symbol, resClose.orderId);
                                pair.closedNotesPnL += pnlData.netPnL;
                                pair.accumulatedFees += pnlData.customFee;

                                // Dọn dẹp Grid & Log riêng theo yêu cầu
                                let gridMarginClosed = 0;
                                let noteMarginClosed = 0;

                                if (gridsToClose.length > 0) {
                                    gridsToClose.forEach(k => {
                                        gridMarginClosed += gridObj[k].margin || 0;
                                        delete gridObj[k];
                                    });
                                    addLog(`🟫 [${symbol}] CHỐT LỜI CHUNG - GRID ${sideStr} | Đã đóng ${gridsToClose.length} tầng | Margin hồi: ${gridMarginClosed.toFixed(2)}$`, "warn");
                                }

                                // Dọn dẹp Note & Xử lý Delay Unlock 5s (Yêu cầu 4)
                                if (notesToClose.length > 0) {
                                    const closedIds = notesToClose.map(n => n.id);
                                    pair.activeNotes = pair.activeNotes.filter(n => !closedIds.includes(n.id));
                                    pair.closedNotesCount += notesToClose.length;

                                    notesToClose.forEach(note => {
                                        noteMarginClosed += note.dcaNoteMargin;
                                        setUnlockDelay(pair, sideStr, note.level);
                                        addLog(`🔓 [${symbol}] Đã hẹn giờ 5 giây Unlock Tầng ${note.level} sau khi chốt Note ${sideStr}!`, "info");
                                    });
                                    addLog(`🟧 [${symbol}] CHỐT LỜI CHUNG - NOTE ${sideStr} | Đã đóng ${notesToClose.length} Note | Margin hồi: ${noteMarginClosed.toFixed(2)}$`, "success");
                                }

                                addLog(`💲 [${symbol}] TỔNG KẾT CHỐT LỜI CHUNG PHE ${sideStr} | SL: ${totalQty.toFixed(4)} | Avg: ${formatPrice(combinedAvg)} | Giá Chốt: ${formatPrice(closeTarget)} | PnL Net: ${pnlData.netPnL.toFixed(4)}$`, "success");
                            } else {
                                notesToClose.forEach(n => n.isProcessing = false);
                            }
                        }
                    }
                };

                await processCombinedTP('LONG');
                await processCombinedTP('SHORT');

                // --- 5. LUỒNG ĐỘNG CƠ NHỒI NOTE (DCA) VÀ MỞ ĐỐI ỨNG ---
                if (!systemBot.isDcaPaused) { // Yêu cầu 7: Tạm dừng DCA khi margin thấp
                    for (let note of pair.activeNotes) {
                        if (note.isProcessing) continue;

                        const isNoteGoingWrong = note.noteSide === 'LONG' 
                            ? note.lastDcaExecutedPrice - markP >= pair.stepUSD 
                            : markP - note.lastDcaExecutedPrice >= pair.stepUSD;
                            
                        if (isNoteGoingWrong) {
                            note.isProcessing = true;

                            // 1. NHỒI NOTE (DCA CỨU LỆNH ÂM)
                            const dcaQtyAdded = note.initialDcaNoteQty * systemSettings.heSoNhoiNote; 
                            const resNoteDca = await executeBatchOrder(symbol, note.noteSide, 0, 'OPEN', dcaQtyAdded);
                            
                            if (resNoteDca.margin > 0) {
                                pair.accumulatedFees += (resNoteDca.qty * resNoteDca.price) * FEE_RATE;

                                note.dcaNoteAvg = ((note.dcaNoteAvg * note.dcaNoteMargin) + (resNoteDca.price * resNoteDca.margin)) / (note.dcaNoteMargin + resNoteDca.margin);
                                note.lastDcaExecutedPrice = resNoteDca.price; 
                                note.dcaNoteMargin += resNoteDca.margin;
                                note.dcaNoteQty += resNoteDca.qty;
                                note.dcaCount++;

                                note.targetTpPrice = note.noteSide === 'LONG' ? note.dcaNoteAvg + pair.stepUSD : note.dcaNoteAvg - pair.stepUSD;

                                const dcaDevPct = (((resNoteDca.price - pair.firstEntryPrice) / pair.firstEntryPrice) * 100).toFixed(2);
                                addLog(`🟧 [${symbol}] NHỒI NOTE ${note.noteSide} | Lần ${note.dcaCount} (Tầng ${note.level}) | Giá: ${formatPrice(resNoteDca.price)} | Độ lệch: ${dcaDevPct}% | Margin: ${resNoteDca.margin.toFixed(2)}$ | TP Avg mới: ${formatPrice(note.targetTpPrice)}`, "orange");

                                // 2. MỞ MỚI ĐỐI ỨNG KHI NHỒI NOTE (Tuân thủ luật Lock)
                                const currentDevPoint = markP - pair.firstEntryPrice;
                                let targetLevel = 0;
                                if (currentDevPoint > 0) {
                                    targetLevel = Math.floor(currentDevPoint / pair.stepUSD);
                                } else if (currentDevPoint < 0) {
                                    targetLevel = -Math.floor(Math.abs(currentDevPoint) / pair.stepUSD);
                                }

                                if (targetLevel !== 0) {
                                    const oppNoteSide = note.noteSide === 'LONG' ? 'SHORT' : 'LONG';
                                    const oppGridSide = note.noteSide === 'LONG' ? 'LONG' : 'SHORT';

                                    if (systemBot.isNotePaused) {
                                        addLog(`⏸️ [${symbol}] Đang tạm dừng Note do Available < ${NOTE_PAUSE_THRESHOLD}%. Bỏ qua mở đối ứng nhồi Note!`, "warn");
                                    } else if (checkLock(pair, oppNoteSide, targetLevel)) {
                                        addLog(`🔒 [${symbol}] Tầng ${targetLevel} Phe ${oppNoteSide} đang bị LOCK. Bỏ qua mở Note/Grid đối ứng mới!`, "info");
                                    } else {
                                        setLock(pair, oppNoteSide, targetLevel); // Đóng lock riêng cho side
                                        
                                        const gridQty = pair.baseQty * systemSettings.heSoDCA;
                                        const resGrid = await executeBatchOrder(symbol, oppGridSide, 0, 'OPEN', gridQty);
                                        if (resGrid.margin > 0) {
                                            const gridKey = `${targetLevel}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
                                            if (oppGridSide === 'LONG') {
                                                pair.executedGridLongs[gridKey] = { level: targetLevel, price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                                            } else {
                                                pair.executedGridShorts[gridKey] = { level: targetLevel, price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                                            }
                                            pair.accumulatedFees += (resGrid.qty * resGrid.price) * FEE_RATE;
                                            addLog(`🟫 [${symbol}] GRID ${oppGridSide} MỞ | Tầng ${targetLevel} (Kèm nhồi) | Giá: ${formatPrice(resGrid.price)} | Margin: ${resGrid.margin.toFixed(2)}$`, "brown");
                                        }

                                        const noteQty = pair.baseQty * systemSettings.heSoMoNote;
                                        const resNewNote = await executeBatchOrder(symbol, oppNoteSide, 0, 'OPEN', noteQty);
                                        if (resNewNote.margin > 0) {
                                            pair.accumulatedFees += (resNewNote.qty * resNewNote.price) * FEE_RATE;
                                            pair.activeNotes.push({
                                                id: `Note_${targetLevel}_${Date.now()}_${Math.floor(Math.random()*1000)}`,
                                                level: targetLevel,
                                                noteSide: oppNoteSide,
                                                openPrice: resNewNote.price,
                                                dcaNoteAvg: resNewNote.price,
                                                lastDcaExecutedPrice: resNewNote.price,
                                                initialDcaNoteQty: resNewNote.qty,
                                                dcaNoteQty: resNewNote.qty,
                                                dcaNoteMargin: resNewNote.margin,
                                                dcaCount: 0,
                                                isProcessing: false,
                                                targetTpPrice: oppNoteSide === 'LONG' ? resNewNote.price + pair.stepUSD : resNewNote.price - pair.stepUSD
                                            });
                                            addLog(`🟧 [${symbol}] NOTE ${oppNoteSide} MỞ | Tầng ${targetLevel} (Kèm nhồi) | Giá: ${formatPrice(resNewNote.price)} | Margin: ${resNewNote.margin.toFixed(2)}$`, "orange");
                                        } else {
                                            const lockObj = oppNoteSide === 'LONG' ? pair.lockedLevelsLong : pair.lockedLevelsShort;
                                            delete lockObj[targetLevel];
                                        }
                                    }
                                }
                            }
                            note.isProcessing = false;
                        }
                    }
                }
            } catch(e) {
                addLog(`❌ [${symbol}] Lỗi vòng lặp xử lý: ${e.message}`, "error");
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
    if (systemBot.pauseUntil && Date.now() < systemBot.pauseUntil) return setTimeout(fastTpMonitor, 250);

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(fastTpMonitor, 250);

        systemBot.globalPosRisk = posRisk; 

        for (let [symbol, pair] of systemBot.activePairs) {
            if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol]) continue;
            if (pair.pnlLockUntil && Date.now() < pair.pnlLockUntil) continue;

            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide);

            const gridAmt = gridPos ? parseFloat(gridPos.positionAmt) : 0;
            const dcaAmt = dcaPos ? parseFloat(dcaPos.positionAmt) : 0;

            if (Math.abs(gridAmt) === 0 && Math.abs(dcaAmt) === 0) continue; 

            let currentUnrealizedPnL = (gridPos ? parseFloat(gridPos.unRealizedProfit || 0) : 0) + (dcaPos ? parseFloat(dcaPos.unRealizedProfit || 0) : 0);
            const combinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
            const profitTargetUSD = (parseFloat(systemSettings.tpPercent) * pair.initialMargin) + pair.accumulatedFees;

            if (combinedPnL >= profitTargetUSD) {
                addLog(`⚡ [${symbol}] [FAST TP] KÍCH HOẠT ĐÓNG TỔNG | PnL Đạt: ${combinedPnL.toFixed(2)}$ >= Mục tiêu: ${profitTargetUSD.toFixed(2)}$`, "success");
                systemBot.activePairs.delete(symbol); 
                sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
                forceCloseSymbol(symbol, `⚡ FAST TP CHỐT TỔNG CẶP (${combinedPnL.toFixed(2)}$)`).catch(()=>{});
            }
        }
    } catch (e) {}
    
    setTimeout(fastTpMonitor, 250);
}

// ============================================================================
// CHECK BIÊN ĐỘ MARGIN AN TOÀN TRÁNH LIQUIDATION & QUẢN LÝ NOTE/DCA (Yêu cầu 5, 7)
// ============================================================================
async function checkMarginLimits() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return;
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc && parseFloat(acc.totalWalletBalance) > 0) {
        const totalWallet = parseFloat(acc.totalWalletBalance);
        const available = parseFloat(acc.availableBalance);
        const threshold = totalWallet * (ANTI_LIQUIDATION_LIMIT / 100); 
        
        if (available <= threshold) { 
            await panicCloseAll(`KÍCH HOẠT CHỐNG THANH LÝ AN TOÀN (Khả dụng ví < ${ANTI_LIQUIDATION_LIMIT}%)`); 
            systemBot.isMarginProtected = false; 
            return; 
        }
        
        const availPercent = (available / totalWallet) * 100;

        // Quản lý Mở Cặp Mới
        if (!systemBot.isMarginProtected && availPercent < systemSettings.marginProtect) {
            systemBot.isMarginProtected = true; 
            addLog(`⚠️ Khả dụng hệ thống dưới ${systemSettings.marginProtect}%. Tạm dừng quét cặp mới!`, "warn");
        } else if (systemBot.isMarginProtected && availPercent >= systemSettings.marginRecover) {
            systemBot.isMarginProtected = false; 
            addLog(`✅ Khả dụng khôi phục trên ${systemSettings.marginRecover}%. Tiếp tục mở quét cặp.`, "info");
        }

        // Quản lý Tạm Dừng Mở Note Mới (Yêu cầu 5)
        if (!systemBot.isNotePaused && availPercent < NOTE_PAUSE_THRESHOLD) {
            systemBot.isNotePaused = true;
            addLog(`⚠️ Available < ${NOTE_PAUSE_THRESHOLD}%. Đã TẠM DỪNG mở các Note mới!`, "warn");
        } else if (systemBot.isNotePaused && availPercent >= NOTE_RESUME_THRESHOLD) {
            systemBot.isNotePaused = false;
            addLog(`✅ Available >= ${NOTE_RESUME_THRESHOLD}%. Khôi phục cho phép mở Note.`, "info");
        }

        // Quản lý Tạm Dừng Nhồi Note (Yêu cầu 7)
        if (!systemBot.isDcaPaused && availPercent < DCA_PAUSE_THRESHOLD) {
            systemBot.isDcaPaused = true;
            addLog(`🚨 Available < ${DCA_PAUSE_THRESHOLD}%. Đã TẠM DỪNG NHỒI NOTE (DCA) để bảo vệ tài khoản!`, "error");
        } else if (systemBot.isDcaPaused && availPercent >= DCA_RESUME_THRESHOLD) {
            systemBot.isDcaPaused = false;
            addLog(`✅ Available >= ${DCA_RESUME_THRESHOLD}%. Khôi phục chức năng NHỒI NOTE (DCA).`, "info");
        }
    }
}

// ============================================================================
// 5. MÁY CHỦ WEB API GIAO TIẾP VỚI DASHBOARD UI
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
    
    const posRisk = systemBot.globalPosRisk || []; 
    
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }

    const activePairsFormatted = Array.from(systemBot.activePairs.values()).map(pair => {
        let pnlUnrealized = 0;
        let realMarginOnExchange = 0;
        posRisk.forEach(pr => { 
            if (pr.symbol === pair.symbol) {
                const amt = Math.abs(parseFloat(pr.positionAmt));
                if (amt > 0) {
                    pnlUnrealized += parseFloat(pr.unRealizedProfit || 0);
                    realMarginOnExchange += (amt * parseFloat(pr.markPrice)) / pair.leverage;
                }
            }
        });
        
        let gridLongMargin = 0;
        let gridShortMargin = 0;
        let lastLevel = 0;
        
        Object.keys(pair.executedGridLongs).forEach(k => {
             gridLongMargin += pair.executedGridLongs[k].margin || 0;
             const lvlStr = pair.executedGridLongs[k].level.toString().replace(/[^0-9]/g, ''); 
             lastLevel = Math.max(lastLevel, lvlStr ? parseInt(lvlStr) : 0);
        });
        Object.keys(pair.executedGridShorts).forEach(k => {
             gridShortMargin += pair.executedGridShorts[k].margin || 0;
             const lvlStr = pair.executedGridShorts[k].level.toString().replace(/[^0-9]/g, ''); 
             lastLevel = Math.max(lastLevel, lvlStr ? parseInt(lvlStr) : 0);
        });
        pair.activeNotes.forEach(n => {
             const lvlStr = n.level.toString().replace(/[^0-9]/g, '');
             lastLevel = Math.max(lastLevel, lvlStr ? parseInt(lvlStr) : 0);
        });

        const totalActualPnL = pair.closedNotesPnL + pnlUnrealized;

        return {
            ...pair,
            leverage: pair.leverage, 
            firstEntryPriceFormat: formatPrice(pair.firstEntryPrice),
            unrealizedPnL: pnlUnrealized.toFixed(2),
            closedNotesPnL: pair.closedNotesPnL.toFixed(2),
            totalPnL: totalActualPnL.toFixed(2),
            realMargin: realMarginOnExchange.toFixed(2), 
            activeNotesCount: pair.activeNotes.length,
            gridLongMargin,
            gridShortMargin,
            lastLevel
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
// 6. KHỞI CHẠY HỆ THỐNG VÀ VÒNG LẶP SỰ KIỆN CHÍNH
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
            const maxLev = b?.brackets[0]?.initialLeverage || 50;
            
            if (maxLev < 50) { sharedState.permanentBlacklist[s.symbol] = true; return; }
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
    if (systemBot.pauseUntil && Date.now() < systemBot.pauseUntil) return;
    if (systemBot.activePairs.size >= systemSettings.maxPositions) return;

    let entrySignal = null;
    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
        if (systemBot.activePairs.has(c.symbol)) continue;

        const existingPosOnExchange = (systemBot.globalPosRisk || []).find(p => p.symbol === c.symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (existingPosOnExchange) {
            sharedState.blackList[c.symbol] = Date.now() + (5 * 60 * 1000); 
            continue; 
        }

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

            const resGrid = await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'OPEN', targetQty);
            const resDcaBase = await executeBatchOrder(symbol, entrySignal.dcaSide, 0, 'OPEN', targetQty);

            if (resGrid.margin <= 0 || resDcaBase.margin <= 0) {
                throw new Error("Không khởi tạo được vị thế phân bổ từ sàn.");
            }

            const absoluteStepUSD = resGrid.price * (systemSettings.gridStepPercent / 100);
            const initFees = ((resGrid.qty * resGrid.price) + (resDcaBase.qty * resDcaBase.price)) * FEE_RATE;
            
            systemBot.activePairs.set(symbol, {
                symbol: symbol,
                gridSide: entrySignal.gridSide,
                dcaSide: entrySignal.dcaSide,
                firstEntryPrice: resGrid.price,
                initialMargin: resGrid.margin, 
                baseQty: targetQty, 
                leverage: info.maxLeverage, 
                stepUSD: absoluteStepUSD,
                
                executedGridLongs: {}, 
                executedGridShorts: {},
                lockedLevelsLong: {},  // Tách 2 object lock riêng
                lockedLevelsShort: {}, // Tách 2 object lock riêng
                lastProcessedLevel: 0, // Biến check hướng di chuyển (Yêu cầu 3)
                activeNotes: [],
                accumulatedFees: initFees,
                
                closedNotesCount: 0,
                closedNotesPnL: 0,
                pnlLockUntil: 0, 
                createdAt: Date.now()
            });

            const expectedTpUSD = parseFloat(systemSettings.tpPercent) * resGrid.margin;
            addLog(`🚀 [${symbol}] [MỞ LỆNH TỔNG CẶP] Đòn bẩy: x${info.maxLeverage} | Giá vào lệnh: ${formatPrice(resGrid.price)} | Margin Khởi tạo: ${resGrid.margin.toFixed(2)}$ | TP Mục Tiêu: ${expectedTpUSD.toFixed(2)}$`, "white");
        } catch (e) {
            addLog(`❌ [${symbol}] Lỗi vào lệnh gốc: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(4953, () => console.log('🚀 [HEDGE SYSTEM V8.4] Khởi chạy hoàn chỉnh chống Lag API trên Port 4953!'));
