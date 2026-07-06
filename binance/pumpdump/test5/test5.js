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
    return `[PnL Đã Chốt: ${closedPnL.toFixed(2)}$ | Chưa Chốt: ${currentUnrealizedPnL.toFixed(2)}$ | Tổng: ${totalPnL.toFixed(2)}$ / T.G: ${profitTargetUSD.toFixed(2)}$ | Đạt: ${progressPercent.toFixed(1)}%]`;
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
async function executeBatchOrder(symbol, positionSide, marginUSD, action, customQty = null) {
    if (marginUSD <= 0 && !customQty) return { qty: 0, margin: 0, price: 0 };
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return { qty: 0, margin: 0, price: 0 };

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
        
        if (qty <= 0) return { qty: 0, margin: 0, price: 0 };

        const orderSide = positionSide === 'LONG' ? (action === 'OPEN' ? 'BUY' : 'SELL') : (action === 'OPEN' ? 'SELL' : 'BUY');

        await systemBot.exchange.createOrder(symbol, 'MARKET', orderSide, qty.toFixed(info.quantityPrecision), undefined, { positionSide });
        
        const actualMargin = (qty * currentPrice) / info.maxLeverage;
        return { qty: qty, margin: actualMargin, price: currentPrice };
    } catch (e) {
        addLog(`❌ [${symbol}] Lệnh Market lỗi: ${e.message}`, "error");
        return { qty: 0, margin: 0, price: 0 };
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
                        let realPnL = 0;
                        let totalFee = 0;
                        for (let checkCount = 1; checkCount <= 8; checkCount++) {
                            await new Promise(r => setTimeout(r, 500));
                            try {
                                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, orderId: orderRes.id });
                                if (trades && trades.length > 0) {
                                    realPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                                    totalFee = trades.reduce((sum, t) => sum + parseFloat(t.commission || 0), 0);
                                    break;
                                }
                            } catch {}
                        }
                        return realPnL - totalFee; 
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
            addLog(`💲💲💲 [${symbol}] [${reasonStr}] ĐÓNG TỔNG | Lãi Thực Tế (Net PnL): ${totalNetPnL.toFixed(4)}$`, totalNetPnL >= 0 ? "success" : "sl");
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
// 4. ĐỘNG CƠ MONITOR CHÍNH: 4 LUỒNG TÁCH BIỆT HOÀN TOÀN KHÔNG DÙNG CHUNG
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

            // --- V8.1 FIX LỖI API LAG: Kiểm tra trạng thái tồn tại đồng thời của cặp lệnh ---
            if (!gridPos || !dcaPos) {
                if (!gridPos && !dcaPos) {
                    systemBot.activePairs.delete(symbol);
                    checkAndAddBlacklist(symbol);
                }
                // Nếu chỉ thiếu một bên (do sàn lag chưa kịp update data sau khi chốt note), bỏ qua không tính toán PnL tổng bậy bạ
                continue; 
            }

            systemBot.isProcessingLogic.add(symbol);

            try {
                const markP = parseFloat(gridPos.markPrice);
                const info = sharedState.exchangeInfo[symbol];

                // Tính toán chính xác PnL trạng thái ròng khi chắc chắn có đủ 2 vị thế
                let currentUnrealizedPnL = parseFloat(gridPos.unRealizedProfit || 0) + parseFloat(dcaPos.unRealizedProfit || 0);

                // --- 1. LUỒNG CHỐT LỜI TỔNG ---
                const targetCheckCombinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
                const activeProfitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;
                if (targetCheckCombinedPnL >= activeProfitTargetUSD) {
                    addLog(`⚡ [${symbol}] [TP TỔNG] PnL Đạt: ${targetCheckCombinedPnL.toFixed(2)}$ >= Mục Tiêu: ${activeProfitTargetUSD.toFixed(2)}$`, "success");
                    systemBot.activePairs.delete(symbol);
                    sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000);
                    forceCloseSymbol(symbol, `⚡ CHỐT TỔNG CẶP LỆNH (${targetCheckCombinedPnL.toFixed(2)}$)`).catch(()=>{});
                    systemBot.isProcessingLogic.delete(symbol);
                    continue;
                }

                // --- 2. LUỒNG ĐỘNG CƠ GRID GỐC ---
                const priceDiffGrid = pair.gridSide === 'LONG' ? pair.firstEntryPrice - markP : markP - pair.firstEntryPrice;
                const currentGridLevel = Math.floor(priceDiffGrid / pair.stepUSD);
                
                if (currentGridLevel > 0) {
                    for (let k = 1; k <= currentGridLevel; k++) {
                        if (!pair.executedGridLevels[k]) {
                            pair.executedGridLevels[k] = true;
                            
                            const resGrid = await executeBatchOrder(symbol, pair.gridSide, 0, 'OPEN', pair.baseQty);
                            if (resGrid.margin > 0) {
                                pair.gridTotalMargin += resGrid.margin;
                                addLog(`🟢 [${symbol}] [GRID GỐC MỞ] Tầng ${k} | Giá khớp: ${formatPrice(resGrid.price)} | Margin vào: ${resGrid.margin.toFixed(2)}$`, "open");
                            }
                            
                            const noteQty = pair.baseQty * 5;
                            const resNote = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', noteQty);
                            if (resNote.margin > 0) {
                                pair.dcaTotalMargin += resNote.margin;
                                
                                const tpPrice = pair.dcaSide === 'LONG' ? resNote.price + pair.stepUSD : resNote.price - pair.stepUSD;
                                const nextDcaNotePrice = pair.dcaSide === 'LONG' ? resNote.price - pair.stepUSD : resNote.price + pair.stepUSD;
                                
                                const newNote = {
                                    id: `Note_${k}_${Date.now()}`,
                                    level: k,
                                    openPrice: resNote.price,
                                    dcaNoteAvg: resNote.price,
                                    lastDcaExecutedPrice: resNote.price, 
                                    dcaNoteQty: resNote.qty,
                                    dcaNoteMargin: resNote.margin,
                                    dcaCount: 0,
                                    isProcessing: false,
                                    targetTpPrice: tpPrice               
                                };
                                pair.activeNotes.push(newNote);
                                
                                addLog(`📝 [${symbol}] [NOTE GIRD KHỞI TẠO] Tầng ${k} | Giá khớp: ${formatPrice(resNote.price)} | Margin vào: ${resNote.margin.toFixed(2)}$ | Next DCA Note: ${formatPrice(nextDcaNotePrice)} | Lock TP: ${formatPrice(tpPrice)}`, "open");
                            }
                        }
                    }
                }
                
                const openedGrids = Object.keys(pair.executedGridLevels).filter(k => pair.executedGridLevels[k]).map(Number);
                for (const k of openedGrids) {
                    const closeTarget = pair.gridSide === 'LONG' 
                        ? pair.firstEntryPrice - ((k - 1) * pair.stepUSD)
                        : pair.firstEntryPrice + ((k - 1) * pair.stepUSD);
                        
                    const isHitClose = pair.gridSide === 'LONG' ? markP >= closeTarget : markP <= closeTarget;
                    
                    if (isHitClose) {
                        pair.executedGridLevels[k] = false; 
                        const resGridClose = await executeBatchOrder(symbol, pair.gridSide, 0, 'CLOSE', pair.baseQty);
                        pair.gridTotalMargin = Math.max(pair.initialMargin, pair.gridTotalMargin - pair.initialMargin);
                        addLog(`🔴 [${symbol}] [GRID GỐC ĐÓNG] Thu hồi Tầng ${k} | Giá chạm đóng: ${formatPrice(markP)}`, "warn");
                    }
                }

                // --- 3. LUỒNG ĐỘNG CƠ DCA GỐC ---
                const priceDiffDca = pair.dcaSide === 'LONG' ? pair.firstEntryPrice - markP : markP - pair.firstEntryPrice;
                const currentDcaBaseLevel = Math.floor(priceDiffDca / pair.stepUSD);
                
                if (currentDcaBaseLevel > 0) {
                    for (let k = 1; k <= currentDcaBaseLevel; k++) {
                        if (k >= systemSettings.maxDcaBaseLevels) {
                            await forceCloseSymbol(symbol, `CHẠM GIỚI HẠN DCA GỐC TẦNG ${k}`);
                            checkAndAddBlacklist(symbol);
                            break;
                        }

                        if (!pair.executedDcaBaseLevels[k]) {
                            pair.executedDcaBaseLevels[k] = true;
                            
                            const dcaBaseQty = pair.baseQty * systemSettings.heSoDCA;
                            const resDcaBase = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaBaseQty);
                            
                            if (resDcaBase.margin > 0) {
                                pair.dcaTotalMargin += resDcaBase.margin;
                                pair.lastDcaBaseLevel = k;
                                
                                const nextDcaBasePrice = pair.dcaSide === 'LONG' ? pair.firstEntryPrice - ((k+1) * pair.stepUSD) : pair.firstEntryPrice + ((k+1) * pair.stepUSD);
                                
                                addLog(`🔵 [${symbol}] [DCA GỐC MỞ] Tầng ${k} | Giá khớp: ${formatPrice(resDcaBase.price)} | Margin USDT nhồi: ${resDcaBase.margin.toFixed(2)}$ | Next DCA Gốc: ${formatPrice(nextDcaBasePrice)}`, "info");
                            }
                        }
                    }
                }

                // --- 4. LUỒNG ĐỘNG CƠ NOTE DCA & TP NOTE ĐỘC LẬP ---
                let notesToClose = [];
                let totalCloseQty = 0;

                for (let note of pair.activeNotes) {
                    if (note.isProcessing) continue;

                    const isNoteHitTp = pair.dcaSide === 'LONG' ? markP >= note.targetTpPrice : markP <= note.targetTpPrice;
                    if (isNoteHitTp) {
                        note.isProcessing = true;
                        notesToClose.push(note);
                        totalCloseQty += note.dcaNoteQty;
                        continue;
                    }

                    const isNoteGoingWrong = pair.dcaSide === 'LONG' 
                        ? note.lastDcaExecutedPrice - markP >= pair.stepUSD 
                        : markP - note.lastDcaExecutedPrice >= pair.stepUSD;
                        
                    if (isNoteGoingWrong) {
                        note.isProcessing = true;

                        const dcaQtyAdded = note.dcaNoteQty; 
                        const resNoteDca = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQtyAdded);
                        
                        if (resNoteDca.margin > 0) {
                            pair.dcaTotalMargin += resNoteDca.margin;

                            note.dcaNoteAvg = ((note.dcaNoteAvg * note.dcaNoteMargin) + (resNoteDca.price * resNoteDca.margin)) / (note.dcaNoteMargin + resNoteDca.margin);
                            note.lastDcaExecutedPrice = resNoteDca.price; 
                            note.dcaNoteMargin += resNoteDca.margin;
                            note.dcaNoteQty += resNoteDca.qty;
                            note.dcaCount++;

                            note.targetTpPrice = pair.dcaSide === 'LONG' ? note.dcaNoteAvg + pair.stepUSD : note.dcaNoteAvg - pair.stepUSD;
                            const nextNoteDcaPrice = pair.dcaSide === 'LONG' ? note.lastDcaExecutedPrice - pair.stepUSD : note.lastDcaExecutedPrice + pair.stepUSD;

                            addLog(`🟡 [${symbol}] [NOTE DCA NHỒI] Lần ${note.dcaCount} (Của Note Tầng ${note.level}) | Giá khớp: ${formatPrice(resNoteDca.price)} | Margin USDT nhồi: ${resNoteDca.margin.toFixed(2)}$ | Next DCA Note: ${formatPrice(nextNoteDcaPrice)} | Lock TP Mới: ${formatPrice(note.targetTpPrice)}`, "warn");
                        }
                        note.isProcessing = false;
                    }
                }

                if (notesToClose.length > 0) {
                    const orderData = {
                        symbol: symbol,
                        side: pair.dcaSide === 'LONG' ? 'SELL' : 'BUY',
                        positionSide: pair.dcaSide,
                        type: 'MARKET',
                        quantity: totalCloseQty.toFixed(info.quantityPrecision)
                    };

                    const resDca = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch(e => {
                        addLog(`❌ [${symbol}] Lỗi chốt Note: ${e.message}`, "error");
                        notesToClose.forEach(n => n.isProcessing = false);
                        return null;
                    });

                    if (resDca && resDca.orderId) {
                        const closedIds = notesToClose.map(n => n.id);
                        pair.activeNotes = pair.activeNotes.filter(n => !closedIds.includes(n.id));
                        pair.closedNotesCount += notesToClose.length;

                        (async () => {
                            let realPnL = 0;
                            let totalFee = 0;
                            for (let checkCount = 1; checkCount <= 8; checkCount++) {
                                await new Promise(r => setTimeout(r, 500));
                                try {
                                    const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, orderId: resDca.orderId });
                                    if (trades && trades.length > 0) {
                                        realPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                                        totalFee = trades.reduce((sum, t) => sum + parseFloat(t.commission || 0), 0);
                                        break;
                                    }
                                } catch {}
                            }
                            
                            const netPnL = realPnL - totalFee; 
                            pair.closedNotesPnL += netPnL;
                            const progressStr = getPairProgressStr(pair, currentUnrealizedPnL);
                            addLog(`💲 [${symbol}] [CHỐT LỜI NOTE] Giải phóng ${notesToClose.length} Note | Lãi Gộp: ${realPnL.toFixed(4)}$ | Phí Sàn: ${totalFee.toFixed(4)}$ | Thực Nhận (Net): ${netPnL.toFixed(4)}$ | ${progressStr}`, "success");
                        })();
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
// ĐỘNG CƠ FAST TP MONITOR SIÊU TỐC ĐỘ 250MS (BẢN SỬA LỖI LAG)
// ============================================================================
async function fastTpMonitor() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return setTimeout(fastTpMonitor, 250);

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(fastTpMonitor, 250);

        for (let [symbol, pair] of systemBot.activePairs) {
            if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol]) continue;

            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide && Math.abs(parseFloat(p.positionAmt || 0)) > 0);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide && Math.abs(parseFloat(p.positionAmt || 0)) > 0);

            // --- V8.1 FIX API LAG: Phải tìm thấy ĐỒNG THỜI 2 vị thế thì mới check TP Tổng ---
            if (!gridPos || !dcaPos) continue; 

            let currentUnrealizedPnL = parseFloat(gridPos.unRealizedProfit || 0) + parseFloat(dcaPos.unRealizedProfit || 0);
            const combinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
            const profitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;

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

            const resGrid = await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'OPEN', targetQty);
            const resDcaBase = await executeBatchOrder(symbol, entrySignal.dcaSide, 0, 'OPEN', targetQty);

            if (resGrid.margin <= 0 || resDcaBase.margin <= 0) {
                throw new Error("Không khởi tạo được vị thế phân bổ từ sàn.");
            }

            const absoluteStepUSD = resGrid.price * (systemSettings.gridStepPercent / 100);
            
            systemBot.activePairs.set(symbol, {
                symbol: symbol,
                gridSide: entrySignal.gridSide,
                dcaSide: entrySignal.dcaSide,
                firstEntryPrice: resGrid.price,
                initialMargin: resGrid.margin, 
                baseQty: targetQty, 
                leverage: info.maxLeverage, 
                stepUSD: absoluteStepUSD,
                
                executedGridLevels: {}, 
                executedDcaBaseLevels: {},
                activeNotes: [],
                
                currentGridCount: 1, 
                lastDcaBaseLevel: 0,
                closedNotesCount: 0,
                closedNotesPnL: 0,
                gridTotalMargin: resGrid.margin,
                dcaTotalMargin: resDcaBase.margin,
                createdAt: Date.now()
            });

            const expectedTpUSD = parseFloat(systemSettings.tpPercent) * resGrid.margin;
            const nextGridPrice = entrySignal.gridSide === 'LONG' ? resGrid.price - absoluteStepUSD : resGrid.price + absoluteStepUSD;
            const nextDcaBasePrice = entrySignal.dcaSide === 'LONG' ? resGrid.price - absoluteStepUSD : resGrid.price + absoluteStepUSD;

            addLog(`🚀 [${symbol}] [VÀO LỆNH TỔNG CẶP] Đòn bẩy: x${info.maxLeverage} | Giá vào lệnh: ${formatPrice(resGrid.price)} | Margin Khởi tạo: ${resGrid.margin.toFixed(2)}$ | Next Grid: ${formatPrice(nextGridPrice)} | Next DCA Gốc: ${formatPrice(nextDcaBasePrice)} | TP Mục Tiêu: ${expectedTpUSD.toFixed(2)}$`, "open");
        } catch (e) {
            addLog(`❌ [${symbol}] Lỗi vào lệnh gốc: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1997, () => console.log('🚀 [HEDGE SYSTEM V8.1] Khởi chạy hoàn chỉnh chống Lag API trên Port 1997!'));
