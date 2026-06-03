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

                const logType = finalPnLFromSàn >= 0 ? "success" : "sl";
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
// ĐỒNG BỘ TP/SL LÊN SÀN (CONTRACT_PRICE)
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
// 🌐 HÀM TẠO SẴN GIAO DIỆN HTML NHÚNG THẲNG (EMBEDDED UI)
// =========================================================
function getBotHTML(botTitle) {
    return `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Điều Khiển ${botTitle}</title>
        <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <style>
            body { background-color: #0f172a; color: #e2e8f0; font-family: sans-serif; }
            .card { background-color: #1e293b; border: 1px solid #334155; }
            ::-webkit-scrollbar { width: 6px; }
            ::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }
        </style>
    </head>
    <body class="p-4 md:p-6">
        <div class="max-w-7xl mx-auto space-y-6">
            <div class="flex flex-col md:flex-row justify-between items-center card p-4 rounded-xl gap-4">
                <div>
                    <h1 class="text-xl font-bold text-teal-400 flex items-center gap-2">
                        🤖 BẢNG ĐIỀU KHIỂN: <span class="text-white">${botTitle}</span>
                    </h1>
                    <p class="text-xs text-gray-400 mt-1">Dữ liệu tài khoản và thông số vị thế quét thời gian thực</p>
                </div>
                <div class="flex flex-wrap items-center gap-4">
                    <div class="text-right">
                        <p class="text-xs text-gray-400">Số dư ví / Khả dụng</p>
                        <p class="text-base font-mono font-bold text-yellow-400">
                            <span id="wallet-balance">0.00</span>$ / <span id="avail-balance">0.00</span>$
                        </p>
                        <p id="unrealized-pnl" class="text-xs font-mono font-bold text-gray-400">Unrealized: 0.00$</p>
                    </div>
                    <button onclick="panicCloseAll()" class="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-3 rounded-lg text-xs shadow transition">
                        🚨 PANIC CLOSE ALL
                    </button>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="card p-5 rounded-xl space-y-4">
                    <h2 class="text-lg font-bold text-teal-300 border-b border-gray-700 pb-2 flex justify-between items-center">
                        ⚙️ Cài Đặt Thông Số
                        <span id="bot-status-badge" class="text-xs px-2 py-0.5 rounded bg-gray-600 text-white">LOADING</span>
                    </h2>
                    <form id="settings-form" onsubmit="updateSettings(event)" class="space-y-3 text-xs">
                        <div class="flex items-center justify-between bg-slate-800 p-2 rounded">
                            <label class="font-bold text-gray-300">Kích hoạt chạy Bot:</label>
                            <input type="checkbox" id="isRunning" class="w-4 h-4 accent-teal-500">
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Số Vị Thế Max</label>
                                <input type="number" id="maxPositions" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Vốn Vào Lệnh (invValue)</label>
                                <input type="text" id="invValue" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Vol Thường (minVol)</label>
                                <input type="number" step="0.01" id="minVol" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Vol Địa Ngục (diangucvol)</label>
                                <input type="number" step="0.01" id="diangucvol" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Chốt Lời Thường %</label>
                                <input type="number" step="0.01" id="posTP" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Cắt Lỗ Thường %</label>
                                <input type="number" step="0.01" id="posSL" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Chốt Lời Địa Ngục %</label>
                                <input type="number" step="0.01" id="dianguctp" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Cắt Lỗ Địa Ngục %</label>
                                <input type="number" step="0.01" id="diangucsl" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Bước DCA Thường %</label>
                                <input type="number" step="0.01" id="posdca" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Bước DCA Địa Ngục %</label>
                                <input type="number" step="0.01" id="diangucdca" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Hệ Số Gấp Thường</label>
                                <input type="number" step="0.1" id="heSoThuong" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                            <div>
                                <label class="block text-xxs text-gray-400 mb-0.5">Hệ Số Gấp Địa Ngục</label>
                                <input type="number" step="0.1" id="heSoDianguc" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                            </div>
                        </div>
                        <div>
                            <label class="block text-xxs text-gray-400 mb-0.5">Giới Hạn Lần DCA Tối Đa (maxDCA)</label>
                            <input type="number" id="maxDCA" class="w-full bg-slate-900 border border-gray-700 rounded p-1 text-white font-mono">
                        </div>
                        <button type="submit" class="w-full bg-teal-600 hover:bg-teal-500 text-white font-bold py-2 rounded text-xs shadow transition">
                            💾 CẬP NHẬT CẤU HÌNH BOT
                        </button>
                    </form>
                    
                    <div class="bg-slate-900 p-2.5 rounded-lg border border-gray-800 space-y-1 text-xs font-mono">
                        <div class="flex justify-between"><span>Lệnh đã đóng:</span><span id="closed-count" class="font-bold text-teal-400">0</span></div>
                        <div class="flex justify-between"><span>Tổng PnL chốt:</span><span id="closed-pnl" class="font-bold">0.00$</span></div>
                    </div>
                </div>

                <div class="card p-5 rounded-xl lg:col-span-2 space-y-4">
                    <h2 class="text-lg font-bold text-teal-300 border-b border-gray-700 pb-2">
                        📊 Vị Thế Hoạt Động Trên Lõi Bot
                    </h2>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse text-xs">
                            <thead>
                                <tr class="border-b border-gray-700 text-gray-400 font-mono">
                                    <th class="p-2">Cặp Coin</th>
                                    <th class="p-2">Side</th>
                                    <th class="p-2 text-center">DCA</th>
                                    <th class="p-2">Giá Entry/Live</th>
                                    <th class="p-2">Giá DCA Tiếp</th>
                                    <th class="p-2">Tổng Ký Quỹ</th>
                                    <th class="p-2">PnL (%)</th>
                                    <th class="p-2 text-center">Hành động</th>
                                </tr>
                            </thead>
                            <tbody id="positions-table" class="divide-y divide-gray-800">
                                <tr><td colspan="8" class="text-center p-4 text-gray-500">Đang đồng bộ dữ liệu...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="card p-5 rounded-xl space-y-3">
                    <h3 class="text-sm font-bold text-red-400 border-b border-gray-700 pb-1.5">🚫 Blacklist Hoạt Động</h3>
                    <div>
                        <p class="text-xxs text-gray-400 mb-1">Chặn 15m (Khi cả 2 bot đã đóng lệnh tránh quét lại):</p>
                        <div id="blacklist-container" class="flex flex-wrap gap-1 max-h-28 overflow-y-auto p-1 text-xxs"></div>
                    </div>
                    <div class="pt-2 border-t border-gray-800">
                        <p class="text-xxs text-red-500 font-bold mb-1">Ban vĩnh viễn (Lỗi đòn bẩy/Hệ thống):</p>
                        <div id="permanent-blacklist-container" class="flex flex-wrap gap-1 max-h-28 overflow-y-auto p-1 text-xxs"></div>
                    </div>
                </div>

                <div class="card p-5 rounded-xl lg:col-span-2 space-y-3">
                    <h3 class="text-sm font-bold text-teal-300 border-b border-gray-700 pb-1.5">📜 Live Logs Lịch Sử</h3>
                    <div id="logs-container" class="font-mono text-xxs overflow-y-auto h-48 space-y-0.5 bg-slate-900 p-2.5 rounded border border-gray-800"></div>
                </div>
            </div>
        </div>

        <script>
            let formInitialized = false;

            async function loadStatus() {
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();
                    
                    document.getElementById('wallet-balance').innerText = data.wallet.totalWalletBalance;
                    document.getElementById('avail-balance').innerText = data.wallet.availableBalance;
                    
                    const pnlEl = document.getElementById('unrealized-pnl');
                    pnlEl.innerText = 'Unrealized PnL: ' + data.wallet.totalUnrealizedProfit + '$';
                    pnlEl.className = parseFloat(data.wallet.totalUnrealizedProfit) >= 0 ? 'text-xs font-mono font-bold text-green-400' : 'text-xs font-mono font-bold text-red-400';

                    document.getElementById('closed-count').innerText = data.status.botClosedCount;
                    const closedPnlEl = document.getElementById('closed-pnl');
                    closedPnlEl.innerText = data.status.botPnLClosed.toFixed(2) + '$';
                    closedPnlEl.className = data.status.botPnLClosed >= 0 ? 'font-bold text-green-400' : 'font-bold text-red-400';

                    if (!formInitialized) {
                        document.getElementById('isRunning').checked = data.botSettings.isRunning;
                        document.getElementById('maxPositions').value = data.botSettings.maxPositions;
                        document.getElementById('invValue').value = data.botSettings.invValue;
                        document.getElementById('minVol').value = data.botSettings.minVol;
                        document.getElementById('diangucvol').value = data.botSettings.diangucvol;
                        document.getElementById('posTP').value = data.botSettings.posTP;
                        document.getElementById('posSL').value = data.botSettings.posSL;
                        document.getElementById('dianguctp').value = data.botSettings.dianguctp;
                        document.getElementById('diangucsl').value = data.botSettings.diangucsl;
                        document.getElementById('posdca').value = data.botSettings.posdca;
                        document.getElementById('diangucdca').value = data.botSettings.diangucdca;
                        document.getElementById('maxDCA').value = data.botSettings.maxDCA;
                        document.getElementById('heSoThuong').value = data.botSettings.heSoThuong;
                        document.getElementById('heSoDianguc').value = data.botSettings.heSoDianguc;
                        formInitialized = true;
                    }

                    const badge = document.getElementById('bot-status-badge');
                    if(data.botSettings.isRunning) {
                        badge.innerText = "RUNNING"; badge.className = "text-xs px-2 py-0.5 rounded bg-green-600 text-white font-bold";
                    } else {
                        badge.innerText = "STOPPED"; badge.className = "text-xs px-2 py-0.5 rounded bg-red-600 text-white font-bold";
                    }

                    const tbody = document.getElementById('positions-table');
                    if (data.activePositions.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="8" class="text-center p-4 text-gray-500 font-mono">Không có vị thế chạy trong bot hiện tại.</td></tr>';
                    } else {
                        tbody.innerHTML = data.activePositions.map(p => {
                            const pnlColor = p.pnl >= 0 ? 'text-green-400' : 'text-red-400';
                            const sideBg = p.side === 'LONG' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300';
                            const modeBadge = p.isDiangucMode ? '<span class="bg-purple-900 text-purple-300 px-1 rounded text-xxs font-bold">ĐỊA NGỤC</span>' : '<span class="bg-blue-950 text-blue-300 px-1 rounded text-xxs font-bold">THƯỜNG</span>';
                            return `
                                <tr class="hover:bg-slate-800 border-b border-gray-800 font-mono">
                                    <td class="p-2 font-bold">\${p.symbol} \${modeBadge}</td>
                                    <td class="p-2"><span class="px-1 py-0.5 rounded font-bold text-xxs \${sideBg}">\${p.side}</span></td>
                                    <td class="p-2 text-center font-bold">\${p.dcaCount}</td>
                                    <td class="p-2 text-gray-300">\${p.avgEntry.toFixed(4)} / <span class="text-white font-bold">\${p.livePrice.toFixed(4)}</span></td>
                                    <td class="p-2 text-yellow-500">\${p.nextDCA ? p.nextDCA.toFixed(4) : '-'}</td>
                                    <td class="p-2 font-bold">\${p.currentMargin.toFixed(2)}$</td>
                                    <td class="p-2 font-bold \${pnlColor}">\${p.pnl.toFixed(2)}$ (\${p.profitPercent.toFixed(2)}%)</td>
                                    <td class="p-2 text-center">
                                        <button onclick="closePosition('\${p.symbol}', '\${p.side}')" class="bg-orange-600 hover:bg-orange-700 text-white font-bold px-2 py-0.5 rounded text-xxs transition">Đóng vị thế</button>
                                    </td>
                                </tr>
                            `;
                        }).join('');
                    }

                    const blCont = document.getElementById('blacklist-container');
                    const blKeys = Object.keys(data.status.blackList);
                    if(blKeys.length === 0) blCont.innerHTML = '<span class="text-gray-600">Trống</span>';
                    else blCont.innerHTML = blKeys.map(k => `<span class="bg-red-950 text-red-300 border border-red-800 px-1.5 py-0.5 rounded">\${k} (\${data.status.blackList[k]}s)</span>`).join('');

                    const pblCont = document.getElementById('permanent-blacklist-container');
                    const pblKeys = Object.keys(data.status.permanentBlacklist);
                    if(pblKeys.length === 0) pblCont.innerHTML = '<span class="text-gray-600">Trống</span>';
                    else pblCont.innerHTML = pblKeys.map(k => `<span class="bg-gray-800 text-gray-400 border border-gray-700 px-1.5 py-0.5 rounded">\${k}</span>`).join('');

                    const logCont = document.getElementById('logs-container');
                    logCont.innerHTML = data.status.botLogs.map(l => {
                        let color = 'text-gray-300';
                        if(l.type === 'error' || l.type==='sl') color = 'text-red-400 font-bold';
                        if(l.type === 'success' || l.type === 'open') color = 'text-green-400';
                        if(l.type === 'warn' || l.type === 'dca' || l.type === 'avg') color = 'text-yellow-400';
                        return `<div class="\${color}">[\${l.time}] \${l.msg}</div>`;
                    }).join('');

                } catch (e) { console.error("Lỗi cập nhật UI:", e); }
            }

            async function updateSettings(e) {
                e.preventDefault();
                const body = {
                    isRunning: document.getElementById('isRunning').checked,
                    maxPositions: parseInt(document.getElementById('maxPositions').value),
                    invValue: document.getElementById('invValue').value,
                    minVol: parseFloat(document.getElementById('minVol').value),
                    diangucvol: parseFloat(document.getElementById('diangucvol').value),
                    posTP: parseFloat(document.getElementById('posTP').value),
                    posSL: parseFloat(document.getElementById('posSL').value),
                    dianguctp: parseFloat(document.getElementById('dianguctp').value),
                    diangucsl: parseFloat(document.getElementById('diangucsl').value),
                    posdca: parseFloat(document.getElementById('posdca').value),
                    diangucdca: parseFloat(document.getElementById('diangucdca').value),
                    maxDCA: parseInt(document.getElementById('maxDCA').value),
                    heSoThuong: parseFloat(document.getElementById('heSoThuong').value),
                    heSoDianguc: parseFloat(document.getElementById('heSoDianguc').value)
                };
                const res = await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
                const rData = await res.json();
                if(rData.success) Swal.fire({ icon: 'success', title: 'Cấu hình thành công!', timer: 1000, showConfirmButton: false, background: '#1e293b', color: '#fff' });
            }

            async function panicCloseAll() {
                if(!confirm('Xác nhận xả KHẨN CẤP toàn bộ trạng thái vị thế sàn?')) return;
                const res = await fetch('/api/close_all', { method: 'POST' });
                const data = await res.json();
                if(data.success) alert('Đã bắn lệnh MARKET đóng hết vị thế!');
            }

            async function closePosition(symbol, side) {
                if(!confirm(\`Xác nhận đóng đơn lẻ \${symbol} \${side}?\`)) return;
                const res = await fetch('/api/close_position', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ symbol, side }) });
                const data = await res.json();
                if(data.success) alert('Đã xử lý đóng đơn lẻ!');
            }

            setInterval(loadStatus, 1000);
            window.onload = loadStatus;
        </script>
    </body>
    </html>
    `;
}

function getMainServerHTML() {
    return `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Hệ Thống Tổng Cổng 2401</title>
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <style>
            body { background-color: #090d16; color: #f1f5f9; font-family: sans-serif; }
            .card { background-color: #111827; border: 1px solid #1f2937; }
        </style>
    </head>
    <body class="p-6">
        <div class="max-w-3xl mx-auto space-y-6">
            <div class="card p-6 rounded-2xl text-center space-y-2 border border-teal-500/30 shadow-lg shadow-teal-500/10">
                <h1 class="text-2xl font-extrabold text-teal-400 tracking-wider">🖥️ TRUNG TÂM ĐIỀU PHỐI (PORT 2401)</h1>
                <p class="text-gray-400 text-xs">Quản trị phân bổ luồng tín hiệu & Giám sát tổng đòn bẩy chống thanh lý</p>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="card p-5 rounded-xl text-center space-y-3 hover:border-green-500 transition">
                    <h2 class="text-lg font-bold text-green-400">📈 BOT_1 (NORMAL Mode)</h2>
                    <p class="text-gray-400 text-xxs">Đánh thuận xu hướng quét theo cấu hình gốc.</p>
                    <a href="http://127.0.0.1:2402" target="_blank" class="inline-block bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg text-xs w-full shadow transition">
                        Mở Control Panel Cổng 2402 ➔
                    </a>
                </div>

                <div class="card p-5 rounded-xl text-center space-y-3 hover:border-red-500 transition">
                    <h2 class="text-lg font-bold text-red-400">📉 BOT_2 (REVERSED Mode)</h2>
                    <p class="text-gray-400 text-xxs">Đánh ngược chiều bảo vệ vị thế tổng tài khoản.</p>
                    <a href="http://127.0.0.1:2403" target="_blank" class="inline-block bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg text-xs w-full shadow transition">
                        Mở Control Panel Cổng 2403 ➔
                    </a>
                </div>
            </div>

            <div class="card p-5 rounded-xl">
                <h3 class="text-xs font-bold text-gray-400 mb-2 uppercase tracking-wide">🔄 Khả dụng lõi điều phối hệ thống:</h3>
                <div id="health-status" class="font-mono text-xs space-y-1 text-teal-300">Đang đồng bộ tình trạng...</div>
            </div>
        </div>
        <script>
            async function refreshHealth() {
                try {
                    const res = await fetch('/api/health');
                    const d = await res.json();
                    document.getElementById('health-status').innerHTML = \`
                        <div>• Trạng thái lõi: <span class="text-green-400 font-bold">\${d.status.toUpperCase()}</span></div>
                        <div>• Vị thế mở tại BOT 1 (2402): <span class="text-white font-bold">\${d.bot1_positions}</span> vị thế</div>
                        <div>• Vị thế mở tại BOT 2 (2403): <span class="text-white font-bold">\${d.bot2_positions}</span> vị thế</div>
                        <div>• Tổng số coin nằm trong Blacklist: <span class="text-yellow-400 font-bold">\${d.blacklist_count}</span> mã</div>
                    \`;
                } catch(e) { }
            }
            setInterval(refreshHealth, 2000);
            window.onload = refreshHealth;
        </script>
    </body>
    </html>
    \`;
}

// =========================================================
// KHỞI TẠO CÁC ROUTE ĐÁP ỨNG GIAO DIỆN VÀ API
// =========================================================
const appServer = express(); appServer.use(express.json());
const appBot1 = express(); appBot1.use(express.json());
const appBot2 = express(); appBot2.use(express.json());

// PORT 2401 (MAIN APP MASTER)
appServer.get('/', (req, res) => res.send(getMainServerHTML()));
appServer.get('/api/health', (req, res) => {
    res.json({ status: "running", bot1_positions: bot1.botActivePositions.size, bot2_positions: bot2.botActivePositions.size, blacklist_count: Object.keys(sharedState.blackList).length });
});

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

// PORT 2402 (BOT 1 CONTROL PANEL)
appBot1.get('/', (req, res) => res.send(getBotHTML("BOT_1 (NORMAL MODE)")));
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

// PORT 2403 (BOT 2 CONTROL PANEL)
appBot2.get('/', (req, res) => res.send(getBotHTML("BOT_2 (REVERSED MODE)")));
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

appServer.listen(2401, () => console.log('🌐 [MAIN SERVER] Giao diện Tổng đang chạy tại Port 2401'));
appBot1.listen(2402, () => console.log('📈 [BOT 1 UI] Giao diện Bot 1 đang chạy tại Port 2402'));
appBot2.listen(2403, () => console.log('📉 [BOT 2 UI] Giao diện Bot 2 đang chạy tại Port 2403'));
