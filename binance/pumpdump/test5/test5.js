// ============================================================================
// 1. KHAI BÁO THƯ VIỆN, ĐỒNG BỘ TRẠNG THÁI & FILE SYSTEM
// ============================================================================
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MIN_NOTIONAL_FORCE = 5.5; 
const ANTI_LIQUIDATION_LIMIT = 10; 
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  
const EPSILON = 0.000001; 

const STATE_FILE_PATH = path.join(process.cwd(), 'bot_state.json');

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

let systemBot = {
    id: "MASTER_BOT", 
    startTime: Date.now(),
    status: { botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    activePairs: new Map(), 
    isProcessingLogic: new Set(), 
    timestampOffset: 0, 
    isMarginProtected: false,
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

function saveBotStateToFile() {
    try {
        const stateToSave = {
            status: systemBot.status,
            activePairs: Array.from(systemBot.activePairs.entries())
        };
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(stateToSave, null, 2), 'utf-8');
    } catch (e) {
        addLog(`❌ Không thể ghi trạng thái xuống file: ${e.message}`, "error");
    }
}

function loadBotStateFromFile() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const rawData = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
            if (!rawData.trim()) return;
            const parsed = JSON.parse(rawData);
            
            if (parsed.status) systemBot.status = parsed.status;
            if (parsed.activePairs && Array.isArray(parsed.activePairs)) {
                systemBot.activePairs = new Map(parsed.activePairs);
                addLog(`💾 [CRASH RECOVERY] Khôi phục thành công ${systemBot.activePairs.size} cặp vị thế từ file cứng!`, "success");
            }
        }
    } catch (e) {
        addLog(`⚠️ Không thể đọc file trạng thái: ${e.message}`, "warn");
    }
}

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
            } catch (syncError) {
                throw e;
            }
        }
        throw e;
    }
}

function checkAndAddBlacklist(symbol) {
    sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
    addLog(`🚫 Đã đưa ${symbol} vào Blacklist 15 phút. Kích hoạt luồng quét dọn...`, "warn");
    forceCloseSymbol(symbol, "ĐÓNG KHI KÍCH HOẠT BLACKLIST").catch(() => {});
}

async function executeBatchOrder(symbol, positionSide, marginUSD, action, customQty = null) {
    if (marginUSD <= 0 && !customQty) return { success: false, actualQty: 0, actualMargin: 0 };
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return { success: false, actualQty: 0, actualMargin: 0 };

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
        
        if (qty <= 0) return { success: false, actualQty: 0, actualMargin: 0 };

        const orderSide = positionSide === 'LONG'
            ? (action === 'OPEN' ? 'BUY' : 'SELL')
            : (action === 'OPEN' ? 'SELL' : 'BUY');

        const orderRes = await systemBot.exchange.createOrder(
            symbol,
            'MARKET',
            orderSide,
            qty.toFixed(info.quantityPrecision),
            undefined,
            { positionSide }
        );

        const filledQty = orderRes && orderRes.filled ? parseFloat(orderRes.filled) : qty;
        const avgPriceReal = orderRes && orderRes.price ? parseFloat(orderRes.price) : currentPrice;
        const actualMarginUsed = (filledQty * avgPriceReal) / info.maxLeverage;

        if (filledQty <= 0) return { success: false, actualQty: 0, actualMargin: 0 };

        return {
            success: true,
            actualQty: filledQty,
            actualMargin: actualMarginUsed,
            price: avgPriceReal
        };
    } catch (e) {
        addLog(`❌ Lệnh Market ${action} cho ${symbol} thất bại: ${e.message}`, "error");
        return { success: false, actualQty: 0, actualMargin: 0 };
    }
}

async function forceCloseSymbol(symbol, reasonStr) {
    let pairData = systemBot.activePairs.get(symbol);
    if (pairData) pairData.isClosing = true; 

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
                    .catch((err) => addLog(`❌ Lỗi đóng vị thế ${p.positionSide} của ${symbol}: ${err.message}`, "error"));
                
                closePromises.push(pOrder);
                totalPnL += parseFloat(p.unRealizedProfit || 0);
            }
        }
        
        await Promise.allSettled(closePromises);

        systemBot.status.botClosedCount++;
        systemBot.status.botPnLClosed += totalPnL;
        if (totalPnL >= 0) systemBot.status.pnlGain = (systemBot.status.pnlGain || 0) + totalPnL;
        else systemBot.status.pnlLoss = (systemBot.status.pnlLoss || 0) + totalPnL;

        if (pairData) {
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG THÀNH CÔNG VỊ THẾ ${symbol} | Lưới: ${pairData.gridSide} | PnL Tổng: ${totalPnL.toFixed(2)}$`, totalPnL >= 0 ? "success" : "sl");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addLog(`❌ LỖI KHI ĐÓNG VỊ THẾ KHẨN CẤP ${symbol}: ${e.message}`, "error");
    } finally {
        systemBot.activePairs.delete(symbol);
        saveBotStateToFile();
    }
}

async function panicCloseAll(reasonLog) {
    try {
        const activeSymbols = Array.from(systemBot.activePairs.keys());
        for(let sym of activeSymbols) {
            await forceCloseSymbol(sym, reasonLog);
        }
        return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
}

// ============================================================================
// 4. LUỒNG QUÉT GIÁ CHÍNH CORE LOGIC (ĐÃ KIÊN CỐ HOÀN TOÀN)
// ============================================================================
async function priceMonitor() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return setTimeout(priceMonitor, 400);
    
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(priceMonitor, 400);
        
        for (let [symbol, pair] of systemBot.activePairs) {
            if (systemBot.isProcessingLogic.has(symbol) || pair.isClosing) continue;
            
            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide && Math.abs(parseFloat(p.positionAmt)) > 0);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide && Math.abs(parseFloat(p.positionAmt)) > 0);

            if (!gridPos && !dcaPos) {
                systemBot.activePairs.delete(symbol);
                saveBotStateToFile();
                continue;
            }

            systemBot.isProcessingLogic.add(symbol);

            try {
                const markP = parseFloat((gridPos || dcaPos).markPrice);
                
                if (pair.gridSide === 'LONG') {
                    if (markP > pair.maxPriceSinceLastGrid) pair.maxPriceSinceLastGrid = markP;
                } else {
                    if (markP < pair.maxPriceSinceLastGrid) pair.maxPriceSinceLastGrid = markP;
                }

                let currentUnrealizedPnL = 0;
                if (gridPos) currentUnrealizedPnL += parseFloat(gridPos.unRealizedProfit || 0);
                if (dcaPos) currentUnrealizedPnL += parseFloat(dcaPos.unRealizedProfit || 0);

                const targetCheckCombinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
                const activeProfitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;
                
                if (targetCheckCombinedPnL >= activeProfitTargetUSD) {
                    pair.isClosing = true;
                    addLog(`⚡ [PRICE MONITOR] ĐẠT TP MỤC TIÊU TỔNG | ${symbol} | PnL: ${targetCheckCombinedPnL.toFixed(2)}$ >= Target: ${activeProfitTargetUSD.toFixed(2)}$`, "success");
                    await forceCloseSymbol(symbol, `⚡ TP CHỐT LỜI TỔNG CẶP (PnL: ${targetCheckCombinedPnL.toFixed(2)}$)`);
                    systemBot.isProcessingLogic.delete(symbol);
                    continue;
                }

                const info = sharedState.exchangeInfo[symbol];
                const cand = sharedState.candidatesList.find(c => c.symbol === symbol) || { c1: "0", c5: "0", c15: "0" };
                const tfStr = `1M:${cand.c1}% 5M:${cand.c5}% 15M:${cand.c15}%`;

                // --------------------------------------------------------------------
                // LUỒNG CHỐT NOTE UNLOCKED (CÓ RETURN CHỐNG XUNG ĐỘT TRỄ SÀN)
                // --------------------------------------------------------------------
                let notesToClose = [];
                let dcaNotesToCloseQty = 0;
                let totalMarginOfNotesToClose = 0;

                for (let i = pair.activeNotes.length - 1; i >= 0; i--) {
                    const note = pair.activeNotes[i];
                    const targetTpPrice = pair.dcaSide === 'LONG' ? note.dcaNoteAvg + pair.stepUSD : note.dcaNoteAvg - pair.stepUSD;
                    const isHit = pair.dcaSide === 'LONG' ? markP >= targetTpPrice - EPSILON : markP <= targetTpPrice + EPSILON;

                    if (isHit) {
                        notesToClose.push(note);
                        dcaNotesToCloseQty += note.dcaNoteQty;
                        totalMarginOfNotesToClose += note.dcaNoteMargin;
                    }
                }

                if (notesToClose.length > 0) {
                    const orderData = {
                        symbol: symbol,
                        side: pair.dcaSide === 'LONG' ? 'SELL' : 'BUY', 
                        positionSide: pair.dcaSide, 
                        type: 'MARKET',
                        quantity: dcaNotesToCloseQty.toFixed(info.quantityPrecision)
                    };

                    addLog(`🎯 [YÊU CẦU CHỐT NOTE] Gửi lệnh đóng ${notesToClose.length} Note unlocked cho ${symbol} | Qty: ${dcaNotesToCloseQty}`, "info");
                    const resDca = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch(() => null);

                    if (resDca && resDca.orderId) {
                        notesToClose.forEach(n => {
                            pair.activeNotes = pair.activeNotes.filter(active => active.id !== n.id);
                        });

                        pair.dcaTotalMargin = Math.max(0, pair.dcaTotalMargin - totalMarginOfNotesToClose);
                        pair.lastGridPriceRef = markP;
                        pair.maxPriceSinceLastGrid = markP;

                        setTimeout(async () => {
                            try {
                                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 50 });
                                const matched = trades.filter(t => t.orderId == resDca.orderId);
                                const realPnL = matched.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                                
                                pair.closedNotesPnL += realPnL;
                                pair.closedNotesCount += notesToClose.length;
                                saveBotStateToFile();
                                
                                addLog(`[CHỐT NOTE THÀNH CÔNG] | ${symbol} | PnL Thực Tế: ${realPnL.toFixed(4)}$ | ${tfStr}`, "success");
                            } catch(e) {}
                        }, 1200);
                    }
                    
                    // NGẮT VÒNG BẢO VỆ: Tránh sàn trễ dữ liệu positionRisk đè lệnh DCA ảo
                    systemBot.isProcessingLogic.delete(symbol);
                    return; 
                }

                // --------------------------------------------------------------------
                // CHỐNG MỞ NOTE LIÊN TỤC KHI GIÁ SIDEWAY GIẬT NẾN TẠI MỘT VÙNG
                // --------------------------------------------------------------------
                let isGridConditionMet = pair.gridSide === 'LONG' 
                    ? (pair.maxPriceSinceLastGrid - markP >= pair.stepUSD - EPSILON) 
                    : (markP - pair.maxPriceSinceLastGrid >= pair.stepUSD - EPSILON);

                let isFarFromLastNote = true;
                if (pair.activeNotes.length > 0) {
                    const lastNoteObj = pair.activeNotes[pair.activeNotes.length - 1];
                    if (Math.abs(markP - lastNoteObj.entryPrice) < pair.stepUSD - EPSILON) {
                        isFarFromLastNote = false; 
                    }
                }

                if (isGridConditionMet && isFarFromLastNote) {
                    if (pair.nextGridIndex === undefined) pair.nextGridIndex = 1;
                    
                    addLog(`⏳ [KÍCH HOẠT MỞ NOTE] Thỏa mãn điều kiện Retrace & Khoảng cách giá an toàn | ${symbol}`, "info");
                    
                    const gridResult = await executeBatchOrder(symbol, pair.gridSide, 0, 'OPEN', pair.baseQty);
                    
                    if (gridResult.success) {
                        const dcaQtyX10 = pair.baseQty * 10;
                        const dcaResult = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQtyX10);

                        if (dcaResult.success) {
                            pair.gridTotalMargin += gridResult.actualMargin;
                            pair.totalNotesCreated = (pair.totalNotesCreated || 0) + 1;

                            const newNote = { 
                                id: `Note_Idx_${pair.nextGridIndex}_${Date.now()}`,
                                noteIndex: pair.totalNotesCreated,
                                entryPrice: markP,
                                gridQty: gridResult.actualQty, 
                                dcaNoteQty: dcaResult.actualQty, 
                                gridMargin: gridResult.actualMargin, 
                                dcaNoteMargin: dcaResult.actualMargin, 
                                dcaNoteAvg: markP, 
                                dcaCount: 1, 
                                dcaHistory: [markP]
                            };
                            
                            pair.activeNotes.push(newNote);
                            pair.dcaTotalMargin += dcaResult.actualMargin;
                            
                            pair.nextGridIndex += 1;
                            pair.lastGridPriceRef = markP;
                            pair.maxPriceSinceLastGrid = markP;
                            
                            saveBotStateToFile(); 

                            addLog(`🔥 [NOTE MỚI KHỚP ĐỒNG BỘ] | ${symbol} | Note Index: ${pair.nextGridIndex - 1} | Vốn Grid: ${gridResult.actualMargin.toFixed(2)}$ | Vốn DCA x10: ${dcaResult.actualMargin.toFixed(2)}$`, "warn");
                        } else {
                            // ATOMIC ROLLBACK KHẨN CẤP KIEN CỐ
                            addLog(`🚨 [LỖI NGUYÊN TỬ] Mở lệnh DCA Note x10 thất bại. Xả ngược lệnh Grid...`, "error");
                            const rollbackRes = await executeBatchOrder(symbol, pair.gridSide, 0, 'CLOSE', gridResult.actualQty);
                            if (!rollbackRes.success) {
                                await forceCloseSymbol(symbol, "CRITICAL_ROLLBACK_FAILED_EMERGENCY_CLOSE");
                            }
                        }
                    }
                    systemBot.isProcessingLogic.delete(symbol);
                    return;
                }
                
                // --------------------------------------------------------------------
                // LUỒNG DCA VỊ THẾ GỐC TOÀN DIỆN KHÔNG DÙNG LASTLEVEL (QUÉT QUÁ KHỨ)
                // --------------------------------------------------------------------
                const priceDiff = Math.abs(markP - pair.firstEntryPrice);
                const maxLevelPossible = Math.floor((priceDiff + EPSILON) / pair.stepUSD);

                for (let k = 1; k <= maxLevelPossible; k++) {
                    if (k >= systemSettings.maxDcaBaseLevels) {
                        await forceCloseSymbol(symbol, `CHỐNG CHÁY TÀI KHOẢN: CHẠM MỐC DCA GỐC TỐI ĐA TẦNG ${k}`);
                        break;
                    }

                    if (!pair.executedDcaBaseLevels[k]) {
                        const targetDcaPrice = pair.dcaSide === 'LONG' 
                            ? pair.firstEntryPrice + (k * pair.stepUSD) 
                            : pair.firstEntryPrice - (k * pair.stepUSD);
                        
                        const isDcaBaseCondition = pair.dcaSide === 'LONG' ? (markP >= targetDcaPrice - EPSILON) : (markP <= targetDcaPrice + EPSILON);

                        if (isDcaBaseCondition) {
                            const dcaQty = pair.baseQty * systemSettings.heSoDCA;
                            const dcaBaseRes = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQty);
                            if (dcaBaseRes.success) {
                                pair.executedDcaBaseLevels[k] = true;
                                pair.dcaTotalMargin += dcaBaseRes.actualMargin;
                                saveBotStateToFile();
                                addLog(`📈 MỞ DCA VỊ THẾ GỐC THÀNH CÔNG | Tầng mốc: ${k} | Vốn nhồi: ${dcaBaseRes.actualMargin.toFixed(2)}$ | Giá: ${formatPrice(markP)}`, "info");
                            }
                        }
                    }
                }
                
                // --------------------------------------------------------------------
                // LUỒNG TUẦN TỰ DCA THÊM CHO NOTE KHI ĐI NGƯỢC BIÊN ĐỘ
                // --------------------------------------------------------------------
                for (let note of pair.activeNotes) {
                    const lastDcaPrice = note.dcaHistory[note.dcaHistory.length - 1];
                    let isDcaNoteTriggered = pair.dcaSide === 'LONG' 
                        ? (markP <= lastDcaPrice - pair.stepUSD + EPSILON) 
                        : (markP >= lastDcaPrice + pair.stepUSD - EPSILON);

                    if (isDcaNoteTriggered) {
                        const dcaQtyX10 = pair.baseQty * 10;
                        const dcaNoteAddedRes = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQtyX10);
                        
                        if (dcaNoteAddedRes.success) {
                            note.dcaNoteAvg = ((note.dcaNoteAvg * note.dcaNoteMargin) + (markP * dcaNoteAddedRes.actualMargin)) / (note.dcaNoteMargin + dcaNoteAddedRes.actualMargin);
                            note.dcaNoteMargin += dcaNoteAddedRes.actualMargin;
                            note.dcaNoteQty += dcaNoteAddedRes.actualQty;
                            note.dcaCount += 1;
                            note.dcaHistory.push(markP);
                            
                            pair.dcaTotalMargin += dcaNoteAddedRes.actualMargin;
                            saveBotStateToFile();
                            addLog(`🔥 [DCA NOTE TIẾP DIỄN THÀNH CÔNG] Note Mã: ${note.id} | Nhồi lần: ${note.dcaCount} | Vốn nhồi: ${dcaNoteAddedRes.actualMargin.toFixed(2)}$`, "warn");
                        }
                    }
                }

            } catch(e) {
                addLog(`❌ Lỗi luồng priceMonitor cho ${symbol}: ${e.message}`, "error");
            } finally {
                systemBot.isProcessingLogic.delete(symbol);
            }
        }
    } catch (e) {
        // Luồng tổng quét an toàn
    }
    setTimeout(priceMonitor, 400); 
}

// ============================================================================
// CÁC HÀM PHỤ TRỢ KHÔNG ĐỔI (ĐÃ ĐỒNG BỘ HOÀN TOÀN BIẾN KHỞI TẠO CŨ)
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

            const combinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
            const profitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;

            if (combinedPnL >= profitTargetUSD) {
                pair.isClosing = true; 
                addLog(`⚡ [FAST TP CHẠM BÁN] ĐẠT CHỈ TIÊU LỢI NHUẬN TỔNG | ${symbol} | PnL: ${combinedPnL.toFixed(2)}$ >= Target: ${profitTargetUSD.toFixed(2)}$`, "success");
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

// KHÔI PHỤC HOÀN TOÀN ĐƯỜNG DẪN TĨNH ĐỂ LOAD FILE HTML GIAO DIỆN CHUẨN XÁC
appServer.use(express.static(__dirname)); 

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
        if (['tpPercent', 'gridStepPercent', 'heSoDCA', 'minVol', 'maxPositions', 'maxDcaBaseLevels'].includes(key)) {
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
        loadBotStateFromFile();
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

            // ĐỒNG BỘ HOÀN TOÀN CẤU TRÚC KHỞI TẠO ĐỂ TRÁNH LỖI UNDEFINED LƯỚI
            systemBot.activePairs.set(symbol, {
                symbol: symbol, gridSide: entrySignal.gridSide, dcaSide: entrySignal.dcaSide,
                firstEntryPrice: startPrice, lastGridPriceRef: startPrice, maxPriceSinceLastGrid: startPrice,
                initialMargin: gridRes.actualMargin, baseQty: targetQty, leverage: info.maxLeverage,
                stepUSD: startPrice * (systemSettings.gridStepPercent / 100), nextGridIndex: 1, isClosing: false,
                executedGridLevels: { 0: true },
                executedDcaBaseLevels: { 0: true }, activeNotes: [],
                totalNotesCreated: 0, closedNotesCount: 0, closedNotesPnL: 0,
                gridAvgPrice: startPrice, dcaAvgPrice: startPrice, gridTotalMargin: gridRes.actualMargin, dcaTotalMargin: dcaRes.actualMargin,
                createdAt: Date.now()
            });

            saveBotStateToFile(); 
            
            const frame1 = rawCandidate?.c1 || 0;
            const frame5 = rawCandidate?.c5 || 0;
            const expectedTpUSD = parseFloat(systemSettings.tpPercent) * gridRes.actualMargin;
            addLog(`🚀 VÀO LỆNH MỚI THÀNH CÔNG | ${symbol} | Giá: ${formatPrice(startPrice)} | Vốn: ${gridRes.actualMargin.toFixed(2)}$ | Target TP: ${expectedTpUSD.toFixed(2)}$ | Biến động: 1M:${frame1}% 5M:${frame5}%`, "open");
        } catch (e) {
            addLog(`❌ LỖI VÀO LỆNH TỔNG CHO ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1997, () => console.log('🚀 [HEDGE SYSTEM] Tiến trình Core kiên cố đang chạy trên Port 1997!'));
