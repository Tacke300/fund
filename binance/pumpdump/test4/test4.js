import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================
// ⚙️ CẤU HÌNH KHUNG THỜI GIAN QUÉT 
// =========================================================
const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],            
    DIA_NGUC: ['M1', 'M5', 'M15']    
};

const ANTI_LIQUIDATION_LIMIT = 5; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  
const MAX_DCA_LEVEL = 999999;     

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null
};

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        const lowerKey = key.toLowerCase();
        const val = reqBody[key];
        
        if (lowerKey === 'hesothuong') normalizedBody.heSoThuong = parseFloat(val);
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

let bot1 = {
    id: "BOT_1",
    sideMode: "NORMAL", 
    botSettings: { 
        isRunning: false, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
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
        isRunning: false, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
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

function addBotLog(bot, msg, type = 'info', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        const last = bot.logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        bot.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    bot.status.botLogs.unshift({ time, msg, type });
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    console.log(`[${time}][${bot.id}][${type.toUpperCase()}] ${msg}`);
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

async function closePositionAndLog(bot, b, markP, reasonStr) {
    try {
        const info = sharedState.exchangeInfo[b.symbol];
        const pPrec = info ? info.pricePrecision : 6; 

        await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
        const nowServer = Date.now() + bot.timestampOffset;
        const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 20000);
        
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

        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | Giá chốt: ${markP.toFixed(pPrec)} | PnL Tổng Vị Thế: ${finalPnL.toFixed(2)}$`, logType);
        
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addBotLog(bot, `❌ Lỗi đóng ${b.symbol}: ${e.message}`, "error");
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
// VÒNG LẶP MONITOR GIÁ & BẮT EVENT CẮN SL ĐỂ ĐÈ LỆNH DCA ÂM
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

                const dcaThreshold = b.isDiangucMode ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
                const slPercent = b.isDiangucMode ? parseFloat(bot.botSettings.diangucsl) : parseFloat(bot.botSettings.posSL);
                const maxDcaSetting = parseInt(bot.botSettings.maxDCA);

                // Tính toán mốc DCA Dương (Nhồi lãi khi giá đi trúng hướng)
                if (b.side === 'LONG') {
                    b.nextDcaDuong = b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100)));
                    b.nextDcaAm = b.firstEntry * (1 - ((b.dcaCount + 1) * (slPercent / 100)));
                } else {
                    b.nextDcaDuong = b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100)));
                    b.nextDcaAm = b.firstEntry * (1 + ((b.dcaCount + 1) * (slPercent / 100)));
                }
                b.nextDCA = b.nextDcaAm; 

                // A. Kiểm tra trạng thái "CHỐT LỜI TRAILING AVG" động sau khi đã từng DCA
                let shouldCloseMarket = false;
                if (b.dcaCount > 0) {
                    const x = b.dcaCount; 
                    if (b.side === 'LONG' && markP >= (avgEntry * (1 + x / 100))) shouldCloseMarket = true;
                    if (b.side === 'SHORT' && markP <= (avgEntry * (1 - x / 100))) shouldCloseMarket = true;
                }

                if (shouldCloseMarket) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "CHỐT TRAILING AVG");
                    checkAndAddBlacklist(b.symbol); 
                    continue;
                }

                // B. Kiểm tra kích hoạt DCA DƯƠNG bằng Polling (Nhồi lãi)
                const hitDcaDuong = (b.side === 'LONG' && markP >= b.nextDcaDuong) || (b.side === 'SHORT' && markP <= b.nextDcaDuong);
                if (hitDcaDuong && b.dcaCount < maxDcaSetting) {
                    if (!bot.isProcessingDCA.has(lockKey)) {
                        const jump = b.dcaCount + 1;
                        const coefThuong = parseFloat(bot.botSettings.heSoThuong || 2);
                        const coefDianguc = parseFloat(bot.botSettings.heSoDianguc || 3);
                        let marginToUse = b.isDiangucMode ? (b.firstMargin * coefDianguc) : (b.firstMargin * coefThuong);
                        
                        openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                    }
                }
            } 
            // ⭐ TRƯỜNG HỢP 2: VỊ THẾ TRÊN SÀN ĐÃ BIẾN MẤT (CÓ THỂ DO CẮN TP HOẶC CẮN SL)
            else {
                if (bot.isProcessingDCA.has(lockKey)) continue;

                // Lấy lịch sử lệnh vừa khớp gần nhất trong 20 giây để kiểm tra nguyên nhân biến mất vị thế
                await new Promise(resolve => setTimeout(resolve, 800));
                const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 5 }).catch(() => []);
                const nowServer = Date.now() + bot.timestampOffset;
                const lastTrade = trades.find(t => t.positionSide === b.side && (nowServer - t.time) < 25000);

                let finalPnLFromSàn = lastTrade ? parseFloat(lastTrade.realizedPnl) : (b.pnl || 0);
                const maxDcaSetting = parseInt(bot.botSettings.maxDCA);

                // 👉 KIỂM TRA: NẾU THU VỀ PNL ÂM => CHẮC CHẮN LÀ DO SÀN VỪA QUÉT LỆNH STOP LOSS (SL)
                if (finalPnLFromSàn < 0 && b.dcaCount < maxDcaSetting) {
                    // Tiến hành kích hoạt luồng DCA ÂM bằng cách đè ngay một vị thế mới lớn hơn lên sàn
                    const jump = b.dcaCount + 1;
                    const coefThuong = parseFloat(bot.botSettings.heSoThuong || 2);
                    const coefDianguc = parseFloat(bot.botSettings.heSoDianguc || 3);
                    let marginToUse = b.isDiangucMode ? (b.firstMargin * coefDianguc) : (b.firstMargin * coefThuong);

                    addBotLog(bot, `⚠️ Sàn vừa cắn SL của ${b.symbol} ${b.side} (PnL: ${finalPnLFromSàn.toFixed(2)}$). Kích hoạt đè lệnh DCA ÂM cấp độ ${jump}!`, "warn");
                    
                    // Gọi hàm mở lại vị thế để tiếp tục nhồi lệnh gồng lỗ
                    await openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                    continue;
                }

                // 👉 TRƯỜNG HỢP LÃI (CẮN TP) HOẶC ĐÃ HẾT LƯỢT DCA CHO PHÉP -> ĐÓNG VÀ HOÀN TẤT LỆNH THỰC TẾ
                bot.status.botClosedCount++;
                bot.status.botPnLClosed += finalPnLFromSàn;

                const logReason = finalPnLFromSàn >= 0 ? "🔒 [CẮN TP TRÊN SÀN]" : "🔒 [CẮT LỖ THỰC TẾ - HẾT LƯỢT DCA]";
                const logType = finalPnLFromSàn >= 0 ? "success" : "sl";
                
                addBotLog(bot, `${logReason} ${b.symbol} ${b.side} | Entry gốc: ${b.firstEntry.toFixed(pPrec)} | PnL: ${finalPnLFromSàn.toFixed(2)}$`, logType);
                
                bot.botActivePositions.delete(key);
                checkAndAddBlacklist(b.symbol); 
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 1000);
}

// =========================================================
// HÀM MỞ VỊ THẾ KHỚP GIÁ THỰC TẾ TRÊN SÀN 
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
            
            // Tính toán khối lượng mua thêm dca
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            qty = sharedQty;
            margin = sharedMargin;
            currentPrice = sharedPrice;
        }

        await bot.exchange.setLeverage(info.maxLeverage, symbol);

        // Đẩy lệnh Market lên sàn Binance
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            
            let newAvgEntry = actualFilledPrice;
            let totalQty = qty;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage;
            let totalMargin = actualMarginUsed;
            let dcaHistory = [];

            if (isDCA) {
                // Do sàn đã cắn SL của lệnh cũ nên khối lượng thực tế trên sàn lúc này của lệnh cũ = 0.
                // Tổng khối lượng vị thế sau khi đè lệnh DCA mới chính bằng khối lượng lệnh vừa mua.
                totalQty = qty;
                newAvgEntry = actualFilledPrice; // Giá entry trung bình đặt lại bằng chính giá khớp lệnh dca âm mới
                totalMargin = dcaData.currentMargin + actualMarginUsed;
                dcaHistory = [...(dcaData.dcaHistory || []), { price: actualFilledPrice, margin: actualMarginUsed }];
            } else {
                dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed }];
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            const currentModeIsHell = isDCA ? dcaData.isDiangucMode : isDiangucSignal;
            
            const dcaThreshold = currentModeIsHell ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
            const slPercent = currentModeIsHell ? parseFloat(bot.botSettings.diangucsl) : parseFloat(bot.botSettings.posSL);
            const tpPercent = currentModeIsHell ? parseFloat(bot.botSettings.dianguctp) : parseFloat(bot.botSettings.posTP);

            const dir = (side === 'LONG' ? 1 : -1);
            let finalTP = newAvgEntry * (1 + dir * (tpPercent / 100));

            // Tính toán mốc SL mới dựa theo giá của entry hiện tại để treo tiếp lệnh SL bảo hiểm lên sàn
            let finalSL = newAvgEntry * (1 - dir * (slPercent / 100));

            // ⭐ LUÔN LUÔN ĐẨY CẢ LỆNH TP VÀ SL THẬT LÊN SÀN BINANCE THEO MỐC MỚI CẬP NHẬT
            await syncTPSL(bot, symbol, side, info, finalTP, finalSL);

            const nextDcaDuong = side === 'LONG' ? firstE * (1 + ((dcaCount + 1) * (dcaThreshold / 100))) : firstE * (1 - ((dcaCount + 1) * (dcaThreshold / 100)));
            const nextDcaAm = finalSL; 

            bot.botActivePositions.set(lockKey, { 
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, dcaCount: dcaCount, 
                leverage: info.maxLeverage, firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, 
                currentMargin: totalMargin, currentQty: totalQty, dcaHistory: dcaHistory,
                isDiangucMode: currentModeIsHell, pnl: 0, profitPercent: 0, avgEntry: newAvgEntry, 
                nextDcaDuong, nextDcaAm, nextDCA: nextDcaAm, livePrice: actualFilledPrice
            });
            
            if (!isDCA) {
                const cand = sharedState.candidatesList.find(c => c.symbol === symbol);
                const logStr = `[MỞ ${side}][CHẾ ĐỘ: ${currentModeIsHell ? "ĐỊA NGỤC" : "THƯỜNG"}] ${symbol} | Lev: ${info.maxLeverage}x | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(pPrec)} | TP Sàn: ${finalTP.toFixed(pPrec)} | SL Sàn (Mốc DCA âm): ${finalSL.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "open"); 
            } else {
                const historyMarginsStr = dcaHistory.map((h, idx) => `Lần ${idx + 1}: ${h.margin.toFixed(2)}$`).join(' | ');
                const logStr = `[DCA ÂM KHỚP LỆNH] ${symbol} | Đè Volume thành công cấp độ ${dcaCount} | Tổng vốn nạp: [ ${historyMarginsStr} ] | Entry Mới: ${newAvgEntry.toFixed(pPrec)} | TP Sàn mới: ${finalTP.toFixed(pPrec)} | SL Sàn mới: ${finalSL.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "dca"); 
            }
        }
    } catch (e) { 
        sharedState.permanentBlacklist[symbol] = true;
        addBotLog(bot, `❌ [BAN VĨNH VIỄN] Lỗi tại ${symbol}: ${e.message}`, "error"); 
    } finally { 
        setTimeout(() => bot.isProcessingDCA.delete(lockKey), 3000); 
    }
}

// =========================================================
// ĐỒNG BỘ TP/SL LÊN SÀN (ĐẢM BẢO LUÔN LUÔN CÓ LỆNH TREO)
// =========================================================
async function syncTPSL(bot, symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
        
        // Treo lệnh TP thật lên sàn
        await bot.exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, 
            stopPrice: tpPrice.toFixed(info.pricePrecision), 
            closePosition: true, 
            workingType: 'CONTRACT_PRICE' 
        });
        
        // Treo lệnh SL thật lên sàn làm cò kích hoạt DCA âm
        await bot.exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, 
            stopPrice: slPrice.toFixed(info.pricePrecision), 
            closePosition: true, 
            workingType: 'CONTRACT_PRICE' 
        });
    } catch (e) { }
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

const appServer = express(); appServer.use(express.json());
const appBot1 = express(); appBot1.use(express.json()); appBot1.use(express.static(__dirname));
const appBot2 = express(); appBot2.use(express.json()); appBot2.use(express.static(__dirname));

async function buildStatusResponse(bot) {
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk').catch(() => []);
    
    const now = Date.now();
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
            botLogs: bot.status.botLogs,
            botClosedCount: bot.status.botClosedCount,
            botPnLClosed: bot.status.botPnLClosed,
            isReady: bot.status.isReady,
            candidatesList: sharedState.candidatesList,
            blackList: formattedBlacklist,
            permanentBlacklist: sharedState.permanentBlacklist,
            exchangeInfo: sharedState.exchangeInfo
        }, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
        } : { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" } 
    };
}

appBot1.post('/api/settings', (req, res) => {
    bot1.botSettings = parseNormalizedSettings(req.body, bot1.botSettings);
    res.json({ success: true });
});

appBot2.post('/api/settings', (req, res) => {
    bot2.botSettings = parseNormalizedSettings(req.body, bot2.botSettings);
    res.json({ success: true });
});

appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1)));
appBot1.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot1, "PANIC CLOSE QUA UI BOT 1")));
appBot1.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body; const key = `${symbol}_${side}`; const b = bot1.botActivePositions.get(key);
    if (b) {
        try { await closePositionAndLog(bot1, b, b.livePrice, "ĐÓNG THỦ CÔNG (BOT 1)"); bot1.botActivePositions.delete(key); checkAndAddBlacklist(symbol); return res.json({ success: true }); } catch (e) { return res.json({ success: false, msg: e.message }); }
    } else {
        try {
            const posRisk = await binancePrivate(bot1, '/fapi/v2/positionRisk', 'GET', { symbol }); const p = posRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) await bot1.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side });
            res.json({ success: true });
        } catch (e) { res.json({ success: false, msg: e.message }); }
    }
});

appBot2.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot2)));
appBot2.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot2, "PANIC CLOSE QUA UI BOT 2")));
appBot2.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body; const key = `${symbol}_${side}`; const b = bot2.botActivePositions.get(key);
    if (b) {
        try { await closePositionAndLog(bot2, b, b.livePrice, "ĐÓNG THỦ CÔNG (BOT 2)"); bot2.botActivePositions.delete(key); checkAndAddBlacklist(symbol); return res.json({ success: true }); } catch (e) { return res.json({ success: false, msg: e.message }); }
    } else {
        try {
            const posRisk = await binancePrivate(bot2, '/fapi/v2/positionRisk', 'GET', { symbol }); const p = posRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) await bot2.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side });
            res.json({ success: true });
        } catch (e) { res.json({ success: false, msg: e.message }); }
    }
});

appServer.get('/api/health', (req, res) => {
    res.json({ status: "running", bot1_positions: bot1.botActivePositions.size, bot2_positions: bot2.botActivePositions.size, blacklist_count: Object.keys(sharedState.blackList).length });
});

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
        
        addBotLog(bot1, `🚀 Hoàn tất setup hệ thống xử lý cắn SL làm DCA.`, "info");
        addBotLog(bot2, `🚀 Hoàn tất setup hệ thống xử lý cắn SL làm DCA.`, "info");
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

            openPosition(bot1, symbol, null, sideForBot1, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
            openPosition(bot2, symbol, null, sideForBot2, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
        }
    }
}, 3000); 

appServer.listen(1800, () => console.log('🌐 [MAIN SERVER] Đang chạy Lõi xử lý tại Port 2401'));
appBot1.listen(1801, () => console.log('📈 [BOT 1 UI] Đang chạy Web theo dõi Bot 1 tại Port 2402'));
appBot2.listen(1802, () => console.log('📉 [BOT 2 UI] Đang chạy Web theo dõi Bot 2 tại Port 2403'));
