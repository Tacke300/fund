import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================
// ⚙️ CẤU HÌNH KHUNG THỜI GIAN QUÉT & TRẠNG THÁI CACHE
// =========================================================
const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],            
    DIA_NGUC: ['M1', 'M5', 'M15']    
};

const ANTI_LIQUIDATION_LIMIT = 5; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  
const MAX_DCA_LEVEL = 999999;     

// Bộ nhớ đệm (Cache) chống chớp nháy số dư trên UI
let walletCache1 = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };
let walletCache2 = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null
};

// =========================================================
// HÀM CHUYỂN ĐỔI VÀ ÉP KIỂU DỮ LIỆU TỪ UI
// =========================================================
function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        const lowerKey = key.toLowerCase();
        const val = reqBody[key];
        
        if (lowerKey === 'dcatypethuong') normalizedBody.dcaTypeThuong = val.toUpperCase(); 
        else if (lowerKey === 'dcatypedianguc') normalizedBody.dcaTypeDianguc = val.toUpperCase(); 
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

function checkEntryCondition(candidate, botSettings, status, botActivePositions) {
    const isBlacklisted = status.blackList[candidate.symbol] || status.permanentBlacklist[candidate.symbol];
    if (isBlacklisted) return null;

    const isPositionActive = botActivePositions.has(`${candidate.symbol}_SHORT`) || botActivePositions.has(`${candidate.symbol}_LONG`);
    if (isPositionActive) return null;

    const minVol = parseFloat(botSettings.minVol);
    const diangucVol = parseFloat(botSettings.diangucvol);

    const timeframes = {
        'M1': parseFloat(candidate.c1 || 0),
        'M5': parseFloat(candidate.c5 || 0),
        'M15': parseFloat(candidate.c15 || 0)
    };

    for (const tf of SCAN_CONFIG.DIA_NGUC) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= diangucVol) {
            return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: tf, isDianguc: true };
        }
    }

    for (const tf of SCAN_CONFIG.THUONG) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= minVol) {
            return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: tf, isDianguc: false };
        }
    }

    return null;
}

// =========================================================
// CẤU TRÚC RIÊNG BIỆT CHO 2 BOT INSTANCE
// =========================================================
let bot1 = {
    id: "BOT_1",
    sideMode: "NORMAL", 
    botSettings: { 
        isRunning: false, dcaTypeThuong: 'DUONG', dcaTypeDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL,
        heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
    botActivePositions: new Map(), 
    isProcessingDCA: new Set(),
    logThrottle: new Map(), 
    timestampOffset: 0,
    isMarginProtected: false,
    exchange: new ccxt.binance({ 
        apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, 
        options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
    }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

let bot2 = {
    id: "BOT_2",
    sideMode: "REVERSED", 
    botSettings: { 
        isRunning: false, dcaTypeThuong: 'DUONG', dcaTypeDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL,
        heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
    botActivePositions: new Map(), 
    isProcessingDCA: new Set(),
    logThrottle: new Map(), 
    timestampOffset: 0,
    isMarginProtected: false,
    exchange: new ccxt.binance({ 
        apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, 
        options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
    }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

// =========================================================
// HỆ THỐNG LOGS (MÀU XANH DƯƠNG CHO ĐỊA NGỤC)
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
        uiMsg = `<span style="color: #00a8ff; font-weight: 600;">[ĐỊA NGỤC] ${msg}</span>`;
    }
    
    bot.status.botLogs.unshift({ time, msg: uiMsg, type, isDianguc });
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    
    let consolePrefix = `[${time}][${bot.id}][${type.toUpperCase()}]`;
    let consoleOutput = `${consolePrefix} ${msg}`;
    if (isDianguc) {
        consoleOutput = `\x1b[36m${consolePrefix} [ĐỊA NGỤC] ${msg}\x1b[0m`;
    }
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
        addBotLog(bot1, `🚫 [BLACKLIST CHUNG] Đã chặn ${symbol} 15 phút do cả 2 bot đã thoát vị thế.`, "warn");
        addBotLog(bot2, `🚫 [BLACKLIST CHUNG] Đã chặn ${symbol} 15 phút do cả 2 bot đã thoát vị thế.`, "warn");
    }
}

// =========================================================
// HÀM ĐÓNG VỊ THẾ BẰNG TAY / TRAILING (FIX LẤY PNL CHÍNH XÁC)
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
        if (matchingTrades.length > 0) {
            finalPnL = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0);
        } else {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            finalPnL = pnlRaw - (b.currentQty * markP * 0.001);
        }

        bot.status.botClosedCount++;
        bot.status.botPnLClosed += finalPnL;

        let logType = finalPnL >= 0 ? "success" : "sl";
        if (reasonStr.includes("AVG")) logType = "avg"; 

        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | Giá chốt: ${markP.toFixed(pPrec)} | PnL: ${finalPnL.toFixed(2)}$`, logType, null, b.isDiangucMode);
        
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addBotLog(bot, `❌ Lỗi đóng ${b.symbol}: ${e.message}`, "error", null, b.isDiangucMode);
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
            try {
                await bot.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                count++;
            } catch (err) { }
        }
        bot.botActivePositions.clear();
        addBotLog(bot, `⚠️ Đã đóng toàn bộ ${count} vị thế (${reasonLog})`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

// =========================================================
// VÒNG LẶP MONITOR GIÁ & TÁCH BIỆT DCA ÂM/DƯƠNG TUYỆT ĐỐI
// =========================================================
async function priceMonitor(bot) {
    if (!bot.status.isReady) return setTimeout(() => priceMonitor(bot), 1000);
    try {
        if (!bot.botSettings.isRunning) return setTimeout(() => priceMonitor(bot), 1000);
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
        
        for (let [key, b] of bot.botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;

            const info = sharedState.exchangeInfo[b.symbol];
            const pPrec = info ? info.pricePrecision : 6; 

            // Xác định chính xác Loại DCA (Dương hay Âm) của vị thế này
            const dcaType = b.isDiangucMode ? bot.botSettings.typeDcaDianguc : bot.botSettings.typeDcaThuong;
            const maxDcaSetting = parseInt(bot.botSettings.maxDCA);

            // ⭐ TRƯỜNG HỢP 1: VỊ THẾ VẪN ĐANG MỞ TRÊN SÀN BINANCE
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                const avgEntry = parseFloat(realP.entryPrice); 
                
                b.currentQty = currentQty;
                b.livePrice = markP;
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.avgEntry = avgEntry;

                if (b.side === 'LONG') b.profitPercent = ((markP - avgEntry) / avgEntry) * 100;
                else b.profitPercent = ((avgEntry - markP) / avgEntry) * 100;

                // CHỈ THỰC THI LOGIC CỦA "DCA DƯƠNG" NẾU ĐƯỢC CHỌN
                if (dcaType === 'DUONG') {
                    // 1. Kiểm tra Trailing AVG (Chỉ chốt lời động cho DCA Dương)
                    let shouldCloseMarket = false;
                    if (b.dcaCount > 0) { 
                        const x = b.dcaCount; 
                        if (b.side === 'LONG' && markP >= (avgEntry * (1 + x / 100))) shouldCloseMarket = true;
                        if (b.side === 'SHORT' && markP <= (avgEntry * (1 - x / 100))) shouldCloseMarket = true;
                    }

                    if (shouldCloseMarket) {
                        bot.botActivePositions.delete(key); 
                        await closePositionAndLog(bot, b, markP, "CHỐT TRAILING AVG (DCA DƯƠNG)");
                        checkAndAddBlacklist(b.symbol); 
                        continue;
                    }

                    // 2. Kiểm tra Nhồi Lãi (DCA Dương)
                    const hitDcaDuong = (b.side === 'LONG' && markP >= b.nextDCA) || (b.side === 'SHORT' && markP <= b.nextDCA);
                    if (hitDcaDuong && b.dcaCount < maxDcaSetting) {
                        if (!bot.isProcessingDCA.has(lockKey)) {
                            const jump = b.dcaCount + 1;
                            const coefMode = b.isDiangucMode ? parseFloat(bot.botSettings.heSoDianguc || 3) : parseFloat(bot.botSettings.heSoThuong || 2);
                            let marginToUse = b.firstMargin * jump * 2 * coefMode; // Volume cấp số nhân
                            openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                        }
                    }
                }
                // (Nếu là DCA Âm, chúng ta không nhồi lệnh trong vòng lặp này, mà đợi Binance quét mất lệnh SL thì nhồi ở nhánh ELSE phía dưới)
            } 
            // ⭐ TRƯỜNG HỢP 2: VỊ THẾ TRÊN SÀN ĐÃ BIẾN MẤT (BẮT SỰ KIỆN CẮN SL ĐỂ DCA ÂM HOẶC CHỐT TP)
            else {
                if (bot.isProcessingDCA.has(lockKey)) continue;

                // Tăng delay lên 2 giây để chờ Binance lưu trữ dữ liệu PnL chính xác vào History
                await new Promise(resolve => setTimeout(resolve, 2000)); 
                const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
                const nowServer = Date.now() + bot.timestampOffset;
                
                const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 25000);
                
                let finalPnLFromSàn = 0;
                if (matchingTrades.length > 0) {
                    finalPnLFromSàn = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0);
                } else {
                    finalPnLFromSàn = b.pnl || 0;
                }

                bot.botActivePositions.delete(key); 

                // NẾU LÀ CẮN SL THẬT TRÊN SÀN (PnL Âm)
                if (finalPnLFromSàn < -0.1) {
                    // CHỈ KÍCH HOẠT NHỒI DCA NẾU CHẾ ĐỘ LÀ DCA ÂM
                    if (dcaType === 'AM' && b.dcaCount < maxDcaSetting) {
                        const jump = b.dcaCount + 1;
                        const coefMode = b.isDiangucMode ? parseFloat(bot.botSettings.heSoDianguc || 3) : parseFloat(bot.botSettings.heSoThuong || 2);
                        let marginToUse = b.firstMargin * jump * 2 * coefMode;

                        addBotLog(bot, `⚠️ Sàn vừa cắn SL của ${b.symbol} ${b.side} (PnL: ${finalPnLFromSàn.toFixed(2)}$). Kích hoạt đè lệnh DCA ÂM cấp độ ${jump}!`, "warn", null, b.isDiangucMode);
                        await openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                        continue;
                    } 
                    // NẾU CHẾ ĐỘ LÀ DCA DƯƠNG (Hoặc đã vượt maxDcaSetting của DCA Âm) -> Chấp nhận cắt lỗ thực sự
                    else {
                        bot.status.botClosedCount++;
                        bot.status.botPnLClosed += finalPnLFromSàn;
                        addBotLog(bot, `🔒 [CẮT LỖ THỰC TẾ] ${b.symbol} ${b.side} | Entry gốc: ${b.firstEntry.toFixed(pPrec)} | PnL: ${finalPnLFromSàn.toFixed(2)}$`, "sl", null, b.isDiangucMode);
                        checkAndAddBlacklist(b.symbol); 
                    }
                } 
                // NẾU LÀ CẮN TP TRÊN SÀN (PnL Dương)
                else {
                    bot.status.botClosedCount++;
                    bot.status.botPnLClosed += finalPnLFromSàn;
                    addBotLog(bot, `🔒 [CẮN TP TRÊN SÀN] ${b.symbol} ${b.side} | Entry gốc: ${b.firstEntry.toFixed(pPrec)} | PnL: ${finalPnLFromSàn.toFixed(2)}$`, "success", null, b.isDiangucMode);
                    checkAndAddBlacklist(b.symbol); 
                }
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 1000);
}

// =========================================================
// HÀM MỞ VỊ THẾ & TÍNH TOÁN ĐÚNG ĐIỂM NEXT DCA
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

        if (isDCA) {
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            currentPrice = parseFloat(ticker.data.price);
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
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
            const dcaType = currentModeIsHell ? bot.botSettings.typeDcaDianguc : bot.botSettings.typeDcaThuong;
            
            let newAvgEntry = actualFilledPrice;
            let totalQty = qty;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage;
            let totalMargin = actualMarginUsed;
            let dcaHistory = [];

            if (isDCA) {
                if (dcaType === 'AM') {
                    // Nếu là DCA Âm: Sàn đã đóng sạch lệnh cũ do cắn SL, vì vậy Entry Trung Bình khởi tạo lại bằng lệnh mua này
                    totalQty = qty;
                    newAvgEntry = actualFilledPrice; 
                } else {
                    // Nếu là DCA Dương: Lệnh cũ vẫn đang gồng lãi, tính gộp khối lượng và Entry Trung Bình
                    totalQty = dcaData.currentQty + qty;
                    newAvgEntry = ((dcaData.currentQty * dcaData.avgEntry) + (qty * actualFilledPrice)) / totalQty;
                }
                totalMargin = dcaData.currentMargin + actualMarginUsed;
                dcaHistory = [...(dcaData.dcaHistory || []), { price: actualFilledPrice, margin: actualMarginUsed }];
            } else {
                dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed }];
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            
            const dcaThreshold = currentModeIsHell ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
            const slPercent = currentModeIsHell ? parseFloat(bot.botSettings.diangucsl) : parseFloat(bot.botSettings.posSL);
            const tpPercent = currentModeIsHell ? parseFloat(bot.botSettings.dianguctp) : parseFloat(bot.botSettings.posTP);

            let finalTP, finalSL, nextDCA;
            const dir = (side === 'LONG' ? 1 : -1);

            // XÁC ĐỊNH MỐC DCA TIẾP THEO THEO CHIẾN THUẬT (ÂM / DƯƠNG)
            if (dcaType === 'DUONG') {
                nextDCA = firstE * (1 + dir * ((dcaCount + 1) * dcaThreshold / 100)); // Nhồi Lãi (Thuận chiều +)
                if (!isDCA) {
                    finalTP = newAvgEntry * (1 + dir * (tpPercent / 100));
                    finalSL = newAvgEntry * (1 - dir * (slPercent / 100)); // Lệnh SL cắt lỗ bảo vệ tài khoản
                } else {
                    finalTP = dcaData.tp; 
                    finalSL = dcaData.sl; // DCA Dương giữ nguyên SL/TP của lệnh trước
                }
            } else {
                // dcaType === 'AM'
                nextDCA = firstE * (1 - dir * ((dcaCount + 1) * slPercent / 100)); // Gồng Lỗ (Ngược chiều -). Mốc SL chính là mốc DCA
                finalSL = nextDCA; 
                // DCA Âm luôn dời TP theo giá Entry Trung Bình mới
                finalTP = newAvgEntry * (1 + dir * (tpPercent / 100));
            }

            // GỬI LỆNH TP/SL MỚI LÊN SÀN BINANCE
            try {
                const sync = await syncTPSL(bot, symbol, side, info, finalTP, finalSL);
                finalTP = sync.tp || finalTP; 
                finalSL = sync.sl || finalSL;
            } catch (e) {}

            bot.botActivePositions.set(lockKey, { 
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, dcaCount: dcaCount, 
                leverage: info.maxLeverage, firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, 
                currentMargin: totalMargin, currentQty: totalQty, dcaHistory: dcaHistory,
                isDiangucMode: currentModeIsHell, pnl: 0, profitPercent: 0, avgEntry: newAvgEntry, 
                nextDCA: nextDCA, livePrice: actualFilledPrice
            });
            
            // LOGGING THÔNG TIN (Kèm Biến Động 3 Khung & Next DCA)
            if (!isDCA) {
                const cand = sharedState.candidatesList.find(c => c.symbol === symbol);
                const m1 = cand ? cand.c1 : '0';
                const m5 = cand ? cand.c5 : '0';
                const m15 = cand ? cand.c15 : '0';
                
                const logStr = `[MỞ ${side}][CHẾ ĐỘ: ${currentModeIsHell ? "ĐỊA NGỤC" : "THƯỜNG"}] ${symbol} | M1:${m1}% M5:${m5}% M15:${m15}% | Lev: ${info.maxLeverage}x | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(pPrec)} | Next DCA: ${nextDCA.toFixed(pPrec)} | TP Sàn: ${finalTP.toFixed(pPrec)} | SL Sàn: ${finalSL.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "open", null, currentModeIsHell); 
            } else {
                const historyMarginsStr = dcaHistory.map((h, idx) => `Lần ${idx + 1}: ${h.margin.toFixed(2)}$`).join(' | ');
                const dcaTypeStr = dcaType === 'AM' ? "DCA ÂM KHỚP LỆNH" : "DCA DƯƠNG NHỒI LÃI";
                const logStr = `[${dcaTypeStr}] ${symbol} | Khớp Volume cấp độ ${dcaCount} | Tổng vốn nạp: [ ${historyMarginsStr} ] | Entry Avg Mới: ${newAvgEntry.toFixed(pPrec)} | Next DCA: ${nextDCA.toFixed(pPrec)} | TP Mới: ${finalTP.toFixed(pPrec)} | SL Mới: ${finalSL.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "dca", null, currentModeIsHell); 
            }
        }
    } catch (e) { 
        sharedState.permanentBlacklist[symbol] = true;
        addBotLog(bot, `❌ [BAN VĨNH VIỄN] Lỗi tại ${symbol}: ${e.message}`, "error"); 
    } finally { 
        setTimeout(() => bot.isProcessingDCA.delete(lockKey), 3000); 
    }
}

async function syncTPSL(bot, symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
        
        await bot.exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'CONTRACT_PRICE' 
        });
        
        await bot.exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'CONTRACT_PRICE' 
        });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: tpPrice, sl: slPrice }; }
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
                addBotLog(bot, `🚨 [CHỐNG THANH LÝ] Khả dụng chỉ còn ${availPercent.toFixed(2)}%. ĐÓNG TOÀN BỘ SÀN!`, "error");
                await panicCloseAll(bot, "CHỐNG THANH LÝ 5%");
                bot.isMarginProtected = true;
                bot.botSettings.isRunning = false; 
                addBotLog(bot, `🛑 Bot tự động STOP để bảo vệ tài khoản an toàn.`, "error");
                return; 
            }

            if (!bot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
                bot.isMarginProtected = true;
                addBotLog(bot, `⚠️ CẢNH BÁO: Khả dụng giảm dưới ${MARGIN_PROTECT_LIMIT}%. Dừng quét lệnh mới!`, "warn");
            } else if (bot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                bot.isMarginProtected = false;
                addBotLog(bot, `✅ Khả dụng phục hồi trên ${MARGIN_RECOVER_LIMIT}%. Mở lại quét lệnh.`, "info");
            }
        }
    }
}

// =========================================================
// EXPRESS SERVER & UI API (ĐÃ SET PORT 1810, 1811, 1813)
// =========================================================
const appServer = express(); appServer.use(express.json());
const appBot1 = express(); appBot1.use(express.json()); appBot1.use(express.static(__dirname));
const appBot2 = express(); appBot2.use(express.json()); appBot2.use(express.static(__dirname));

async function buildStatusResponse(bot, cacheObj) {
    const now = Date.now();
    
    // Sử dụng Cache 3 giây để chống chớp nháy số dư UI
    if (now - cacheObj.lastUpdate > 3000) {
        const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
        if (acc) {
            cacheObj.data = { 
                totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
            };
            cacheObj.lastUpdate = now;
        }
    }

    const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk').catch(() => []);
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }

    return { 
        botSettings: bot.botSettings, 
        activePositions: Array.from(bot.botActivePositions.values()), 
        exchangePositions: posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0),
        status: { 
            botLogs: bot.status.botLogs, botClosedCount: bot.status.botClosedCount, botPnLClosed: bot.status.botPnLClosed,
            isReady: bot.status.isReady, candidatesList: sharedState.candidatesList, blackList: formattedBlacklist,
            permanentBlacklist: sharedState.permanentBlacklist, exchangeInfo: sharedState.exchangeInfo
        }, 
        wallet: cacheObj.data 
    };
}

appBot1.post('/api/settings', (req, res) => { bot1.botSettings = parseNormalizedSettings(req.body, bot1.botSettings); res.json({ success: true }); });
appBot2.post('/api/settings', (req, res) => { bot2.botSettings = parseNormalizedSettings(req.body, bot2.botSettings); res.json({ success: true }); });

appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1, walletCache1)));
appBot1.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot1, "PANIC CLOSE QUA UI BOT 1")));
appBot1.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body; const key = `${symbol}_${side}`; const b = bot1.botActivePositions.get(key);
    if (b) {
        bot1.botActivePositions.delete(key); 
        try { await closePositionAndLog(bot1, b, b.livePrice, "ĐÓNG THỦ CÔNG (BOT 1)"); checkAndAddBlacklist(symbol); return res.json({ success: true }); } catch (e) { return res.json({ success: false, msg: e.message }); }
    } else {
        try {
            const posRisk = await binancePrivate(bot1, '/fapi/v2/positionRisk', 'GET', { symbol }); const p = posRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) await bot1.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side });
            res.json({ success: true });
        } catch (e) { res.json({ success: false, msg: e.message }); }
    }
});

appBot2.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot2, walletCache2)));
appBot2.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot2, "PANIC CLOSE QUA UI BOT 2")));
appBot2.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body; const key = `${symbol}_${side}`; const b = bot2.botActivePositions.get(key);
    if (b) {
        bot2.botActivePositions.delete(key);
        try { await closePositionAndLog(bot2, b, b.livePrice, "ĐÓNG THỦ CÔNG (BOT 2)"); checkAndAddBlacklist(symbol); return res.json({ success: true }); } catch (e) { return res.json({ success: false, msg: e.message }); }
    } else {
        try {
            const posRisk = await binancePrivate(bot2, '/fapi/v2/positionRisk', 'GET', { symbol }); const p = posRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) await bot2.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side });
            res.json({ success: true });
        } catch (e) { res.json({ success: false, msg: e.message }); }
    }
});

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
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        bot1.status.isReady = true; bot2.status.isReady = true;
        priceMonitor(bot1); priceMonitor(bot2); 
        
        addBotLog(bot1, `🚀 Khởi động hệ thống. Tách biệt DCA, Ports: 1810, 1811, 1813.`, "info");
        addBotLog(bot2, `🚀 Khởi động hệ thống. Tách biệt DCA, Ports: 1810, 1811, 1813.`, "info");
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
    await checkMarginLimits(bot1); await checkMarginLimits(bot2);
    if (!bot1.status.isReady || !bot2.status.isReady) return;
    if (!bot1.botSettings.isRunning || !bot2.botSettings.isRunning) return;
    if (bot1.isMarginProtected || bot2.isMarginProtected) return;

    if (bot1.botActivePositions.size < bot1.botSettings.maxPositions && 
        bot2.botActivePositions.size < bot2.botSettings.maxPositions &&
        bot1.isProcessingDCA.size === 0 && bot2.isProcessingDCA.size === 0) {

        const posRisk = await binancePrivate(bot1, '/fapi/v2/positionRisk').catch(() => []);
        const exchangeSymbolsWithPositions = new Set(posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => p.symbol));

        let entrySignal = null;
        for (const c of sharedState.candidatesList) {
            if (exchangeSymbolsWithPositions.has(c.symbol) || sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
            
            const result = checkEntryCondition(c, bot1.botSettings, { ...sharedState, botLogs: bot1.status.botLogs }, bot1.botActivePositions);
            if (result) { entrySignal = result; break; }
        }

        if (entrySignal) {
            const symbol = entrySignal.symbol;
            const info = sharedState.exchangeInfo[symbol];
            if (!info) return;

            const acc = await binancePrivate(bot1, '/fapi/v2/account').catch(() => null);
            if (!acc) return; 
            const snapshotAvailable = parseFloat(acc.availableBalance || 0);

            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
            if (!ticker) return;
            const currentPrice = parseFloat(ticker.data.price);
            
            const marginSetting = bot1.botSettings.invValue;
            let calculatedMargin = marginSetting.toString().includes('%') 
                ? (snapshotAvailable * parseFloat(marginSetting) / 100) 
                : parseFloat(marginSetting);

            const desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
            const finalQty = Math.ceil(Math.max(desiredQty, 5.05 / currentPrice) / info.stepSize) * info.stepSize;
            const finalMargin = (finalQty * currentPrice) / info.maxLeverage;

            const sideForBot1 = bot1.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;
            const sideForBot2 = bot2.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;

            // Mở Bot 1 ngay lập tức
            openPosition(bot1, symbol, null, sideForBot1, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
            
            // Dãn cách 1.5 giây để tránh kẹt rate limit API Binance rồi mới mở Bot 2
            setTimeout(() => {
                openPosition(bot2, symbol, null, sideForBot2, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
            }, 1500);
        }
    }
}, 3000); 

// === YÊU CẦU: Port chính 1810, bot 1 1811, bot 2 1813 ===
appServer.listen(1810, () => console.log('🌐 [MAIN SERVER] Đang chạy Lõi xử lý tại Port 1810'));
appBot1.listen(1811, () => console.log('📈 [BOT 1 UI] Đang chạy Web theo dõi Bot 1 tại Port 1811'));
appBot2.listen(1812, () => console.log('📉 [BOT 2 UI] Đang chạy Web theo dõi Bot 2 tại Port 1813'));
