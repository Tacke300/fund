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
const EPSILON = 0.000001; // Thêm Epsilon chống nhiễu số thực

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
    if (sharedState.masterLogs.length > 1000) sharedState.masterLogs.pop(); // Nâng bộ nhớ đệm log lên 1000 để log chi tiết không bị trôi
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
        addLog(`❌ Không thể ghi trạng thái xuống file cứng: ${e.message}`, "error");
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
                // Khôi phục map dữ liệu và vá triệt để thiếu sót nextGridIndex khi khôi phục từ file cứng
                const remappedPairs = parsed.activePairs.map(([symbol, pair]) => {
                    if (pair.nextGridIndex === undefined || pair.nextGridIndex === null) {
                        pair.nextGridIndex = (pair.activeNotes && pair.activeNotes.length > 0) 
                            ? Math.max(...pair.activeNotes.map(n => n.noteIndex || 0)) + 1 
                            : 1;
                        addLog(`🔧 [CRASH RECOVERY] Khôi phục chỉ số nextGridIndex cho ${symbol} = ${pair.nextGridIndex}`, "warn");
                    }
                    return [symbol, pair];
                });
                systemBot.activePairs = new Map(remappedPairs);
                addLog(`💾 [HỆ THỐNG CRASH RECOVERY] Đã khôi phục thành công ${systemBot.activePairs.size} cặp vị thế lưới từ file trạng thái!`, "success");
            }
        }
    } catch (e) {
        addLog(`⚠️ Không thể đọc file trạng thái hoặc file trống: ${e.message}`, "warn");
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
    addLog(`🚫 Đã đưa ${symbol} vào Blacklist 15 phút. Hệ thống quét đóng dọn dẹp ẩn lập tức...`, "warn");
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

        addLog(`⚙️ Bắn lệnh Market [${action}] | ${symbol} | Side: ${orderSide} | PosSide: ${positionSide} | Qty dự kiến: ${qty}`, "info");

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

        addLog(`✅ Khớp lệnh Market [${action}] thành công | ${symbol} | Giá khớp: ${avgPriceReal} | Qty thực tế: ${filledQty} | Vốn: ${actualMarginUsed.toFixed(2)}$`, "success");

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
                addLog(`⚙️ Đóng vị thế sàn của ${symbol} | Side: ${p.positionSide} | Qty: ${Math.abs(amt)} | PnL hiện tại: ${p.unRealizedProfit}$`, "info");
                
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
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG THÀNH CÔNG VỊ THẾ TỔNG TÀI KHOẢN ${symbol} | Lưới: ${pairData.gridSide} | PnL Tổng: ${totalPnL.toFixed(2)}$ | Tổng số Note từng mở: ${pairData.totalNotesCreated} | Note đã chốt: ${pairData.closedNotesCount}`, totalPnL >= 0 ? "success" : "sl");
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
    addLog(`🚨🚨🚨 CHỈ THỊ PANIC CLOSE ALL: ĐÓNG TOÀN BỘ VỊ THẾ HỆ THỐNG | Lý do: ${reasonLog}`, "error");
    try {
        const activeSymbols = Array.from(systemBot.activePairs.keys());
        for(let sym of activeSymbols) {
            await forceCloseSymbol(sym, reasonLog);
        }
        return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
}

// ============================================================================
// 4. LUỒNG QUÉT GIÁ CHÍNH VÀ GIẢI QUYẾT TRIỆT ĐỂ CÁC LỖI LOGIC
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
                addLog(`⚠️ Không tìm thấy vị thế thực tế trên sàn cho ${symbol}. Tiến hành dọn dẹp bộ nhớ RAM.`, "warn");
                systemBot.activePairs.delete(symbol);
                saveBotStateToFile();
                continue;
            }

            systemBot.isProcessingLogic.add(symbol);

            try {
                const markP = parseFloat((gridPos || dcaPos).markPrice);
                
                // Theo dõi Đỉnh/Đáy cục bộ để tính toán điều kiện retrace chính xác theo bước giá lưới
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
                    addLog(`⚡ [PRICE MONITOR] ĐẠT TP MỤC TIÊU TỔNG | ${symbol} | PnL Tổng hợp: ${targetCheckCombinedPnL.toFixed(2)}$ >= Mục tiêu: ${activeProfitTargetUSD.toFixed(2)}$`, "success");
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

                // Lưu lại trạng thái danh sách Note bị chốt trong lượt quét này nhằm chặn đứng lỗi dữ liệu sàn trễ (Lỗi số 2)
                let recentlyClosedNoteIds = new Set();

                if (notesToClose.length > 0) {
                    addLog(`⚙️ Tiến hành chốt gộp ${notesToClose.length} Note đã đạt TP cho ${symbol}. Tổng Qty chốt: ${dcaNotesToCloseQty}`, "info");
                    
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
                            recentlyClosedNoteIds.add(n.id);
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
                                
                                addLog(`[CHỐT NOTE UNLOCKED THÀNH CÔNG] | ${symbol} | Đã chốt thành công thu về PnL: ${realPnL.toFixed(4)}$ | Số Note còn hoạt động: ${pair.activeNotes.length}`, "success");
                            } catch(e) {}
                        }, 1200);
                    } else {
                        addLog(`❌ Gửi lệnh chốt gộp Note cho ${symbol} thất bại từ phía Binance API!`, "error");
                    }
                }

                // --------------------------------------------------------------------
                // SỬA LỖI 1: KHẮC PHỤC TRIỆT ĐỂ LỖI NOTE OPEN LIÊN TỤC KHI GIÁ SIDEWAY
                // --------------------------------------------------------------------
                // Kiểm tra khoảng cách giá so với điểm tham chiếu lưới gần nhất (lastGridPriceRef)
                // Buộc giá phải di chuyển vượt qua mốc bước giá lưới (stepUSD) chứ không dựa vào Đỉnh/Đáy cục bộ tự do khi sideway giật nến
                let isGridConditionMet = pair.gridSide === 'LONG' 
                    ? (pair.lastGridPriceRef - markP >= pair.stepUSD - EPSILON) 
                    : (markP - pair.lastGridPriceRef >= pair.stepUSD - EPSILON);

                if (isGridConditionMet) {
                    if (pair.nextGridIndex === undefined) pair.nextGridIndex = 1;
                    
                    addLog(`🔥 Phát hiện mốc mở Lưới mới hợp lệ | ${symbol} | Mốc giá cũ: ${pair.lastGridPriceRef} | Giá hiện tại: ${markP} (Bước lệch: ${pair.stepUSD})`, "info");

                    // Giai đoạn 1: Bắn lệnh Grid ban đầu
                    const gridResult = await executeBatchOrder(symbol, pair.gridSide, 0, 'OPEN', pair.baseQty);
                    
                    if (gridResult.success) {
                        // Giai đoạn 2: Bắn lệnh DCA đi kèm Note (Nhân x10 volume)
                        const dcaQtyX10 = pair.baseQty * 10;
                        const dcaResult = await executeBatchOrder(symbol, pair.dcaSide, 0, 'OPEN', dcaQtyX10);

                        if (dcaResult.success) {
                            pair.gridTotalMargin += gridResult.actualMargin;
                            pair.totalNotesCreated = (pair.totalNotesCreated || 0) + 1;

                            const newNote = { 
                                id: `Note_Idx_${pair.nextGridIndex}_${Date.now()}`,
                                noteIndex: pair.nextGridIndex,
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
                            
                            addLog(`🔥 HỆ THỐNG NOTE MỚI KHỚP ĐỒNG BỘ | ${symbol} | Khởi tạo thành công Note mã số định danh: ${pair.nextGridIndex} | Vốn Grid: ${gridResult.actualMargin.toFixed(2)}$ - Vốn DCA x10: ${dcaResult.actualMargin.toFixed(2)}$`, "warn");

                            // Dịch chuyển mốc tham chiếu lưới tuyệt đối sang mốc giá vừa khớp, triệt tiêu sideway giật note
                            pair.lastGridPriceRef = markP;
                            pair.maxPriceSinceLastGrid = markP;
                            pair.nextGridIndex += 1;
                            
                            saveBotStateToFile(); 
                        } else {
                            // SỬA LỖI 4: VÁ LỖ HỔNG ATOMIC ROLLBACK BẰNG CƠ CHẾ ĐÓNG CƯỠNG CHẾ KHẨN CẤP HOẶC BLACKLIST
                            addLog(`🚨 [CẢNH BÁO NGUYÊN TỬ] Lệnh DCA Note x10 lỗi. Tiến hành xả Rollback vị thế Grid khẩn cấp...`, "error");
                            const rollbackRes = await executeBatchOrder(symbol, pair.gridSide, 0, 'CLOSE', gridResult.actualQty);
                            if (!rollbackRes.success) {
                                addLog(`🚨 [CRITICAL ERROR] Rollback xả vị thế Grid thất bại! Kích hoạt forceCloseSymbol và đưa vào Blacklist bảo vệ tài khoản lập tức!`, "error");
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
                // LUỒNG DCA VỊ THẾ GỐC TOÀN DIỆN KHÔNG DÙNG LASTLEVEL (QUÉT QUÁ KHỨ)
                // --------------------------------------------------------------------
                const priceDiff = Math.abs(markP - pair.firstEntryPrice);
                const maxLevelPossible = Math.floor((priceDiff + EPSILON) / pair.stepUSD);

                for (let k = 1; k <= maxLevelPossible; k++) {
                    if (k >= systemSettings.maxDcaBaseLevels) {
                        await forceCloseSymbol(symbol, `CHỐNG CHÁY TÀI KHOẢN: CHẠM MỐC DCA GỐC TỐI ĐA ${k}`);
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
                                addLog(`📈 MỞ DCA VỊ THẾ GỐC TOÀN DIỆN | ${symbol} | Tầng mốc: ${k} | Vốn nhồi: ${dcaBaseRes.actualMargin.toFixed(2)}$`, "info");
                            }
                        }
                    }
                }
                
                // --------------------------------------------------------------------
                // LUỒNG TUẦN TỰ DCA THÊM CHO NOTE KHI ĐI NGƯỢC BIÊN ĐỘ
                // --------------------------------------------------------------------
                for (let note of pair.activeNotes) {
                    // SỬA LỖI 2: Chặn đứng tình huống Note vừa TP ở luồng quét trên nhưng do positionRisk chưa cập nhật, luồng dưới lại nhồi DCA
                    if (recentlyClosedNoteIds.has(note.id)) {
                        addLog(`🛡️ [CHỐN XUNG ĐỘT TRẠNG THÁI] Bỏ qua kiểm tra DCA cho Note ${note.id} do Note này vừa được khớp lệnh đóng TP!`, "warn");
                        continue;
                    }

                    const lastDcaPrice = note.dcaHistory[note.dcaHistory.length - 1];
                    let isDcaNoteTriggered = pair.dcaSide === 'LONG' 
                        ? (markP <= lastDcaPrice - pair.stepUSD + EPSILON) 
                        : (markP >= lastDcaPrice + pair.stepUSD - EPSILON);

                    if (isDcaNoteTriggered) {
                        addLog(`⚙️ Kích hoạt lệnh nhồi DCA tiếp diễn cho Note mã định danh: ${note.id} | Giá cuối: ${lastDcaPrice} | Giá hiện tại: ${markP}`, "info");
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
                            addLog(`🔥 [DCA NOTE TIẾP DIỄN THÀNH CÔNG] Note định danh: ${note.id} | Nhồi lần thứ: ${note.dcaCount} | Vốn nhồi: ${dcaNoteAddedRes.actualMargin.toFixed(2)}$ | Giá Entry trung bình mới của riêng Note: ${note.dcaNoteAvg}`, "warn");
                        }
                    }
                }

            } catch(e) {
                addLog(`❌ Lỗi cục bộ phát sinh trong luồng quét giá cặp ${symbol}: ${e.message}`, "error");
            } finally {
                systemBot.isProcessingLogic.delete(symbol);
            }
        }
    } catch (e) {
        addLog(`❌ Lỗi hệ thống tổng tại luồng priceMonitor: ${e.message}`, "error");
    }
    setTimeout(priceMonitor, 400); 
}

// ============================================================================
// CÁC LUỒNG BỔ TRỢ, GIAO DIỆN WEB VÀ KHỞI CHẠY KHÔNG THAY ĐỔI
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
                addLog(`⚡ [FAST TP KÍCH HOẠT] ĐẠT CHỈ TIÊU LỢI NHUẬN TỔNG LUỒNG FAST | ${symbol} | PnL Tổng hợp: ${combinedPnL.toFixed(2)}$ >= Target: ${profitTargetUSD.toFixed(2)}$`, "success");
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

            addLog(`⚙️ Khởi động mở cặp lưới ban đầu cho ${symbol} | Giá: ${startPrice} | Leverage: ${info.maxLeverage}x`, "info");

            const gridRes = await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'OPEN', targetQty);
            if (!gridRes.success) throw new Error("Mở vị thế Grid ban đầu thất bại.");

            const dcaRes = await executeBatchOrder(symbol, entrySignal.dcaSide, 0, 'OPEN', targetQty);
            if (!dcaRes.success) {
                addLog(`🚨 Lỗi mở vị thế đối ứng DCA, tiến hành xả ngược lệnh Grid hoàn trả vốn...`, "error");
                await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'CLOSE', gridRes.actualQty);
                throw new Error("Mở vị thế DCA ban đầu lỗi, tự động xả ngược Grid.");
            }

            systemBot.activePairs.set(symbol, {
                symbol: symbol, gridSide: entrySignal.gridSide, dcaSide: entrySignal.dcaSide,
                firstEntryPrice: startPrice, lastGridPriceRef: startPrice, maxPriceSinceLastGrid: startPrice,
                initialMargin: gridRes.actualMargin, baseQty: targetQty, leverage: info.maxLeverage,
                stepUSD: startPrice * (systemSettings.gridStepPercent / 100), nextGridIndex: 1, isClosing: false,
                executedDcaBaseLevels: { 0: true }, activeNotes: [],
                totalNotesCreated: 0, closedNotesCount: 0, closedNotesPnL: 0,
                gridAvgPrice: startPrice, dcaAvgPrice: startPrice, gridTotalMargin: gridRes.actualMargin, dcaTotalMargin: dcaRes.actualMargin,
                createdAt: Date.now()
            });

            saveBotStateToFile(); 
            addLog(`🚀 VÀO LỆNH CẶP HEDGE BAN ĐẦU THÀNH CÔNG | ${symbol} | Mốc giá tham chiếu gốc: ${formatPrice(startPrice)} | Bước giá lưới (USD): ${startPrice * (systemSettings.gridStepPercent / 100)}`, "open");
        } catch (e) {
            addLog(`❌ LỖI VÀO LỆNH TỔNG CHO ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1997, () => console.log('🚀 [HEDGE SYSTEM] Đang chạy trên duy nhất một Port ổn định 1997!'));
