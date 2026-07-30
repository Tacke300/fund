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
    minVol: 2,
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
    id: "MASTER_BOT", startTime: Date.now(),
    status: { botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    activePairs: new Map(), 
    isProcessingLogic: new Set(), timestampOffset: 0, isMarginProtected: false,
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
    return `[Lãi: ${closedPnL.toFixed(2)}$ | Treo: ${currentUnrealizedPnL.toFixed(2)}$ | TỔNG: ${totalPnL.toFixed(2)}$/${profitTargetUSD.toFixed(2)}$]`;
}

function calculateLevel(markP, firstEntryPrice, stepUSD) {
    const deviation = markP - firstEntryPrice;
    if (deviation > 0) return Math.floor(deviation / stepUSD);
    if (deviation < 0) return -Math.floor(Math.abs(deviation) / stepUSD);
    return 0;
}

function getDevPercent(currentPrice, firstEntryPrice) {
    if (!firstEntryPrice || firstEntryPrice === 0) return "0.00";
    return (((currentPrice - firstEntryPrice) / firstEntryPrice) * 100).toFixed(2);
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
    addLog(`🚫 [${symbol}] Đưa vào Blacklist 15 phút. Khóa và giải tỏa vị thế...`, "warn");
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
            if (trades && Array.isArray(trades) && trades.length > 0) {
                realPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl || 0), 0);
                execVol = trades.reduce((sum, t) => sum + (parseFloat(t.qty || 0) * parseFloat(t.price || 0)), 0);
                totalQtyExecuted = trades.reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                totalVol = execVol * 2;
                break;
            }
        } catch (e) {}
    }
    let customFee = totalVol * FEE_RATE; 
    let netPnL = realPnL - customFee;
    return { realPnL, customFee, netPnL, totalQtyExecuted, execVol };
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
        const totalNetPnL = settledResults.reduce((sum, val) => sum + val, 0);

        systemBot.status.botClosedCount++;
        systemBot.status.botPnLClosed += totalNetPnL;

        if (pairData) {
            addLog(`💲 [${symbol}] [${reasonStr}] ĐÓNG TỔNG | Lãi Thực Tế (Net PnL): ${totalNetPnL.toFixed(4)}$`, totalNetPnL >= 0 ? "success" : "error");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
        return totalNetPnL;
    } catch (e) {
        addLog(`❌ [${symbol}] Lỗi đóng khẩn cấp tổng: ${e.message}`, "error");
        return 0;
    }
}

async function panicCloseAll(reasonLog) {
    try {
        const activeSymbols = Array.from(systemBot.activePairs.keys());
        let grandTotalPnL = 0;
        for(let sym of activeSymbols) {
            let pnl = await forceCloseSymbol(sym, reasonLog);
            grandTotalPnL += pnl;
        }
        addLog(`⚠️ ĐÓNG TOÀN BỘ HỆ THỐNG: ${reasonLog} | Tổng PnL Chốt: ${grandTotalPnL.toFixed(4)}$`, "warn");
        return { success: true, grandTotalPnL };
    } catch (e) { return { success: false, msg: e.message }; }
}

// ============================================================================
// 4. ĐỘNG CƠ MONITOR CHÍNH
// ============================================================================
async function priceMonitor() {
    if (!systemBot.status.isReady) return setTimeout(priceMonitor, 500);
    try {
        if (!systemSettings.isRunning) return setTimeout(priceMonitor, 500);
        
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
                    addLog(`🛑 [${symbol}] CẮT LỖ PnL Tổng ${targetCheckCombinedPnL.toFixed(2)}$ chạm mức SL ${maxLossThreshold.toFixed(2)}$`, "error");
                    systemBot.activePairs.delete(symbol);
                    sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                    forceCloseSymbol(symbol, `🛑 CẮT LỖ VỊ THẾ (${targetCheckCombinedPnL.toFixed(2)}$)`).catch(()=>{});
                    systemBot.isProcessingLogic.delete(symbol);
                    continue;
                }

                // --- 1. CHỐT LỜI TỔNG BẢO VỆ PHÍ ---
                if (!pair.pnlLockUntil || Date.now() > pair.pnlLockUntil) {
                    const activeProfitTargetUSD = (parseFloat(systemSettings.tpPercent) * pair.initialMargin) + pair.accumulatedFees;
                    if (targetCheckCombinedPnL >= activeProfitTargetUSD) {
                        addLog(`⚡ [${symbol}] TP TỔNG PnL Đạt: ${targetCheckCombinedPnL.toFixed(2)}$ >= Mục Tiêu: ${activeProfitTargetUSD.toFixed(2)}$`, "success");
                        systemBot.activePairs.delete(symbol);
                        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                        forceCloseSymbol(symbol, `⚡ CHỐT TỔNG CẶP LỆNH (${targetCheckCombinedPnL.toFixed(2)}$)`).catch(()=>{});
                        systemBot.isProcessingLogic.delete(symbol);
                        continue;
                    }
                }

                // --- 2. LUỒNG ĐỘNG CƠ THEO TẦNG CỐ ĐỊNH TỪ ENTRY ---
                const levelStr = calculateLevel(markP, pair.firstEntryPrice, pair.stepUSD);
                
                if (levelStr !== 0 && !pair.lockedLevels[levelStr]) {
                    if (levelStr > 0) {
                        // GIÁ TĂNG: MỞ NOTE LONG + GRID SHORT
                        const gridQty = pair.baseQty * systemSettings.heSoDCA;
                        const resGrid = await executeBatchOrder(symbol, 'SHORT', 0, 'OPEN', gridQty);
                        if (resGrid.margin > 0) {
                            const gridKey = `${levelStr}_${Date.now()}`;
                            pair.executedGridShorts[gridKey] = { level: levelStr, price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                            pair.accumulatedFees += (resGrid.qty * resGrid.price) * FEE_RATE;
                            const devPct = getDevPercent(resGrid.price, pair.firstEntryPrice);
                            addLog(`[${symbol}] grid short mở Tầng ${levelStr} | Giá entry: ${formatPrice(resGrid.price)} | Độ lệch: ${devPct}%`, "grid");
                        }

                        const noteQty = pair.baseQty * systemSettings.heSoMoNote;
                        const resNote = await executeBatchOrder(symbol, 'LONG', 0, 'OPEN', noteQty);
                        if (resNote.margin > 0) {
                            pair.lockedLevels[levelStr] = true;
                            pair.accumulatedFees += (resNote.qty * resNote.price) * FEE_RATE;
                            pair.activeNotes.push({
                                id: `Note_${levelStr}_${Date.now()}`,
                                level: levelStr,
                                noteSide: 'LONG',
                                openPrice: resNote.price,
                                dcaNoteAvg: resNote.price,
                                lastDcaExecutedPrice: resNote.price,
                                initialDcaNoteQty: resNote.qty,
                                dcaNoteQty: resNote.qty,
                                dcaNoteMargin: resNote.margin,
                                dcaCount: 0,
                                isProcessing: false,
                                targetTpPrice: resNote.price + pair.stepUSD
                            });
                            const devPct = getDevPercent(resNote.price, pair.firstEntryPrice);
                            addLog(`[${symbol}] note long mở Tầng ${levelStr} | Giá entry: ${formatPrice(resNote.price)} | Độ lệch: ${devPct}%`, "note");
                        }
                    } else {
                        // GIÁ GIẢM: MỞ NOTE SHORT + GRID LONG
                        const gridQty = pair.baseQty * systemSettings.heSoDCA;
                        const resGrid = await executeBatchOrder(symbol, 'LONG', 0, 'OPEN', gridQty);
                        if (resGrid.margin > 0) {
                            const gridKey = `${levelStr}_${Date.now()}`;
                            pair.executedGridLongs[gridKey] = { level: levelStr, price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                            pair.accumulatedFees += (resGrid.qty * resGrid.price) * FEE_RATE;
                            const devPct = getDevPercent(resGrid.price, pair.firstEntryPrice);
                            addLog(`[${symbol}] grid long mở Tầng ${levelStr} | Giá entry: ${formatPrice(resGrid.price)} | Độ lệch: ${devPct}%`, "grid");
                        }

                        const noteQty = pair.baseQty * systemSettings.heSoMoNote;
                        const resNote = await executeBatchOrder(symbol, 'SHORT', 0, 'OPEN', noteQty);
                        if (resNote.margin > 0) {
                            pair.lockedLevels[levelStr] = true;
                            pair.accumulatedFees += (resNote.qty * resNote.price) * FEE_RATE;
                            pair.activeNotes.push({
                                id: `Note_${levelStr}_${Date.now()}`,
                                level: levelStr,
                                noteSide: 'SHORT',
                                openPrice: resNote.price,
                                dcaNoteAvg: resNote.price,
                                lastDcaExecutedPrice: resNote.price,
                                initialDcaNoteQty: resNote.qty,
                                dcaNoteQty: resNote.qty,
                                dcaNoteMargin: resNote.margin,
                                dcaCount: 0,
                                isProcessing: false,
                                targetTpPrice: resNote.price - pair.stepUSD
                            });
                            const devPct = getDevPercent(resNote.price, pair.firstEntryPrice);
                            addLog(`[${symbol}] note short mở Tầng ${levelStr} | Giá entry: ${formatPrice(resNote.price)} | Độ lệch: ${devPct}%`, "note");
                        }
                    }
                }
                
                // === 3. XỬ LÝ CHỐT LỜI GRID LONG ===
                const openedGridLongs = Object.keys(pair.executedGridLongs);
                if (openedGridLongs.length > 0) {
                    let totalQty = 0, totalExecVol = 0;
                    openedGridLongs.forEach(k => {
                        totalQty += pair.executedGridLongs[k].qty;
                        totalExecVol += pair.executedGridLongs[k].qty * pair.executedGridLongs[k].price;
                    });
                    
                    const avgPrice = totalExecVol / totalQty;
                    const closeTarget = avgPrice + pair.stepUSD;

                    if (markP >= closeTarget) {
                        const resGridClose = await executeBatchOrder(symbol, 'LONG', 0, 'CLOSE', totalQty);
                        
                        let netPnLTotal = 0, customFeeTotal = 0;
                        if (resGridClose && resGridClose.orderId) {
                            const pnlData = await getNetPnLFromOrder(symbol, resGridClose.orderId);
                            netPnLTotal = pnlData.netPnL;
                            customFeeTotal = pnlData.customFee;
                            pair.closedNotesPnL += netPnLTotal;
                            pair.accumulatedFees += customFeeTotal;
                        }

                        for (let i = 0; i < openedGridLongs.length; i++) {
                            const k = openedGridLongs[i];
                            const marginClosed = pair.executedGridLongs[k]?.margin || 0;
                            const closedLevel = pair.executedGridLongs[k]?.level;
                            delete pair.executedGridLongs[k];
                            
                            let closePnLMsg = (i === 0) ? `| Giá TB: ${formatPrice(avgPrice)} | PnL Mảng: ${netPnLTotal.toFixed(4)}$` : ``;
                            addLog(`🔴 [${symbol}] GRID LONG ĐÓNG Tầng ${closedLevel} | Margin: ${marginClosed.toFixed(2)}$ ${closePnLMsg}`, "warn");
                        }
                    }
                }

                // === 4. XỬ LÝ CHỐT LỜI GRID SHORT ===
                const openedGridShorts = Object.keys(pair.executedGridShorts);
                if (openedGridShorts.length > 0) {
                    let totalQty = 0, totalExecVol = 0;
                    openedGridShorts.forEach(k => {
                        totalQty += pair.executedGridShorts[k].qty;
                        totalExecVol += pair.executedGridShorts[k].qty * pair.executedGridShorts[k].price;
                    });

                    const avgPrice = totalExecVol / totalQty;
                    const closeTarget = avgPrice - pair.stepUSD;

                    if (markP <= closeTarget) {
                        const resGridClose = await executeBatchOrder(symbol, 'SHORT', 0, 'CLOSE', totalQty);

                        let netPnLTotal = 0, customFeeTotal = 0;
                        if (resGridClose && resGridClose.orderId) {
                            const pnlData = await getNetPnLFromOrder(symbol, resGridClose.orderId);
                            netPnLTotal = pnlData.netPnL;
                            customFeeTotal = pnlData.customFee;
                            pair.closedNotesPnL += netPnLTotal; 
                            pair.accumulatedFees += customFeeTotal;
                        }

                        for (let i = 0; i < openedGridShorts.length; i++) {
                            const k = openedGridShorts[i];
                            const marginClosed = pair.executedGridShorts[k]?.margin || 0;
                            const closedLevel = pair.executedGridShorts[k]?.level;
                            delete pair.executedGridShorts[k];
                            
                            let closePnLMsg = (i === 0) ? `| Giá TB: ${formatPrice(avgPrice)} | PnL Mảng: ${netPnLTotal.toFixed(4)}$` : ``;
                            addLog(`🔴 [${symbol}] GRID SHORT ĐÓNG Tầng ${closedLevel} | Margin: ${marginClosed.toFixed(2)}$ ${closePnLMsg}`, "warn");
                        }
                    }
                }

                // --- 5. LUỒNG ĐỘNG CƠ NOTE ĐỘC LẬP & NHỒI NOTE ---
                let notesToClose = [];

                const longNotes = pair.activeNotes.filter(n => n.noteSide === 'LONG' && !n.isProcessing);
                const shortNotes = pair.activeNotes.filter(n => n.noteSide === 'SHORT' && !n.isProcessing);

                const checkNoteGroupTp = (noteGroup, side) => {
                    if (noteGroup.length === 0) return;
                    let tQty = 0, tVal = 0;
                    noteGroup.forEach(n => { tQty += n.dcaNoteQty; tVal += n.dcaNoteQty * n.dcaNoteAvg; });
                    const avgNotePrice = tVal / tQty;
                    const tpTarget = side === 'LONG' ? avgNotePrice + pair.stepUSD : avgNotePrice - pair.stepUSD;
                    const isHit = side === 'LONG' ? markP >= tpTarget : markP <= tpTarget;
                    
                    if (isHit) {
                        noteGroup.forEach(n => { 
                            n.isProcessing = true; 
                            n.targetTpPrice = tpTarget; 
                            notesToClose.push(n); 
                        });
                    }
                };

                checkNoteGroupTp(longNotes, 'LONG');
                checkNoteGroupTp(shortNotes, 'SHORT');

                for (let note of pair.activeNotes) {
                    if (note.isProcessing) continue;

                    const isNoteGoingWrong = note.noteSide === 'LONG' 
                        ? note.lastDcaExecutedPrice - markP >= pair.stepUSD 
                        : markP - note.lastDcaExecutedPrice >= pair.stepUSD;
                        
                    if (isNoteGoingWrong) {
                        note.isProcessing = true;

                        // 1. NHỒI NOTE DCA
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

                            const dcaDevPct = getDevPercent(resNoteDca.price, pair.firstEntryPrice);
                            addLog(`🟡 [${symbol}] nhồi note ${note.noteSide.toLowerCase()} lần ${note.dcaCount} Tầng ${note.level} | Giá entry: ${formatPrice(resNoteDca.price)} | Độ lệch: ${dcaDevPct}% | TP Mới: ${formatPrice(note.targetTpPrice)}`, "warn");

                            // 2. MỞ ĐỐI ỨNG KHI DCA NOTE (TUÂN THỦ QUY TẮC LOCK TẦNG)
                            const currentDcaLevel = calculateLevel(markP, pair.firstEntryPrice, pair.stepUSD);

                            if (!pair.lockedLevels[currentDcaLevel]) {
                                const oppNoteSide = note.noteSide === 'LONG' ? 'SHORT' : 'LONG';
                                const oppGridSide = note.noteSide === 'LONG' ? 'LONG' : 'SHORT';

                                const gridQty = pair.baseQty * systemSettings.heSoDCA;
                                const resGrid = await executeBatchOrder(symbol, oppGridSide, 0, 'OPEN', gridQty);
                                if (resGrid.margin > 0) {
                                    const gridKey = `Grid_${currentDcaLevel}_${Date.now()}`;
                                    if (oppGridSide === 'LONG') {
                                        pair.executedGridLongs[gridKey] = { level: currentDcaLevel, price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                                    } else {
                                        pair.executedGridShorts[gridKey] = { level: currentDcaLevel, price: resGrid.price, qty: resGrid.qty, margin: resGrid.margin };
                                    }
                                    pair.accumulatedFees += (resGrid.qty * resGrid.price) * FEE_RATE;
                                    const gridDevPct = getDevPercent(resGrid.price, pair.firstEntryPrice);
                                    addLog(`[${symbol}] grid ${oppGridSide.toLowerCase()} mở Tầng ${currentDcaLevel} | Giá entry: ${formatPrice(resGrid.price)} | Độ lệch: ${gridDevPct}%`, "grid");
                                }

                                const noteQty = pair.baseQty * systemSettings.heSoMoNote;
                                const resNewNote = await executeBatchOrder(symbol, oppNoteSide, 0, 'OPEN', noteQty);
                                if (resNewNote.margin > 0) {
                                    pair.lockedLevels[currentDcaLevel] = true;
                                    pair.accumulatedFees += (resNewNote.qty * resNewNote.price) * FEE_RATE;
                                    pair.activeNotes.push({
                                        id: `Note_${currentDcaLevel}_${Date.now()}`,
                                        level: currentDcaLevel,
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
                                    const oppDevPct = getDevPercent(resNewNote.price, pair.firstEntryPrice);
                                    addLog(`[${symbol}] note ${oppNoteSide.toLowerCase()} mở Tầng ${currentDcaLevel} | Giá entry: ${formatPrice(resNewNote.price)} | Độ lệch: ${oppDevPct}%`, "note");
                                }
                            } else {
                                addLog(`🔒 [${symbol}] Tầng ${currentDcaLevel} đang bị Lock, bỏ qua mở Note/Grid đối ứng khi DCA.`, "info");
                            }
                        }
                        note.isProcessing = false;
                    }
                }

                if (notesToClose.length > 0) {
                    const notesLongToClose = notesToClose.filter(n => n.noteSide === 'LONG');
                    const notesShortToClose = notesToClose.filter(n => n.noteSide === 'SHORT');
                    
                    const processGroupClose = async (groupNotes, sideStr) => {
                        if(groupNotes.length === 0) return;
                        let totalQty = groupNotes.reduce((sum, n) => sum + n.dcaNoteQty, 0);
                        const info = sharedState.exchangeInfo[symbol];
                        const orderData = {
                            symbol: symbol,
                            side: sideStr === 'LONG' ? 'SELL' : 'BUY',
                            positionSide: sideStr,
                            type: 'MARKET',
                            quantity: totalQty.toFixed(info ? info.quantityPrecision : 4)
                        };

                        const resDca = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch(e => {
                            addLog(`❌ [${symbol}] Lỗi chốt Note Phe ${sideStr}: ${e.message}`, "error");
                            groupNotes.forEach(n => n.isProcessing = false);
                            return null;
                        });

                        if (resDca && resDca.orderId) {
                            groupNotes.forEach(note => {
                                if (pair.lockedLevels[note.level]) {
                                    delete pair.lockedLevels[note.level];
                                    addLog(`🔓 [${symbol}] Unlock điểm lưới Tầng ${note.level} do chốt Note ${sideStr}!`, "info");
                                }
                            });
                            
                            const totalMarginClosed = groupNotes.reduce((sum, n) => sum + n.dcaNoteMargin, 0);
                            const closedIds = groupNotes.map(n => n.id);
                            pair.activeNotes = pair.activeNotes.filter(n => !closedIds.includes(n.id));
                            pair.closedNotesCount += groupNotes.length;

                            const { netPnL, customFee } = await getNetPnLFromOrder(symbol, resDca.orderId);
                            pair.closedNotesPnL += netPnL;
                            pair.accumulatedFees += customFee;
                            
                            if (groupNotes.length === 1) {
                                addLog(`💲 [${symbol}] CHỐT LÃI NOTE ${sideStr} | Margin Đóng: ${totalMarginClosed.toFixed(2)}$ | Net PnL: ${netPnL.toFixed(4)}$`, "success");
                            } else {
                                let noteDetails = groupNotes.map(n => `[Tầng ${n.level}]`).join(" ");
                                addLog(`💲 [${symbol}] CHỐT LÃI GỘP NOTE ${sideStr} (${groupNotes.length} Note: ${noteDetails}) | Margin: ${totalMarginClosed.toFixed(2)}$ | Net PnL: ${netPnL.toFixed(4)}$`, "success");
                            }
                        }
                    };

                    await processGroupClose(notesLongToClose, 'LONG');
                    await processGroupClose(notesShortToClose, 'SHORT');
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
// ĐỘNG CƠ FAST TP MONITOR 250MS
// ============================================================================
async function fastTpMonitor() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return setTimeout(fastTpMonitor, 250);

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
                addLog(`⚡ [${symbol}] FAST TP ĐÓNG TỔNG | PnL Đạt: ${combinedPnL.toFixed(2)}$ >= Target: ${profitTargetUSD.toFixed(2)}$`, "success");
                systemBot.activePairs.delete(symbol); 
                sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
                forceCloseSymbol(symbol, `⚡ FAST TP CHỐT TỔNG CẶP (${combinedPnL.toFixed(2)}$)`).catch(()=>{});
            }
        }
    } catch (e) {}
    
    setTimeout(fastTpMonitor, 250);
}

// ============================================================================
// CHECK MARGIN & CHỐNG THANH LÝ AN TOÀN
// ============================================================================
async function checkMarginLimits() {
    if (!systemBot.status.isReady) return;
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc && parseFloat(acc.totalWalletBalance) > 0) {
        const totalWallet = parseFloat(acc.totalWalletBalance);
        const available = parseFloat(acc.availableBalance);
        const threshold = totalWallet * (ANTI_LIQUIDATION_LIMIT / 100); 
        
        if (available <= threshold) { 
            addLog(`🚨 KÍCH HOẠT CHỐNG THANH LÝ! Khả dụng ví (${available.toFixed(2)}$) < ${ANTI_LIQUIDATION_LIMIT}%. Tạm dừng bot 30s & blacklist coin...`, "error");
            
            systemSettings.isRunning = false;
            
            const closedSymbols = Array.from(systemBot.activePairs.keys());
            
            const closeRes = await panicCloseAll(`CHỐNG THANH LÝ AN TOÀN (Ví < ${ANTI_LIQUIDATION_LIMIT}%)`); 
            
            for (const sym of closedSymbols) {
                sharedState.blackList[sym] = Date.now() + (30 * 60 * 1000);
            }
            if (closedSymbols.length > 0) {
                addLog(`🚫 Đã Blacklist ${closedSymbols.length} coin vừa đóng trong 30 phút. PnL Chốt Chống Thanh Lý: ${(closeRes.grandTotalPnL || 0).toFixed(4)}$`, "warn");
            }

            setTimeout(() => {
                systemSettings.isRunning = true;
                addLog(`▶️ Bot tự động bật lại sau 30s tạm dừng chống thanh lý.`, "info");
            }, 30000);

            systemBot.isMarginProtected = false; 
            return; 
        }
        
        if (!systemSettings.isRunning) return;

        const availPercent = (available / totalWallet) * 100;
        if (!systemBot.isMarginProtected && availPercent < systemSettings.marginProtect) {
            systemBot.isMarginProtected = true; 
            addLog(`⚠️ Khả dụng hệ thống dưới ${systemSettings.marginProtect}%. Tạm dừng quét cặp mới!`, "warn");
        } else if (systemBot.isMarginProtected && availPercent >= systemSettings.marginRecover) {
            systemBot.isMarginProtected = false; 
            addLog(`✅ Khả dụng khôi phục trên ${systemSettings.marginRecover}%. Tiếp tục quét cặp mới.`, "info");
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
            walletCache.data = { 
                totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
            };
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
        let pnl = 0;
        let realMarginOnExchange = 0;
        posRisk.forEach(pr => { 
            if (pr.symbol === pair.symbol) {
                const amt = Math.abs(parseFloat(pr.positionAmt));
                if (amt > 0) {
                    pnl += parseFloat(pr.unRealizedProfit || 0);
                    realMarginOnExchange += (amt * parseFloat(pr.markPrice)) / pair.leverage;
                }
            }
        });
        
        let gridLongMargin = 0;
        let gridShortMargin = 0;
        let lastLevel = 0;
        
        Object.keys(pair.executedGridLongs).forEach(k => {
             gridLongMargin += pair.executedGridLongs[k].margin || 0;
             const lvlStr = pair.executedGridLongs[k].level.toString().replace(/[^0-9-]/g, ''); 
             lastLevel = Math.max(lastLevel, lvlStr ? Math.abs(parseInt(lvlStr)) : 0);
        });
        Object.keys(pair.executedGridShorts).forEach(k => {
             gridShortMargin += pair.executedGridShorts[k].margin || 0;
             const lvlStr = pair.executedGridShorts[k].level.toString().replace(/[^0-9-]/g, ''); 
             lastLevel = Math.max(lastLevel, lvlStr ? Math.abs(parseInt(lvlStr)) : 0);
        });
        pair.activeNotes.forEach(n => {
             const lvlStr = n.level.toString().replace(/[^0-9-]/g, '');
             lastLevel = Math.max(lastLevel, lvlStr ? Math.abs(parseInt(lvlStr)) : 0);
        });

        return {
            ...pair,
            leverage: pair.leverage, 
            firstEntryPriceFormat: formatPrice(pair.firstEntryPrice),
            unrealizedPnL: pnl.toFixed(2),
            closedNotesPnL: pair.closedNotesPnL.toFixed(4),
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
        status: { 
            botLogs: sharedState.masterLogs, 
            botClosedCount: systemBot.status.botClosedCount, 
            botPnLClosed: systemBot.status.botPnLClosed.toFixed(4), 
            isReady: systemBot.status.isReady, 
            candidatesList: sharedState.candidatesList, 
            blackList: formattedBlacklist 
        }, 
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
// 6. KHỞI CHẠY HỆ THỐNG VÀ VÒNG LẶP QuÉT CẶP MỚI
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
                lockedLevels: {}, 
                activeNotes: [],
                accumulatedFees: initFees,
                
                closedNotesCount: 0,
                closedNotesPnL: 0,
                pnlLockUntil: 0, 
                createdAt: Date.now()
            });

            addLog(`mở lệnh tổng cặp ${symbol} | Giá entry: ${formatPrice(resGrid.price)} | Margin: ${resGrid.margin.toFixed(2)}$ | x${info.maxLeverage}`, "white");
        } catch (e) {
            addLog(`❌ [${symbol}] Lỗi vào lệnh gốc: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(4953, () => console.log('🚀 [HEDGE SYSTEM V8.4] Khởi chạy hoàn chỉnh trên Port 4953!'));
