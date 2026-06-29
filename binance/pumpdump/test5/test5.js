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

// Các hằng số an toàn cho Margin
const MIN_NOTIONAL_FORCE = 5.5; // Ngưỡng bắt buộc của sàn Binance cho lệnh Futures
const ANTI_LIQUIDATION_LIMIT = 10; // Ngưỡng phanh khẩn cấp để chống cháy tài khoản (dưới 10% khả dụng)
const MARGIN_PROTECT_LIMIT = 65;  // Ngưỡng cảnh báo ngừng vào lệnh (dưới 65% khả dụng)
const MARGIN_RECOVER_LIMIT = 75;  // Ngưỡng an toàn để tiếp tục vào lệnh (trên 75% khả dụng)

const globalStartTime = Date.now();

// Hàm hiển thị thời gian bot đã chạy (Uptime)
function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

// Hàm format giá linh hoạt để xử lý các coin có nhiều số 0
function formatPrice(num) {
    if (!num) return "0";
    let n = parseFloat(num);
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.01) return n.toFixed(5);
    return n.toPrecision(5).replace(/0+\( /, '').replace(/\. \)/, ''); 
}

// Cache thông tin ví để giảm thiểu số lượng request lên API
let walletCache = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

// Khởi tạo instance axios riêng cho các request public
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

// State chia sẻ lưu trữ danh sách chặn, dữ liệu coin và lịch sử log
let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    masterLogs: []
};

// Cấu hình ban đầu của bot (sẽ được ghi đè từ UI)
let systemSettings = {
    isRunning: false,
    invValue: "1",
    maxPositions: 3,
    minVol: 7,
    diangucvol: 0,
    gridStepPercent: 1.0,
    heSoDCA: 1,
    tpPercent: 1.0 // Số lưới chốt tổng
};

// Hàm xử lý dữ liệu cấu hình từ UI đẩy về Server
function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        normalizedBody[key] = reqBody[key];
    }
    return { ...currentSettings, ...normalizedBody };
}

// Khởi tạo cấu trúc quản lý bot trung tâm
let systemBot = {
    id: "MASTER_BOT", startTime: Date.now(),
    status: { botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    activePairs: new Map(), // Lưu thông tin các cặp đang chạy
    isProcessingLogic: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    // Cấu hình ccxt cho các thao tác đặt lệnh
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    // Axios cấu hình riêng cho private API với Timeout lớn hơn
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 60000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

// Hàm quản lý log: hiển thị trên terminal và gửi ra UI
function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };
    
    sharedState.masterLogs.unshift(logItem);
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    
    console.log(`[\( {time}][ \){type.toUpperCase()}] ${msg}`);
}

// ============================================================================
// 2. KẾT NỐI API BINANCE & QUẢN LÝ LỖI
// ============================================================================

// Hàm gửi request Private API với xử lý chữ ký bảo mật
async function binancePrivate(endpoint, method = 'GET', data = {}, retryCount = 0) {
    try {
        const timestamp = Date.now() + systemBot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await systemBot.binanceApi({ method, url: `\( {endpoint}? \){query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        // Tự động đồng bộ lại thời gian với Binance nếu bị lệch (Lỗi -1021)
        if (e.response?.data?.code === -1021 && retryCount < 10) {
            addLog(`⚠️ Phát hiện lệch thời gian (-1021), đang đồng bộ lại...`, "warn");
            try {
                const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
                systemBot.timestampOffset = t.data.serverTime - Date.now();
                return await binancePrivate(endpoint, method, data, retryCount + 1);
            } catch (syncError) {
                addLog(`❌ Không thể đồng bộ thời gian: ${syncError.message}`, "error");
                throw e;
            }
        }
        throw e;
    }
}

// Vòng lặp liên tục dọn dẹp các cặp đã hết thời gian chặn (Blacklist)
setInterval(() => {
    const now = Date.now();
    for (const symbol in sharedState.blackList) {
        if (now > sharedState.blackList[symbol]) delete sharedState.blackList[symbol];
    }
}, 1000);

// Thêm một đồng coin vào Blacklist 15 phút nếu gặp lỗi
function checkAndAddBlacklist(symbol) {
    if (!systemBot.activePairs.has(symbol)) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
        addLog(`🚫 Đã chặn ${symbol} 15 phút do lỗi.`, "warn");
    }
}

// ============================================================================
// 3. LOGIC XỬ LÝ LỆNH VÀ ĐÓNG MỞ VỊ THẾ
// ============================================================================

// Hàm thực thi lệnh Market Order hàng loạt (gom lệnh)
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

// HÀM CHỐT LỜI/CẮT LỖ ĐỘC LẬP CHO TỪNG NOTE (Gửi Khối lượng chuẩn của Note)
async function closeSingleNote(symbol, note, type = 'CHỐT NOTE') {
    const info = sharedState.exchangeInfo[symbol];
    const pairData = systemBot.activePairs.get(symbol);
    if (!info || !pairData) return;

    let gridSuccess = false;
    let dcaSuccess = false;
    let gridRealPnL = 0;
    let dcaRealPnL = 0;

    try {
        if (note.gridMargin > 0) {
            const gridCloseSide = pairData.gridSide === 'LONG' ? 'SELL' : 'BUY';
            let gridQty = note.gridQty; 

            if (gridQty > 0) {
                const orderData = {
                    symbol: symbol,
                    side: gridCloseSide,
                    positionSide: pairData.gridSide,
                    type: 'MARKET',
                    quantity: gridQty.toFixed(info.quantityPrecision)
                };

                const resGrid = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch((err) => { 
                    addLog(`❌ API Lỗi đóng phần Grid Note ${note.id}: ${err.response?.data?.msg || err.message}`, "error"); 
                    return null; 
                });

                if (resGrid && resGrid.orderId) {
                    gridSuccess = true;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    try {
                        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
                        const matched = trades.filter(t => t.orderId == resGrid.orderId);
                        gridRealPnL = matched.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                    } catch (e) { gridRealPnL = 0; }
                }
            } else { gridSuccess = true; }
        } else { gridSuccess = true; }

        if (note.dcaNoteMargin > 0) {
            const dcaCloseSide = pairData.dcaSide === 'LONG' ? 'SELL' : 'BUY';
            let dcaQty = note.dcaNoteQty;

            if (dcaQty > 0) {
                const orderData = {
                    symbol: symbol,
                    side: dcaCloseSide,
                    positionSide: pairData.dcaSide,
                    type: 'MARKET',
                    quantity: dcaQty.toFixed(info.quantityPrecision)
                };

                const resDca = await binancePrivate('/fapi/v1/order', 'POST', orderData).catch((err) => { 
                    addLog(`❌ API Lỗi đóng phần DCA Note ${note.id}: ${err.response?.data?.msg || err.message}`, "error"); 
                    return null; 
                });

                if (resDca && resDca.orderId) {
                    dcaSuccess = true;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    try {
                        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
                        const matched = trades.filter(t => t.orderId == resDca.orderId);
                        dcaRealPnL = matched.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                    } catch (e) { dcaRealPnL = 0; }
                }
            } else { dcaSuccess = true; }
        } else { dcaSuccess = true; }

        if (gridSuccess && dcaSuccess) {
            const totalNoteRealPnL = gridRealPnL + dcaRealPnL;
            pairData.closedNotesCount++;
            pairData.closedNotesPnL += totalNoteRealPnL;

            pairData.gridTotalMargin = Math.max(0, pairData.gridTotalMargin - note.gridMargin);
            pairData.dcaTotalMargin = Math.max(0, pairData.dcaTotalMargin - note.dcaNoteMargin);

            addLog(`[${type}] | ${symbol} | ${note.id} | PnL Sàn thực tế: \( {totalNoteRealPnL.toFixed(4)} \) (Grid:\( {gridRealPnL.toFixed(4)} \) | DCA:\( {dcaRealPnL.toFixed(4)} \))`, "success");

            pairData.activeNotes = pairData.activeNotes.filter(n => n.id !== note.id);
        } else {
            addLog(`⚠️ Cắt Note ${note.id} bị kẹt (API từ chối). Vị thế trên sàn giữ nguyên. Đợi vòng lặp sau thử lại...`, "warn");
        }

    } catch (globalErr) {
        addLog(`❌ Lỗi nghiêm trọng xử lý Note ${note.id}: ${globalErr.message}`, "error");
    }
}

// Hàm đóng toàn bộ vị thế của một Symbol
async function forceCloseSymbol(symbol, reasonStr) {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => []);
        let totalPnL = 0;
        let pairData = systemBot.activePairs.get(symbol);
        
        for (const p of posRisk) {
            const amt = parseFloat(p.positionAmt);
            if (Math.abs(amt) > 0) {
                const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                await systemBot.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide }).catch(() => {});
                
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
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG TỔNG ${symbol} | Hướng Grid: \( {pairData.gridSide} | Lev: x \){pairData.leverage} | Entry: ${formatPrice(pairData.firstEntryPrice)} | Note Đóng Lẻ: ${pairData.closedNotesCount} | PnL Note Đã Đóng: \( {pairData.closedNotesPnL.toFixed(2)} \) | PnL Sàn Lệnh Cuối: \( {totalPnL.toFixed(2)} \) | TỔNG KẾT: \( {(totalPnL + pairData.closedNotesPnL).toFixed(2)} \)`, totalPnL >= 0 ? "success" : "sl");
        } else {
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG THỦ CÔNG ${symbol} | PnL: \( {totalPnL.toFixed(2)} \)`, totalPnL >= 0 ? "success" : "sl");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
        
        systemBot.activePairs.delete(symbol);
        checkAndAddBlacklist(symbol);
    } catch (e) {
        addLog(`❌ LỖI ĐÓNG VỊ THẾ ${symbol}: ${e.message}`, "error");
    }
}

// Đóng khẩn cấp toàn bộ hệ thống
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
// 4. VÒNG LẶP QUÉT GIÁ VÀ XỬ LÝ LƯỚI & NOTE (CHỈ SỬA PHẦN NÀY)
// ============================================================================
async function priceMonitor() {
    if (!systemBot.status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!systemSettings.isRunning) return setTimeout(priceMonitor, 1000);
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(()=>[]);
        
        for (let [symbol, pair] of systemBot.activePairs) {
            if (systemBot.isProcessingLogic.has(symbol)) continue;
            
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
                const dir = pair.gridSide === 'LONG' ? 1 : -1;
                
                const currentLevel = Math.trunc((markP - pair.firstEntryPrice) / pair.stepUSD) * dir;

                let ordersToExecute = {
                    LONG: { addQty: 0, closeQty: 0 },
                    SHORT: { addQty: 0, closeQty: 0 }
                };

                // --- 1. KIỂM TRA CHỐT NOTE (KHÔNG MỞ NOTE MỚI TẠI ĐIỂM TP) ---
                for (let i = pair.activeNotes.length - 1; i >= 0; i--) {
                    const note = pair.activeNotes[i];
                    let shouldCloseNote = false;
                    
                    const tpLevel = note.startLevel - 1; 
                    const slLevel = note.startLevel + 1; 
                    
                    const targetTpPrice = pair.firstEntryPrice + tpLevel * pair.stepUSD * dir;
                    const targetSlPrice = pair.firstEntryPrice + slLevel * pair.stepUSD * dir;

                    if (pair.dcaSide === 'SHORT') {
                        if (markP <= targetTpPrice) {
                            shouldCloseNote = true;
                            pair.executedGridLevels[tpLevel] = true;
                        } else if (markP >= targetSlPrice) {
                            shouldCloseNote = true;
                        }
                    } else {
                        if (markP >= targetTpPrice) {
                            shouldCloseNote = true;
                            pair.executedGridLevels[tpLevel] = true;
                        } else if (markP <= targetSlPrice) {
                            shouldCloseNote = true;
                        }
                    }

                    if (shouldCloseNote) {
                        systemBot.isProcessingLogic.delete(symbol);
                        await closeSingleNote(symbol, note, 'CHỐT NOTE');
                        systemBot.isProcessingLogic.add(symbol);
                    }
                }

                // --- 2. XỬ LÝ KHI GIÁ ĐI NGƯỢC (GRID LỖ) ---
                if (currentLevel < pair.lastLevel) {
                    for (let k = pair.lastLevel - 1; k >= currentLevel; k--) {
                        if (!pair.executedGridLevels[k]) {
                            ordersToExecute[pair.gridSide].addQty += pair.baseQty; 
                            pair.executedGridLevels[k] = true;
                            
                            pair.gridTotalMargin += pair.initialMargin;
                            pair.gridAvgPrice = ((pair.gridAvgPrice * (pair.gridTotalMargin - pair.initialMargin)) + (markP * pair.initialMargin)) / pair.gridTotalMargin;

                            const newNote = { 
                                id: `Note_${Math.abs(k)}`, 
                                startLevel: k, 
                                gridQty: pair.baseQty, 
                                dcaNoteQty: pair.baseQty * 5, 
                                gridMargin: pair.initialMargin, 
                                dcaNoteMargin: pair.initialMargin * 5, 
                                dcaNoteAvg: markP, 
                                dcaNoteCount: 1, 
                                executedDcaLevels: { [k]: true } 
                            };
                            pair.activeNotes.push(newNote);
                            ordersToExecute[pair.dcaSide].addQty += newNote.dcaNoteQty;

                            const distPercent = Math.abs((markP - pair.firstEntryPrice) / pair.firstEntryPrice) * 100;
                            addLog(`🔔 TẠO NOTE MỚI | ${symbol} | Mốc Lưới: ${k} | Cách Entry Gốc: ${distPercent.toFixed(2)}% | Hướng Grid: ${pair.gridSide} | Giá: ${formatPrice(markP)}`, "warn");
                        }
                    }
                } 
                // --- 3. XỬ LÝ KHI GIÁ CHẠY THUẬN + DCA NOTE (GỘP TỔNG) ---
                else if (currentLevel > pair.lastLevel) {
                    for (let k = pair.lastLevel + 1; k <= currentLevel; k++) {
                        if (k > 0 && !pair.executedDcaBaseLevels[k]) {
                            const dcaQty = pair.baseQty * systemSettings.heSoDCA;
                            ordersToExecute[pair.dcaSide].addQty += dcaQty;
                            pair.executedDcaBaseLevels[k] = true;
                            
                            const dcaMargin = pair.initialMargin * systemSettings.heSoDCA;
                            pair.dcaAvgPrice = ((pair.dcaAvgPrice * pair.dcaTotalMargin) + (markP * dcaMargin)) / (pair.dcaTotalMargin + dcaMargin);
                            pair.dcaTotalMargin += dcaMargin;
                        }

                        let totalDcaNoteQty = 0;
                        for (let note of pair.activeNotes) {
                            if (!note.executedDcaLevels[k]) {
                                note.executedDcaLevels[k] = true;
                                totalDcaNoteQty += pair.baseQty * 5;
                            }
                        }
                        if (totalDcaNoteQty > 0) {
                            ordersToExecute[pair.dcaSide].addQty += totalDcaNoteQty;
                        }
                    }
                }
                pair.lastLevel = currentLevel;

                for (const side of ['LONG', 'SHORT']) {
                    if (ordersToExecute[side].addQty > 0) await executeBatchOrder(symbol, side, 0, 'OPEN', ordersToExecute[side].addQty);
                }

            } catch(e) {
                addLog(`❌ LỖI VÒNG LẶP ${symbol}: ${e.message}`, "error");
            } finally {
                systemBot.isProcessingLogic.delete(symbol);
            }
        }
    } catch (e) { }
    setTimeout(priceMonitor, 500); 
}

// Hàm kiểm soát an toàn tài khoản ký quỹ
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
// 6. KHỞI CHẠY BOT VÀ BẮT ĐẦU VÒNG LẶP SỰ KIỆN
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
        
        let isNormal = false; let normalSide = 'SHORT';
        let matchedVol = 0;

        if (Math.abs(m1) >= systemSettings.minVol) {
            isNormal = true;
            matchedVol = m1;
        } else if (Math.abs(m5) >= systemSettings.minVol) {
            isNormal = true;
            matchedVol = m5;
        }
        
        if (isNormal) {
            normalSide = matchedVol > 0 ? 'LONG' : 'SHORT';
            entrySignal = { symbol: c.symbol, gridSide: normalSide, dcaSide: normalSide === 'LONG' ? 'SHORT' : 'LONG' };
            rawCandidate = c; // Lưu lại để đẩy vào Log
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
                addLog(`✅ [START] Đã tự động chuyển sang CROSSED Margin cho ${symbol}`, "info");
            } catch (e) {
                if (e.response?.data?.code === -4046) {
                    addLog(`✅ [START] Tài khoản đã ở sẵn chế độ CROSSED Margin cho ${symbol}`, "info");
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

            addLog(`🚀 VÀO LỆNH MỚI | ${symbol} | Hướng Grid: ${entrySignal.gridSide} | Giá: ${formatPrice(startPrice)} | Vốn: \( {gridMargin.toFixed(2)} \) mỗi chiều | Biến động: 1M:\( {frame1}% 5M: \){frame5}% 15M:${frame15}%`, "open");
        } catch (e) {
            addLog(`❌ LỖI VÀO LỆNH ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1820, () => console.log('🚀 [HEDGE SYSTEM] Đang chạy trên Port 1820 duy nhất!'));
