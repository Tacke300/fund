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
const ANTI_LIQUIDATION_LIMIT = 10; // Giữ nguyên mức chống thanh lý xuống 10% theo yêu cầu trước
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  

const globalStartTime = Date.now();

function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

function formatPrice(num) {
    if (!num) return "0";
    let n = parseFloat(num);
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.01) return n.toFixed(5);
    return n.toPrecision(5).replace(/0+$/, '').replace(/\.$/, ''); 
}

let walletCache = {
    data: {
        totalWalletBalance: "0",
        availableBalance: "0",
        totalUnrealizedProfit: "0"
    },
    lastUpdate: 0
};

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
    tpPercent: 1.0
};

let systemBot = {
    id: "MASTER_BOT",
    startTime: Date.now(),
    status: {
        botClosedCount: 0,
        botPnLClosed: 0,
        pnlGain: 0,
        pnlLoss: 0,
        isReady: false
    },
    activePairs: new Map(),
    isProcessingLogic: new Set(),
    timestampOffset: 0,
    isMarginProtected: false,
    exchange: new ccxt.binance({
        apiKey: API_KEY,
        secret: SECRET_KEY,
        enableRateLimit: true,
        options: {
            defaultType: 'future',
            dualSidePosition: true,
            recvWindow: 60000,
            adjustForTimeDifference: true
        }
    }),
    binanceApi: axios.create({
        baseURL: 'https://fapi.binance.com',
        timeout: 60000,
        headers: { 'X-MBX-APIKEY': API_KEY }
    })
};

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };
    sharedState.masterLogs.unshift(logItem);
    if (sharedState.masterLogs.length > 1000) sharedState.masterLogs.pop();
    console.log(`[${time}][${type.toUpperCase()}] ${msg}`);
}

// --------------------------------------------------------------------
// BỘ NHỚ LƯU TRẠNG THÁI LOG GẦN NHẤT ĐỂ CHỐNG SPAM (CHỈ LOG KHI THAY ĐỔI)
// --------------------------------------------------------------------
let lastLoggedState = new Map();

function debugPosition(pair, symbol, eventName = "SỰ KIỆN") {
    const activeNotesLen = pair.activeNotes?.length || 0;
    const executedDcaLen = pair.executedDcaBaseLevels ? Object.keys(pair.executedDcaBaseLevels).length : 0;
    
    // Khóa duy nhất xác định trạng thái thực tế dựa trên các biến số lõi
    const logKey = `${symbol}_${eventName.toUpperCase()}`;
    const logValueSnapshot = `${pair.nextGridIndex}_${activeNotesLen}_${pair.totalNotesCreated}_${pair.closedNotesCount}_${executedDcaLen}_${pair.isClosing}`;

    // Nếu sự kiện với trạng thái số liệu này đã log rồi -> Bỏ qua không in trùng lặp
    if (lastLoggedState.get(logKey) === logValueSnapshot) {
        return;
    }
    // Cập nhật trạng thái log mới nhất
    lastLoggedState.set(logKey, logValueSnapshot);

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    let block = `\n================================================================\n`;
    block += `🕒 TIME: [${time}] | SYMBOL: ${symbol} | EVENT: [${eventName.toUpperCase()}]\n`;
    block += `----------------------------------------------------------------\n`;
    block += `📈 Mark Price: ${formatPrice(pair.lastGridPriceRef || 0)} | Leverage: x${pair.leverage || 0}\n`;
    block += `📐 Grid Side: ${pair.gridSide} | DCA Side: ${pair.dcaSide}\n`;
    block += `💰 Grid Avg Price: ${formatPrice(pair.gridAvgPrice)} | DCA Avg Price: ${formatPrice(pair.dcaAvgPrice)}\n`;
    block += `📦 Base Qty: ${pair.baseQty} | Grid Step: ${pair.stepUSD?.toFixed(4)} USD\n`;
    block += `💳 Total Margin Used: Grid: ${pair.gridTotalMargin?.toFixed(2)}$ | DCA: ${pair.dcaTotalMargin?.toFixed(2)}$\n`;
    block += `💵 Initial Margin Target: ${pair.initialMargin?.toFixed(2)}$\n`;
    block += `🔄 Floating PnL: ${(parseFloat(pair.unrealizedPnL) || 0).toFixed(2)}$ | Closed Notes PnL: ${pair.closedNotesPnL?.toFixed(2)}$\n`;
    block += `🎯 Combined PnL Total: ${(pair.closedNotesPnL + (parseFloat(pair.unrealizedPnL) || 0)).toFixed(2)}$ | Target TP: ${(parseFloat(systemSettings.tpPercent) * pair.initialMargin).toFixed(2)}$\n`;
    block += `📊 NextGridIndex: ${pair.nextGridIndex} | Active Notes Count: ${activeNotesLen}\n`;
    block += `📉 Total Notes Created: ${pair.totalNotesCreated} | Closed Notes Count: ${pair.closedNotesCount}\n`;
    block += `🛠️ Executed DCA Base Levels: ${JSON.stringify(pair.executedDcaBaseLevels)}\n`;
    block += `📅 Created At: ${new Date(pair.createdAt).toLocaleString('vi-VN', { hour12: false })}\n`;
    
    if (pair.activeNotes && pair.activeNotes.length > 0) {
        block += `-------------------- ACTIVE NOTES DETAILS ----------------------\n`;
        pair.activeNotes.forEach(note => {
            block += ` ├─ ID: ${note.id} | Index: ${note.noteIndex} | EntryPrice: ${formatPrice(note.entryPrice)}\n`;
            block += ` │  ├─ Grid: Qty: ${note.gridQty}, Margin USDT: ${note.gridMargin?.toFixed(2)}$\n`;
            block += ` │  └─ DCA: Qty: ${note.dcaNoteQty}, Margin USDT: ${note.dcaNoteMargin?.toFixed(2)}$, AvgPrice: ${formatPrice(note.dcaNoteAvg)}, Count: ${note.dcaCount}\n`;
            block += ` │  └─ DCA History (Last 10): ${JSON.stringify(note.dcaHistory)}\n`;
        });
    }
    block += `================================================================\n`;
    console.log(block);
}

async function binancePrivate(endpoint, method = 'GET', data = {}, retryCount = 0) {
    try {
        const timestamp = Date.now() + systemBot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await systemBot.binanceApi({
            method,
            url: `${endpoint}?${query}&signature=${signature}`
        });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021 && retryCount < 10) {
            try {
                const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
                systemBot.timestampOffset = t.data.serverTime - Date.now();
                return await binancePrivate(endpoint, method, data, retryCount + 1);
            } catch (syncError) {
                throw e;
            }
        }
        throw e;
    }
}

function checkAndAddBlacklist(symbol) {
    sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
    forceCloseSymbol(symbol, "ĐÓNG KHI KÍCH HOẠT BLACKLIST").catch(() => {});
}

async function executeBatchOrder(symbol, positionSide, marginUSD, action, customQty = null) {
    if (marginUSD <= 0 && !customQty) return { success: false, actualQty: 0, actualMargin: 0, price: 0 };
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return { success: false, actualQty: 0, actualMargin: 0, price: 0 };

    try {
        const ticker = await systemBot.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
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
        
        if (qty <= 0) return { success: false, actualQty: 0, actualMargin: 0, price: 0 };

        const orderSide = positionSide === 'LONG'
            ? (action === 'OPEN' ? 'BUY' : 'SELL')
            : (action === 'OPEN' ? 'SELL' : 'BUY');

        addLog(`⚙️ Thao tác Bot: Phát lệnh Market [${action}] | ${symbol} | Side: ${orderSide} | PosSide: ${positionSide} | Qty dự kiến: ${qty}`, "info");

        const orderRes = await systemBot.exchange.createOrder(
            symbol,
            'MARKET',
            orderSide,
            qty.toFixed(info.quantityPrecision),
            undefined,
            { positionSide }
        );

        const filledQty = orderRes && orderRes.filled ? parseFloat(orderRes.filled) : 0;
        const avgPriceReal = orderRes && orderRes.price ? parseFloat(orderRes.price) : currentPrice;
        const actualMarginUsed = (filledQty * avgPriceReal) / info.maxLeverage;

        if (filledQty <= 0) return { success: false, actualQty: 0, actualMargin: 0, price: 0 };

        addLog(`✅ Vị thế chi tiết [${action}] THÀNH CÔNG | ${symbol} | Giá khớp: ${avgPriceReal} | Qty thực tế: ${filledQty} | Ký quỹ: ${actualMarginUsed.toFixed(2)}$`, "success");

        return {
            success: true,
            actualQty: filledQty,
            actualMargin: actualMarginUsed,
            price: avgPriceReal
        };
    } catch (e) {
        addLog(`❌ Thao tác Bot [${action}] cho ${symbol} THẤT BẠI: ${e.message}`, "error");
        return { success: false, actualQty: 0, actualMargin: 0, price: 0 };
    }
}

async function forceCloseSymbol(symbol, reasonStr) {
    let pairData = systemBot.activePairs.get(symbol);
    if (pairData) pairData.isClosing = true;

    addLog(`🚨 KÍCH HOẠT ĐÓNG KHẨN CẤP VỊ THẾ CẶP | ${symbol} | Lý do: ${reasonStr}`, "warn");

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => null);
        if (!posRisk) {
            if (pairData) pairData.isClosing = false;
            return;
        }

        let totalPnL = 0;
        const closePromises = [];
        
        for (const p of posRisk) {
            const amt = parseFloat(p.positionAmt);
            if (Math.abs(amt) > 0) {
                const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                
                const pOrder = systemBot.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide })
                    .then((res) => {
                        const realOrderPnL = res && res.info && res.info.realizedPnl ? parseFloat(res.info.realizedPnl) : parseFloat(p.unRealizedProfit || 0);
                        totalPnL += realOrderPnL;
                        return res;
                    })
                    .catch((err) => addLog(`❌ Lỗi đóng vị thế ${p.positionSide} của ${symbol}: ${err.message}`, "error"));
                
                closePromises.push(pOrder);
            }
        }
        
        await Promise.allSettled(closePromises);

        systemBot.status.botClosedCount++;
        systemBot.status.botPnLClosed += totalPnL;
        if (totalPnL >= 0) systemBot.status.pnlGain = (systemBot.status.pnlGain || 0) + totalPnL;
        else systemBot.status.pnlLoss = (systemBot.status.pnlLoss || 0) + totalPnL;

        if (pairData) {
            debugPosition(pairData, symbol, "FORCE CLOSE SUCCESS");
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG THÀNH CÔNG VỊ THẾ TỔNG TÀI KHOẢN ${symbol} | PnL Tổng: ${totalPnL.toFixed(2)}$ | Số Note: ${pairData.closedNotesCount}`, totalPnL >= 0 ? "success" : "sl");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addLog(`❌ LỖI KHI ĐÓNG VỊ THẾ KHẨN CẤP ${symbol}: ${e.message}`, "error");
    } finally {
        systemBot.activePairs.delete(symbol);
    }
}

async function panicCloseAll(reasonLog) {
    addLog(`🚨🚨🚨 CHỈ THỊ PANIC CLOSE ALL | Lý do: ${reasonLog}`, "error");
    try {
        const activeSymbols = Array.from(systemBot.activePairs.keys());
        for(let sym of activeSymbols) {
            await forceCloseSymbol(sym, reasonLog);
        }
        return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
}

// ============================================================================
// 4. LUỒNG QUÉT GIÁ CHÍNH VÀ GIẢI QUYẾT SAI LỆCH TRẠNG THÁI (STATE SYNC)
// ============================================================================
async function priceMonitor() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return setTimeout(priceMonitor, 400);
    
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(priceMonitor, 400);
        
        for (let [symbol, pair] of systemBot.activePairs) {
            if (!systemBot.activePairs.has(symbol) || systemBot.isProcessingLogic.has(symbol) || pair.isClosing) continue;
            
            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide && Math.abs(parseFloat(p.positionAmt)) > 0);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide && Math.abs(parseFloat(p.positionAmt)) > 0);

            if (!gridPos && !dcaPos) {
                systemBot.activePairs.delete(symbol);
                continue;
            }

            systemBot.isProcessingLogic.add(symbol);

            try {
                const markP = parseFloat((gridPos || dcaPos).markPrice);
                
                let totalUnrealizedPnL = 0;
                if (gridPos) totalUnrealizedPnL += parseFloat(gridPos.unRealizedProfit || 0);
                if (dcaPos) totalUnrealizedPnL += parseFloat(dcaPos.unRealizedProfit || 0);
                pair.unrealizedPnL = totalUnrealizedPnL;

                if (pair.gridSide === 'LONG') {
                    if (markP > pair.maxPriceSinceLastGrid) pair.maxPriceSinceLastGrid = markP;
                } else {
                    if (markP < pair.maxPriceSinceLastGrid) pair.maxPriceSinceLastGrid = markP;
                }

                const targetCheckCombinedPnL = pair.closedNotesPnL + totalUnrealizedPnL;
                const activeProfitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;
                
                if (targetCheckCombinedPnL >= activeProfitTargetUSD) {
                    pair.isClosing = true;
                    await forceCloseSymbol(symbol, `⚡ TP CHỐT LỜI TỔNG CẶP (PnL: ${targetCheckCombinedPnL.toFixed(2)}$)`);
                    systemBot.isProcessingLogic.delete(symbol);
                    continue;
                }

                const info = sharedState.exchangeInfo[symbol];

                // --------------------------------------------------------------------
                // LUỒNG CHỐT NOTE UNLOCKED GỘP AN TOÀN
                // --------------------------------------------------------------------
                let notesToClose = [];
                let dcaNotesToCloseQty = 0;
                let totalMarginOfNotesToClose = 0;

                for (let i = pair.activeNotes.length - 1; i >= 0; i--) {
                    const note = pair.activeNotes[i];
                    const targetTpPrice = pair.dcaSide === 'LONG' ? note.dcaNoteAvg + pair.stepUSD : note.dcaNoteAvg - pair.stepUSD;
                    const isHit = pair.dcaSide === 'LONG' ? markP >= targetTpPrice : markP <= targetTpPrice;

                    if (isHit) {
                        notesToClose.push(note);
                        dcaNotesToCloseQty += note.dcaNoteQty;
                        totalMarginOfNotesToClose += note.dcaNoteMargin;
                    }
                }

                let localClosedIdsThisTick = new Set();

                if (notesToClose.length > 0) {
                    const orderData = {
                        symbol: symbol,
                        side: pair.dcaSide === 'LONG' ? 'SELL' : 'BUY', 
                        positionSide: pair.dcaSide, 
                        type: 'MARKET',
                        quantity: dcaNotesToCloseQty.toFixed(info.quantityPrecision)
                    };

                    const resDca = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch(() => null);

                    if (resDca && resDca.orderId) {
                        notesToClose.forEach(n => {
                            localClosedIdsThisTick.add(n.id);
                        });
                        pair.activeNotes = pair.activeNotes.filter(active => !localClosedIdsThisTick.has(active.id));

                        pair.dcaTotalMargin = Math.max(0, pair.dcaTotalMargin - totalMarginOfNotesToClose);
                        pair.lastGridPriceRef = markP;
                        pair.maxPriceSinceLastGrid = markP;

                        const fetchRealizedPnL = async (attempts = 0) => {
                            try {
                                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, orderId: resDca.orderId });
                                if (trades && trades.length > 0) {
                                    const realPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                                    pair.closedNotesPnL += realPnL;
                                    pair.closedNotesCount += notesToClose.length;
                                    
                                    debugPosition(pair, symbol, "TP NOTE SUCCESS");
                                } else if (attempts < 5) {
                                    setTimeout(() => fetchRealizedPnL(attempts + 1), 2000);
                                } else {
                                    const orderInfo = await binancePrivate('/fapi/v1/order', 'GET', { symbol, orderId: resDca.orderId }).catch(() => null);
                                    const fallbackPnL = orderInfo && orderInfo.cumProfit ? parseFloat(orderInfo.cumProfit) : 0;
                                    pair.closedNotesPnL += fallbackPnL;
                                    pair.closedNotesCount += notesToClose.length;
                                    
                                    debugPosition(pair, symbol, "TP NOTE SUCCESS");
                                }
                            } catch(e) {}
                        };
                        setTimeout(() => fetchRealizedPnL(0), 1200);
                    }
                }

                // --------------------------------------------------------------------
                // LUỒNG MỞ LƯỚI & NOTE MỚI
                // --------------------------------------------------------------------
                let isGridConditionMet = false;
                if (pair.gridSide === 'LONG') {
                    isGridConditionMet = (pair.maxPriceSinceLastGrid - markP) >= pair.stepUSD;
                } else {
                    isGridConditionMet = (markP - pair.maxPriceSinceLastGrid) >= pair.stepUSD;
                }

                if (isGridConditionMet) {
                    if (pair.nextGridIndex === undefined) pair.nextGridIndex = 1;
                    
                    const gridResult = await executeBatchOrder(symbol, pair.gridSide, 0, 'OPEN', pair.baseQty);
                    
                    if (gridResult.success) {
                        const dcaQtyX10 = pair.baseQty * 10;
                        const dcaResult = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQtyX10);

                        if (dcaResult.success) {
                            let expectedDcaQty = gridResult.actualQty * 10;
                            let infoPrecision = info.stepSize;
                            expectedDcaQty = Math.floor(expectedDcaQty / infoPrecision) * infoPrecision;

                            if (Math.abs(dcaResult.actualQty - expectedDcaQty) > infoPrecision) {
                                addLog(`🚨 [PARTIAL FILL DETECTED] Chân DCA không khớp đủ tỉ lệ x10. Tiến hành cân bằng...`, "warn");
                                let correctGridQty = dcaResult.actualQty / 10;
                                correctGridQty = Math.floor(correctGridQty / infoPrecision) * infoPrecision;
                                let excessGridQty = gridResult.actualQty - correctGridQty;
                                excessGridQty = Math.floor(excessGridQty / infoPrecision) * infoPrecision;

                                if (excessGridQty > 0) {
                                    const fixGridRes = await executeBatchOrder(symbol, pair.gridSide, 0, 'CLOSE', excessGridQty);
                                    if (fixGridRes.success) {
                                        gridResult.actualQty = correctGridQty;
                                        gridResult.actualMargin = (gridResult.actualQty * gridResult.price) / info.maxLeverage;
                                    }
                                }
                            }

                            pair.gridAvgPrice = ((pair.gridAvgPrice * pair.gridTotalMargin) + (gridResult.price * gridResult.actualMargin)) / (pair.gridTotalMargin + gridResult.actualMargin);
                            pair.dcaAvgPrice = ((pair.dcaAvgPrice * pair.dcaTotalMargin) + (dcaResult.price * dcaResult.actualMargin)) / (pair.dcaTotalMargin + dcaResult.actualMargin);

                            pair.gridTotalMargin += gridResult.actualMargin;
                            pair.totalNotesCreated = (pair.totalNotesCreated || 0) + 1;

                            const newNote = { 
                                id: `Note_Idx_${pair.nextGridIndex}_${Date.now()}`,
                                noteIndex: pair.nextGridIndex,
                                entryPrice: gridResult.price, 
                                gridQty: gridResult.actualQty, 
                                dcaNoteQty: dcaResult.actualQty, 
                                gridMargin: gridResult.actualMargin, 
                                dcaNoteMargin: dcaResult.actualMargin, 
                                dcaNoteAvg: dcaResult.price,  
                                dcaCount: 1, 
                                dcaHistory: [dcaResult.price]
                            };
                            
                            pair.activeNotes.push(newNote);
                            pair.activeNotes.sort((a, b) => (a.noteIndex || 0) - (b.noteIndex || 0));

                            pair.dcaTotalMargin += dcaResult.actualMargin;
                            
                            pair.lastGridPriceRef = markP;
                            pair.maxPriceSinceLastGrid = markP;
                            pair.nextGridIndex += 1;
                            
                            debugPosition(pair, symbol, "OPEN NOTE");
                        } else {
                            addLog(`🚨 [ROLLBACK] Lỗi mở DCA đối ứng cho Note. Hủy bỏ vị thế Grid bảo vệ tài khoản...`, "error");
                            const rollbackRes = await executeBatchOrder(symbol, pair.gridSide, 0, 'CLOSE', gridResult.actualQty);
                            if (!rollbackRes.success) {
                                pair.isClosing = true;
                                await forceCloseSymbol(symbol, "LỖI NGUYÊN TỬ PHÁT SINH KHI ROLLBACK THẤT BẠI");
                                checkAndAddBlacklist(symbol);
                                systemBot.isProcessingLogic.delete(symbol);
                                continue;
                            }
                        }
                    }
                }
                
                // --------------------------------------------------------------------
                // LUỒNG DCA VỊ THẾ GỐC TOÀN DIỆN
                // --------------------------------------------------------------------
                if (pair.lastLevel !== undefined) {
                    const priceDiff = Math.abs(markP - pair.firstEntryPrice);
                    const currentLevel = Math.floor(priceDiff / pair.stepUSD);

                    if (currentLevel > pair.lastLevel) {
                        for (let k = pair.lastLevel + 1; k <= currentLevel; k++) {
                            if (!pair.executedDcaBaseLevels[k]) {
                                const targetDcaPrice = pair.dcaSide === 'LONG' 
                                    ? pair.firstEntryPrice + (k * pair.stepUSD) 
                                    : pair.firstEntryPrice - (k * pair.stepUSD);
                                
                                const isDcaBaseCondition = pair.dcaSide === 'LONG' ? (markP >= targetDcaPrice) : (markP <= targetDcaPrice);

                                if (isDcaBaseCondition) {
                                    const dcaQty = pair.baseQty * systemSettings.heSoDCA;
                                    const dcaBaseRes = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQty);
                                    if (dcaBaseRes.success) {
                                        pair.dcaAvgPrice = ((pair.dcaAvgPrice * pair.dcaTotalMargin) + (dcaBaseRes.price * dcaBaseRes.actualMargin)) / (pair.dcaTotalMargin + dcaBaseRes.actualMargin);
                                        
                                        pair.executedDcaBaseLevels[k] = true;
                                        pair.dcaTotalMargin += dcaBaseRes.actualMargin;
                                        
                                        debugPosition(pair, symbol, `DCA BASE LEVEL ${k}`);
                                    }
                                }
                            }
                        }
                        pair.lastLevel = currentLevel;
                    }
                }
                
                // --------------------------------------------------------------------
                // LUỒNG TUẦN TỰ DCA THÊM CHO NOTE KHI ĐI NGƯỢC BIÊN ĐỘ
                // --------------------------------------------------------------------
                for (let note of pair.activeNotes) {
                    if (localClosedIdsThisTick.has(note.id)) continue;

                    const lastDcaPrice = note.dcaHistory[note.dcaHistory.length - 1];
                    let isDcaNoteTriggered = pair.dcaSide === 'LONG' 
                        ? (markP <= lastDcaPrice - pair.stepUSD) 
                        : (markP >= lastDcaPrice + pair.stepUSD);

                    if (isDcaNoteTriggered) {
                        const dcaQtyX10 = pair.baseQty * 10;
                        const dcaNoteAddedRes = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQtyX10);
                        
                        if (dcaNoteAddedRes.success) {
                            pair.dcaAvgPrice = ((pair.dcaAvgPrice * pair.dcaTotalMargin) + (dcaNoteAddedRes.price * dcaNoteAddedRes.actualMargin)) / (pair.dcaTotalMargin + dcaNoteAddedRes.actualMargin);

                            note.dcaNoteAvg = ((note.dcaNoteAvg * note.dcaNoteMargin) + (dcaNoteAddedRes.price * dcaNoteAddedRes.actualMargin)) / (note.dcaNoteMargin + dcaNoteAddedRes.actualMargin);
                            note.dcaNoteMargin += dcaNoteAddedRes.actualMargin;
                            note.dcaNoteQty += dcaNoteAddedRes.actualQty;
                            note.dcaCount += 1;
                            note.dcaHistory.push(dcaNoteAddedRes.price);
                            
                            pair.dcaTotalMargin += dcaNoteAddedRes.actualMargin;
                            
                            debugPosition(pair, symbol, `DCA NOTE INDEX ${note.noteIndex}`);
                        }
                    }
                }

            } catch(e) {
                addLog(`❌ Lỗi luồng quét giá cặp ${symbol}: ${e.message}`, "error");
            } finally {
                systemBot.isProcessingLogic.delete(symbol);
            }
        }
    } catch (e) {
        addLog(`❌ Lỗi tổng tại luồng priceMonitor: ${e.message}`, "error");
    }
    
    // ĐÃ LOẠI BỎ LOG THÔNG BÁO HIỆU NĂNG GÂY SPAM TẠI ĐÂY TỰ ĐỘNG THEO DÕI QUA 400MS
    setTimeout(priceMonitor, 400); 
}

// ============================================================================
// LUỒNG THEO DÕI TP NHANH, BẢO VỆ KÝ QUỸ VÀ KHỞI TẠO HỆ THỐNG
// ============================================================================
async function fastTpMonitor() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return setTimeout(fastTpMonitor, 250);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(fastTpMonitor, 250);

        for (let [symbol, pair] of systemBot.activePairs) {
            if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol] || pair.isClosing) continue;

            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide);

            let currentUnrealizedPnL = 0;
            if (gridPos && Math.abs(parseFloat(gridPos.positionAmt || 0)) > 0) currentUnrealizedPnL += parseFloat(gridPos.unRealizedProfit || 0);
            if (dcaPos && Math.abs(parseFloat(dcaPos.positionAmt || 0)) > 0) currentUnrealizedPnL += parseFloat(dcaPos.unRealizedProfit || 0);
            pair.unrealizedPnL = currentUnrealizedPnL;

            const combinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
            const profitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;

            if (combinedPnL >= profitTargetUSD) {
                pair.isClosing = true; 
                debugPosition(pair, symbol, "FAST TP TRIGGERED");
                await forceCloseSymbol(symbol, `⚡ FAST TP CHỐT LỜI TỔNG CẶP`);
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
            await panicCloseAll(`KÍCH HOẠT CHỐNG THANH LÝ KHẨN CẤP DƯỚI ${ANTI_LIQUIDATION_LIMIT}%`); 
            systemBot.isMarginProtected = false; 
            return; 
        }
        if (!systemBot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
            systemBot.isMarginProtected = true; addLog(`⚠️ Khả dụng dưới ${MARGIN_PROTECT_LIMIT}%. Tạm thời dừng quét vào cặp mới!`, "warn");
        } else if (systemBot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            systemBot.isMarginProtected = false; addLog(`✅ An toàn: Số dư khả dụng phục hồi trên ${MARGIN_RECOVER_LIMIT}%. Mở lại luồng quét cặp mới.`, "info");
        }
    }
}

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

appServer.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
        return { ...pair, firstEntryPriceFormat: formatPrice(pair.firstEntryPrice), unrealizedPnL: pnl.toFixed(2), activeNotesCount: pair.activeNotes.length };
    });

    return { 
        botSettings: systemSettings, activePositions: activePairsFormatted, 
        exchangePositions: posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => ({...p, entryPriceFormat: formatPrice(p.entryPrice)})), 
        status: { botLogs: sharedState.masterLogs, botClosedCount: systemBot.status.botClosedCount, botPnLClosed: systemBot.status.botPnLClosed, isReady: systemBot.status.isReady, candidatesList: sharedState.candidatesList, blackList: formattedBlacklist }, 
        wallet: walletCache.data
    };
}

appServer.post('/api/settings', (req, res) => {
    for (let key in req.body) {
        if (['tpPercent', 'gridStepPercent', 'heSoDCA', 'minVol', 'maxPositions'].includes(key)) {
            systemSettings[key] = parseFloat(req.body[key]);
        } else { systemSettings[key] = req.body[key]; }
    }
    res.json({ success: true, msg: "Cập nhật cấu hình thành công!" });
});

appServer.get('/api/status', async (req, res) => res.json(await buildStatusResponse()));
appServer.post('/api/close_all', async (req, res) => res.json(await panicCloseAll("PANIC CLOSE TỪ UI")));
appServer.post('/api/close_position', async (req, res) => { 
    const { symbol } = req.body; 
    await forceCloseSymbol(symbol, "ĐÓNG THỦ CÔNG TỪ UI");
    res.json({ success: true });
});

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
        addLog(`🚀 Hệ thống khởi chạy thành công. Đang lắng nghe luồng quét giá chính...`, "success");
        priceMonitor(); 
        fastTpMonitor(); 
    } catch (e) { 
        console.log(`Lỗi init hệ thống, thử lại sau 5s: ${e.message}`);
        setTimeout(init, 5000); 
    }
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
    
    const nowTime = Date.now();
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        if (nowTime > expireTime) {
            delete sharedState.blackList[sym];
        }
    }

    if (!systemBot.status.isReady || !systemSettings.isRunning || systemBot.isMarginProtected) return;
    if (systemBot.activePairs.size >= systemSettings.maxPositions) return;

    let entrySignal = null;
    let rawCandidate = null;

    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
        if (systemBot.activePairs.has(c.symbol)) continue;

        const m1 = parseFloat(c.c1 || 0);
        const m5 = parseFloat(c.c5 || 0);
        if (Math.abs(m1) >= systemSettings.minVol || Math.abs(m5) >= systemSettings.minVol) {
            entrySignal = { symbol: c.symbol, gridSide: 'LONG', dcaSide: 'SHORT' };
            rawCandidate = c; 
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
            await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(()=>{});
            await systemBot.exchange.setLeverage(info.maxLeverage, symbol).catch(()=>{});

            const ticker = await systemBot.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            const startPrice = parseFloat(ticker.data.price);

            const actualMinNotional = Math.max(info.minNotional, MIN_NOTIONAL_FORCE);
            let targetQty = (calculatedMargin * info.maxLeverage) / startPrice;
            targetQty = Math.floor(targetQty / info.stepSize) * info.stepSize;
            if (targetQty * startPrice < actualMinNotional) {
                targetQty = Math.ceil((actualMinNotional / startPrice) / info.stepSize) * info.stepSize;
            }

            const gridRes = await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'OPEN', targetQty);
            if (!gridRes.success) throw new Error("Mở vị thế Grid ban đầu thất bại.");

            const dcaRes = await executeBatchOrder(symbol, entrySignal.dcaSide, 0, 'OPEN', targetQty);
            if (!dcaRes.success) {
                await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'CLOSE', gridRes.actualQty);
                throw new Error("Mở vị thế DCA ban đầu lỗi, tự động xả ngược Grid.");
            }

            const gridMargin = gridRes.actualMargin;
            const dcaMargin = dcaRes.actualMargin;

            const initialPairObj = {
                symbol: symbol, 
                gridSide: entrySignal.gridSide, 
                dcaSide: entrySignal.dcaSide,
                firstEntryPrice: startPrice, 
                lastGridPriceRef: startPrice, 
                maxPriceSinceLastGrid: startPrice,
                initialMargin: gridMargin, 
                baseQty: targetQty, 
                leverage: info.maxLeverage,
                stepUSD: startPrice * (systemSettings.gridStepPercent / 100),
                lastLevel: 0,
                executedGridLevels: { 0: true },
                executedDcaBaseLevels: { 0: true },
                activeNotes: [],
                totalNotesCreated: 0, 
                closedNotesCount: 0,
                closedNotesPnL: 0,
                gridAvgPrice: startPrice,
                dcaAvgPrice: startPrice,
                gridTotalMargin: gridMargin,
                dcaTotalMargin: dcaMargin,
                createdAt: Date.now()
            };

            systemBot.activePairs.set(symbol, initialPairObj);

            debugPosition(initialPairObj, symbol, "OPEN PAIR INITIAL SUCCESS");

            const frame1 = rawCandidate?.c1 || 0;
            const frame5 = rawCandidate?.c5 || 0;
            const frame15 = rawCandidate?.c15 || 0;

            const expectedTpUSD = parseFloat(systemSettings.tpPercent) * gridMargin;
            addLog(`🚀 VÀO LỆNH MỚI | ${symbol} | Mặc định Grid: ${entrySignal.gridSide} | Giá: ${formatPrice(startPrice)} | Vốn: ${gridMargin.toFixed(2)}$ | TP Dự Kiến: ${expectedTpUSD.toFixed(2)}$ (${systemSettings.tpPercent}x vốn) | Biến động: 1M:${frame1}% 5M:${frame5}% 15M:${frame15}%`, "open");
        } catch (e) {
            addLog(`❌ LỖI VÀO LỆNH VỊ THẾ GỐC CHO ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1997, () => console.log('🚀 [HEDGE SYSTEM] Đang chạy trên duy nhất một Port ổn định 1997!'));
