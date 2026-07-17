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

// --- CẤU HÌNH QUẢN LÝ VỐN, SL & NHỒI LỆNH (DỄ DÀNG CHỈNH SỬA) ---
const HE_SO_NHOI_NOTE = 2;        // 1 = Nhồi thêm đúng bằng số lượng ban đầu của Note (tuyến tính x1)
const GLOBAL_SL_MULTIPLIER = 100; // [Req 6] Cắt lỗ vị thế nếu (Lỗ chưa chốt + Lãi đã chốt - Phí) <= -(Margin Ban Đầu * 100)
const FEE_RATE = 0.001;           // [Req 4] Phí giao dịch 0.1% (Tính x2 cho cả mở và đóng = 0.2% Vol)
const ESTIMATED_FUNDING = 0.0005; // [Req 4] Buffer 0.05% dự trù phí Funding để không bị hụt khi chốt
const MIN_NOTIONAL_FORCE = 5.5; 
const ANTI_LIQUIDATION_LIMIT = 10; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  
// -----------------------------------------------------------

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
    maxDcaBaseLevels: 30
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
    return `[Lãi Đã Chốt: ${closedPnL.toFixed(2)}$ | Đang Treo Sàn: ${currentUnrealizedPnL.toFixed(2)}$ | TỔNG: ${totalPnL.toFixed(2)}$ / T.G: ${profitTargetUSD.toFixed(2)}$ | Đạt: ${progressPercent.toFixed(1)}%]`;
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
                totalVol = execVol * 2; // Tính vol 2 chiều cho cả đóng/mở
                break;
            }
        } catch (e) {}
    }
    // [Req 4] Tính phí thực tế (0.1% * 2 chiều) và Funding giả định
    let customFee = totalVol * FEE_RATE; 
    let fundingBuffer = totalVol * ESTIMATED_FUNDING;
    let totalDeductions = customFee + fundingBuffer;
    
    return { realPnL, customFee: totalDeductions, netPnL: realPnL - totalDeductions, totalQtyExecuted, execVol };
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
        const totalNetPnL = settledResults.reduce((sum, val) => sum + val, 0);

        systemBot.status.botClosedCount++;
        systemBot.status.botPnLClosed += totalNetPnL;

        if (pairData) {
            addLog(`💲💲💲 [${symbol}] [${reasonStr}] ĐÓNG TỔNG | Lãi Thực Tế (Đã trừ Fee/Funding): ${totalNetPnL.toFixed(4)}$`, totalNetPnL >= 0 ? "success" : "sl");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addLog(`❌ [${symbol}] Lỗi đóng khẩn cấp tổng: ${e.message}`, "error");
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
// 4. ĐỘNG CƠ MONITOR CHÍNH: QUẢN LÝ TẦNG ĐỘC LẬP THEO GIÁ (UP/DOWN)
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
                const info = sharedState.exchangeInfo[symbol];

                let currentUnrealizedPnL = (gridPos ? parseFloat(gridPos.unRealizedProfit || 0) : 0) + (dcaPos ? parseFloat(dcaPos.unRealizedProfit || 0) : 0);

                // [Req 2] Cập nhật Margin thực tế cho hiển thị HTML
                pair.realGridMargin = gridAmt === 0 ? 0 : (Math.abs(gridAmt) * markP) / pair.leverage;
                pair.realDcaMargin = dcaAmt === 0 ? 0 : (Math.abs(dcaAmt) * markP) / pair.leverage;

                // [Req 6] SL VỊ THẾ TOÀN CỤC (Kèm bù trừ Fee ước tính)
                const totalVolEst = (Math.abs(gridAmt) + Math.abs(dcaAmt)) * markP;
                const estimatedCurrentFee = totalVolEst * (FEE_RATE + ESTIMATED_FUNDING);
                const currentNetPnL = pair.closedNotesPnL + currentUnrealizedPnL - estimatedCurrentFee;
                const slThreshold = -(pair.initialMargin * GLOBAL_SL_MULTIPLIER);
                
                if (currentNetPnL <= slThreshold) {
                    addLog(`🛑 [${symbol}] [STOPLOSS KÍCH HOẠT] PnL Net Hiện Tại: ${currentNetPnL.toFixed(2)}$ chạm mức cắt lỗ (<= ${slThreshold.toFixed(2)}$)`, "sl");
                    systemBot.activePairs.delete(symbol);
                    sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                    forceCloseSymbol(symbol, `🛑 CẮT LỖ VỊ THẾ (-x${GLOBAL_SL_MULTIPLIER} MARGIN)`).catch(()=>{});
                    systemBot.isProcessingLogic.delete(symbol);
                    continue;
                }

                // --- 1. LUỒNG CHỐT LỜI TỔNG (ĐÃ BÙ PHÍ) ---
                if (!pair.pnlLockUntil || Date.now() > pair.pnlLockUntil) {
                    const targetCheckCombinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
                    // [Req 4] Mục tiêu chốt = Mục tiêu lãi gốc + Bù trừ phí/funding để Net > 0
                    const activeProfitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;
                    const requiredGrossPnL = activeProfitTargetUSD + estimatedCurrentFee;

                    if (targetCheckCombinedPnL >= requiredGrossPnL) {
                        addLog(`⚡ [${symbol}] [TP TỔNG] PnL Đạt: ${targetCheckCombinedPnL.toFixed(2)}$ >= Mục Tiêu (Đã gồm Fee): ${requiredGrossPnL.toFixed(2)}$`, "success");
                        systemBot.activePairs.delete(symbol);
                        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                        forceCloseSymbol(symbol, `⚡ CHỐT TỔNG CẶP LỆNH (${targetCheckCombinedPnL.toFixed(2)}$)`).catch(()=>{});
                        systemBot.isProcessingLogic.delete(symbol);
                        continue;
                    }
                }

                if (!pair.lockedLevels) pair.lockedLevels = {};

                // --- [Req 3, 5] TÍNH TOÁN TẦNG SO VỚI ENTRY GỐC ---
                const priceDelta = markP - pair.firstEntryPrice;
                const currentLevelIndex = Math.trunc(priceDelta / pair.stepUSD); // Tầng dương (Tăng) hoặc âm (Giảm)

                // LUỒNG 2: MỞ DCA GỐC (KHI GIÁ TĂNG -> TẦNG DƯƠNG)
                if (currentLevelIndex > 0) {
                    for (let k = 1; k <= currentLevelIndex; k++) {
                        if (k >= systemSettings.maxDcaBaseLevels) continue;
                        
                        // [Req 3] Chỉ lock điểm mở lệnh
                        if (!pair.lockedLevels[`DCA_${k}`]) {
                            const dcaBaseQty = pair.baseQty * systemSettings.heSoDCA;
                            const resDcaBase = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaBaseQty);
                            
                            if (resDcaBase.margin > 0) {
                                pair.lockedLevels[`DCA_${k}`] = true; // Khóa mốc này
                                pair.executedDcaBaseLevels[k] = { price: resDcaBase.price, qty: resDcaBase.qty, margin: resDcaBase.margin };
                                
                                addLog(`🔵 [${symbol}] [DCA GỐC MỞ] Tầng ${k} (Giá trên Entry) | Khớp: ${formatPrice(resDcaBase.price)} | Margin: ${resDcaBase.margin.toFixed(2)}$ | Đã Khóa Điểm Mở Tầng ${k}`, "info");
                            }
                        }
                    }
                }

                // LUỒNG 3: MỞ NOTE (KHI GIÁ GIẢM -> TẦNG ÂM)
                if (currentLevelIndex < 0) {
                    for (let k = -1; k >= currentLevelIndex; k--) {
                        if (!pair.lockedLevels[`NOTE_${k}`]) {
                            const noteQty = pair.baseQty * 1;
                            const resNote = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', noteQty);
                            
                            if (resNote.margin > 0) {
                                pair.lockedLevels[`NOTE_${k}`] = true; // Khóa mốc này
                                
                                // TP NOTE tính động theo mức trung bình của nó (như cũ)
                                const tpPrice = pair.dcaSide === 'LONG' ? resNote.price + pair.stepUSD : resNote.price - pair.stepUSD;
                                
                                pair.activeNotes.push({
                                    id: `NOTE_TANG_${k}_${Date.now()}`,
                                    level: k, // [Req 5] Lưu đúng Tầng âm để Unlock
                                    noteSide: pair.dcaSide,
                                    openPrice: resNote.price,
                                    dcaNoteAvg: resNote.price,
                                    lastDcaExecutedPrice: resNote.price, 
                                    initialDcaNoteQty: resNote.qty,
                                    dcaNoteQty: resNote.qty,
                                    dcaNoteMargin: resNote.margin,
                                    dcaCount: 0,
                                    isProcessing: false,
                                    targetTpPrice: tpPrice               
                                });
                                
                                addLog(`📝 [${symbol}] [NOTE ĐỘC LẬP MỞ] Tầng ${k} (Giá dưới Entry) | Hướng: ${pair.dcaSide} | Khớp: ${formatPrice(resNote.price)} | M.USDT: ${resNote.margin.toFixed(2)}$ | Đã Khóa Điểm Mở Tầng ${k}`, "open");
                            }
                        }
                    }
                }

                // LUỒNG GRID GỐC (GIỮ NGUYÊN HOẠT ĐỘNG NGƯỢC HƯỚNG NHƯ CŨ, KHÔNG KHÓA TP)
                const priceDiffGrid = pair.gridSide === 'LONG' ? pair.firstEntryPrice - markP : markP - pair.firstEntryPrice;
                const currentGridLevel = Math.floor(priceDiffGrid / pair.stepUSD);
                if (currentGridLevel > 0) {
                    for (let k = 1; k <= currentGridLevel; k++) {
                        if (!pair.lockedLevels[`GRID_${k}`]) {
                            const resGrid = await executeBatchOrder(symbol, pair.gridSide, 0, 'OPEN', pair.baseQty);
                            if (resGrid.margin > 0) {
                                pair.lockedLevels[`GRID_${k}`] = true;
                                pair.executedGridLevels[k] = { price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                                addLog(`🟢 [${symbol}] [GRID GỐC MỞ] Tầng G_${k} | Giá khớp: ${formatPrice(resGrid.price)} | Margin: ${resGrid.margin.toFixed(2)}$`, "open");
                            }
                        }
                    }
                }

                // === XỬ LÝ CHỐT LỜI (VWAP) & UNLOCK MỤC TIÊU ===

                // 1. CHỐT LỜI GRID GỐC
                const openedGrids = Object.keys(pair.executedGridLevels).filter(k => pair.executedGridLevels[k]).map(Number);
                if (openedGrids.length > 0) {
                    let totalQty = 0, totalExecVol = 0;
                    openedGrids.forEach(k => { totalQty += pair.executedGridLevels[k].qty; totalExecVol += pair.executedGridLevels[k].qty * pair.executedGridLevels[k].price; });
                    const avgPrice = totalExecVol / totalQty;
                    // Bù phí vào khoảng cách chốt
                    const adjustedStep = pair.stepUSD * 1.05; 
                    const closeTarget = pair.gridSide === 'LONG' ? avgPrice + adjustedStep : avgPrice - adjustedStep;
                    const isHitClose = pair.gridSide === 'LONG' ? markP >= closeTarget : markP <= closeTarget;

                    if (isHitClose) {
                        const resGridClose = await executeBatchOrder(symbol, pair.gridSide, 0, 'CLOSE', totalQty);
                        if (resGridClose && resGridClose.orderId) {
                            const pnlData = await getNetPnLFromOrder(symbol, resGridClose.orderId);
                            pair.closedNotesPnL += pnlData.netPnL;

                            openedGrids.forEach(k => {
                                pair.executedGridLevels[k] = false;
                                delete pair.lockedLevels[`GRID_${k}`]; // Unlock lưới
                            });
                            addLog(`🔴 [${symbol}] [GRID GỐC ĐÓNG] Đã chốt & UNLOCK các Tầng: ${openedGrids.join(',')} | Net PnL: ${pnlData.netPnL.toFixed(4)}$`, "warn");
                        }
                    }
                }

                // 2. CHỐT LỜI DCA GỐC
                const openedDcaBases = Object.keys(pair.executedDcaBaseLevels).filter(k => pair.executedDcaBaseLevels[k]).map(Number);
                if (openedDcaBases.length > 0) {
                    let totalQty = 0, totalExecVol = 0;
                    openedDcaBases.forEach(k => { totalQty += pair.executedDcaBaseLevels[k].qty; totalExecVol += pair.executedDcaBaseLevels[k].qty * pair.executedDcaBaseLevels[k].price; });
                    const avgPrice = totalExecVol / totalQty;
                    const adjustedStep = pair.stepUSD * 1.05; 
                    const closeTargetDca = pair.dcaSide === 'LONG' ? avgPrice + adjustedStep : avgPrice - adjustedStep;
                    const isHitCloseDca = pair.dcaSide === 'LONG' ? markP >= closeTargetDca : markP <= closeTargetDca;

                    if (isHitCloseDca) {
                        const resDcaClose = await executeBatchOrder(symbol, pair.dcaSide, 0, 'CLOSE', totalQty);
                        if (resDcaClose && resDcaClose.orderId) {
                            const pnlData = await getNetPnLFromOrder(symbol, resDcaClose.orderId);
                            pair.closedNotesPnL += pnlData.netPnL;

                            openedDcaBases.forEach(k => {
                                pair.executedDcaBaseLevels[k] = false;
                                // [Req 3] Lập tức Unlock khi chốt DCA gốc
                                delete pair.lockedLevels[`DCA_${k}`]; 
                                addLog(`🔓 [${symbol}] Đã chốt & UNLOCK điểm lưới DCA Gốc Tầng ${k}`, "warn");
                            });
                            addLog(`🔴 [${symbol}] [DCA GỐC ĐÓNG] Gộp chốt mảng DCA | Net PnL: ${pnlData.netPnL.toFixed(4)}$`, "success");
                        }
                    }
                }

                // 3. CHỐT LỜI NOTE ĐỘC LẬP
                let notesToClose = [];
                const longNotes = pair.activeNotes.filter(n => (n.noteSide || pair.dcaSide) === 'LONG' && !n.isProcessing);
                const shortNotes = pair.activeNotes.filter(n => (n.noteSide || pair.dcaSide) === 'SHORT' && !n.isProcessing);

                const checkNoteGroupTp = (noteGroup, side) => {
                    if (noteGroup.length === 0) return;
                    let tQty = 0, tVal = 0;
                    noteGroup.forEach(n => { tQty += n.dcaNoteQty; tVal += n.dcaNoteQty * n.dcaNoteAvg; });
                    const avgNotePrice = tVal / tQty;
                    const adjustedStep = pair.stepUSD * 1.05; // Cộng 5% khoảng cách để bù trượt/phí
                    const tpTarget = side === 'LONG' ? avgNotePrice + adjustedStep : avgNotePrice - adjustedStep;
                    const isHit = side === 'LONG' ? markP >= tpTarget : markP <= tpTarget;
                    
                    if (isHit) {
                        noteGroup.forEach(n => { n.isProcessing = true; n.targetTpPrice = tpTarget; notesToClose.push(n); });
                    }
                };

                checkNoteGroupTp(longNotes, 'LONG');
                checkNoteGroupTp(shortNotes, 'SHORT');

                for (let note of pair.activeNotes) {
                    if (note.isProcessing) continue;
                    note.noteSide = note.noteSide || pair.dcaSide; 
                    const isNoteGoingWrong = note.noteSide === 'LONG' ? note.lastDcaExecutedPrice - markP >= pair.stepUSD : markP - note.lastDcaExecutedPrice >= pair.stepUSD;
                        
                    if (isNoteGoingWrong) {
                        note.isProcessing = true;
                        const dcaQtyAdded = note.initialDcaNoteQty * HE_SO_NHOI_NOTE; 
                        const resNoteDca = await executeBatchOrder(symbol, note.noteSide, 0, 'OPEN', dcaQtyAdded);
                        
                        if (resNoteDca.margin > 0) {
                            note.dcaNoteAvg = ((note.dcaNoteAvg * note.dcaNoteMargin) + (resNoteDca.price * resNoteDca.margin)) / (note.dcaNoteMargin + resNoteDca.margin);
                            note.lastDcaExecutedPrice = resNoteDca.price; 
                            note.dcaNoteMargin += resNoteDca.margin;
                            note.dcaNoteQty += resNoteDca.qty;
                            note.dcaCount++;
                            note.targetTpPrice = note.noteSide === 'LONG' ? note.dcaNoteAvg + pair.stepUSD : note.dcaNoteAvg - pair.stepUSD;

                            addLog(`🟡 [${symbol}] [NHỒI NOTE] Tầng ${note.level} | Giá khớp: ${formatPrice(resNoteDca.price)} | Kéo TP Về: ${formatPrice(note.targetTpPrice)}`, "warn");
                        }
                        note.isProcessing = false;
                    }
                }

                if (notesToClose.length > 0) {
                    const processGroupClose = async (groupNotes, sideStr) => {
                        if(groupNotes.length === 0) return;
                        let totalQty = groupNotes.reduce((sum, n) => sum + n.dcaNoteQty, 0);
                        const orderData = { symbol: symbol, side: sideStr === 'LONG' ? 'SELL' : 'BUY', positionSide: sideStr, type: 'MARKET', quantity: totalQty.toFixed(info.quantityPrecision) };

                        const resDca = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch(e => {
                            addLog(`❌ [${symbol}] Lỗi chốt Note Phe ${sideStr}: ${e.message}`, "error");
                            groupNotes.forEach(n => n.isProcessing = false);
                            return null;
                        });

                        if (resDca && resDca.orderId) {
                            // [Req 3] Lập tức Unlock các Tầng Note đã đóng để có thể mở lại khi quét lại
                            groupNotes.forEach(note => {
                                delete pair.lockedLevels[`NOTE_${note.level}`];
                                addLog(`🔓 [${symbol}] Đã chốt & UNLOCK điểm lưới Note Tầng ${note.level}`, "success");
                            });

                            const closedIds = groupNotes.map(n => n.id);
                            pair.activeNotes = pair.activeNotes.filter(n => !closedIds.includes(n.id));
                            pair.closedNotesCount += groupNotes.length;
                            pair.pnlLockUntil = Date.now() + 4000; 

                            (async () => {
                                const { netPnL, customFee } = await getNetPnLFromOrder(symbol, resDca.orderId);
                                pair.closedNotesPnL += netPnL;
                                let noteDetails = groupNotes.map(n => `[Tầng ${n.level}]`).join(" ");
                                addLog(`💲 [${symbol}] [CHỐT LÃI NOTE PHE ${sideStr}] Các Note: ${noteDetails} | Phí trừ (Fee+Fund): ~${customFee.toFixed(4)}$ | Thực Nhận Net: ${netPnL.toFixed(4)}$`, "success");
                            })();
                        }
                    };

                    await processGroupClose(notesToClose.filter(n => n.noteSide === 'LONG'), 'LONG');
                    await processGroupClose(notesToClose.filter(n => n.noteSide === 'SHORT'), 'SHORT');
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

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(fastTpMonitor, 250);

        for (let [symbol, pair] of systemBot.activePairs) {
            if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol]) continue;
            if (pair.pnlLockUntil && Date.now() < pair.pnlLockUntil) continue;

            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide);

            const gridAmt = gridPos ? parseFloat(gridPos.positionAmt) : 0;
            const dcaAmt = dcaPos ? parseFloat(dcaPos.positionAmt) : 0;
            if (Math.abs(gridAmt) === 0 && Math.abs(dcaAmt) === 0) continue; 

            const markP = parseFloat(gridPos?.markPrice || dcaPos?.markPrice || 0);
            let currentUnrealizedPnL = (gridPos ? parseFloat(gridPos.unRealizedProfit || 0) : 0) + (dcaPos ? parseFloat(dcaPos.unRealizedProfit || 0) : 0);
            
            const totalVolEst = (Math.abs(gridAmt) + Math.abs(dcaAmt)) * markP;
            const estimatedCurrentFee = totalVolEst * (FEE_RATE + ESTIMATED_FUNDING);

            const combinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
            const profitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;
            const requiredGrossPnL = profitTargetUSD + estimatedCurrentFee;

            if (combinedPnL >= requiredGrossPnL) {
                addLog(`⚡ [${symbol}] [FAST TP] KÍCH HOẠT ĐÓNG TỔNG | PnL Đạt: ${combinedPnL.toFixed(2)}$ >= Mục tiêu (Bù phí): ${requiredGrossPnL.toFixed(2)}$`, "success");
                systemBot.activePairs.delete(symbol); 
                sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
                forceCloseSymbol(symbol, `⚡ FAST TP CHỐT TỔNG CẶP (${combinedPnL.toFixed(2)}$)`).catch(()=>{});
            }
        }
    } catch (e) {}
    setTimeout(fastTpMonitor, 250);
}

// CHECK BIÊN ĐỘ MARGIN AN TOÀN TRÁNH LIQUIDATION
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
        if (!systemBot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
            systemBot.isMarginProtected = true; addLog(`⚠️ Khả dụng hệ thống dưới ${MARGIN_PROTECT_LIMIT}%. Tạm dừng quét cặp mới!`, "warn");
        } else if (systemBot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            systemBot.isMarginProtected = false; addLog(`✅ Khả dụng khôi phục trên ${MARGIN_RECOVER_LIMIT}%. Tiếp tục mở quét cặp.`, "info");
        }
    }
}

// ============================================================================
// 5. MÁY CHỦ WEB API GIAO TIẾP VỚI DASHBOARD UI (PORT 1871)
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
            // [Req 2] Trả về UI Margin thực tế, không cộng dồn
            gridTotalMargin: pair.realGridMargin || pair.gridTotalMargin,
            dcaTotalMargin: pair.realDcaMargin || pair.dcaTotalMargin,
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

appServer.get('/api/status', async (req, res) => res.json(await buildStatusResponse()));

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
            const maxLev = b?.brackets[0]?.initialLeverage || 30;
            
            // [Req 1] Chỉ mở lệnh từ lev 50 trở lên
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

        const marginSetting = systemSettings.invValue;
        let calculatedMargin = marginSetting.toString().includes('%') ? (parseFloat(acc.availableBalance || 0) * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

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

            if (resGrid.margin <= 0 || resDcaBase.margin <= 0) throw new Error("Không khởi tạo được vị thế.");

            const absoluteStepUSD = resGrid.price * (systemSettings.gridStepPercent / 100);
            
            systemBot.activePairs.set(symbol, {
                symbol: symbol, gridSide: entrySignal.gridSide, dcaSide: entrySignal.dcaSide,
                firstEntryPrice: resGrid.price, initialMargin: resGrid.margin, baseQty: targetQty, 
                leverage: info.maxLeverage, stepUSD: absoluteStepUSD,
                
                executedGridLevels: {}, executedDcaBaseLevels: {},
                lockedLevels: {}, // Dictionary chung lưu mốc Tầng
                activeNotes: [],
                
                closedNotesCount: 0, closedNotesPnL: 0,
                gridTotalMargin: resGrid.margin, dcaTotalMargin: resDcaBase.margin,
                pnlLockUntil: 0, createdAt: Date.now()
            });

            addLog(`🚀 [${symbol}] [VÀO LỆNH TỔNG CẶP] Đòn bẩy: x${info.maxLeverage} | Giá vào lệnh: ${formatPrice(resGrid.price)} | Margin Khởi tạo: ${resGrid.margin.toFixed(2)}$`, "open");
        } catch (e) {
            addLog(`❌ [${symbol}] Lỗi vào lệnh gốc: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

// [Req 1] Đổi port 1871
appServer.listen(1851, () => console.log('🚀 [HEDGE SYSTEM V9.0] Khởi chạy hoàn chỉnh Port 1871!'));
