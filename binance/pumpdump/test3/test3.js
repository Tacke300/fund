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
// BỘ NHỚ CHIA SẺ (SHARED STATE) - QUẢN LÝ BLACKLIST CHUNG
// =========================================================
let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null
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
    status: { botLogs: [], botHistory: [], botClosedCount: 0, botPnLClosed: 0, winCount: 0, lossCount: 0, avgCount: 0, isReady: false },
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
    status: { botLogs: [], botHistory: [], botClosedCount: 0, botPnLClosed: 0, winCount: 0, lossCount: 0, avgCount: 0, isReady: false },
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
        addBotLog(bot1, `🚫 [BLACKLIST CHUNG] Đã chặn ${symbol} 15 phút do 2 bot thoát vị thế.`, "warn");
        addBotLog(bot2, `🚫 [BLACKLIST CHUNG] Đã chặn ${symbol} 15 phút do 2 bot thoát vị thế.`, "warn");
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
        if (reasonStr.includes("AVG") || reasonStr.includes("ĐỊA NGỤC")) logType = "avg"; 

        if (logType === "success") bot.status.winCount++;
        else if (logType === "sl") bot.status.lossCount++;
        else bot.status.avgCount++;

        // LƯU LỊCH SỬ DÀNH CHO BẢNG HIỂN THỊ TRÊN WEB
        bot.status.botHistory.unshift({
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
            mode: b.isDiangucMode ? "ĐỊA NGỤC" : "THƯỜNG",
            symbol: b.symbol,
            leverage: b.leverage,
            margin: b.firstMargin,
            entry: b.firstEntry,
            dcaHistory: b.dcaHistory || [],
            tp: b.tp,
            sl: b.sl,
            reason: reasonStr,
            pnl: finalPnL
        });
        if (bot.status.botHistory.length > 200) bot.status.botHistory.pop();

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
                b.nextDCA = b.side === 'LONG' ? b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100))) : b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100)));

                // 💥 KIỂM TRA ƯU TIÊN CHẾ ĐỘ ĐỊA NGỤC (ĐÓNG VỊ THẾ THƯỜNG)
                if (!b.isDiangucMode) {
                    const cand = sharedState.candidatesList.find(c => c.symbol === b.symbol);
                    if (cand) {
                        const hellVol = bot.botSettings.diangucvol;
                        if (Math.abs(cand.c1) >= hellVol || Math.abs(cand.c5) >= hellVol || Math.abs(cand.c15) >= hellVol) {
                            bot.botActivePositions.delete(key);
                            delete sharedState.blackList[b.symbol]; // Xóa chặn để có thể mở lại địa ngục ngay lập tức
                            await closePositionAndLog(bot, b, markP, "CHUYỂN CHẾ ĐỘ ĐỊA NGỤC");
                            continue;
                        }
                    }
                }

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
                
                let finalPnLFromSàn = matchingTrades.length > 0 ? matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0) : (b.pnl || 0);
                
                bot.status.botClosedCount++;
                bot.status.botPnLClosed += finalPnLFromSàn;

                let logType = finalPnLFromSàn >= 0 ? "success" : "sl";
                if (logType === "success") bot.status.winCount++; else bot.status.lossCount++;

                bot.status.botHistory.unshift({
                    time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
                    mode: b.isDiangucMode ? "ĐỊA NGỤC" : "THƯỜNG",
                    symbol: b.symbol, leverage: b.leverage, margin: b.firstMargin, entry: b.firstEntry,
                    dcaHistory: b.dcaHistory || [], tp: b.tp, sl: b.sl, reason: "CHẠM TP/SL", pnl: finalPnLFromSàn
                });
                if (bot.status.botHistory.length > 200) bot.status.botHistory.pop();

                addBotLog(bot, `🔒 [ĐÓNG TRÊN SÀN - TP/SL] ${b.symbol} ${b.side} | Entry: ${b.avgEntry.toFixed(pPrec)} | PnL Tổng Vị Thế: ${finalPnLFromSàn.toFixed(2)}$`, logType);
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
                const modeLabel = currentModeIsHell ? "ĐỊA NGỤC" : "THƯỜNG";
                addBotLog(bot, `[MỞ ${side}][CHẾ ĐỘ: ${modeLabel}] ${symbol} | Lev: ${info.maxLeverage}x | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(pPrec)} | TP: ${finalTP.toFixed(pPrec)} | SL: ${finalSL.toFixed(pPrec)}`, "open"); 
            } else {
                const historyMarginsStr = dcaHistory.map((h, idx) => `Lần ${idx + 1}: ${h.margin.toFixed(2)}$`).join(' | ');
                addBotLog(bot, `[DCA LẦN ${dcaCount}] ${symbol} | Margin Đầu: ${dcaData.firstMargin.toFixed(2)}$ | Nạp Margin: [ ${historyMarginsStr} ] | Giá DCA: ${actualFilledPrice.toFixed(pPrec)} | Avg: ${newAvgEntry.toFixed(pPrec)}`, "dca"); 
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
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        await bot.exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'CONTRACT_PRICE' });
        await bot.exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'CONTRACT_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
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
                await panicCloseAll(bot, "CHỐNG THANH LÝ 5%");
                bot.isMarginProtected = true; bot.botSettings.isRunning = false; 
                addBotLog(bot, `🛑 Bot tự động STOP để bảo vệ tài khoản an toàn.`, "error"); return; 
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
// KHỞI TẠO EXPRESS SERVER LOGIC
// =========================================================
const appServer = express(); appServer.use(express.json());
const appBot1 = express(); appBot1.use(express.json()); 
const appBot2 = express(); appBot2.use(express.json()); 

async function buildStatusResponse(bot) {
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    return { 
        botSettings: bot.botSettings, 
        activePositions: Array.from(bot.botActivePositions.values()), 
        status: bot.status, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
        } : { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" } 
    };
}

// API CHUYÊN DỤNG CHO SERVER TỔNG HỢP GIAO DIỆN MỚI
appServer.get('/api/dashboard', async (req, res) => {
    res.json({
        bot1: await buildStatusResponse(bot1),
        bot2: await buildStatusResponse(bot2)
    });
});

// ROUTE CORES CŨ (Bot 1, Bot 2)
appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1)));
appBot1.post('/api/settings', (req, res) => { bot1.botSettings = { ...bot1.botSettings, ...req.body }; res.json({ success: true }); });
appBot2.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot2)));
appBot2.post('/api/settings', (req, res) => { bot2.botSettings = { ...bot2.botSettings, ...req.body }; res.json({ success: true }); });

// =========================================================
// GIAO DIỆN HTML/JS TÍCH HỢP TRỰC TIẾP (SERVER 2401)
// =========================================================
const HTML_UI = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>⚡ Binance Bot Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .tab-content { display: none; }
        .tab-content.active { display: block; animation: fadeIn 0.3s ease-in-out; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-thumb { background: #4b5563; border-radius: 4px; }
    </style>
</head>
<body class="bg-gray-900 text-gray-200 font-sans p-4 text-sm leading-relaxed">
    <div class="max-w-7xl mx-auto">
        <header class="flex justify-between items-center mb-6 pb-4 border-b border-gray-700">
            <h1 class="text-2xl font-bold text-blue-400">🤖 Trading Bot Controller</h1>
            <div class="flex space-x-2">
                <button onclick="switchTab('tab1')" class="tab-btn px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-gray-300 active-tab font-semibold border-b-2 border-transparent">Cấu Hình</button>
                <button onclick="switchTab('tab2')" class="tab-btn px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-gray-300">Tổng Quan</button>
                <button onclick="switchTab('tab3')" class="tab-btn px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-gray-300">Logs System</button>
                <button onclick="switchTab('tab4')" class="tab-btn px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-gray-300">Vị Thế</button>
                <button onclick="switchTab('tab5')" class="tab-btn px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-gray-300">Lịch Sử</button>
            </div>
        </header>

        <div id="tab1" class="tab-content active">
            <div class="grid grid-cols-2 gap-6">
                <div class="bg-gray-800 p-5 rounded-lg border border-gray-700 shadow-md" id="config-bot1">Đang tải cấu hình Bot 1...</div>
                <div class="bg-gray-800 p-5 rounded-lg border border-gray-700 shadow-md" id="config-bot2">Đang tải cấu hình Bot 2...</div>
            </div>
        </div>

        <div id="tab2" class="tab-content">
            <div class="grid grid-cols-2 gap-6">
                <div class="bg-gray-800 p-5 rounded-lg border border-gray-700 shadow-md">
                    <h3 class="text-lg font-bold text-blue-300 mb-4 border-b border-gray-700 pb-2">Bot 1 (Normal Mode)</h3>
                    <div class="grid grid-cols-2 gap-4 mb-4">
                        <div class="bg-gray-700 p-3 rounded text-center">
                            <p class="text-gray-400 text-xs">Vị thế đang mở</p>
                            <p class="text-xl font-bold" id="b1-active-pos">0</p>
                        </div>
                        <div class="bg-gray-700 p-3 rounded text-center">
                            <p class="text-gray-400 text-xs">Tổng PnL (Kín)</p>
                            <p class="text-xl font-bold" id="b1-pnl">0.00$</p>
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 text-center text-xs">
                        <div class="bg-green-900/40 p-2 rounded text-green-400 border border-green-800">Thắng: <span class="font-bold text-sm block" id="b1-win">0</span></div>
                        <div class="bg-yellow-900/40 p-2 rounded text-yellow-400 border border-yellow-800">AVG (Hoà): <span class="font-bold text-sm block" id="b1-avg">0</span></div>
                        <div class="bg-red-900/40 p-2 rounded text-red-400 border border-red-800">Lỗ: <span class="font-bold text-sm block" id="b1-loss">0</span></div>
                    </div>
                </div>
                <div class="bg-gray-800 p-5 rounded-lg border border-gray-700 shadow-md">
                    <h3 class="text-lg font-bold text-purple-300 mb-4 border-b border-gray-700 pb-2">Bot 2 (Reverse Mode)</h3>
                    <div class="grid grid-cols-2 gap-4 mb-4">
                        <div class="bg-gray-700 p-3 rounded text-center">
                            <p class="text-gray-400 text-xs">Vị thế đang mở</p>
                            <p class="text-xl font-bold" id="b2-active-pos">0</p>
                        </div>
                        <div class="bg-gray-700 p-3 rounded text-center">
                            <p class="text-gray-400 text-xs">Tổng PnL (Kín)</p>
                            <p class="text-xl font-bold" id="b2-pnl">0.00$</p>
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 text-center text-xs">
                        <div class="bg-green-900/40 p-2 rounded text-green-400 border border-green-800">Thắng: <span class="font-bold text-sm block" id="b2-win">0</span></div>
                        <div class="bg-yellow-900/40 p-2 rounded text-yellow-400 border border-yellow-800">AVG (Hoà): <span class="font-bold text-sm block" id="b2-avg">0</span></div>
                        <div class="bg-red-900/40 p-2 rounded text-red-400 border border-red-800">Lỗ: <span class="font-bold text-sm block" id="b2-loss">0</span></div>
                    </div>
                </div>
            </div>
            <div class="mt-6 bg-gray-800 p-5 rounded-lg border border-gray-700 shadow-md text-center">
                <h3 class="text-lg font-bold text-white mb-2">Số dư tài khoản (Margin)</h3>
                <p class="text-3xl font-bold text-yellow-400" id="wallet-balance">0.00 USDT</p>
                <p class="text-sm text-gray-400 mt-1">PnL Chưa chốt (Sàn): <span id="unrealized-pnl" class="font-bold">0.00</span> USDT</p>
            </div>
        </div>

        <div id="tab3" class="tab-content">
            <div class="grid grid-cols-2 gap-6">
                <div class="bg-gray-800 p-4 rounded-lg border border-gray-700 h-[600px] overflow-y-auto">
                    <h3 class="text-blue-300 font-bold mb-3 border-b border-gray-700 pb-2 sticky top-0 bg-gray-800">📝 Logs Bot 1</h3>
                    <div id="logs-bot1" class="space-y-2 text-xs font-mono"></div>
                </div>
                <div class="bg-gray-800 p-4 rounded-lg border border-gray-700 h-[600px] overflow-y-auto">
                    <h3 class="text-purple-300 font-bold mb-3 border-b border-gray-700 pb-2 sticky top-0 bg-gray-800">📝 Logs Bot 2</h3>
                    <div id="logs-bot2" class="space-y-2 text-xs font-mono"></div>
                </div>
            </div>
        </div>

        <div id="tab4" class="tab-content">
            <div class="bg-gray-800 p-5 rounded-lg border border-gray-700 overflow-x-auto shadow-md">
                <table class="w-full text-left text-xs whitespace-nowrap">
                    <thead class="bg-gray-700 text-gray-300">
                        <tr>
                            <th class="px-3 py-2 rounded-tl">Bot</th>
                            <th class="px-3 py-2">Symbol</th>
                            <th class="px-3 py-2">Chế Độ</th>
                            <th class="px-3 py-2">Side</th>
                            <th class="px-3 py-2">Đòn Bẩy</th>
                            <th class="px-3 py-2">Ký Quỹ ($)</th>
                            <th class="px-3 py-2">Entry AVG</th>
                            <th class="px-3 py-2">Live Price</th>
                            <th class="px-3 py-2">Mức DCA</th>
                            <th class="px-3 py-2">TP / SL</th>
                            <th class="px-3 py-2 rounded-tr text-right">PnL</th>
                        </tr>
                    </thead>
                    <tbody id="active-positions-body" class="divide-y divide-gray-700 font-mono">
                        <tr><td colspan="11" class="text-center py-4 text-gray-500">Không có dữ liệu</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div id="tab5" class="tab-content">
            <div class="bg-gray-800 p-5 rounded-lg border border-gray-700 overflow-x-auto shadow-md">
                <table class="w-full text-left text-xs whitespace-nowrap">
                    <thead class="bg-gray-700 text-gray-300">
                        <tr>
                            <th class="px-3 py-2 rounded-tl">STT</th>
                            <th class="px-3 py-2">Bot</th>
                            <th class="px-3 py-2">Thời gian</th>
                            <th class="px-3 py-2">Chế Độ</th>
                            <th class="px-3 py-2">Coin</th>
                            <th class="px-3 py-2">Ký Quỹ Đầu ($)</th>
                            <th class="px-3 py-2">Entry Đầu</th>
                            <th class="px-3 py-2">Lịch Sử Nạp DCA</th>
                            <th class="px-3 py-2">TP / SL Cài</th>
                            <th class="px-3 py-2">Lý Do Đóng</th>
                            <th class="px-3 py-2 rounded-tr text-right">PnL Lệnh ($)</th>
                        </tr>
                    </thead>
                    <tbody id="history-body" class="divide-y divide-gray-700 font-mono">
                        <tr><td colspan="11" class="text-center py-4 text-gray-500">Không có dữ liệu lịch sử</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(el => {
                el.classList.remove('border-blue-500', 'text-white');
                el.classList.add('border-transparent');
            });
            document.getElementById(tabId).classList.add('active');
            event.currentTarget.classList.remove('border-transparent');
            event.currentTarget.classList.add('border-blue-500', 'text-white');
        }
        
        // INIT TAB UI
        document.querySelector('.tab-btn').click();

        function renderConfig(settings, botName, colorClass) {
            return '<h3 class="text-lg font-bold ' + colorClass + ' mb-3">' + botName + '</h3>' +
                   '<ul class="space-y-1 text-xs text-gray-300">' +
                   '<li>Trạng thái: <span class="font-bold text-white">' + (settings.isRunning ? 'Đang chạy' : 'Đang tắt') + '</span></li>' +
                   '<li>Max Vị thế: <span class="font-bold text-white">' + settings.maxPositions + '</span></li>' +
                   '<li>Vốn lệnh (invValue): <span class="font-bold text-white">' + settings.invValue + '</span></li>' +
                   '<li>Volume Thường: <span class="font-bold text-white">' + settings.minVol + '%</span></li>' +
                   '<li>Volume Địa Ngục: <span class="font-bold text-white">' + settings.diangucvol + '%</span></li>' +
                   '<li>TP/SL (Thường): <span class="font-bold text-green-400">' + settings.posTP + '%</span> / <span class="font-bold text-red-400">' + settings.posSL + '%</span></li>' +
                   '<li>TP/SL (Địa ngục): <span class="font-bold text-green-400">' + settings.dianguctp + '%</span> / <span class="font-bold text-red-400">' + settings.diangucsl + '%</span></li>' +
                   '<li>DCA (Thường/Địa Ngục): <span class="font-bold text-white">' + settings.posdca + '% / ' + settings.diangucdca + '%</span></li>' +
                   '<li>Hệ số Margin DCA: <span class="font-bold text-white">x' + settings.heSoThuong + ' (Thường) / x' + settings.heSoDianguc + ' (Địa Ngục)</span></li>' +
                   '</ul>';
        }

        function renderLogs(logs) {
            return logs.map(l => {
                let col = l.type === 'error' ? 'text-red-400' : l.type === 'success' ? 'text-green-400' : l.type === 'warn' ? 'text-yellow-400' : l.type === 'dca' ? 'text-purple-400' : 'text-gray-300';
                return '<p class="' + col + '">[' + l.time + '] ' + l.msg + '</p>';
            }).join('');
        }

        async function fetchDashboard() {
            try {
                const res = await fetch('/api/dashboard');
                const data = await res.json();
                
                // TAB 1: Config
                document.getElementById('config-bot1').innerHTML = renderConfig(data.bot1.botSettings, "Bot 1 (Normal Mode)", "text-blue-300");
                document.getElementById('config-bot2').innerHTML = renderConfig(data.bot2.botSettings, "Bot 2 (Reverse Mode)", "text-purple-300");

                // TAB 2: Stats
                document.getElementById('b1-active-pos').innerText = data.bot1.activePositions.length;
                document.getElementById('b1-pnl').innerText = data.bot1.status.botPnLClosed.toFixed(2) + '$';
                document.getElementById('b1-pnl').className = data.bot1.status.botPnLClosed >= 0 ? "text-xl font-bold text-green-400" : "text-xl font-bold text-red-400";
                document.getElementById('b1-win').innerText = data.bot1.status.winCount;
                document.getElementById('b1-avg').innerText = data.bot1.status.avgCount;
                document.getElementById('b1-loss').innerText = data.bot1.status.lossCount;

                document.getElementById('b2-active-pos').innerText = data.bot2.activePositions.length;
                document.getElementById('b2-pnl').innerText = data.bot2.status.botPnLClosed.toFixed(2) + '$';
                document.getElementById('b2-pnl').className = data.bot2.status.botPnLClosed >= 0 ? "text-xl font-bold text-green-400" : "text-xl font-bold text-red-400";
                document.getElementById('b2-win').innerText = data.bot2.status.winCount;
                document.getElementById('b2-avg').innerText = data.bot2.status.avgCount;
                document.getElementById('b2-loss').innerText = data.bot2.status.lossCount;

                document.getElementById('wallet-balance').innerText = data.bot1.wallet.totalWalletBalance + ' USDT';
                document.getElementById('unrealized-pnl').innerText = data.bot1.wallet.totalUnrealizedProfit;
                document.getElementById('unrealized-pnl').className = parseFloat(data.bot1.wallet.totalUnrealizedProfit) >= 0 ? "font-bold text-green-400" : "font-bold text-red-400";

                // TAB 3: Logs
                document.getElementById('logs-bot1').innerHTML = renderLogs(data.bot1.status.botLogs);
                document.getElementById('logs-bot2').innerHTML = renderLogs(data.bot2.status.botLogs);

                // TAB 4: Active Positions
                let posHtml = '';
                const allPos = [
                    ...data.bot1.activePositions.map(p => ({...p, botName: 'BOT 1'})),
                    ...data.bot2.activePositions.map(p => ({...p, botName: 'BOT 2'}))
                ];
                if (allPos.length === 0) posHtml = '<tr><td colspan="11" class="text-center py-4 text-gray-500">Không có vị thế nào đang mở</td></tr>';
                else {
                    allPos.forEach(p => {
                        let sideColor = p.side === 'LONG' ? 'text-green-400' : 'text-red-400';
                        let modeColor = p.isDiangucMode ? 'bg-red-900/50 text-red-300' : 'bg-blue-900/50 text-blue-300';
                        let pnlColor = p.pnl >= 0 ? 'text-green-400' : 'text-red-400';
                        posHtml += '<tr class="hover:bg-gray-700/50">' +
                            '<td class="px-3 py-2 text-gray-400">' + p.botName + '</td>' +
                            '<td class="px-3 py-2 font-bold">' + p.symbol + '</td>' +
                            '<td class="px-3 py-2"><span class="px-2 py-1 rounded text-[10px] ' + modeColor + '">' + (p.isDiangucMode ? 'ĐỊA NGỤC' : 'THƯỜNG') + '</span></td>' +
                            '<td class="px-3 py-2 font-bold ' + sideColor + '">' + p.side + '</td>' +
                            '<td class="px-3 py-2">' + p.leverage + 'x</td>' +
                            '<td class="px-3 py-2">' + p.currentMargin.toFixed(2) + '$</td>' +
                            '<td class="px-3 py-2">' + p.avgEntry.toFixed(6) + '</td>' +
                            '<td class="px-3 py-2">' + (p.livePrice || 0).toFixed(6) + '</td>' +
                            '<td class="px-3 py-2">' + p.dcaCount + '</td>' +
                            '<td class="px-3 py-2">' + p.tp.toFixed(5) + ' / ' + p.sl.toFixed(5) + '</td>' +
                            '<td class="px-3 py-2 text-right font-bold ' + pnlColor + '">' + (p.pnl || 0).toFixed(2) + '$</td>' +
                            '</tr>';
                    });
                }
                document.getElementById('active-positions-body').innerHTML = posHtml;

                // TAB 5: History
                let histHtml = '';
                const allHist = [
                    ...data.bot1.status.botHistory.map(h => ({...h, botName: 'BOT 1'})),
                    ...data.bot2.status.botHistory.map(h => ({...h, botName: 'BOT 2'}))
                ].sort((a,b) => {
                    const timeA = a.time.split(':').map(Number);
                    const timeB = b.time.split(':').map(Number);
                    return (timeB[0]*3600+timeB[1]*60+timeB[2]) - (timeA[0]*3600+timeA[1]*60+timeA[2]); // Sort by HH:MM:SS descending roughly
                });
                
                if (allHist.length === 0) histHtml = '<tr><td colspan="11" class="text-center py-4 text-gray-500">Chưa có lịch sử giao dịch</td></tr>';
                else {
                    allHist.forEach((h, idx) => {
                        let modeColor = h.mode === 'ĐỊA NGỤC' ? 'text-red-400' : 'text-blue-400';
                        let pnlColor = h.pnl >= 0 ? 'text-green-400' : 'text-red-400';
                        let dcaStr = h.dcaHistory.map((d, i) => 'L' + (i+1) + ': ' + d.margin.toFixed(1) + '$').join(' | ') || 'Không DCA';
                        
                        histHtml += '<tr class="hover:bg-gray-700/50">' +
                            '<td class="px-3 py-2 text-gray-500">' + (idx + 1) + '</td>' +
                            '<td class="px-3 py-2 text-gray-400">' + h.botName + '</td>' +
                            '<td class="px-3 py-2 text-gray-400">' + h.time + '</td>' +
                            '<td class="px-3 py-2 font-bold ' + modeColor + '">' + h.mode + '</td>' +
                            '<td class="px-3 py-2 font-bold">' + h.symbol + '</td>' +
                            '<td class="px-3 py-2">' + h.margin.toFixed(2) + '$</td>' +
                            '<td class="px-3 py-2">' + h.entry.toFixed(6) + '</td>' +
                            '<td class="px-3 py-2 text-[10px] text-gray-400 max-w-[200px] truncate" title="'+dcaStr+'">' + dcaStr + '</td>' +
                            '<td class="px-3 py-2">' + (h.tp||0).toFixed(5) + ' / ' + (h.sl||0).toFixed(5) + '</td>' +
                            '<td class="px-3 py-2 truncate max-w-[150px]" title="'+h.reason+'">' + h.reason + '</td>' +
                            '<td class="px-3 py-2 text-right font-bold text-sm ' + pnlColor + '">' + (h.pnl > 0 ? '+' : '') + h.pnl.toFixed(2) + '$</td>' +
                            '</tr>';
                    });
                }
                document.getElementById('history-body').innerHTML = histHtml;

            } catch (e) { console.error("UI Fetch Error:", e); }
        }
        setInterval(fetchDashboard, 2000);
        fetchDashboard();
    </script>
</body>
</html>`;

appServer.get('/', (req, res) => res.send(HTML_UI));

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

appServer.listen(2401, () => console.log('🌐 [MAIN UI] Web Quản Trị Trung Tâm đang chạy tại http://localhost:2401/'));
appBot1.listen(2402, () => console.log('📈 [BOT 1 API] Đang chạy Lõi Bot 1 tại Port 2402'));
appBot2.listen(2403, () => console.log('📉 [BOT 2 API] Đang chạy Lõi Bot 2 tại Port 2403'));
