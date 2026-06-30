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
const ANTI_LIQUIDATION_LIMIT = 15; // Cập nhật lên 15% theo yêu cầu
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

let walletCache = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

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

// SỬA LỖI: Ép kiểu dữ liệu an toàn từ UI gửi lên
function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        if (key === 'tpPercent' || key === 'gridStepPercent' || key === 'heSoDCA' || key === 'minVol' || key === 'maxPositions') {
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
    isProcessingLogic: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
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

// Hàm hỗ trợ tạo chuỗi tiến trình PnL phục vụ yêu cầu Log số 2
function getPairProgressStr(pair, currentUnrealizedPnL) {
    const closedPnL = pair.closedNotesPnL;
    const totalPnL = closedPnL + currentUnrealizedPnL;
    const profitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;
    const progressPercent = profitTargetUSD > 0 ? (totalPnL / profitTargetUSD) * 100 : 0;
    return `[📊 TIẾN ĐỘ | PnL Đã Chốt: ${closedPnL.toFixed(2)}$ | PnL Chưa Chốt: ${currentUnrealizedPnL.toFixed(2)}$ | Tổng PnL: ${totalPnL.toFixed(2)}$ / TP Mục Tiêu: ${profitTargetUSD.toFixed(2)}$ | Đạt: ${progressPercent.toFixed(1)}%]`;
}

// ============================================================================
// 2. KẾT NỐI API BINANCE & QUẢN LÝ LỖI
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
            } catch (syncError) {
                throw e;
            }
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
    if (!systemBot.activePairs.has(symbol)) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
        addLog(`🚫 Đã chặn ${symbol} 15 phút do lỗi trạng thái dữ liệu vị thế.`, "warn");
    }
}

// ============================================================================
// 3. LOGIC XỬ LÝ LỆNH VÀ ĐÓNG MỞ VỊ THẾ
// ============================================================================
async function executeBatchOrder(symbol, positionSide, marginUSD, action, customQty = null) {
    if (marginUSD <= 0 && !customQty) return 0;
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return 0;

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
        
        if (qty <= 0) return 0;

        const orderSide = positionSide === 'LONG'
            ? (action === 'OPEN' ? 'BUY' : 'SELL')
            : (action === 'OPEN' ? 'SELL' : 'BUY');

        await systemBot.exchange.createOrder(
            symbol,
            'MARKET',
            orderSide,
            qty.toFixed(info.quantityPrecision),
            undefined,
            { positionSide }
        );

        return (qty * currentPrice) / info.maxLeverage;
    } catch (e) {
        addLog(`❌ executeBatchOrder ${symbol}: ${e.message}`, "error");
        return 0;
    }
}

async function forceCloseSymbol(symbol, reasonStr) {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol }).catch((err) => {
            addLog(`❌ Không thể lấy positionRisk để forceClose cho ${symbol}: ${err.message}`, "error");
            return null;
        });
        if (!posRisk) return;

        let totalPnL = 0;
        let pairData = systemBot.activePairs.get(symbol);
        
        for (const p of posRisk) {
            const amt = parseFloat(p.positionAmt);
            if (Math.abs(amt) > 0) {
                const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                await systemBot.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide }).catch((err) => {
                    addLog(`❌ Thất bại lệnh đóng khẩn cấp market vị thế của ${symbol}: ${err.message}`, "error");
                });
                
                const markP = parseFloat(p.markPrice);
                const feeVolDeduction = (Math.abs(amt) * markP * 0.001);
                totalPnL += (parseFloat(p.unRealizedProfit) - feeVolDeduction);
            }
        }
        
        systemBot.status.botClosedCount++;
        systemBot.status.botPnLClosed += totalPnL;
        if (totalPnL >= 0) systemBot.status.pnlGain = (systemBot.status.pnlGain || 0) + totalPnL;
        else systemBot.status.pnlLoss = (systemBot.status.pnlLoss || 0) + totalPnL;

        if (pairData) {
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG TỔNG TÀI KHOẢN ${symbol} | Hướng Grid: ${pairData.gridSide} | Lev: x${pairData.leverage} | Entry Gốc: ${formatPrice(pairData.firstEntryPrice)} | Note Đóng Lẻ: ${pairData.closedNotesCount} | PnL Lượt Cuối: ${totalPnL.toFixed(2)}$`, totalPnL >= 0 ? "success" : "sl");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
        
        systemBot.activePairs.delete(symbol);
        checkAndAddBlacklist(symbol);
    } catch (e) {
        addLog(`❌ LỖI TRONG QUÁ TRÌNH ĐÓNG VỊ THẾ KHẨN CẤP ${symbol}: ${e.message}`, "error");
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
// 4. VÒNG LẶP QUÉT GIÁ VÀ XỬ LÝ LƯỚI & NOTE
// ============================================================================
async function priceMonitor() {
    if (!systemBot.status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!systemSettings.isRunning) return setTimeout(priceMonitor, 1000);
        
        let apiFailed = false;
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch((err) => {
            addLog(`❌ Lỗi API kết nối khi lấy dữ liệu positionRisk trong priceMonitor: ${err.message}`, "error");
            apiFailed = true;
            return null;
        });
        
        if (apiFailed || !posRisk || !Array.isArray(posRisk)) {
            return setTimeout(priceMonitor, 500);
        }
        
        for (let [symbol, pair] of systemBot.activePairs) {
            if (systemBot.isProcessingLogic.has(symbol)) continue;
            
            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide && Math.abs(parseFloat(p.positionAmt)) > 0);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide && Math.abs(parseFloat(p.positionAmt)) > 0);

            if (!gridPos && !dcaPos) {
                addLog(`⚠️ Phát hiện vị thế trống thực tế trên sàn đối với cặp ${symbol}. Đang dọn dẹp bộ nhớ...`, "warn");
                systemBot.activePairs.delete(symbol);
                checkAndAddBlacklist(symbol);
                continue;
            }

            systemBot.isProcessingLogic.add(symbol);

            try {
                const markP = parseFloat((gridPos || dcaPos).markPrice);
                
                // Tính toán PnL chưa chốt trạng thái hiện tại phục vụ Log tiến độ
                let currentUnrealizedPnL = 0;
                if (gridPos) currentUnrealizedPnL += parseFloat(gridPos.unRealizedProfit);
                if (dcaPos) currentUnrealizedPnL += parseFloat(dcaPos.unRealizedProfit);

                // --- ĐƯA ĐIỀU KIỆN CHỐT LỜI TỔNG LÊN ĐẦU (ƯU TIÊN REAL-TIME CAO NHẤT) ---
                const combinedPnL = pair.closedNotesPnL + currentUnrealizedPnL;
                const profitTargetUSD = parseFloat(systemSettings.tpPercent) * pair.initialMargin;

                if (combinedPnL >= profitTargetUSD) {
                    await forceCloseSymbol(symbol, `CHỐT LỜI TỔNG CẶP LỆNH (Tổng PnL: ${combinedPnL.toFixed(2)}$ đạt mục tiêu ${profitTargetUSD.toFixed(2)}$ [${systemSettings.tpPercent}x Vốn đầu])`);
                    systemBot.isProcessingLogic.delete(symbol);
                    continue; // Bỏ qua toàn bộ xử lý lưới phía dưới để đóng trạng thái ngay
                }

                const currentLevel = Math.trunc((markP - pair.firstEntryPrice) / pair.stepUSD);
                const info = sharedState.exchangeInfo[symbol];

                let ordersToExecute = {
                    LONG: { addQty: 0, closeQty: 0 },
                    SHORT: { addQty: 0, closeQty: 0 }
                };

                const cand = sharedState.candidatesList.find(c => c.symbol === symbol) || { c1: "0", c5: "0", c15: "0" };
                const tfStr = `1M:${cand.c1}% 5M:${cand.c5}% 15M:${cand.c15}%`;
                const distPercent = Math.abs((markP - pair.firstEntryPrice) / pair.firstEntryPrice) * 100;

                // --- 1. KIỂM TRA CHỐT NOTE (CHỈ ĐÓNG ĐÚNG SỐ MARGIN/QTY CỦA NOTE) ---
                let notesToClose = [];
                let dcaNotesToCloseQty = 0;
                let totalMarginOfNotesToClose = 0;

                for (let i = pair.activeNotes.length - 1; i >= 0; i--) {
                    const note = pair.activeNotes[i];
                    
                    const targetTpPrice = pair.dcaSide === 'LONG' 
                        ? note.dcaNoteAvg + pair.stepUSD 
                        : note.dcaNoteAvg - pair.stepUSD;

                    const isHit = pair.dcaSide === 'LONG' 
                        ? markP >= targetTpPrice 
                        : markP <= targetTpPrice;

                    if (isHit) {
                        notesToClose.push(note);
                        dcaNotesToCloseQty += note.dcaNoteQty;
                        totalMarginOfNotesToClose += note.dcaNoteMargin;
                    }
                }

                if (notesToClose.length > 0) {
                    try {
                        const orderData = {
                            symbol: symbol,
                            side: pair.dcaSide === 'LONG' ? 'SELL' : 'BUY', 
                            positionSide: pair.dcaSide, 
                            type: 'MARKET',
                            quantity: dcaNotesToCloseQty.toFixed(info.quantityPrecision)
                        };

                        const resDca = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch(e => {
                            addLog(`❌ API Từ chối lệnh chốt gộp Note của ${symbol}: ${e.response?.data?.msg || e.message}`, "error");
                            return null;
                        });

                        if (resDca && resDca.orderId) {
                            const closedIds = [];
                            notesToClose.forEach(n => {
                                pair.executedGridLevels[n.startLevel] = false;     
                                pair.executedGridLevels[n.startLevel - 1] = false; 
                                
                                pair.activeNotes = pair.activeNotes.filter(active => active.id !== n.id);
                                closedIds.push(n.id);
                            });

                            pair.dcaTotalMargin = Math.max(0, pair.dcaTotalMargin - totalMarginOfNotesToClose);

                            setTimeout(async () => {
                                try {
                                    const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
                                    const matched = trades.filter(t => t.orderId == resDca.orderId);
                                    const realPnL = matched.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                                    
                                    pair.closedNotesPnL += realPnL;
                                    pair.closedNotesCount += notesToClose.length;
                                    
                                    let noteLogs = notesToClose.map(n => {
                                        let hStr = `Entry: ${formatPrice(n.entryPrice)}`;
                                        if (n.dcaHistory.length > 0) hStr += ' -> ' + n.dcaHistory.map((p, i) => `DCA${i+1}: ${formatPrice(p)}`).join(' -> ');
                                        return `[ID: ${n.id} | DCA: ${n.dcaCount} lần | Hành trình: ${hStr}]`;
                                    }).join(' || ');

                                    // Thêm Log tiến độ chốt note
                                    const progressStr = getPairProgressStr(pair, currentUnrealizedPnL);
                                    addLog(`[CHỐT NOTE] | ${symbol} | Khoảng cách: +${distPercent.toFixed(2)}% | Các Note: ${closedIds.join(', ')} | Đã mở khóa note & tp | Chi tiết: ${noteLogs} | PnL Sàn thực tế: ${realPnL.toFixed(4)}$ | ${progressStr}`, "success");
                                } catch(e) {}
                            }, 1500);
                        }
                    } catch (globalErr) {
                        addLog(`❌ Lỗi hệ thống khi chốt gộp Note cho ${symbol}: ${globalErr.message}`, "error");
                    }
                    systemBot.isProcessingLogic.delete(symbol);
                    return; 
                }

                // --- 2. CHỈ MỞ NOTE KHI GIÁ GIẢM (VÙNG ÂM < 0) ---
                // GỘP LOG: Gộp trực tiếp log tạo Note mới và thông báo DCA chung bên dưới khi có hành động
                let hasGridAction = false;
                let logDetails = "";

                if (currentLevel < pair.lastLevel && currentLevel < 0) {
                    for (let k = pair.lastLevel - 1; k >= currentLevel; k--) {
                        if (!pair.executedGridLevels[k]) {
                            ordersToExecute[pair.gridSide].addQty += pair.baseQty; 
                            
                            pair.gridTotalMargin += pair.initialMargin;
                            pair.gridAvgPrice = ((pair.gridAvgPrice * (pair.gridTotalMargin - pair.initialMargin)) + (markP * pair.initialMargin)) / pair.gridTotalMargin;

                            const newNote = { 
                                id: `Note_${Math.abs(k)}_${Date.now()}`, 
                                startLevel: k, 
                                entryPrice: markP,
                                gridQty: pair.baseQty, 
                                dcaNoteQty: pair.baseQty, 
                                gridMargin: pair.initialMargin, 
                                dcaNoteMargin: pair.initialMargin, 
                                dcaNoteAvg: markP, 
                                dcaCount: 0, 
                                executedDcaLevels: {}, 
                                dcaHistory: []
                            };
                            pair.activeNotes.push(newNote);
                            ordersToExecute[pair.dcaSide].addQty += newNote.dcaNoteQty;
                            
                            pair.dcaAvgPrice = ((pair.dcaAvgPrice * pair.dcaTotalMargin) + (markP * pair.initialMargin)) / (pair.dcaTotalMargin + pair.initialMargin);
                            pair.dcaTotalMargin += pair.initialMargin;

                            pair.executedGridLevels[k] = true;
                            pair.executedGridLevels[k - 1] = true; 

                            hasGridAction = true;
                            logDetails = `[TẠO NOTE] Tầng: ${k} | Giá: ${formatPrice(markP)} | Mở Grid: 1x | Chờ DCA x5`;
                        }
                    }
                } 
                // --- 3. CHỈ MỞ DCA GỐC KHI GIÁ TĂNG (VÙNG DƯƠNG > 0) ---
                else if (currentLevel > pair.lastLevel && currentLevel > 0) {
                    for (let k = pair.lastLevel + 1; k <= currentLevel; k++) {
                        if (!pair.executedDcaBaseLevels[k]) {
                            const dcaQty = pair.baseQty * systemSettings.heSoDCA;
                            ordersToExecute[pair.dcaSide].addQty += dcaQty;
                            pair.executedDcaBaseLevels[k] = true;
                            
                            const dcaMargin = pair.initialMargin * systemSettings.heSoDCA;
                            pair.dcaAvgPrice = ((pair.dcaAvgPrice * pair.dcaTotalMargin) + (markP * dcaMargin)) / (pair.dcaTotalMargin + dcaMargin);
                            pair.dcaTotalMargin += dcaMargin;

                            const progressStr = getPairProgressStr(pair, currentUnrealizedPnL);
                            addLog(`📈 MỞ DCA GỐC | ${symbol} | Cách Entry Gốc: +${distPercent.toFixed(2)}% | Tầng: ${k} | Giá: ${formatPrice(markP)} | Margin: ${dcaMargin.toFixed(2)}$ | ${progressStr}`, "info");
                        }
                    }
                }
                
                // --- 4. XỬ LÝ DCA NOTE KHI GIÁ TĂNG ĐỘC LẬP ---
                pair.activeNotes.forEach(note => {
                    if (currentLevel > note.startLevel) {
                        for (let lvl = note.startLevel + 1; lvl <= currentLevel; lvl++) {
                            if (!note.executedDcaLevels[lvl]) {
                                const dcaMargin = pair.initialMargin * 5; 
                                const dcaQty = pair.baseQty * 5;

                                ordersToExecute[pair.dcaSide].addQty += dcaQty;
                                
                                note.dcaNoteAvg = ((note.dcaNoteAvg * note.dcaNoteMargin) + (markP * dcaMargin)) / (note.dcaNoteMargin + dcaMargin);
                                note.dcaNoteMargin += dcaMargin;
                                note.dcaNoteQty += dcaQty;
                                note.dcaCount += 1;
                                note.dcaHistory.push(markP);
                                
                                pair.dcaAvgPrice = ((pair.dcaAvgPrice * pair.dcaTotalMargin) + (markP * dcaMargin)) / (pair.dcaTotalMargin + dcaMargin);
                                pair.dcaTotalMargin += dcaMargin;

                                note.executedDcaLevels[lvl] = true;

                                hasGridAction = true;
                                logDetails = `[DCA NOTE] ${note.id} | Level: ${lvl} | Lần DCA: ${note.dcaCount} | Giá DCA: ${formatPrice(markP)} | Avg Mới: ${formatPrice(note.dcaNoteAvg)} | Kích thước: x5`;
                            }
                        }
                    }
                });

                // In 1 dòng Log duy nhất đại diện cho tương tác Note (Tạo mới hoặc DCA Note)
                if (hasGridAction) {
                    const progressStr = getPairProgressStr(pair, currentUnrealizedPnL);
                    addLog(`🔥 HỆ THỐNG LƯỚI NOTE | ${symbol} | Cách Entry Gốc: ${currentLevel < 0 ? '-' : '+'}${distPercent.toFixed(2)}% | Biến động: ${tfStr} | ${logDetails} | ${progressStr}`, "warn");
                }

                pair.lastLevel = currentLevel;

                // Thực thi các lệnh mở rộng lưới/DCA nếu có
                for (const side of ['LONG', 'SHORT']) {
                    if (ordersToExecute[side].addQty > 0) {
                        await executeBatchOrder(symbol, side, 0, 'OPEN', ordersToExecute[side].addQty);
                    }
                }

            } catch(e) {
                addLog(`❌ LỖI VÒNG LẶP XỬ LÝ LƯỚI CHO ${symbol}: ${e.message}`, "error");
            } finally {
                systemBot.isProcessingLogic.delete(symbol);
            }
        }
    } catch (e) { 
        addLog(`❌ LỖI HỆ THỐNG TRONG HÀM priceMonitor: ${e.message}`, "error");
    }
    setTimeout(priceMonitor, 500); 
}

// Kiểm soát an toàn Margin
async function checkMarginLimits() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return;
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc && parseFloat(acc.totalMarginBalance) > 0) {
        const availPercent = (parseFloat(acc.availableBalance) / parseFloat(acc.totalMarginBalance)) * 100;
        if (availPercent <= ANTI_LIQUIDATION_LIMIT) { 
            await panicCloseAll(`CHỐNG THANH LÝ ${ANTI_LIQUIDATION_LIMIT}%`); 
            systemBot.isMarginProtected = false; 
            return; 
        }
        if (!systemBot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
            systemBot.isMarginProtected = true; addLog(`⚠️ Khả dụng dưới ${MARGIN_PROTECT_LIMIT}%. Dừng quét mới!`, "warn");
        } else if (systemBot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            systemBot.isMarginProtected = false; addLog(`✅ Khả dụng trên ${MARGIN_RECOVER_LIMIT}%. Mở lại quét.`, "info");
        }
    }
}

// ============================================================================
// 5. MÁY CHỦ WEB API ĐỂ GIAO TIẾP VỚI GIAO DIỆN HTML
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
        posRisk.forEach(pr => { if (pr.symbol === pair.symbol && Math.abs(parseFloat(pr.positionAmt)) > 0) pnl += parseFloat(pr.unRealizedProfit); });
        return {
            ...pair,
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
    res.json({ success: true, msg: "Cập nhật cấu hình Hệ thống Hedge thành công!" });
});

appServer.get('/api/status', async (req, res) => {
    res.json(await buildStatusResponse());
});

appServer.post('/api/close_all', async (req, res) => res.json(await panicCloseAll("PANIC CLOSE TỪ UI")));

appServer.post('/api/close_position', async (req, res) => { 
    const { symbol } = req.body; 
    if (systemBot.activePairs.has(symbol)) {
        await forceCloseSymbol(symbol, "ĐÓNG THỦ CÔNG TỪ UI");
        res.json({ success: true });
    } else {
        res.json({ success: false, msg: "Không tìm thấy Cặp lệnh." });
    }
});

// ============================================================================
// 6. KHỔI CHẠY BOT VÀ BẮT ĐẦU VÒNG LẶP SỰ KIỆN
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
            const b = brk.find(x => x.symbol === s.symbol); const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { sharedState.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        systemBot.status.isReady = true;
        priceMonitor(); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

// Lắng nghe tín hiệu Coin biến động từ Server Port 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// Vòng lặp quét mở vị thế mới (Quét cả khung M1 và M5)
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
        let isNormal = false; 
        
        if (Math.abs(m1) >= systemSettings.minVol || Math.abs(m5) >= systemSettings.minVol) {
            isNormal = true;
        }
        
        if (isNormal) {
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
            try {
                await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' });
                addLog(`✅ [START] Đã chuyển Margin thành công sang CROSSED cho cặp ${symbol}`, "info");
            } catch (e) {
                if (e.response?.data?.code === -4046) {
                    addLog(`✅ [START] Tài khoản đã thiết lập sẵn CROSSED Margin cho ${symbol}`, "info");
                } else {
                    addLog(`⚠️ Không thể chuyển Cross Margin cho ${symbol}: ${e.response?.data?.msg || e.message}`, "warn");
                }
            }

            await systemBot.exchange.setLeverage(info.maxLeverage, symbol).catch(()=>{});

            const ticker = await systemBot.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            const startPrice = parseFloat(ticker.data.price);

            const actualMinNotional = Math.max(info.minNotional, MIN_NOTIONAL_FORCE);
            let targetQty = (calculatedMargin * info.maxLeverage) / startPrice;
            targetQty = Math.floor(targetQty / info.stepSize) * info.stepSize;
            
            if (targetQty * startPrice < actualMinNotional) {
                targetQty = Math.ceil((actualMinNotional / startPrice) / info.stepSize) * info.stepSize;
            }

            const gridMargin = await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'OPEN', targetQty);
            const dcaMargin = await executeBatchOrder(symbol, entrySignal.dcaSide, 0, 'OPEN', targetQty);

            if (gridMargin <= 0 || dcaMargin <= 0) {
                throw new Error("Không lấy được margin thực tế từ sàn.");
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
                lastLevel: 0,
                executedGridLevels: { 0: true },
                executedDcaBaseLevels: { 0: true },
                activeNotes: [],
                closedNotesCount: 0,
                closedNotesPnL: 0,
                gridAvgPrice: startPrice,
                dcaAvgPrice: startPrice,
                gridTotalMargin: gridMargin,
                dcaTotalMargin: dcaMargin,
                createdAt: Date.now()
            });

            const frame1 = rawCandidate?.c1 || 0;
            const frame5 = rawCandidate?.c5 || 0;
            const frame15 = rawCandidate?.c15 || 0;

            // YÊU CẦU 1: Log thêm số tiền TP dự kiến là bao nhiêu $ ngay khi vào lệnh
            const expectedTpUSD = parseFloat(systemSettings.tpPercent) * gridMargin;
            addLog(`🚀 VÀO LỆNH MỚI | ${symbol} | Mặc định Grid: ${entrySignal.gridSide} | Giá: ${formatPrice(startPrice)} | Vốn: ${gridMargin.toFixed(2)}$ | TP Dự Kiến: ${expectedTpUSD.toFixed(2)}$ (${systemSettings.tpPercent}x vốn) | Biến động: 1M:${frame1}% 5M:${frame5}% 15M:${frame15}%`, "open");
        } catch (e) {
            addLog(`❌ LỖI VÀO LỆNH VỊ THẾ GỐC CHO ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1820, () => console.log('🚀 [HEDGE SYSTEM] Đang chạy trên Port 1820 duy nhất!'));
