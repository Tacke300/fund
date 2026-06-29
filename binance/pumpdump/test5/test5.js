// ==========================================
// 1. KHAI BÁO THƯ VIỆN & CẤU HÌNH HỆ THỐNG
// ==========================================
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
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  

const globalStartTime = Date.now();

// Hàm tính toán thời gian hoạt động liên tục của Bot
function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

// FORMAT SỐ THẬP PHÂN ĐỘNG CHO COIN NHIỀU SỐ 0
function formatPrice(num) {
    if (!num) return "0";
    let n = parseFloat(num);
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.01) return n.toFixed(5);
    return n.toPrecision(5).replace(/0+$/, '').replace(/\.$/, ''); 
}

// Bộ nhớ đệm lưu trữ thông tin ví tài khoản Binance Futures
let walletCache = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

// Trạng thái chia sẻ toàn cục của hệ thống quét tín hiệu và danh sách chặn
let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    masterLogs: []
};

// Cấu hình thông số mặc định của Bot nhận từ UI điều khiển
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

// Hàm đồng bộ hóa cấu hình nhận về từ Client UI
function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        normalizedBody[key] = reqBody[key];
    }
    return { ...currentSettings, ...normalizedBody };
}

// Khởi tạo các thực thể kết nối Sàn giao dịch CCXT và API Binance
let systemBot = {
    id: "MASTER_BOT", startTime: Date.now(),
    status: { botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    activePairs: new Map(),
    isProcessingLogic: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 60000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

// Hàm ghi log tập trung hiển thị ra Terminal và UI điều khiển
function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };
    
    sharedState.masterLogs.unshift(logItem);
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    
    console.log(`[${time}][${type.toUpperCase()}] ${msg}`);
}

// ==========================================
// 2. KẾT NỐI API BẢO MẬT BINANCE PRIVATE
// ==========================================
async function binancePrivate(endpoint, method = 'GET', data = {}, retryCount = 0) {
    try {
        const timestamp = Date.now() + systemBot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await systemBot.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        // Kiểm tra lỗi -1021 lệch thời gian hệ thống và thực hiện đồng bộ lại tự động
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

// Tiến trình tự động giải phóng các cặp coin hết thời gian phạt 15 phút khỏi blacklist
setInterval(() => {
    const now = Date.now();
    for (const symbol in sharedState.blackList) {
        if (now > sharedState.blackList[symbol]) delete sharedState.blackList[symbol];
    }
}, 1000);

// Hàm đưa cặp coin vào danh sách blacklist tạm thời khi sảy ra lỗi xử lý lệnh
function checkAndAddBlacklist(symbol) {
    if (!systemBot.activePairs.has(symbol)) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
        addLog(`🚫 Đã chặn ${symbol} 15 phút do lỗi.`, "warn");
    }
}

// ==========================================
// 3. ĐẶT LỆNH MARKET ĐỒNG LOẠT (BATCH ORDER)
// ==========================================
async function executeBatchOrder(symbol, positionSide, marginUSD, action, customQty = null) {
    if (marginUSD <= 0 && !customQty) return 0;
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return 0;

    try {
        const ticker = await systemBot.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let qty = 0;
        // FIX: Nếu có truyền khối lượng qty ghi nhớ sẵn thì dùng luôn, không tính lại bằng USD để tránh lệch bước min sàn
        if (customQty !== null) {
            qty = customQty;
        } else {
            qty = (marginUSD * info.maxLeverage) / currentPrice;
            qty = Math.floor(qty / info.stepSize) * info.stepSize;
            
            if (action === 'OPEN' && qty * currentPrice < info.minNotional) {
                qty = Math.ceil((info.minNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
        }
        
        if (qty <= 0) return 0;

        const orderSide =
            positionSide === 'LONG'
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

        // Trả về số Margin thực tế tương ứng kích thước vị thế đã khớp
        return (qty * currentPrice) / info.maxLeverage;

    } catch (e) {
        addLog(`❌ executeBatchOrder ${symbol}: ${e.message}`, "error");
        return 0;
    }
}

// ==========================================
// 4. LOGIC ĐÓNG VỊ THẾ KHẨN CẤP / CHỐT LỜI CẶP COIN
// ==========================================
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
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG VỊ THẾ ${symbol} | Lev: x${pairData.leverage} | Entry: ${formatPrice(pairData.firstEntryPrice)} | Note Đóng: ${pairData.closedNotesCount} | PnL Lưới Đóng: ${pairData.closedNotesPnL.toFixed(2)}$ | PnL Chốt Sàn: ${totalPnL.toFixed(2)}$ | TỔNG PNL: ${(totalPnL + pairData.closedNotesPnL).toFixed(2)}$`, totalPnL >= 0 ? "success" : "sl");
        } else {
            addLog(`💲💲💲 [${reasonStr}] ĐÓNG ${symbol} | PnL: ${totalPnL.toFixed(2)}$`, totalPnL >= 0 ? "success" : "sl");
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

// Đóng toàn bộ tất cả vị thế đang chạy trên tài khoản sàn
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

// ==========================================
// 5. TIẾN TRÌNH GIÁM SÁT GIÁ VÀ ĐIỀU PHỐI LƯỚI (PRICE MONITOR)
// ==========================================
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
                
                // FIXED: MATH.TRUNC ĐỂ TÍNH ĐÚNG MỐC LƯỚI KHÔNG BỊ TRÒN SAI SỚM
                const currentLevel = Math.trunc((markP - pair.firstEntryPrice) / pair.stepUSD) * dir;
                let noteClosedThisTick = false;
                let ordersToExecute = {
                    LONG: { addQty: 0, closeQty: 0 },
                    SHORT: { addQty: 0, closeQty: 0 }
                };

                // XỬ LÝ LƯỚI & NOTE KHI GIÁ ĐI NGƯỢC HƯỚNG (GẶP LỖ)
                if (currentLevel < pair.lastLevel) {
                    for (let k = pair.lastLevel - 1; k >= currentLevel; k--) {
                        // Rule 1 & 3: Lưới chạy ngược, Lỗ => Nhồi Grid & Mở Note bằng đơn vị khối lượng Qty an toàn
                        if (!noteClosedThisTick && !pair.executedGridLevels[k]) {
                            ordersToExecute[pair.gridSide].addQty += pair.baseQty;
                            pair.executedGridLevels[k] = true;
                            
                            pair.gridTotalMargin += pair.initialMargin;
                            pair.gridAvgPrice = ((pair.gridAvgPrice * (pair.gridTotalMargin - pair.initialMargin)) + (markP * pair.initialMargin)) / pair.gridTotalMargin;

                            // Khởi tạo Note quản lý kèm khối lượng qty tương ứng
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

                            addLog(`🔔 TẠO NOTE MỚI | ${symbol} | Mốc: ${k} | Giá: ${formatPrice(markP)} | Nhồi Grid: ${pair.initialMargin}$ | DCA Note: ${newNote.dcaNoteMargin}$`, "warn");
                        }

                        // Rule 4: Cắt Note nếu đi thêm 1 lưới ngược sâu hơn
                        for (let i = pair.activeNotes.length - 1; i >= 0; i--) {
                            const note = pair.activeNotes[i];
                            if (k <= note.startLevel - 1) {
                                ordersToExecute[pair.gridSide].closeQty += note.gridQty;
                                ordersToExecute[pair.dcaSide].closeQty += note.dcaNoteQty;
                                pair.gridTotalMargin -= note.gridMargin;
                                pair.closedNotesCount++;
                                
                                // Lý thuyết PnL khi cắt lỗ Note
                                const gridPnL = note.gridMargin * pair.leverage * ((markP - pair.gridAvgPrice)/pair.gridAvgPrice) * dir;
                                const dcaPnL = note.dcaNoteMargin * pair.leverage * ((markP - note.dcaNoteAvg)/note.dcaNoteAvg) * (dir * -1);
                                pair.closedNotesPnL += (gridPnL + dcaPnL);

                                addLog(`🛑 CẮT LỖ NOTE | ${symbol} | ${note.id} | Giá: ${formatPrice(markP)} | Cắt Grid: ${note.gridMargin}$ | Cắt DCA Note: ${note.dcaNoteMargin}$ | PnL Note Ước tính: ${(gridPnL+dcaPnL).toFixed(2)}$`, "sl");
                                pair.activeNotes.splice(i, 1);
                                noteClosedThisTick = false;
                            }
                        }
                    }
                } else if (currentLevel > pair.lastLevel) {
                    // GIÁ CHẠY THUẬN HƯỚNG GRID (HOẶC HỒI)
                    for (let k = pair.lastLevel + 1; k <= currentLevel; k++) {
                        
                        // Rule 2: Mở DCA Gốc nếu chưa mở
                        if (k > 0 && !pair.executedDcaBaseLevels[k]) {
                            const dcaQty = pair.baseQty * systemSettings.heSoDCA;
                            ordersToExecute[pair.dcaSide].addQty += dcaQty;
                            pair.executedDcaBaseLevels[k] = true;
                            
                            const dcaMargin = pair.initialMargin * systemSettings.heSoDCA;
                            pair.dcaTotalMargin += dcaMargin;
                            addLog(`📈 MỞ DCA GỐC | ${symbol} | Mốc: ${k} | Giá: ${formatPrice(markP)} | Margin: ${dcaMargin.toFixed(2)}$`, "info");
                        }

                        // Rule 6: Giá hồi về & Đang có Note vị thế ngược
                        if (pair.activeNotes.length > 0) {
                            const currentNote = pair.activeNotes[pair.activeNotes.length - 1];
                            const addDcaNoteMargin = pair.initialMargin * 5;
                            let logMsg = `☯️ GIÁ HỒI KÉO NOTE | ${symbol} | ${currentNote.id} | Giá: ${formatPrice(markP)}`;

                            if (!pair.executedDcaBaseLevels[k]) {
                                const dcaQty = pair.baseQty * systemSettings.heSoDCA;
                                ordersToExecute[pair.dcaSide].addQty += dcaQty;
                                pair.executedDcaBaseLevels[k] = true;
                                
                                const dcaMargin = pair.initialMargin * systemSettings.heSoDCA;
                                pair.dcaTotalMargin += dcaMargin;
                                logMsg += ` | Mở DCA Gốc: ${dcaMargin.toFixed(2)}$ + DCA Note: ${addDcaNoteMargin.toFixed(2)}$`;
                            } else {
                                logMsg += ` | Chỉ mở DCA Note: ${addDcaNoteMargin.toFixed(2)}$`;
                            }

                            if (!currentNote.executedDcaLevels[k]) {
                                currentNote.executedDcaLevels[k] = true;
                                // FIX: Không cộng thêm addDcaNoteMargin vào ordersToExecute nữa để giữ nguyên tỷ lệ x5 chuẩn của Note đầu, tránh bị nhân đôi volume lên x10 không mong muốn.
                                currentNote.dcaNoteAvg =
                                    ((currentNote.dcaNoteAvg * currentNote.dcaNoteMargin) +
                                    (markP * addDcaNoteMargin))
                                    /
                                    (currentNote.dcaNoteMargin + addDcaNoteMargin);

                                currentNote.dcaNoteMargin += addDcaNoteMargin;
                                currentNote.dcaNoteCount++;

                                addLog(logMsg, "warn");
                            }
                        }
                    }
                }
                pair.lastLevel = currentLevel;

                // Rule 6.b: Kiểm tra điều kiện Chốt Lời Note (TP Note)
                for (let i = pair.activeNotes.length - 1; i >= 0; i--) {
                    const note = pair.activeNotes[i];
                    const isDcaShort = pair.dcaSide === 'SHORT';
                    const isNoteTpReached = isDcaShort ? (markP <= note.dcaNoteAvg - pair.stepUSD) : (markP >= note.dcaNoteAvg + pair.stepUSD);
                    
                    if (isNoteTpReached) {
                        ordersToExecute[pair.gridSide].closeQty += note.gridQty;
                        ordersToExecute[pair.dcaSide].closeQty += note.dcaNoteQty;
                        pair.gridTotalMargin -= note.gridMargin;
                        pair.closedNotesCount++;
                        
                        // Tính toán Lời Note thực tế
                        const gridPnL = note.gridMargin * pair.leverage * ((markP - pair.gridAvgPrice)/pair.gridAvgPrice) * dir;
                        const dcaPnL = note.dcaNoteMargin * pair.leverage * ((markP - note.dcaNoteAvg)/note.dcaNoteAvg) * (dir * -1);
                        pair.closedNotesPnL += (gridPnL + dcaPnL);

                        addLog(`💲💲💲 CHỐT LỜI NOTE | ${symbol} | ${note.id} | Avg DCA: ${formatPrice(note.dcaNoteAvg)} | Cắt toàn bộ DCA Note (${note.dcaNoteMargin}$) & 1 Grid (${note.gridMargin}$) | PnL Note: ${(gridPnL+dcaPnL).toFixed(2)}$`, "success");
                        pair.activeNotes.splice(i, 1);
                        noteClosedThisTick = true;
                    }
                }

                // Rule 9: Kiểm tra điều kiện Chốt Tổng Vị Thế (Global TP)
                let shouldForceCloseAll = false;
                if (pair.activeNotes.length === 0) {
                    const isGridLong = pair.gridSide === 'LONG';
                    const targetTpOffset = systemSettings.tpPercent * pair.stepUSD;
                    const isGlobalTpReached = isGridLong ? (markP >= pair.gridAvgPrice + targetTpOffset) : (markP <= pair.gridAvgPrice - targetTpOffset);
                    
                    if (isGlobalTpReached) {
                        shouldForceCloseAll = true;
                    }
                }

                if (shouldForceCloseAll) {
                    await forceCloseSymbol(symbol, `CHỐT VỊ THẾ (Avg + ${systemSettings.tpPercent} Lưới)`);
                } else {
                    // Gom Lệnh thực thi ra sàn bằng khối lượng Qty an toàn tuyệt đối
                    for (const side of ['LONG', 'SHORT']) {
                        if (ordersToExecute[side].addQty > 0) await executeBatchOrder(symbol, side, 0, 'OPEN', ordersToExecute[side].addQty);
                        if (ordersToExecute[side].closeQty > 0) await executeBatchOrder(symbol, side, 0, 'CLOSE', ordersToExecute[side].closeQty);
                    }
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

// Kiểm tra giới hạn ký quỹ tài khoản phòng chống rủi ro cháy tài khoản
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

// ==========================================
// 6. XỬ LÝ SERVER HTTP API VÀ ĐIỀU KHIỂN UI
// ==========================================
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

// Đóng gói dữ liệu trạng thái của bot gửi lên giao diện UI Client
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

// ==========================================
// 7. KHỞI TẠO HỆ THỐNG VÀ ĐỒNG BỘ THÔNG TIN SÀN
// ==========================================
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

// Tiến trình fetch danh sách coin tín hiệu đầu vào từ Server cổng 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// ==========================================
// 8. TIẾN TRÌNH VÀO LỆNH TỰ ĐỘNG (MAIN LOOP)
// ==========================================
setInterval(async () => {
    await checkMarginLimits();
    if (!systemBot.status.isReady || !systemSettings.isRunning || systemBot.isMarginProtected) return;
    if (systemBot.activePairs.size >= systemSettings.maxPositions) return;

    let entrySignal = null;
    let rawCandidate = null; // Lưu trữ object tín hiệu gốc phục vụ in log đa khung
    
    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
        if (systemBot.activePairs.has(c.symbol)) continue;

        const m1 = parseFloat(c.c1 || 0);
        let isNormal = false; let normalSide = 'SHORT';
        if (Math.abs(m1) >= systemSettings.minVol) { isNormal = true; normalSide = m1 > 0 ? 'LONG' : 'SHORT'; }
        
        if (isNormal) {
            entrySignal = { symbol: c.symbol, gridSide: normalSide, dcaSide: normalSide === 'LONG' ? 'SHORT' : 'LONG' };
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

            // TÍNH TOÁN VÀ ÉP VOLUME THEO ĐÚNG TIÊU CHUẨN MIN NOTIONAL CỦA SÀN TRƯỚC KHI MỞ
            let targetQty = (calculatedMargin * info.maxLeverage) / startPrice;
            targetQty = Math.floor(targetQty / info.stepSize) * info.stepSize;
            if (targetQty * startPrice < info.minNotional) {
                targetQty = Math.ceil((info.minNotional / startPrice) / info.stepSize) * info.stepSize;
            }

            // Gọi lệnh mở vị thế với khối lượng qty đã tính toán an toàn
            const gridMargin = await executeBatchOrder(symbol, entrySignal.gridSide, 0, 'OPEN', targetQty);
            const dcaMargin = await executeBatchOrder(symbol, entrySignal.dcaSide, 0, 'OPEN', targetQty);

            if (gridMargin <= 0 || dcaMargin <= 0) {
                throw new Error("Không lấy được margin thực tế.");
            }

            // Khởi tạo lưu cấu trúc cặp giao dịch và ghi nhớ baseQty
            systemBot.activePairs.set(symbol, {
                symbol: symbol,
                gridSide: entrySignal.gridSide,
                dcaSide: entrySignal.dcaSide,
                firstEntryPrice: startPrice,
                initialMargin: gridMargin,
                baseQty: targetQty, // Ghi nhớ khối lượng gốc cố định tránh lỗi volume < 5 notional về sau
                leverage: info.maxLeverage,
                stepUSD: startPrice * (systemSettings.gridStepPercent / 100),
                lastLevel: 0,
                executedGridLevels: { 0: true },
                executedDcaBaseLevels: { 0: true },
                activeNotes: [],
                closedNotesCount: 0,
                closedNotesPnL: 0,
                gridAvgPrice: startPrice,
                gridTotalMargin: gridMargin,   // FIX: Khôi phục và sửa triệt để lỗi realMargin is not defined
                dcaTotalMargin: dcaMargin,     // FIX: Khôi phục và sửa triệt để lỗi realMargin is not defined
                createdAt: Date.now()
            });

            // Ghi nhận biến động dữ liệu 3 khung
            const frame1 = rawCandidate?.c1 || 0;
            const frame2 = rawCandidate?.c2 || 0;
            const frame3 = rawCandidate?.c3 || 0;

            addLog(`🚀 VÀO LỆNH MỚI | ${symbol} | Giá: ${formatPrice(startPrice)} | Vốn: ${gridMargin.toFixed(2)}$ mỗi chiều | Lev: x${info.maxLeverage} | Hướng Lưới: ${entrySignal.gridSide} | Biến động 3 khung: [${frame1}, ${frame2}, ${frame3}]`, "open");
        } catch (e) {
            addLog(`❌ LỖI VÀO LỆNH ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

// Khởi chạy Express Server quản lý lắng nghe duy nhất trên Port 1820
appServer.listen(1820, () => console.log('🚀 [HEDGE SYSTEM] Đang chạy trên Port 1820 duy nhất!'));
