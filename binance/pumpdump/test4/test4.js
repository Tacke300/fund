import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================
// ⚙️ CẤU HÌNH MAX DCA CHO BOT (ĐƯA LÊN ĐẦU CODE)
// =========================================================
const MAX_DCA_LEVEL = 999999; 
const MIN_NOTIONAL_FORCE = 5.1; // Ép lệnh tối thiểu 5.1$ không cho vọt lên 10$

function getMaxDcaLimit(dcaType, side) {
    if (dcaType === 'DUONG') {
        return MAX_DCA_LEVEL; 
    } else {
        if (side === 'LONG') return MAX_DCA_LEVEL; 
        if (side === 'SHORT') return 3; // Đã giảm từ 5 xuống 3 theo yêu cầu             
    }
    return MAX_DCA_LEVEL;
}

// =========================================================
// CẤU HÌNH KHUNG THỜI GIAN QUÉT & TRẠNG THÁI CACHE
// =========================================================
const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],            
    DIA_NGUC: ['M1', 'M5', 'M15']    
};

const ANTI_LIQUIDATION_LIMIT = 10; // Đã đẩy lên bảo vệ 10% tài khoản
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  

const globalStartTime = Date.now();

function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

let walletCache1 = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };
let walletCache2 = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    dcaAmOpponentClosedProfit: {} // Theo dõi chốt lời chéo khi chưa DCA của chu kỳ DCA Âm
};

// =========================================================
// HÀM CHUYỂN ĐỔI VÀ ÉP KIỂU DỮ LIỆU TỪ UI
// =========================================================
function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        const lowerKey = key.toLowerCase();
        const val = reqBody[key];
        
        if (lowerKey === 'dcatypethuong' || lowerKey === 'typedcathuong') {
            normalizedBody.dcaTypeThuong = val.toUpperCase(); 
            normalizedBody.typeDcaThuong = val.toUpperCase(); 
        }
        else if (lowerKey === 'dcatypedianguc' || lowerKey === 'typedcadianguc') {
            normalizedBody.dcaTypeDianguc = val.toUpperCase(); 
            normalizedBody.typeDcaDianguc = val.toUpperCase(); 
        }
        else if (lowerKey === 'hesothuong') normalizedBody.heSoThuong = parseFloat(val);
        else if (lowerKey === 'hesodianguc') normalizedBody.heSoDianguc = parseFloat(val);
        else if (lowerKey === 'maxpositions') normalizedBody.maxPositions = parseInt(val);
        else if (lowerKey === 'minvol') normalizedBody.minVol = parseFloat(val);
        else if (lowerKey === 'postp') normalizedBody.posTP = parseFloat(val);
        else if (lowerKey === 'possl') normalizedBody.posSL = parseFloat(val);
        else if (lowerKey === 'dianguctp') normalizedBody.dianguctp = parseFloat(val);
        else if (lowerKey === 'diangucsl') normalizedBody.diangucsl = parseFloat(val);
        else if (lowerKey === 'diangucdca') normalizedBody.diangucdca = parseFloat(val);
        else if (lowerKey === 'posdca') normalizedBody.posdca = parseFloat(val);
        else if (lowerKey === 'diangucvol') normalizedBody.diangucvol = parseFloat(val);
        else if (lowerKey === 'maxdca') normalizedBody.maxDCA = parseInt(val);
        else {
            if (typeof val === 'string' && !isNaN(val) && val.trim() !== '' && !val.includes('%')) {
                normalizedBody[key] = parseFloat(val);
            } else {
                normalizedBody[key] = val;
            }
        }
    }
    return { ...currentSettings, ...normalizedBody };
}

// =========================================================
// CẤU TRÚC RIÊNG BIỆT CHO 2 BOT INSTANCE
// =========================================================
let bot1 = {
    id: "BOT_1",
    sideMode: "NORMAL", 
    startTime: Date.now(),
    botSettings: { 
        isRunning: false, dcaTypeThuong: 'DUONG', typeDcaThuong: 'DUONG', dcaTypeDianguc: 'AM', typeDcaDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL,
        heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(), 
    isProcessingDCA: new Set(),
    logThrottle: new Map(), 
    timestampOffset: 0,
    isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

let bot2 = {
    id: "BOT_2",
    sideMode: "REVERSED", 
    startTime: Date.now(),
    botSettings: { 
        isRunning: false, dcaTypeThuong: 'DUONG', typeDcaThuong: 'DUONG', dcaTypeDianguc: 'AM', typeDcaDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL,
        heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(), 
    isProcessingDCA: new Set(),
    logThrottle: new Map(), 
    timestampOffset: 0,
    isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

// =========================================================
// HỆ THỐNG LOGS
// =========================================================
function addBotLog(bot, msg, type = 'info', throttleKey = null, isDianguc = false) {
    if (throttleKey) {
        const now = Date.now();
        const last = bot.logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        bot.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    
    let uiMsg = msg;
    if (isDianguc && !msg.includes('<span')) {
        uiMsg = `<span style="color: #ef4444; font-weight: 600;">[ĐỊA NGỤC] ${msg}</span>`;
    }
    
    bot.status.botLogs.unshift({ time, msg: uiMsg, type, isDianguc });
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    
    let consolePrefix = `[${time}][${bot.id}][${type.toUpperCase()}]`;
    let consoleOutput = `${consolePrefix} ${msg}`;
    if (isDianguc) consoleOutput = `\x1b[31m${consolePrefix} [ĐỊA NGỤC] ${msg}\x1b[0m`;
    console.log(consoleOutput);
}

async function binancePrivate(bot, endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + bot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await bot.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            bot.timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(bot, endpoint, method, data);
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
    const hasBot1 = bot1.botActivePositions.has(`${symbol}_LONG`) || bot1.botActivePositions.has(`${symbol}_SHORT`);
    const hasBot2 = bot2.botActivePositions.has(`${symbol}_LONG`) || bot2.botActivePositions.has(`${symbol}_SHORT`);
    if (!hasBot1 && !hasBot2) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
        addBotLog(bot1, `🚫 [BLACKLIST CHUNG] Đã chặn ${symbol} 15 phút.`, "warn");
        addBotLog(bot2, `🚫 [BLACKLIST CHUNG] Đã chặn ${symbol} 15 phút.`, "warn");
    }
}

// =========================================================
// HÀM ĐÓNG VỊ THẾ BẰNG TAY / TRAILING
// =========================================================
async function closePositionAndLog(bot, b, markP, reasonStr) {
    try {
        const info = sharedState.exchangeInfo[b.symbol];
        const pPrec = info ? info.pricePrecision : 6; 

        await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        await new Promise(resolve => setTimeout(resolve, 2000)); 
        const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
        const nowServer = Date.now() + bot.timestampOffset;
        const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 25000);
        
        let finalPnL = 0;
        const feeVolDeduction = (b.currentQty * markP * 0.001);

        if (matchingTrades.length > 0) {
            finalPnL = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0) - feeVolDeduction;
        } else {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            finalPnL = pnlRaw - feeVolDeduction;
        }

        bot.status.botClosedCount++;
        bot.status.botPnLClosed += finalPnL;

        if (finalPnL >= 0) {
            bot.status.pnlGain = (bot.status.pnlGain || 0) + finalPnL;
        } else {
            bot.status.pnlLoss = (bot.status.pnlLoss || 0) + finalPnL;
        }

        let logType = finalPnL >= 0 ? "success" : "sl";
        if (reasonStr.includes("AVG") || reasonStr.includes("TRAILING")) logType = "avg"; 

        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | Giá chốt: ${markP.toFixed(pPrec)} | PnL: ${finalPnL.toFixed(2)}$`, logType, null, b.isDiangucMode);
        
        // Dọn sạch lệnh treo nếu có liên quan
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol }).catch(() => []);
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addBotLog(bot, `❌ Lỗi đóng vị thế ${b.symbol}: ${e.message}`, "error", null, b.isDiangucMode);
    }
}

async function panicCloseAll(bot, reasonLog) {
    try {
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        let count = 0;
        for (const p of active) {
            const side = p.positionSide;
            const qty = Math.abs(parseFloat(p.positionAmt));
            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            const key = `${p.symbol}_${side}`;
            try {
                await bot.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                count++;
                
                // Kết toán PnL dứt điểm của bot vào báo cáo danh dự
                const b = bot.botActivePositions.get(key);
                if (b) {
                    let pnlRaw = parseFloat(p.unRealizedProfit || 0);
                    const feeVolDeduction = (qty * parseFloat(p.markPrice) * 0.001);
                    let finalPnL = pnlRaw - feeVolDeduction;

                    bot.status.botClosedCount++;
                    bot.status.botPnLClosed += finalPnL;
                    if (finalPnL >= 0) {
                        bot.status.pnlGain = (bot.status.pnlGain || 0) + finalPnL;
                    } else {
                        bot.status.pnlLoss = (bot.status.pnlLoss || 0) + finalPnL;
                    }
                }
            } catch (err) { }
        }
        bot.botActivePositions.clear();
        addBotLog(bot, `⚠️ [CHỐNG THANH LÝ 10%] Đã đóng sạch vị thế (${reasonLog}) và kết toán tài khoản công khai.`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

// =========================================================
// VÒNG LẶP MONITOR GIÁ & BẮT CẮN LỆNH NỘI BỘ VÀ BLACKLIST
// =========================================================
async function priceMonitor(bot) {
    if (!bot.status.isReady) return setTimeout(() => priceMonitor(bot), 1000);
    try {
        if (!bot.botSettings.isRunning) return setTimeout(() => priceMonitor(bot), 1000);
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
        
        for (let [key, b] of bot.botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;

            const dcaType = b.isDiangucMode ? (bot.botSettings.typeDcaDianguc || bot.botSettings.dcaTypeDianguc) : (bot.botSettings.typeDcaThuong || bot.botSettings.dcaTypeThuong);
            const maxDcaSetting = getMaxDcaLimit(dcaType, b.side);

            // ⭐ TRƯỜNG HỢP VỊ THẾ ĐANG CHẠY TRÊN SÀN
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                b.currentQty = currentQty;
                b.livePrice = markP;
                b.pnl = parseFloat(realP.unRealizedProfit);

                if (b.side === 'LONG') b.profitPercent = ((markP - b.avgEntry) / b.avgEntry) * 100;
                else b.profitPercent = ((b.avgEntry - markP) / b.avgEntry) * 100;

                // ⚡ 1. TÍNH NĂNG CHỐNG TREO QUÁ 60 PHÚT
                const lastActionTime = b.lastActionTime || b.createdAt || Date.now();
                if (Date.now() - lastActionTime > 60 * 60 * 1000) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "CHỐNG TREO >60P KHÔNG HOẠT ĐỘNG");
                    checkAndAddBlacklist(b.symbol);
                    continue;
                }

                // ⚡ 2. KIỂM TRA CHỐT LỜI TP (Đọc bộ nhớ trong của bot)
                const hitInternalTP = b.side === 'LONG' ? (markP >= b.tp) : (markP <= b.tp);
                if (hitInternalTP) {
                    bot.botActivePositions.delete(key);
                    // Nếu là lệnh gốc DCA Âm chốt lời thành công, kích hoạt tín hiệu cho bot đối thủ chốt non 0.5%
                    if (dcaType === 'AM' && b.dcaCount === 0) {
                        sharedState.dcaAmOpponentClosedProfit[b.symbol] = true;
                    }
                    await closePositionAndLog(bot, b, markP, "CHỐT TP NỘI BỘ CỨNG");
                    checkAndAddBlacklist(b.symbol);
                    continue;
                }

                // ⚡ 3. KIỂM TRA CHỐT LỖ SL NỘI BỘ (Khi hết lượt DCA Âm mà giá vẫn vượt mốc)
                const hitInternalSL = b.side === 'LONG' ? (markP <= b.sl) : (markP >= b.sl);
                if (hitInternalSL) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "CẮT LỖ SL NỘI BỘ");
                    checkAndAddBlacklist(b.symbol);
                    continue;
                }

                // ⚡ 4. KIỂM TRA CHỐT SỚM 0.5% (DCA Âm - Khi chưa DCA và bot còn lại đã TP)
                if (dcaType === 'AM' && b.dcaCount === 0 && sharedState.dcaAmOpponentClosedProfit[b.symbol] === true) {
                    const originalProfitPercent = b.side === 'LONG' ? ((markP - b.firstEntry) / b.firstEntry) * 100 : ((b.firstEntry - markP) / b.firstEntry) * 100;
                    if (originalProfitPercent >= 0.5) {
                        bot.botActivePositions.delete(key);
                        await closePositionAndLog(bot, b, markP, "CHỐT SỚM AN TOÀN 0.5% (ĐỐI THỦ ĐÃ TP)");
                        checkAndAddBlacklist(b.symbol);
                        continue;
                    }
                }

                // ⚡ 5. LOGIC KÍCH HOẠT NHỒI LỆNH DCA
                if (dcaType === 'DUONG') {
                    // DCA Dương: Giữ nguyên cơ chế Trailing cũ như yêu cầu
                    let shouldCloseMarket = false;
                    if (b.dcaCount > 0) { 
                        const trailingOffset = b.firstEntry * 0.001; 
                        if (b.side === 'LONG' && markP <= (b.avgEntry + trailingOffset)) shouldCloseMarket = true;
                        if (b.side === 'SHORT' && markP >= (b.avgEntry - trailingOffset)) shouldCloseMarket = true;
                    }

                    if (shouldCloseMarket) {
                        bot.botActivePositions.delete(key); 
                        await closePositionAndLog(bot, b, markP, "CHỐT TRAILING AVG (DCA DƯƠNG)");
                        checkAndAddBlacklist(b.symbol); 
                        continue;
                    }

                    const hitDcaDuong = (b.side === 'LONG' && markP >= b.nextDCA) || (b.side === 'SHORT' && markP <= b.nextDCA);
                    if (hitDcaDuong && b.dcaCount < maxDcaSetting) {
                        if (!bot.isProcessingDCA.has(lockKey)) {
                            const jump = b.dcaCount + 1;
                            const coefMode = b.isDiangucMode ? parseFloat(bot.botSettings.heSoDianguc || 3) : parseFloat(bot.botSettings.heSoThuong || 2);
                            let marginToUse = b.firstMargin * jump * 2 * coefMode; 
                            openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                        }
                    }
                } else {
                    // DCA ÂM MỚI: Chỉ nhồi trực tiếp lệnh khi đang lỗ chạm mốc
                    const hitDcaAm = (b.side === 'LONG' && markP <= b.nextDCA) || (b.side === 'SHORT' && markP >= b.nextDCA);
                    if (hitDcaAm) {
                        if (b.dcaCount < maxDcaSetting) {
                            if (!bot.isProcessingDCA.has(lockKey)) {
                                const jump = b.dcaCount + 1;
                                const coefMode = b.isDiangucMode ? parseFloat(bot.botSettings.heSoDianguc || 3) : parseFloat(bot.botSettings.heSoThuong || 2);
                                let marginToUse = b.firstMargin * jump * 2 * coefMode; 
                                addBotLog(bot, `📉 Đang gồng lỗ ${b.symbol} ${b.side}. Nhồi lệnh DCA ÂM trực tiếp cấp ${jump}!`, "warn", null, b.isDiangucMode);
                                openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                            }
                        } else {
                            // Hết lượt DCA => Ép giá cắt lỗ SL nội bộ ngay lập tức tại điểm gồng cuối cùng
                            bot.botActivePositions.delete(key);
                            await closePositionAndLog(bot, b, markP, "CẮT LỖ SL NỘI BỘ (HẾT LƯỢT DCA)");
                            checkAndAddBlacklist(b.symbol);
                            continue;
                        }
                    }
                }
            } 
            // ⭐ TRƯỜNG HỢP VỊ THẾ BỊ SÀN QUÉT MẤT NGOÀI Ý MUỐN (BẢO VỆ DỰ PHÒNG)
            else {
                if (bot.isProcessingDCA.has(lockKey)) continue;
                bot.botActivePositions.delete(key); 
                checkAndAddBlacklist(b.symbol);
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 500); // Tần suất quét lệnh siêu nhanh 500ms
}

// =========================================================
// HÀM MỞ VỊ THẾ & ÉP CHUẨN KÍCH THƯỚC VỐN MIN SÀN
// =========================================================
async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isDiangucSignal = false) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    
    if (bot.isProcessingDCA.has(lockKey)) return;
    bot.isProcessingDCA.add(lockKey); 
    
    try {
        const info = sharedState.exchangeInfo[symbol];
        if(!info) throw new Error("Coin không hỗ trợ");
        const pPrec = info.pricePrecision; 

        let qty = 0, margin = 0, currentPrice = 0;
        
        // Mức vốn tối thiểu an toàn, ép không để vọt lên tận 10$
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        if (isDCA) {
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            currentPrice = parseFloat(ticker.data.price);
            margin = dcaData.margin;
            
            // SỬA LỖI SIZE VỌT: Ép sàn chặt chẽ bằng Math.ceil theo đúng stepSize để không bị nhảy giá trị quá lớn
            let desiredQty = (margin * info.maxLeverage) / currentPrice;
            qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
            
            if (qty * currentPrice < actualMinNotional) {
                qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
            qty = Number(qty.toFixed(info.quantityPrecision)); // Chuẩn hóa string tránh lỗi exponent
        } else {
            qty = sharedQty;
            margin = sharedMargin;
            currentPrice = sharedPrice;
        }

        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            const currentModeIsHell = isDCA ? dcaData.isDiangucMode : isDiangucSignal;
            const dcaType = currentModeIsHell ? (bot.botSettings.typeDcaDianguc || bot.botSettings.dcaTypeDianguc) : (bot.botSettings.typeDcaThuong || bot.botSettings.dcaTypeThuong);
            
            let cumulativeQty = qty;
            let cumulativeCost = qty * actualFilledPrice;
            let newAvgEntry = actualFilledPrice;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage;
            let totalMargin = actualMarginUsed;
            let dcaHistory = [];

            if (isDCA) {
                cumulativeQty = dcaData.cumulativeQty + qty;
                cumulativeCost = dcaData.cumulativeCost + (qty * actualFilledPrice);
                newAvgEntry = cumulativeCost / cumulativeQty;
                totalMargin = dcaData.currentMargin + actualMarginUsed;
                dcaHistory = [...dcaData.dcaHistory, { price: actualFilledPrice, margin: actualMarginUsed }];
            } else {
                dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed }];
                // Thiết lập chu kỳ mới, reset trạng thái chốt chéo lệnh gốc
                sharedState.dcaAmOpponentClosedProfit[symbol] = false;
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            
            const dcaThreshold = currentModeIsHell ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
            const slPercent = currentModeIsHell ? parseFloat(bot.botSettings.diangucsl) : parseFloat(bot.botSettings.posSL);
            const tpPercent = currentModeIsHell ? parseFloat(bot.botSettings.dianguctp) : parseFloat(bot.botSettings.posTP);

            let finalTP, finalSL, nextDCA;
            const dir = (side === 'LONG' ? 1 : -1);

            if (dcaType === 'DUONG') {
                nextDCA = firstE * (1 + dir * ((dcaCount + 1) * dcaThreshold / 100)); 
                if (!isDCA) {
                    finalTP = newAvgEntry * (1 + dir * (tpPercent / 100));
                    finalSL = newAvgEntry * (1 - dir * (slPercent / 100)); 
                } else {
                    finalTP = dcaData.tp; finalSL = dcaData.sl; 
                }
            } else {
                // DCA ÂM: Khoảng cách mốc nhồi kế tiếp dựa trên % khoảng lỗ cài đặt
                nextDCA = firstE * (1 - dir * ((dcaCount + 1) * slPercent / 100)); 
                
                // FIX CHUẨN TP DCA ÂM: TP = Giá Avg mới + % TP đã cài tính theo giá Entry gốc ban đầu
                const baseProfitFromOriginalEntry = firstE * (tpPercent / 100);
                finalTP = newAvgEntry + dir * baseProfitFromOriginalEntry;
                
                // Mốc SL cuối cùng của DCA Âm tính theo điểm giới hạn nhồi lệnh tối đa
                const maxAllowedDca = getMaxDcaLimit('AM', side);
                finalSL = firstE * (1 - dir * ((maxAllowedDca + 1) * slPercent / 100));
            }

            bot.botActivePositions.set(lockKey, { 
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, dcaCount: dcaCount, 
                leverage: info.maxLeverage, firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, 
                currentMargin: totalMargin, currentQty: cumulativeQty, 
                cumulativeQty: cumulativeQty, cumulativeCost: cumulativeCost, dcaHistory: dcaHistory,
                isDiangucMode: currentModeIsHell, pnl: 0, profitPercent: 0, 
                avgEntry: newAvgEntry, nextDCA: nextDCA, livePrice: actualFilledPrice,
                createdAt: dcaData ? dcaData.createdAt : Date.now(),
                lastActionTime: Date.now(), // Cập nhật mốc thời gian hành động mới nhất
                time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
            });
            
            if (!isDCA) {
                const cand = sharedState.candidatesList.find(c => c.symbol === symbol);
                const logStr = `[MỞ ${side}][CHẾ ĐỘ: ${currentModeIsHell ? "ĐỊA NGỤC" : "THƯỜNG"}] ${symbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(pPrec)} | Mốc DCA kế: ${nextDCA.toFixed(pPrec)} | TP Bộ nhớ: ${finalTP.toFixed(pPrec)} | SL Bộ nhớ: ${finalSL.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "open", null, currentModeIsHell); 
            } else {
                const historyPricesStr = dcaHistory.map(h => h.price.toFixed(pPrec)).join(' ➔ ');
                const dcaTypeStr = dcaType === 'AM' ? "DCA ÂM" : "DCA DƯƠNG";
                const logStr = `[${dcaTypeStr}] ${symbol} | Khớp lệnh nhồi cấp ${dcaCount} | Vốn tổng: ${totalMargin.toFixed(2)}$ | Chuỗi giá: [ ${historyPricesStr} ] | Avg Mới: ${newAvgEntry.toFixed(pPrec)} | TP Mới: ${finalTP.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "dca", null, currentModeIsHell); 
            }
        }
    } catch (e) { 
        const info = sharedState.exchangeInfo?.[symbol];
        if (info && info.maxLeverage < 20) {
            sharedState.permanentBlacklist[symbol] = true;
            addBotLog(bot, `❌ [BAN VĨNH VIỄN] Max leverage dưới 20 | Lỗi tại ${symbol}: ${e.message}`, "error"); 
        } else {
            sharedState.blackList[symbol] = Date.now() + (5 * 60 * 1000); 
            addBotLog(bot, `⏳ [BLACKLIST TẠM THỜI 5 PHÚT] Gặp lỗi hệ thống/margin tại ${symbol}: ${e.message}`, "error");
        }
    } finally { 
        setTimeout(() => bot.isProcessingDCA.delete(lockKey), 1000); 
    }
}

async function checkMarginLimits(bot) {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return;
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0);
        const availUsdt = parseFloat(acc.availableBalance || 0);
        if (totalWallet > 0) {
            const availPercent = (availUsdt / totalWallet) * 100;
            
            if (availPercent <= ANTI_LIQUIDATION_LIMIT) {
                await panicCloseAll(bot, `CHỐNG THANH LÝ ${ANTI_LIQUIDATION_LIMIT}%`);
                bot.isMarginProtected = false; 
                return; 
            }
            if (!bot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
                bot.isMarginProtected = true; addBotLog(bot, `⚠️ CẢNH BÁO: Khả dụng giảm dưới ${MARGIN_PROTECT_LIMIT}%. Dừng quét lệnh mới!`, "warn");
            } else if (bot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                bot.isMarginProtected = false; addBotLog(bot, `✅ Khả dụng phục hồi trên ${MARGIN_RECOVER_LIMIT}%. Mở lại quét lệnh.`, "info");
            }
        }
    }
}

// =========================================================
// EXPRESS SERVER & UI API
// =========================================================
function allowCors(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

const appServer = express(); appServer.use(allowCors); appServer.use(express.json()); 
appServer.use(express.static(__dirname, { index: false })); 

const appBot1 = express(); appBot1.use(allowCors); appBot1.use(express.json()); appBot1.use(express.static(__dirname));
const appBot2 = express(); appBot2.use(allowCors); appBot2.use(express.json()); appBot2.use(express.static(__dirname));

appServer.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'sever.html'));
});

async function buildStatusResponse(bot, cacheObj) {
    const now = Date.now();
    if (now - cacheObj.lastUpdate > 3000) {
        const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
        if (acc) {
            cacheObj.data = { totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) };
            cacheObj.lastUpdate = now;
        }
    }
    const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk').catch(() => []);
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }
    const currentBotUptime = formatUptime(bot.startTime);
    return { 
        botSettings: bot.botSettings, 
        activePositions: Array.from(bot.botActivePositions.values()), 
        exchangePositions: posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0), 
        status: { 
            botLogs: bot.status.botLogs, 
            botClosedCount: bot.status.botClosedCount, 
            botPnLClosed: bot.status.botPnLClosed,
            pnlGain: bot.status.pnlGain || 0,
            pnlLoss: bot.status.pnlLoss || 0,
            isReady: bot.status.isReady, 
            candidatesList: sharedState.candidatesList, 
            blackList: formattedBlacklist, 
            permanentBlacklist: sharedState.permanentBlacklist, 
            exchangeInfo: sharedState.exchangeInfo,
            timeRun: currentBotUptime
        }, 
        wallet: cacheObj.data,
        timeRun: currentBotUptime
    };
}

const handleQuickCloseSymbol = async (bot, req, res) => {
    const { symbol } = req.body;
    let foundSide = null;
    for (let [key, b] of bot.botActivePositions) {
        if (b.symbol === symbol) { foundSide = b.side; break; }
    }
    if (!foundSide) {
        try {
            const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk', 'GET', { symbol });
            const p = posRisk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) foundSide = p.positionSide;
        } catch(e){}
    }
    if (!foundSide) return res.json({ success: false, msg: "Không thấy vị thế" });
    
    const key = `${symbol}_${foundSide}`; const b = bot.botActivePositions.get(key);
    if (b) {
        bot.botActivePositions.delete(key);
        try { await closePositionAndLog(bot, b, b.livePrice, "ĐÓNG NHANH TỪ LÕI UI"); checkAndAddBlacklist(symbol); return res.json({ success: true }); } 
        catch (e) { return res.json({ success: false, msg: e.message }); }
    } else {
        try {
            const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk', 'GET', { symbol });
            const p = posRisk.find(x => x.positionSide === foundSide && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) await bot.exchange.createOrder(symbol, 'MARKET', foundSide === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: foundSide });
            res.json({ success: true });
        } catch (e) { res.json({ success: false, msg: e.message }); }
    }
};

appBot1.post('/api/settings', (req, res) => { 
    const prevRunning = bot1.botSettings.isRunning;
    bot1.botSettings = parseNormalizedSettings(req.body, bot1.botSettings); 
    if (!prevRunning && bot1.botSettings.isRunning) bot1.startTime = Date.now();
    res.json({ success: true }); 
});
appBot2.post('/api/settings', (req, res) => { 
    const prevRunning = bot2.botSettings.isRunning;
    bot2.botSettings = parseNormalizedSettings(req.body, bot2.botSettings); 
    if (!prevRunning && bot2.botSettings.isRunning) bot2.startTime = Date.now();
    res.json({ success: true }); 
});

appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1, walletCache1)));
appBot1.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot1, "PANIC CLOSE QUA UI BOT 1")));
appBot1.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body; const key = `${symbol}_${side}`; const b = bot1.botActivePositions.get(key);
    if (b) { bot1.botActivePositions.delete(key); try { await closePositionAndLog(bot1, b, b.livePrice, "ĐÓNG THỦ CÔNG"); checkAndAddBlacklist(symbol); return res.json({ success: true }); } catch (e) { return res.json({ success: false, msg: e.message }); } } 
    else { try { const posRisk = await binancePrivate(bot1, '/fapi/v2/positionRisk', 'GET', { symbol }); const p = posRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0); if (p) await bot1.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side }); res.json({ success: true }); } catch (e) { res.json({ success: false, msg: e.message }); } }
});
appBot1.post('/api/close_symbol', (req, res) => handleQuickCloseSymbol(bot1, req, res));

appBot2.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot2, walletCache2)));
appBot2.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot2, "PANIC CLOSE QUA UI BOT 2")));
appBot2.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body; const key = `${symbol}_${side}`; const b = bot2.botActivePositions.get(key);
    if (b) { bot2.botActivePositions.delete(key); try { await closePositionAndLog(bot2, b, b.livePrice, "ĐÓNG THỦ CÔNG"); checkAndAddBlacklist(symbol); return res.json({ success: true }); } catch (e) { return res.json({ success: false, msg: e.message }); } } 
    else { try { const posRisk = await binancePrivate(bot2, '/fapi/v2/positionRisk', 'GET', { symbol }); const p = posRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0); if (p) await bot2.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side }); res.json({ success: true }); } catch (e) { res.json({ success: false, msg: e.message }); } }
});
appBot2.post('/api/close_symbol', (req, res) => handleQuickCloseSymbol(bot2, req, res));

appServer.get('/api/health', (req, res) => { res.json({ status: "running", bot1_positions: bot1.botActivePositions.size, bot2_positions: bot2.botActivePositions.size, blacklist_count: Object.keys(sharedState.blackList).length }); });

async function init() {
    try {
        await bot1.exchange.loadMarkets(); await bot2.exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(bot1, '/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol); const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { sharedState.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        bot1.status.isReady = true; bot2.status.isReady = true;
        priceMonitor(bot1); priceMonitor(bot2); 
        
        addBotLog(bot1, `🚀 Khởi động Lõi thành công. Ports mở: 1815 (Master), 1816 (Bot 1), 1817 (Bot 2).`, "info");
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// =========================================================
// VÒNG LẶP CHÍNH & PHÂN PHỐI LỆNH TỐC ĐỘ CAO (DELAY 300MS)
// =========================================================
setInterval(async () => {
    await checkMarginLimits(bot1); await checkMarginLimits(bot2);
    if (!bot1.status.isReady || !bot2.status.isReady) return;

    const canBot1Run = bot1.botSettings.isRunning && !bot1.isMarginProtected && (bot1.botActivePositions.size < bot1.botSettings.maxPositions) && (bot1.isProcessingDCA.size === 0);
    const canBot2Run = bot2.botSettings.isRunning && !bot2.isMarginProtected && (bot2.botActivePositions.size < bot2.botSettings.maxPositions) && (bot2.isProcessingDCA.size === 0);

    if (!canBot1Run && !canBot2Run) return;

    const targetBotForRisk = bot1.botSettings.isRunning ? bot1 : bot2;
    const posRisk = await binancePrivate(targetBotForRisk, '/fapi/v2/positionRisk').catch(() => []);
    const exchangeSymbolsWithPositions = new Set(posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => p.symbol));

    let entrySignal = null;
    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 

        const diangucVol = parseFloat(bot1.botSettings.diangucvol);
        const minVol = parseFloat(bot1.botSettings.minVol);
        
        const m1 = parseFloat(c.c1 || 0); const m5 = parseFloat(c.c5 || 0); const m15 = parseFloat(c.c15 || 0);
        
        let isHell = false; let hellSide = 'SHORT';
        for (const tf of SCAN_CONFIG.DIA_NGUC) {
            const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
            if (Math.abs(val) >= diangucVol) { isHell = true; hellSide = val > 0 ? 'LONG' : 'SHORT'; break; }
        }

        const b1Active = Array.from(bot1.botActivePositions.values()).filter(p => p.symbol === c.symbol);
        const b2Active = Array.from(bot2.botActivePositions.values()).filter(p => p.symbol === c.symbol);
        const hasNormalPos = (bot1.botSettings.isRunning && b1Active.some(p => !p.isDiangucMode)) || (bot2.botSettings.isRunning && b2Active.some(p => !p.isDiangucMode));
        
        const manualPos = posRisk.filter(p => p.symbol === c.symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
        const trackedCount = (bot1.botSettings.isRunning ? b1Active.length : 0) + (bot2.botSettings.isRunning ? b2Active.length : 0);
        const hasManualNotTracked = manualPos.length > trackedCount;

        if (isHell) {
            const needsOverride = hasNormalPos || hasManualNotTracked;
            entrySignal = { symbol: c.symbol, side: hellSide, isDianguc: true, override: needsOverride };
            break; 
        }

        if (!entrySignal && !exchangeSymbolsWithPositions.has(c.symbol)) {
            let isNormal = false; let normalSide = 'SHORT';
            for (const tf of SCAN_CONFIG.THUONG) {
                const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
                if (Math.abs(val) >= minVol) { isNormal = true; normalSide = val > 0 ? 'LONG' : 'SHORT'; break; }
            }
            if (isNormal) {
                entrySignal = { symbol: c.symbol, side: normalSide, isDianguc: false, override: false };
                break;
            }
        }
    }

    if (entrySignal) {
        const symbol = entrySignal.symbol;

        if (entrySignal.override) {
            if (bot1.botSettings.isRunning) addBotLog(bot1, `🔥 ĐỊA NGỤC KÍCH HOẠT! Dứt chuỗi lệnh Thường/Tay tại ${symbol}.`, "warn", null, true);
            if (bot2.botSettings.isRunning) addBotLog(bot2, `🔥 ĐỊA NGỤC KÍCH HOẠT! Dứt chuỗi lệnh Thường/Tay tại ${symbol}.`, "warn", null, true);
            
            const forceCloseSymbol = async (bot) => {
                if (!bot.botSettings.isRunning) return;
                const pr = await binancePrivate(bot, '/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => []);
                for (const p of pr) {
                    const amt = parseFloat(p.positionAmt);
                    if (Math.abs(amt) > 0) {
                        const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                        await bot.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide }).catch(() => {});
                    }
                }
                bot.botActivePositions.forEach((v, k) => { if (v.symbol === symbol) bot.botActivePositions.delete(k); });
            };
            
            await Promise.all([forceCloseSymbol(bot1), forceCloseSymbol(bot2)]);
            await new Promise(r => setTimeout(r, 500)); 
        }

        const info = sharedState.exchangeInfo[symbol];
        if (!info) return;

        const targetBotForAcc = bot1.botSettings.isRunning ? bot1 : bot2;
        const acc = await binancePrivate(targetBotForAcc, '/fapi/v2/account').catch(() => null);
        if (!acc) return; 
        const snapshotAvailable = parseFloat(acc.availableBalance || 0);

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
        if (!ticker) return;
        const currentPrice = parseFloat(ticker.data.price);
        
        const marginSetting = targetBotForAcc.botSettings.invValue;
        let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

        // Mức vốn tối thiểu an toàn, ép không để vọt lên tận 10$
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        // ĐỒNG BỘ LẠI SIZE BAN ĐẦU: Giảm thiểu sai lệch bước giá và chặn lỗi Notional sàn
        const desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
        let finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
        if (finalQty * currentPrice < actualMinNotional) {
            finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
        finalQty = Number(finalQty.toFixed(info.quantityPrecision)); // Ép kiểu chuẩn
        
        const finalMargin = (finalQty * currentPrice) / info.maxLeverage;

        if (canBot1Run) {
            const sideForBot1 = bot1.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;
            openPosition(bot1, symbol, null, sideForBot1, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
        }
        if (canBot2Run) {
            const sideForBot2 = bot2.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;
            if (canBot1Run) {
                // ⚡ GIẢM TRỄ MỞ LỆNH SONG SONG XUỐNG CÒN ĐÚNG 300MS NHƯ YÊU CẦU
                setTimeout(() => { openPosition(bot2, symbol, null, sideForBot2, finalQty, finalMargin, currentPrice, entrySignal.isDianguc); }, 300);
            } else {
                openPosition(bot2, symbol, null, sideForBot2, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
            }
        }
    }
}, 3000); 

appServer.listen(1815, () => console.log('🌐 [MAIN SERVER] Giao diện VIP đang chạy tại Port 1815'));
appBot1.listen(1816, () => console.log('📈 [BOT 1 UI] Web Điều Khiển Bot 1 đang chạy tại Port 1816'));
appBot2.listen(1817, () => console.log('📉 [BOT 2 UI] Web Điều Khiển Bot 2 đang chạy tại Port 1817'));
