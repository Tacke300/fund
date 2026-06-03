import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================
// ⚙️ CẤU HÌNH KHUNG THỜI GIAN QUÉT (DỄ DÀNG SỬA ĐỔI TẠI ĐÂY)
// =========================================================
const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],            // Chế độ thường: Chỉ quét M1 và M5
    DIA_NGUC: ['M1', 'M5', 'M15']    // Chế độ địa ngục: Quét cả 3 khung M1, M5, M15
};

// =========================================================
// CẤU HÌNH HỆ THỐNG CỐ ĐỊNH
// =========================================================
const ANTI_LIQUIDATION_LIMIT = 5; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  
const MAX_DCA_LEVEL = 999999;     

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

// =========================================================
// BỘ NHỚ CHIA SẺ (SHARED STATE) - QUẢN LÝ BLACKLIST & LỊCH SỬ CHUNG
// =========================================================
let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    closedHistory: [] // Lưu trữ tối đa 100 vị thế đã chốt gần nhất toàn hệ thống
};

// =========================================================
// HÀM ĐIỀU KIỆN ĐÃ ĐƯỢC ĐỘNG HÓA THEO CẤU HÌNH ĐẦU FILE
// =========================================================
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
        isRunning: false, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL,
        heSoThuong: 2, heSoDianguc: 3 
    },
    status: { 
        botLogs: [], botClosedCount: 0, botPnLClosed: 0, isReady: false,
        totalOpenedCount: 0, tpCount: 0, tpPnL: 0, avgCount: 0, avgPnL: 0, slCount: 0, slPnL: 0
    },
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
    status: { 
        botLogs: [], botClosedCount: 0, botPnLClosed: 0, isReady: false,
        totalOpenedCount: 0, tpCount: 0, tpPnL: 0, avgCount: 0, avgPnL: 0, slCount: 0, slPnL: 0
    },
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
// LOGIC HỖ TRỢ CORE
// =========================================================
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

// Hàm đẩy vị thế vào danh sách lịch sử gộp (Giới hạn 100 phần tử gần nhất)
function pushToClosedHistory(botId, position, closePrice, finalPnL, reasonStr) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    sharedState.closedHistory.unshift({
        time,
        botId,
        symbol: position.symbol,
        side: position.side,
        dcaCount: position.dcaCount,
        isDiangucMode: position.isDiangucMode,
        margin: position.currentMargin,
        qty: position.currentQty,
        avgEntry: position.avgEntry,
        closePrice: closePrice,
        pnl: finalPnL,
        profitPercent: position.profitPercent,
        reason: reasonStr
    });
    if (sharedState.closedHistory.length > 100) {
        sharedState.closedHistory.pop();
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

        // Phân loại thống kê chi tiết nâng cao
        if (reasonStr.includes("AVG")) {
            bot.status.avgCount++;
            bot.status.avgPnL += finalPnL;
        } else if (finalPnL >= 0) {
            bot.status.tpCount++;
            bot.status.tpPnL += finalPnL;
        } else {
            bot.status.slCount++;
            bot.status.slPnL += finalPnL;
        }

        let logType = finalPnL >= 0 ? "success" : "sl";
        if (reasonStr.includes("AVG")) logType = "avg"; 

        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | Giá chốt: ${markP.toFixed(pPrec)} | PnL Tổng Vị Thế: ${finalPnL.toFixed(2)}$`, logType);
        
        // Lưu lịch sử vị thế
        pushToClosedHistory(bot.id, b, markP, finalPnL, reasonStr);

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
                const key = `${p.symbol}_${side}`;
                const cachedPos = bot.botActivePositions.get(key);
                await bot.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                
                if (cachedPos) {
                    pushToClosedHistory(bot.id, cachedPos, cachedPos.livePrice, cachedPos.pnl || 0, "PANIC CLOSE");
                }
                count++;
            } catch (err) { }
        }
        bot.botActivePositions.clear();
        addBotLog(bot, `⚠️ Đã đóng toàn bộ ${count} vị thế (${reasonLog})`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

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

                const dcaThreshold = b.isDiangucMode ? bot.botSettings.diangucdca : bot.botSettings.posdca;
                if (b.side === 'LONG') b.nextDCA = b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100)));
                else b.nextDCA = b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100)));

                let shouldCloseMarket = false;
                if (b.dcaCount > 0) {
                    const x = b.dcaCount; 
                    if (b.side === 'LONG' && markP < (avgEntry * (1 + x / 100))) shouldCloseMarket = true;
                    if (b.side === 'SHORT' && markP > (avgEntry * (1 - x / 100))) shouldCloseMarket = true;
                }

                if (shouldCloseMarket) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "CHỐT TRAILING AVG");
                    checkAndAddBlacklist(b.symbol); 
                    continue;
                }

                const jump = b.dcaCount + 1;
                const hitNextDCA = (b.side === 'LONG' && markP >= b.nextDCA) || (b.side === 'SHORT' && markP <= b.nextDCA);

                if (hitNextDCA && jump <= bot.botSettings.maxDCA) {
                    let marginToUse = b.isDiangucMode ? (b.firstMargin * bot.botSettings.heSoDianguc) : (b.firstMargin * bot.botSettings.heSoThuong);
                    openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                }
            } else {
                if (bot.isProcessingDCA.has(lockKey)) continue;
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
                const nowServer = Date.now() + bot.timestampOffset;
                const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 25000);
                
                let finalPnLFromSàn = 0;
                if (matchingTrades.length > 0) {
                    finalPnLFromSàn = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0);
                } else {
                    finalPnLFromSàn = b.pnl || 0;
                }
                
                bot.status.botClosedCount++;
                bot.status.botPnLClosed += finalPnLFromSàn;

                // Đồng bộ chỉ số chốt lệnh tự động trên sàn
                let closedReason = "ĐÓNG TRÊN SÀN - SL";
                if (finalPnLFromSàn >= 0) {
                    bot.status.tpCount++;
                    bot.status.tpPnL += finalPnLFromSàn;
                    closedReason = "ĐÓNG TRÊN SÀN - TP";
                } else {
                    bot.status.slCount++;
                    bot.status.slPnL += finalPnLFromSàn;
                }

                const logType = finalPnLFromSàn >= 0 ? "success" : "sl";
                addBotLog(bot, `🔒 [ĐÓNG TRÊN SÀN - TP/SL] ${b.symbol} ${b.side} | Entry: ${b.avgEntry.toFixed(pPrec)} | PnL Tổng Vị Thế: ${finalPnLFromSàn.toFixed(2)}$`, logType);
                
                // Lưu lịch sử vị thế tự động đóng trên sàn
                pushToClosedHistory(bot.id, b, b.livePrice, finalPnLFromSàn, closedReason);

                bot.botActivePositions.delete(key);
                checkAndAddBlacklist(b.symbol); 
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 1000);
}

// =========================================================
// HÀM MỞ VỊ THẾ KHỚP GIÁ THỰC TẾ
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

        // Gửi lệnh Market thực tế lên sàn
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            
            let newAvgEntry = actualFilledPrice;
            let totalQty = qty;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage;
            let totalMargin = actualMarginUsed;
            let dcaHistory = [];

            if (isDCA) {
                const oldQty = dcaData.currentQty;
                const oldAvg = dcaData.avgEntry;
                totalQty = oldQty + qty;
                newAvgEntry = ((oldQty * oldAvg) + (qty * actualFilledPrice)) / totalQty;
                totalMargin = dcaData.currentMargin + actualMarginUsed;
                dcaHistory = [...(dcaData.dcaHistory || []), { price: actualFilledPrice, margin: actualMarginUsed }];
            } else {
                bot.status.totalOpenedCount++; 
                dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed }];
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            const currentModeIsHell = isDCA ? dcaData.isDiangucMode : isDiangucSignal;
            
            let finalTP, finalSL;
            if (!isDCA) {
                const dir = (side === 'LONG' ? 1 : -1);
                const tpPercent = currentModeIsHell ? bot.botSettings.dianguctp : bot.botSettings.posTP;
                const slPercent = currentModeIsHell ? bot.botSettings.diangucsl : bot.botSettings.posSL;

                const targetProfit = (totalQty * newAvgEntry * (tpPercent / 100));
                finalTP = newAvgEntry + (dir * (targetProfit / totalQty));
                finalSL = firstE * (1 - (dir * (slPercent / 100)));
                
                const sync = await syncTPSL(bot, symbol, side, info, finalTP, finalSL);
                finalTP = sync.tp;
                finalSL = sync.sl;
            } else {
                finalTP = dcaData.tp;
                finalSL = dcaData.sl;
            }

            const dcaThreshold = currentModeIsHell ? bot.botSettings.diangucdca : bot.botSettings.posdca;
            const nextDCA = side === 'LONG' ? firstE * (1 + ((dcaCount + 1) * (dcaThreshold / 100))) : firstE * (1 - ((dcaCount + 1) * (dcaThreshold / 100)));

            bot.botActivePositions.set(lockKey, { 
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, dcaCount: dcaCount, 
                leverage: info.maxLeverage, firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, 
                currentMargin: totalMargin, currentQty: totalQty, dcaHistory: dcaHistory,
                isDiangucMode: currentModeIsHell, pnl: 0, profitPercent: 0, avgEntry: newAvgEntry, nextDCA, livePrice: actualFilledPrice
            });
            
            if (!isDCA) {
                const cand = sharedState.candidatesList.find(c => c.symbol === symbol);
                const m1 = cand ? cand.c1 : '0';
                const m5 = cand ? cand.c5 : '0';
                const m15 = cand ? cand.c15 : '0';
                
                const modeLabel = currentModeIsHell ? "ĐỊA NGỤC" : "THƯỜNG";
                const logStr = `[MỞ ${side}][CHẾ ĐỘ: ${modeLabel}] ${symbol} | Biến động: M1:${m1}% M5:${m5}% M15:${m15}% | Lev: ${info.maxLeverage}x | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(pPrec)} | TP: ${finalTP.toFixed(pPrec)} | SL: ${finalSL.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "open"); 
            } else {
                const firstMarginVal = dcaData.firstMargin.toFixed(2);
                const historyMarginsStr = dcaHistory.map((h, idx) => `Lần ${idx + 1}: ${h.margin.toFixed(2)}$`).join(' | ');
                const historyPricesStr = dcaHistory.map(h => h.price.toFixed(pPrec)).join(' ➔ ');
                
                const logStr = `[DCA LẦN ${dcaCount}] ${symbol} | Margin Đầu: ${firstMarginVal}$ | Lịch sử nạp Margin DCA: [ ${historyMarginsStr} ] | Entry đầu: ${firstE.toFixed(pPrec)} | Giá DCA: ${actualFilledPrice.toFixed(pPrec)} | Avg: ${newAvgEntry.toFixed(pPrec)} | Lịch sử giá: ${historyPricesStr}`;
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
// ĐỒNG BỘ TP/SL LÊN SÀN
// =========================================================
async function syncTPSL(bot, symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
        
        await bot.exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, 
            stopPrice: tpPrice.toFixed(info.pricePrecision), 
            closePosition: true, 
            workingType: 'CONTRACT_PRICE' 
        });
        
        await bot.exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, 
            stopPrice: slPrice.toFixed(info.pricePrecision), 
            closePosition: true, 
            workingType: 'CONTRACT_PRICE' 
        });
        
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { 
        return { tp: 0, sl: 0 }; 
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
// KHỞI TẠO CẤU TRÚC PHẢN HỒI DỮ LIỆU ĐỘC LẬP
// =========================================================
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
            exchangeInfo: sharedState.exchangeInfo,
            totalOpenedCount: bot.status.totalOpenedCount || 0,
            tpCount: bot.status.tpCount || 0,
            tpPnL: bot.status.tpPnL || 0,
            avgCount: bot.status.avgCount || 0,
            avgPnL: bot.status.avgPnL || 0,
            slCount: bot.status.slCount || 0,
            slPnL: bot.status.slPnL || 0
        }, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
        } : { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" } 
    };
}

// ROUTE CHO BOT 1 VÀ BOT 2 UI GIỮ NGUYÊN
appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1)));
appBot1.post('/api/settings', (req, res) => { bot1.botSettings = { ...bot1.botSettings, ...req.body }; res.json({ success: true }); });
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
appBot2.post('/api/settings', (req, res) => { bot2.botSettings = { ...bot2.botSettings, ...req.body }; res.json({ success: true }); });
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

// =========================================================
// LOGIC SERVER TỔNG HỢP (PORT 2401)
// =========================================================

appServer.get('/api/global_summary', async (req, res) => {
    const data1 = await buildStatusResponse(bot1);
    const data2 = await buildStatusResponse(bot2);
    
    const combinedPositions = [...data1.activePositions.map(p => ({...p, botId: 'BOT 1'})), ...data2.activePositions.map(p => ({...p, botId: 'BOT 2'}))];
    const systemRunning = bot1.botSettings.isRunning && bot2.botSettings.isRunning;

    res.json({
        systemRunning,
        stats: {
            totalOpened: (data1.status.totalOpenedCount || 0) + (data2.status.totalOpenedCount || 0),
            currentlyOpen: combinedPositions.length,
            tpCount: (data1.status.tpCount || 0) + (data2.status.tpCount || 0),
            tpPnL: (data1.status.tpPnL || 0) + (data2.status.tpPnL || 0),
            avgCount: (data1.status.avgCount || 0) + (data2.status.avgCount || 0),
            avgPnL: (data1.status.avgPnL || 0) + (data2.status.avgPnL || 0),
            slCount: (data1.status.slCount || 0) + (data2.status.slCount || 0),
            slPnL: (data1.status.slPnL || 0) + (data2.status.slPnL || 0),
            totalPnL: (data1.status.botPnLClosed || 0) + (data2.status.botPnLClosed || 0)
        },
        activePositions: combinedPositions,
        closedHistory: sharedState.closedHistory, // Gửi dữ liệu lịch sử về UI
        bot1Logs: data1.status.botLogs,
        bot2Logs: data2.status.botLogs,
        configs: {
            bot1: data1.botSettings,
            bot2: data2.botSettings
        }
    });
});

appServer.post('/api/global_control', (req, res) => {
    const { action } = req.body;
    const isRunning = (action === 'start');
    bot1.botSettings.isRunning = isRunning;
    bot2.botSettings.isRunning = isRunning;
    
    addBotLog(bot1, `🌐 [SERVER ĐIỀU PHỐI CHUNG] Trạng thái được cập nhật thành: ${action.toUpperCase()}`, "warn");
    addBotLog(bot2, `🌐 [SERVER ĐIỀU PHỐI CHUNG] Trạng thái được cập nhật thành: ${action.toUpperCase()}`, "warn");
    res.json({ success: true, isRunning });
});

// Giao diện HTML Dashboard Core tích hợp bảng Log và đưa bảng lịch sử xuống dưới cùng
appServer.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <title>MAIN SERVER CONTROL DASHBOARD</title>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet">
        <style>
            body { background-color: #0f172a; color: #f1f5f9; }
            .card { background-color: #1e293b; border: 1px solid #334155; }
            .log-container { background-color: #020617; font-family: monospace; font-size: 11px; overflow-y: auto; height: 260px; border: 1px solid #1e293b; }
            .log-line { border-b: 1px solid #0f172a; padding: 2px 6px; }
            .log-success { color: #4ade80; }
            .log-error { color: #f87171; }
            .log-warn { color: #fbbf24; }
            .log-open { color: #38bdf8; }
            .log-dca { color: #c084fc; }
            .log-info { color: #cbd5e1; }
        </style>
    </head>
    <body class="p-6">
        <div class="max-w-7xl mx-auto space-y-6">
            <header class="flex justify-between items-center pb-4 border-b border-gray-700">
                <div>
                    <h1 class="text-3xl font-bold text-blue-400">MAIN SERVER CORE LOGIC</h1>
                    <p class="text-gray-400 text-sm">Quản lý tổng hợp & Giám sát thông số thời gian thực</p>
                </div>
                <div class="flex items-center space-x-4">
                    <span id="sysStatus" class="px-4 py-2 rounded font-bold text-white bg-gray-600">ĐANG TẢI...</span>
                    <button id="btnToggle" onclick="toggleSystem()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-2 rounded transition shadow-md">ĐỒNG BỘ LỆNH</button>
                </div>
            </header>

            <div>
                <h2 class="text-xl font-semibold text-gray-300 mb-4">📊 BẢNG TỔNG QUAN HỆ THỐNG GỘP</h2>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                    <div class="card p-4 rounded shadow">
                        <div class="text-gray-400 text-xs font-medium uppercase">Tổng Vị Thế Đã Mở</div>
                        <div id="statTotalOpened" class="text-2xl font-bold text-blue-400 mt-1">0</div>
                    </div>
                    <div class="card p-4 rounded shadow">
                        <div class="text-gray-400 text-xs font-medium uppercase">Vị Thế Đang Mở</div>
                        <div id="statCurrentlyOpen" class="text-2xl font-bold text-yellow-400 mt-1">0</div>
                    </div>
                    <div class="card p-4 rounded shadow">
                        <div class="text-gray-400 text-xs font-medium uppercase">Chốt Lãi (TP)</div>
                        <div id="statTP" class="text-lg font-bold text-green-400 mt-1">0 lệnh</div>
                        <div id="statTP_PnL" class="text-sm text-gray-400">0.00$</div>
                    </div>
                    <div class="card p-4 rounded shadow">
                        <div class="text-gray-400 text-xs font-medium uppercase">Chốt Trailing (AVG)</div>
                        <div id="statAVG" class="text-lg font-bold text-purple-400 mt-1">0 lệnh</div>
                        <div id="statAVG_PnL" class="text-sm text-gray-400">0.00$</div>
                    </div>
                    <div class="card p-4 rounded shadow">
                        <div class="text-gray-400 text-xs font-medium uppercase">Chốt Stop Loss (SL)</div>
                        <div id="statSL" class="text-lg font-bold text-red-400 mt-1">0 lệnh</div>
                        <div id="statSL_PnL" class="text-sm text-gray-400">0.00$</div>
                    </div>
                    <div class="card p-4 rounded shadow">
                        <div class="text-gray-400 text-xs font-medium uppercase">PnL Tổng Hợp</div>
                        <div id="statTotalPnL" class="text-2xl font-bold mt-1 text-white">0.00$</div>
                    </div>
                </div>
            </div>

            <div class="card p-6 rounded shadow">
                <h3 class="text-lg font-bold text-yellow-400 mb-4 flex items-center">
                    <span class="inline-block w-3 h-3 bg-yellow-400 rounded-full mr-2 animate-pulse"></span>
                    DANH SÁCH VỊ THẾ ĐANG MỞ HIỆN TẠI CẢ 2 BOT
                </h3>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-sm text-gray-300">
                        <thead>
                            <tr class="border-b border-gray-700 text-gray-400 font-medium">
                                <th class="pb-2">BOT</th>
                                <th class="pb-2">Cặp Coin</th>
                                <th class="pb-2">Vị Thế</th>
                                <th class="pb-2">Số Lần DCA</th>
                                <th class="pb-2">Margin Hiện Tại</th>
                                <th class="pb-2">Kích Thước (Qty)</th>
                                <th class="pb-2">Entry Đầu / Avg Entry</th>
                                <th class="pb-2">Giá Hiện Tại</th>
                                <th class="pb-2">Mục Tiêu TP / SL</th>
                                <th class="pb-2">PnL (%)</th>
                            </tr>
                        </thead>
                        <tbody id="positionTable" class="divide-y divide-gray-800">
                            <tr>
                                <td colspan="10" class="py-4 text-center text-gray-500">Không có vị thế hoạt động.</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="card p-6 rounded shadow">
                    <h3 class="text-lg font-bold text-blue-400 border-b border-gray-700 pb-2 mb-4">⚙️ THÔNG SỐ CẤU HÌNH BOT 1 (CỔNG 2402)</h3>
                    <pre id="configBot1" class="text-xs text-green-400 overflow-x-auto p-3 bg-black rounded h-40">Đang tải cấu hình...</pre>
                </div>
                <div class="card p-6 rounded shadow">
                    <h3 class="text-lg font-bold text-pink-400 border-b border-gray-700 pb-2 mb-4">⚙️ THÔNG SỐ CẤU HÌNH BOT 2 (CỔNG 2403)</h3>
                    <pre id="configBot2" class="text-xs text-green-400 overflow-x-auto p-3 bg-black rounded h-40">Đang tải cấu hình...</pre>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="card p-4 rounded shadow">
                    <h3 class="text-sm font-bold text-blue-400 mb-2">📟 LOG CHẠY THỜI GIAN THỰC BOT 1</h3>
                    <div id="logBot1" class="log-container p-2 rounded"></div>
                </div>
                <div class="card p-4 rounded shadow">
                    <h3 class="text-sm font-bold text-pink-400 mb-2">📟 LOG CHẠY THỜI GIAN THỰC BOT 2</h3>
                    <div id="logBot2" class="log-container p-2 rounded"></div>
                </div>
            </div>

            <div class="card p-6 rounded shadow">
                <h3 class="text-lg font-bold text-green-400 mb-4 flex items-center">
                    <span class="inline-block w-3 h-3 bg-green-400 rounded-full mr-2"></span>
                    📜 LỊCH SỬ VỊ THẾ ĐÃ ĐÓNG (TỐI ĐA 100 VỊ THẾ GẦN NHẤT)
                </h3>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-sm text-gray-300">
                        <thead>
                            <tr class="border-b border-gray-700 text-gray-400 font-medium">
                                <th class="pb-2">Thời Gian</th>
                                <th class="pb-2">BOT</th>
                                <th class="pb-2">Cặp Coin</th>
                                <th class="pb-2">Vị Thế</th>
                                <th class="pb-2">DCA</th>
                                <th class="pb-2">Margin Chốt</th>
                                <th class="pb-2">Kích Thước</th>
                                <th class="pb-2">Entry Đầu / Avg</th>
                                <th class="pb-2">Giá Đóng</th>
                                <th class="pb-2">Lý Do Đóng</th>
                                <th class="pb-2">PnL Thực Tế</th>
                            </tr>
                        </thead>
                        <tbody id="historyTable" class="divide-y divide-gray-800">
                            <tr>
                                <td colspan="11" class="py-4 text-center text-gray-500">Chưa có lịch sử lệnh đóng.</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            let currentStatus = false;

            function parseLogClass(type) {
                if (type === 'success') return 'log-success';
                if (type === 'error' || type === 'sl') return 'log-error';
                if (type === 'warn') return 'log-warn';
                if (type === 'open') return 'log-open';
                if (type === 'dca') return 'log-dca';
                return 'log-info';
            }

            async function updateDashboard() {
                try {
                    const res = await fetch('/api/global_summary');
                    const data = await res.json();
                    
                    currentStatus = data.systemRunning;
                    const statusEl = document.getElementById('sysStatus');
                    const btnToggle = document.getElementById('btnToggle');
                    
                    if(currentStatus) {
                        statusEl.innerText = "HỆ THỐNG: START";
                        statusEl.className = "px-4 py-2 rounded font-bold text-white bg-green-600";
                        btnToggle.innerText = "STOP TOÀN BỘ SYSTEM";
                        btnToggle.className = "bg-red-600 hover:bg-red-700 text-white font-bold px-6 py-2 rounded transition shadow-md";
                    } else {
                        statusEl.innerText = "HỆ THỐNG: STOP";
                        statusEl.className = "px-4 py-2 rounded font-bold text-white bg-red-600";
                        btnToggle.innerText = "START TOÀN BỘ SYSTEM";
                        btnToggle.className = "bg-green-600 hover:bg-green-700 text-white font-bold px-6 py-2 rounded transition shadow-md";
                    }

                    // Cập nhật thẻ thông số
                    document.getElementById('statTotalOpened').innerText = data.stats.totalOpened;
                    document.getElementById('statCurrentlyOpen').innerText = data.stats.currentlyOpen;
                    
                    document.getElementById('statTP').innerText = data.stats.tpCount + " lệnh";
                    document.getElementById('statTP_PnL').innerText = data.stats.tpPnL.toFixed(2) + "$";
                    
                    document.getElementById('statAVG').innerText = data.stats.avgCount + " lệnh";
                    document.getElementById('statAVG_PnL').innerText = data.stats.avgPnL.toFixed(2) + "$";
                    
                    document.getElementById('statSL').innerText = data.stats.slCount + " lệnh";
                    document.getElementById('statSL_PnL').innerText = data.stats.slPnL.toFixed(2) + "$";
                    
                    const totalPnL = data.stats.totalPnL;
                    const pnlEl = document.getElementById('statTotalPnL');
                    pnlEl.innerText = totalPnL.toFixed(2) + "$";
                    pnlEl.className = "text-2xl font-bold mt-1 " + (totalPnL >= 0 ? "text-green-400" : "text-red-400");

                    // Cập nhật cấu hình Read-Only công khai
                    document.getElementById('configBot1').innerText = JSON.stringify(data.configs.bot1, null, 4);
                    document.getElementById('configBot2').innerText = JSON.stringify(data.configs.bot2, null, 4);

                    // Cập nhật bảng Log động cho 2 Bot
                    document.getElementById('logBot1').innerHTML = data.bot1Logs.map(l => \`<div class="log-line \${parseLogClass(l.type)}">[\${l.time}] \${l.msg}</div>\`).join('');
                    document.getElementById('logBot2').innerHTML = data.bot2Logs.map(l => \`<div class="log-line \${parseLogClass(l.type)}">[\${l.time}] \${l.msg}</div>\`).join('');

                    // Cập nhật danh sách vị thế đang mở
                    const tbody = document.getElementById('positionTable');
                    if(data.activePositions.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="10" class="py-4 text-center text-gray-500">Không có vị thế hoạt động.</td></tr>';
                    } else {
                        tbody.innerHTML = data.activePositions.map(p => {
                            const sideClass = p.side === 'LONG' ? 'text-green-400' : 'text-red-400';
                            const pnlClass = p.pnl >= 0 ? 'text-green-400' : 'text-red-400';
                            return \`
                                <tr class="border-b border-gray-800 hover:bg-gray-800 transition">
                                    <td class="py-3 font-semibold text-gray-400">\${p.botId}</td>
                                    <td class="py-3 font-bold text-white">\${p.symbol}</td>
                                    <td class="py-3 \${sideClass} font-bold">\${p.side}</td>
                                    <td class="py-3">\${p.dcaCount} / \${p.isDiangucMode ? 'ĐỊA NGỤC' : 'THƯỜNG'}</td>
                                    <td class="py-3 font-medium">\${p.currentMargin.toFixed(2)}$</td>
                                    <td class="py-3">\${p.currentQty}</td>
                                    <td class="py-3 text-xs">\${p.firstEntry.toFixed(4)} / <span class="text-blue-300 font-bold">\${p.avgEntry.toFixed(4)}</span></td>
                                    <td class="py-3 font-bold">\${p.livePrice.toFixed(4)}</td>
                                    <td class="py-3 text-xs text-gray-400">TP: <span class="text-green-400">\${p.tp.toFixed(4)}</span><br>SL: <span class="text-red-400">\${p.sl.toFixed(4)}</span></td>
                                    <td class="py-3 \${pnlClass} font-bold">\${p.pnl.toFixed(2)}$ (\${p.profitPercent.toFixed(2)}%)</td>
                                </tr>
                            \`;
                        }).join('');
                    }

                    // Cập nhật bảng Lịch sử vị thế đã đóng (Tối đa 100 dòng gần nhất)
                    const hbody = document.getElementById('historyTable');
                    if(!data.closedHistory || data.closedHistory.length === 0) {
                        hbody.innerHTML = '<tr><td colspan="11" class="py-4 text-center text-gray-500">Chưa có lịch sử lệnh đóng.</td></tr>';
                    } else {
                        hbody.innerHTML = data.closedHistory.map(h => {
                            const sideClass = h.side === 'LONG' ? 'text-green-400' : 'text-red-400';
                            const pnlClass = h.pnl >= 0 ? 'text-green-400' : 'text-red-400';
                            return \`
                                <tr class="border-b border-gray-800 hover:bg-gray-800/50 transition">
                                    <td class="py-2 text-xs text-gray-400">\${h.time}</td>
                                    <td class="py-2 text-xs font-semibold text-gray-500">\${h.botId}</td>
                                    <td class="py-2 font-bold text-white">\${h.symbol}</td>
                                    <td class="py-2 \${sideClass} font-bold text-xs">\${h.side}</td>
                                    <td class="py-2 text-xs">\${h.dcaCount} (\${h.isDiangucMode ? 'ĐN' : 'T'})</td>
                                    <td class="py-2 text-xs">\${h.margin.toFixed(2)}$</td>
                                    <td class="py-2 text-xs">\${h.qty}</td>
                                    <td class="py-2 text-xs">\${h.avgEntry.toFixed(4)}</td>
                                    <td class="py-2 text-xs font-bold">\${h.closePrice.toFixed(4)}</td>
                                    <td class="py-2 text-xs font-medium text-purple-400">\${h.reason}</td>
                                    <td class="py-2 \${pnlClass} font-bold text-xs">\${h.pnl.toFixed(2)}$</td>
                                </tr>
                            \`;
                        }).join('');
                    }
                } catch (e) { console.error("Lỗi cập nhật dữ liệu Server UI:", e); }
            }

            async function toggleSystem() {
                const action = currentStatus ? 'stop' : 'start';
                if(confirm("Bạn có chắc chắn muốn " + action.toUpperCase() + " toàn bộ 2 Bot cùng lúc không?")) {
                    await fetch('/api/global_control', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action })
                    });
                    updateDashboard();
                }
            }

            setInterval(updateDashboard, 1500);
            updateDashboard();
        </script>
    </body>
    </html>
    `);
});

appServer.get('/api/health', (req, res) => {
    res.json({ status: "running", bot1_positions: bot1.botActivePositions.size, bot2_positions: bot2.botActivePositions.size, blacklist_count: Object.keys(sharedState.blackList).length });
});

// =========================================================
// KHỞI CHẠY CORE LOGIC
// =========================================================
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
        
        addBotLog(bot1, `🚀 Hoàn tất setup hệ thống gộp tối ưu.`, "info");
        addBotLog(bot2, `🚀 Hoàn tất setup hệ thống gộp tối ưu.`, "info");
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
// VÒNG LẶP ĐIỀU PHỐI: TÍNH TOÁN VỐN CHUNG TUYỆT ĐỐI
// =========================================================
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

appServer.listen(2401, () => console.log('🌐 [MAIN SERVER] Đang chạy Lõi xử lý tổng hợp tại Port 2401'));
appBot1.listen(2402, () => console.log('📈 [BOT 1 UI] Đang chạy Web theo dõi Bot 1 tại Port 2402'));
appBot2.listen(2403, () => console.log('📉 [BOT 2 UI] Đang chạy Web theo dõi Bot 2 tại Port 2403'));
