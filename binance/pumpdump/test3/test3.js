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

// =========================================================
// BỘ NHỚ CHIA SẺ CHUNG & THỐNG KÊ CHI TIẾT
// =========================================================
let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    globalLogs: [],      // Hệ thống lưu trữ Log tổng hợp
    tradeHistory: [],    // Lịch sử lệnh chi tiết cho Tab 5
    stats: {             // Thống kê hiệu suất cho Tab 2
        winCount: 0, winPnL: 0,
        avgCount: 0, avgPnL: 0,
        lossCount: 0, lossPnL: 0,
        totalPnL: 0
    }
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

    const activeLong = botActivePositions.get(`${candidate.symbol}_LONG`);
    const activeShort = botActivePositions.get(`${candidate.symbol}_SHORT`);
    if ((activeLong && activeLong.isDiangucMode) || (activeShort && activeShort.isDiangucMode)) {
        return null;
    }

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

    const isPositionActive = activeLong || activeShort;
    if (isPositionActive) return null;

    for (const tf of SCAN_CONFIG.THUONG) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= minVol) {
            return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: tf, isDianguc: false };
        }
    }
    return null;
}

// =========================================================
// KHỞI TẠO CẤU TRÚC ĐỐI TƯỢNG BOT 1 & BOT 2
// =========================================================
let bot1 = {
    id: "BOT_1", sideMode: "NORMAL", 
    botSettings: { 
        isRunning: false, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
    botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

let bot2 = {
    id: "BOT_2", sideMode: "REVERSED", 
    botSettings: { 
        isRunning: false, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
    botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

// =========================================================
// HÀM GHI LOG ĐA LUỒNG KHÔNG MẤT DỮ LIỆU
// =========================================================
function addBotLog(bot, msg, type = 'info', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        const last = bot.logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        bot.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    
    // Khôi phục lưu log cục bộ cho giao diện con của từng bot
    bot.status.botLogs.unshift({ time, msg, type });
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    
    // Gom vết log tổng bộ về cho Dashboard chính
    sharedState.globalLogs.unshift({ time, msg: `[${bot.id}] ${msg}`, type });
    if (sharedState.globalLogs.length > 600) sharedState.globalLogs.pop();

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
        addBotLog(bot1, `🚫 [BLACKLIST] Chặn ${symbol} 15p do hệ thống đã thoát sạch vị thế.`, "warn");
        addBotLog(bot2, `🚫 [BLACKLIST] Chặn ${symbol} 15p do hệ thống đã thoát sạch vị thế.`, "warn");
    }
}

// =========================================================
// XỬ LÝ LƯU TRỮ LỊCH SỬ KHI ĐÓNG VỊ THẾ CHỦ ĐỘNG
// =========================================================
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
        let exitLabel = finalPnL >= 0 ? "LÃI" : "LỖ";
        if (reasonStr.includes("AVG")) { logType = "avg"; exitLabel = "AVG"; }

        // Cập nhật Tab 2 thống kê
        if (exitLabel === "AVG") { sharedState.stats.avgCount++; sharedState.stats.avgPnL += finalPnL; }
        else if (exitLabel === "LÃI") { sharedState.stats.winCount++; sharedState.stats.winPnL += finalPnL; }
        else { sharedState.stats.lossCount++; sharedState.stats.lossPnL += finalPnL; }
        sharedState.stats.totalPnL += finalPnL;

        // Cập nhật Tab 5 lịch sử chi tiết
        sharedState.tradeHistory.unshift({
            time: new Date().toLocaleString('vi-VN', { hour12: false }),
            botId: bot.id,
            mode: b.isDiangucMode ? "ĐỊA NGỤC" : "THƯỜNG",
            symbol: b.symbol, side: b.side, leverage: b.leverage,
            firstMargin: b.firstMargin, firstEntry: b.firstEntry,
            dcaHistory: JSON.parse(JSON.stringify(b.dcaHistory || [])),
            tp: b.tp, sl: b.sl, exitType: exitLabel, pnl: finalPnL
        });
        if (sharedState.tradeHistory.length > 1000) sharedState.tradeHistory.pop();

        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | Chốt: ${markP.toFixed(pPrec)} | PnL: ${finalPnL.toFixed(2)}$`, logType);
        
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addBotLog(bot, `❌ Lỗi đóng vị thế ${b.symbol}: ${e.message}`, "error");
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
            try {
                await bot.exchange.createOrder(p.symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
                count++;
            } catch (err) { }
        }
        bot.botActivePositions.clear();
        addBotLog(bot, `⚠️ Đã đóng toàn bộ ${count} vị thế sàn (${reasonLog})`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

// =========================================================
// MONITOR GIÁ & PHÁT HIỆN TỰ ĐỘNG KHỚP LỆNH SÀN (TP/SL)
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

            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                const avgEntry = parseFloat(realP.entryPrice); 
                
                b.currentQty = currentQty; b.livePrice = markP; b.pnl = parseFloat(realP.unRealizedProfit); b.avgEntry = avgEntry;
                b.profitPercent = b.side === 'LONG' ? ((markP - avgEntry) / avgEntry) * 100 : ((avgEntry - markP) / avgEntry) * 100;

                const dcaThreshold = b.isDiangucMode ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
                b.nextDCA = b.side === 'LONG' ? b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100))) : b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100)));

                let shouldCloseMarket = false;
                if (b.dcaCount > 0) {
                    const x = b.dcaCount; 
                    if (b.side === 'LONG' && markP >= (avgEntry * (1 + x / 100))) shouldCloseMarket = true;
                    if (b.side === 'SHORT' && markP <= (avgEntry * (1 - x / 100))) shouldCloseMarket = true;
                }

                if (shouldCloseMarket) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "CHỐT TRAILING AVG");
                    checkAndAddBlacklist(b.symbol); continue;
                }

                const jump = b.dcaCount + 1;
                const hitNextDCA = (b.side === 'LONG' && markP <= b.nextDCA) || (b.side === 'SHORT' && markP >= b.nextDCA);

                if (hitNextDCA && jump <= parseInt(bot.botSettings.maxDCA)) {
                    const coefThuong = parseFloat(bot.botSettings.heSoThuong || 2);
                    const coefDianguc = parseFloat(bot.botSettings.heSoDianguc || 3);
                    let marginToUse = b.isDiangucMode ? (b.firstMargin * coefDianguc) : (b.firstMargin * coefThuong);
                    openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                }
            } else {
                if (bot.isProcessingDCA.has(lockKey)) continue;
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
                const nowServer = Date.now() + bot.timestampOffset;
                const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 25000);
                
                let finalPnLFromSàn = matchingTrades.length > 0 ? matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0) : (b.pnl || 0);
                
                bot.status.botClosedCount++; bot.status.botPnLClosed += finalPnLFromSàn;
                let exitLabel = finalPnLFromSàn >= 0 ? "LÃI" : "LỖ";

                if (exitLabel === "LÃI") { sharedState.stats.winCount++; sharedState.stats.winPnL += finalPnLFromSàn; }
                else { sharedState.stats.lossCount++; sharedState.stats.lossPnL += finalPnLFromSàn; }
                sharedState.stats.totalPnL += finalPnLFromSàn;

                sharedState.tradeHistory.unshift({
                    time: new Date().toLocaleString('vi-VN', { hour12: false }),
                    botId: bot.id, mode: b.isDiangucMode ? "ĐỊA NGỤC" : "THƯỜNG",
                    symbol: b.symbol, side: b.side, leverage: b.leverage,
                    firstMargin: b.firstMargin, firstEntry: b.firstEntry,
                    dcaHistory: JSON.parse(JSON.stringify(b.dcaHistory || [])),
                    tp: b.tp, sl: b.sl, exitType: exitLabel, pnl: finalPnLFromSàn
                });

                addBotLog(bot, `🔒 [TỰ ĐỘNG SÀN Khớp TP/SL] ${b.symbol} ${b.side} | Entry: ${b.avgEntry.toFixed(pPrec)} | PnL: ${finalPnLFromSàn.toFixed(2)}$`, finalPnLFromSàn >= 0 ? "success" : "sl");
                bot.botActivePositions.delete(key);
                checkAndAddBlacklist(b.symbol); 
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 1000);
}

async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isDiangucSignal = false) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCA = dcaData !== null; const lockKey = `${symbol}_${side}`;
    if (bot.isProcessingDCA.has(lockKey)) return;
    bot.isProcessingDCA.add(lockKey); 
    
    try {
        const info = sharedState.exchangeInfo[symbol]; if(!info) throw new Error("Coin không hỗ trợ");
        let qty = 0, margin = 0, currentPrice = 0;

        if (isDCA) {
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`); currentPrice = parseFloat(ticker.data.price);
            margin = dcaData.margin; if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            qty = sharedQty; margin = sharedMargin; currentPrice = sharedPrice;
        }

        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            let newAvgEntry = actualFilledPrice, totalQty = qty, actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage, totalMargin = actualMarginUsed, dcaHistory = [];

            if (isDCA) {
                totalQty = dcaData.currentQty + qty; newAvgEntry = ((dcaData.currentQty * dcaData.avgEntry) + (qty * actualFilledPrice)) / totalQty;
                totalMargin = dcaData.currentMargin + actualMarginUsed; dcaHistory = [...(dcaData.dcaHistory || []), { price: actualFilledPrice, margin: actualMarginUsed }];
            } else { dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed }]; }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            const currentModeIsHell = isDCA ? dcaData.isDiangucMode : isDiangucSignal;
            
            let finalTP, finalSL;
            if (!isDCA) {
                const dir = (side === 'LONG' ? 1 : -1);
                const tpPercent = currentModeIsHell ? parseFloat(bot.botSettings.dianguctp) : parseFloat(bot.botSettings.posTP);
                const slPercent = currentModeIsHell ? parseFloat(bot.botSettings.diangucsl) : parseFloat(bot.botSettings.posSL);
                finalTP = newAvgEntry + (dir * ((totalQty * newAvgEntry * (tpPercent / 100)) / totalQty));
                finalSL = firstE * (1 - (dir * (slPercent / 100)));
                const sync = await syncTPSL(bot, symbol, side, info, finalTP, finalSL); finalTP = sync.tp; finalSL = sync.sl;
            } else { finalTP = dcaData.tp; finalSL = dcaData.sl; }

            const dcaThreshold = currentModeIsHell ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
            const nextDCA = side === 'LONG' ? firstE * (1 - ((dcaCount + 1) * (dcaThreshold / 100))) : firstE * (1 + ((dcaCount + 1) * (dcaThreshold / 100)));

            bot.botActivePositions.set(lockKey, { 
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, dcaCount: dcaCount, leverage: info.maxLeverage, 
                firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: totalMargin, 
                currentQty: totalQty, dcaHistory: dcaHistory, isDiangucMode: currentModeIsHell, pnl: 0, profitPercent: 0, avgEntry: newAvgEntry, nextDCA, livePrice: actualFilledPrice
            });
            
            if (!isDCA) {
                addBotLog(bot, `[MỞ ${side}][${currentModeIsHell ? "ĐỊA NGỤC" : "THƯỜNG"}] ${symbol} | Lev: ${info.maxLeverage}x | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(info.pricePrecision)}`, "open"); 
            } else {
                addBotLog(bot, `[DCA LẦN ${dcaCount}] ${symbol} | Giá DCA: ${actualFilledPrice.toFixed(info.pricePrecision)} | Avg mới: ${newAvgEntry.toFixed(info.pricePrecision)}`, "dca"); 
            }
        }
    } catch (e) { 
        sharedState.permanentBlacklist[symbol] = true;
        addBotLog(bot, `❌ [BAN VĨNH VIỄN] Lỗi tại ${symbol}: ${e.message}`, "error"); 
    } finally { setTimeout(() => bot.isProcessingDCA.delete(lockKey), 3000); }
}

async function syncTPSL(bot, symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) { await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }); }
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
                await panicCloseAll(bot, "CHỐNG THANH LÝ 5%"); bot.isMarginProtected = true; bot.botSettings.isRunning = false; 
                addBotLog(bot, `🛑 Bot tự động STOP để bảo vệ tài khoản an toàn.`, "error"); return; 
            }
            if (!bot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) { bot.isMarginProtected = true; addBotLog(bot, `⚠️ Khả dụng giảm dưới ${MARGIN_PROTECT_LIMIT}%. Dừng quét lệnh mới!`, "warn"); }
            else if (bot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) { bot.isMarginProtected = false; addBotLog(bot, `✅ Khả dụng phục hồi trên ${MARGIN_RECOVER_LIMIT}%. Mở lại quét.`, "info"); }
        }
    }
}

// =========================================================
// KHỞI TẠO CÁC PHÂN HỆ SERVER EXPRESS UI
// =========================================================
const appServer = express(); appServer.use(express.json());
const appBot1 = express(); appBot1.use(express.json()); appBot1.use(express.static(__dirname));
const appBot2 = express(); appBot2.use(express.json()); appBot2.use(express.static(__dirname));

async function buildStatusResponse(bot) {
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk').catch(() => []);
    const now = Date.now(); const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000); if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }
    return { 
        botSettings: bot.botSettings, activePositions: Array.from(bot.botActivePositions.values()), exchangePositions: posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0),
        status: { botLogs: bot.status.botLogs, botClosedCount: bot.status.botClosedCount, botPnLClosed: bot.status.botPnLClosed, isReady: bot.status.isReady, candidatesList: sharedState.candidatesList, blackList: formattedBlacklist, permanentBlacklist: sharedState.permanentBlacklist, exchangeInfo: sharedState.exchangeInfo }, 
        wallet: acc ? { totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) } : { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" } 
    };
}

appBot1.post('/api/settings', (req, res) => { bot1.botSettings = parseNormalizedSettings(req.body, bot1.botSettings); res.json({ success: true }); });
appBot2.post('/api/settings', (req, res) => { bot2.botSettings = parseNormalizedSettings(req.body, bot2.botSettings); res.json({ success: true }); });
appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1)));
appBot2.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot2)));

// API cung cấp dữ liệu độc quyền cho Giao diện chính 5 Tab
appServer.get('/api/main_status', async (req, res) => {
    const acc1 = await binancePrivate(bot1, '/fapi/v2/account').catch(() => null);
    const acc2 = await binancePrivate(bot2, '/fapi/v2/account').catch(() => null);
    res.json({
        bot1Settings: bot1.botSettings, bot2Settings: bot2.botSettings,
        stats: sharedState.stats, globalLogs: sharedState.globalLogs,
        activePositions1: Array.from(bot1.botActivePositions.values()),
        activePositions2: Array.from(bot2.botActivePositions.values()),
        tradeHistory: sharedState.tradeHistory,
        wallet1: acc1 ? { total: parseFloat(acc1.totalMarginBalance||0).toFixed(2), avail: parseFloat(acc1.availableBalance||0).toFixed(2), pnl: parseFloat(acc1.totalUnrealizedProfit||0).toFixed(2) } : null,
        wallet2: acc2 ? { total: parseFloat(acc2.totalMarginBalance||0).toFixed(2), avail: parseFloat(acc2.availableBalance||0).toFixed(2), pnl: parseFloat(acc2.totalUnrealizedProfit||0).toFixed(2) } : null,
    });
});

// =========================================================
// 🌐 MÃ NGUỒN GIAO DIỆN HTML DASHBOARD CHÍNH (PORT 2401)
// =========================================================
appServer.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <title>HỆ THỐNG ĐIỀU PHỐI BOT TRUNG TÂM</title>
        <script src="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.js"></script>
        <style>
            body { background-color: #0f172a; color: #e2e8f0; }
            .tab-btn.active { background-color: #2563eb; color: white; border-color: #3b82f6; }
            .log-info { color: #94a3b8; }
            .log-success { color: #4ade80; font-weight: bold; }
            .log-sl { color: #f87171; font-weight: bold; }
            .log-avg { color: #38bdf8; font-weight: bold; }
            .log-open { color: #fbbf24; }
            .log-dca { color: #c084fc; }
            .log-warn { color: #fb923c; font-weight: bold; }
            .log-error { color: #ef4444; background: #7f1d1d; padding: 2px 6px; rounded: 4px; }
        </style>
    </head>
    <body class="p-6">
        <div class="max-w-7xl mx-auto">
            <!-- Header Balance -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div class="bg-slate-800 p-4 rounded-lg border border-slate-700 shadow-lg">
                    <h2 class="text-blue-400 font-bold text-lg">💰 TÀI KHOẢN BOT 1 (NORMAL)</h2>
                    <div class="grid grid-cols-3 gap-2 mt-2 text-sm">
                        <div>Ví Tổng: <span id="w1-total" class="font-bold text-white">0</span>$</div>
                        <div>Khả Dụng: <span id="w1-avail" class="font-bold text-green-400">0</span>$</div>
                        <div>PnL Thả Nổi: <span id="w1-pnl" class="font-bold">0</span>$</div>
                    </div>
                </div>
                <div class="bg-slate-800 p-4 rounded-lg border border-slate-700 shadow-lg">
                    <h2 class="text-purple-400 font-bold text-lg">💰 TÀI KHOẢN BOT 2 (REVERSED)</h2>
                    <div class="grid grid-cols-3 gap-2 mt-2 text-sm">
                        <div>Ví Tổng: <span id="w2-total" class="font-bold text-white">0</span>$</div>
                        <div>Khả Dụng: <span id="w2-avail" class="font-bold text-green-400">0</span>$</div>
                        <div>PnL Thả Nổi: <span id="w2-pnl" class="font-bold">0</span>$</div>
                    </div>
                </div>
            </div>

            <!-- Tabs Navigation -->
            <div class="flex flex-wrap space-x-2 border-b border-slate-700 mb-6 pb-2">
                <button onclick="switchTab('tab1')" id="btn-tab1" class="tab-btn px-4 py-2 rounded text-slate-400 bg-slate-800 border border-slate-700 font-medium transition-all">📋 Tab 1: Cấu hình thông số</button>
                <button onclick="switchTab('tab2')" id="btn-tab2" class="tab-btn px-4 py-2 rounded text-slate-400 bg-slate-800 border border-slate-700 font-medium transition-all">📊 Tab 2: Hiệu suất & Tổng quan</button>
                <button onclick="switchTab('tab3')" id="btn-tab3" class="tab-btn px-4 py-2 rounded text-slate-400 bg-slate-800 border border-slate-700 font-medium transition-all">📰 Tab 3: Dòng Log trung tâm</button>
                <button onclick="switchTab('tab4')" id="btn-tab4" class="tab-btn px-4 py-2 rounded text-slate-400 bg-slate-800 border border-slate-700 font-medium transition-all">🔥 Tab 4: Vị thế đang mở</button>
                <button onclick="switchTab('tab5')" id="btn-tab5" class="tab-btn px-4 py-2 rounded text-slate-400 bg-slate-800 border border-slate-700 font-medium transition-all">⏳ Tab 5: Lịch sử giao dịch chi tiết</button>
            </div>

            <!-- TAB 1: CẤU HÌNH -->
            <div id="content-tab1" class="tab-content hidden bg-slate-800 p-6 rounded-lg border border-slate-700">
                <h3 class="text-xl font-bold text-blue-400 mb-4">THÔNG SỐ THỜI GIAN THỰC ĐANG CÀI TRÊN 2 BOT</h3>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-sm text-slate-300">
                        <thead>
                            <tr class="border-b border-slate-700 bg-slate-900 text-slate-400">
                                <th class="p-3">Thuộc Tính Cấu Hình</th>
                                <th class="p-3 text-blue-400">BOT 1 (NORMAL)</th>
                                <th class="p-3 text-purple-400">BOT 2 (REVERSED)</th>
                            </tr>
                        </thead>
                        <tbody id="settings-table-body">
                            <!-- JS Inject -->
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- TAB 2: TỔNG QUAN HIỆU SUẤT -->
            <div id="content-tab2" class="tab-content hidden bg-slate-800 p-6 rounded-lg border border-slate-700">
                <h3 class="text-xl font-bold text-green-400 mb-4">BẢNG HIỆU SUẤT HOẠT ĐỘNG TOÀN HỆ THỐNG</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                    <div class="p-4 bg-slate-900 border border-slate-700 rounded-lg text-center">
                        <div class="text-slate-400 text-xs font-bold uppercase">Vị thế đang mở</div>
                        <div id="stat-active" class="text-2xl font-bold text-amber-400 mt-1">0</div>
                    </div>
                    <div class="p-4 bg-slate-900 border border-slate-700 rounded-lg text-center">
                        <div class="text-slate-400 text-xs font-bold uppercase">Đã chốt lãi</div>
                        <div id="stat-win" class="text-2xl font-bold text-green-400 mt-1">0 lệnh</div>
                        <div id="stat-win-pnl" class="text-xs text-slate-400 mt-1">PnL: 0$</div>
                    </div>
                    <div class="p-4 bg-slate-900 border border-slate-700 rounded-lg text-center">
                        <div class="text-slate-400 text-xs font-bold uppercase">Chốt hòa mã nguồn (AVG)</div>
                        <div id="stat-avg" class="text-2xl font-bold text-sky-400 mt-1">0 lệnh</div>
                        <div id="stat-avg-pnl" class="text-xs text-slate-400 mt-1">PnL: 0$</div>
                    </div>
                    <div class="p-4 bg-slate-900 border border-slate-700 rounded-lg text-center">
                        <div class="text-slate-400 text-xs font-bold uppercase">Đã chốt lỗ</div>
                        <div id="stat-loss" class="text-2xl font-bold text-red-400 mt-1">0 lệnh</div>
                        <div id="stat-loss-pnl" class="text-xs text-slate-400 mt-1">PnL: 0$</div>
                    </div>
                </div>
                <div class="p-4 bg-slate-950 rounded-lg border border-slate-700 flex justify-between items-center">
                    <span class="text-lg font-bold text-white">💰 TỔNG LỢI NHUẬN RÒNG (Bao gồm phí sàn):</span>
                    <span id="stat-total-pnl" class="text-3xl font-extrabold text-white">0.00$</span>
                </div>
            </div>

            <!-- TAB 3: LOG HỆ THỐNG -->
            <div id="content-tab3" class="tab-content hidden bg-slate-800 p-4 rounded-lg border border-slate-700">
                <h3 class="text-xl font-bold text-amber-400 mb-2">DÒNG LOG TẬP TRUNG TOÀN HỆ THỐNG (MỚI KHÔNG LỆCH)</h3>
                <div id="log-box" class="h-96 overflow-y-auto bg-slate-950 p-4 rounded-lg font-mono text-xs leading-relaxed space-y-1">
                    <!-- Logs Inject -->
                </div>
            </div>

            <!-- TAB 4: VỊ THẾ ĐANG MỞ -->
            <div id="content-tab4" class="tab-content hidden bg-slate-800 p-6 rounded-lg border border-slate-700">
                <h3 class="text-xl font-bold text-orange-400 mb-4">DANH SÁCH CÁC VỊ THẾ THỰC TẾ TRÊN SÀN</h3>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-sm text-slate-300">
                        <thead>
                            <tr class="border-b border-slate-700 bg-slate-900 text-slate-400">
                                <th class="p-3">Hệ thống</th>
                                <th class="p-3">Mã Coin</th>
                                <th class="p-3">Hướng lệnh</th>
                                <th class="p-3">Chế độ</th>
                                <th class="p-3">Ký quỹ / Lever</th>
                                <th class="p-3">Entry Đầu / AVG</th>
                                <th class="p-3">Giá Hiện Tại</th>
                                <th class="p-3">TP / SL</th>
                                <th class="p-3">DCA Kế Tiếp</th>
                                <th class="p-3">PnL Thả Nổi</th>
                            </tr>
                        </thead>
                        <tbody id="active-positions-body">
                            <!-- JS Inject -->
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- TAB 5: LỊCH SỬ GIAO DỊCH -->
            <div id="content-tab5" class="tab-content hidden bg-slate-800 p-6 rounded-lg border border-slate-700">
                <h3 class="text-xl font-bold text-purple-400 mb-4">BẢNG LỊCH SỬ GIAO DỊCH TRUY XUẤT CHUYÊN SÂU</h3>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-xs text-slate-300">
                        <thead>
                            <tr class="border-b border-slate-700 bg-slate-900 text-slate-400">
                                <th class="p-2">STT</th>
                                <th class="p-2">Thời Gian</th>
                                <th class="p-2">Hệ Bot</th>
                                <th class="p-2">Chế Độ</th>
                                <th class="p-2">Coin</th>
                                <th class="p-2">Hướng</th>
                                <th class="p-2">Ký Quỹ Đầu</th>
                                <th class="p-2">Entry Đầu</th>
                                <th class="p-2">Chuỗi Lịch Sử DCA (Giá & Vốn)</th>
                                <th class="p-2">TP / SL Chốt</th>
                                <th class="p-2">Kết Quả</th>
                                <th class="p-2">PnL Thực Thu</th>
                            </tr>
                        </thead>
                        <tbody id="history-table-body">
                            <!-- JS Inject -->
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            let currentTab = 'tab2'; 
            function switchTab(tabId) {
                currentTab = tabId;
                document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.getElementById('content-' + tabId).classList.remove('hidden');
                document.getElementById('btn-' + tabId).classList.add('active');
            }

            async function updateDashboard() {
                try {
                    const res = await fetch('/api/main_status');
                    const data = await res.json();
                    
                    // Wallet
                    if(data.wallet1) {
                        document.getElementById('w1-total').innerText = data.wallet1.total;
                        document.getElementById('w1-avail').innerText = data.wallet1.avail;
                        const pnlEl = document.getElementById('w1-pnl'); pnlEl.innerText = data.wallet1.pnl + "$";
                        pnlEl.className = parseFloat(data.wallet1.pnl) >= 0 ? "font-bold text-green-400" : "font-bold text-red-400";
                    }
                    if(data.wallet2) {
                        document.getElementById('w2-total').innerText = data.wallet2.total;
                        document.getElementById('w2-avail').innerText = data.wallet2.avail;
                        const pnlEl = document.getElementById('w2-pnl'); pnlEl.innerText = data.wallet2.pnl + "$";
                        pnlEl.className = parseFloat(data.wallet2.pnl) >= 0 ? "font-bold text-green-400" : "font-bold text-red-400";
                    }

                    // Tab 2: Stats
                    const totalActive = data.activePositions1.length + data.activePositions2.length;
                    document.getElementById('stat-active').innerText = totalActive;
                    document.getElementById('stat-win').innerText = data.stats.winCount + " lệnh";
                    document.getElementById('stat-win-pnl').innerText = "PnL: +" + data.stats.winPnL.toFixed(2) + "$";
                    document.getElementById('stat-avg').innerText = data.stats.avgCount + " lệnh";
                    document.getElementById('stat-avg-pnl').innerText = "PnL: " + data.stats.avgPnL.toFixed(2) + "$";
                    document.getElementById('stat-loss').innerText = data.stats.lossCount + " lệnh";
                    document.getElementById('stat-loss-pnl').innerText = "PnL: " + data.stats.lossPnL.toFixed(2) + "$";
                    
                    const totalPnL = data.stats.totalPnL;
                    const totEl = document.getElementById('stat-total-pnl'); totEl.innerText = totalPnL.toFixed(2) + "$";
                    totEl.className = totalPnL >= 0 ? "text-3xl font-extrabold text-green-400" : "text-3xl font-extrabold text-red-400";

                    // Tab 1: Settings
                    const s1 = data.bot1Settings; const s2 = data.bot2Settings;
                    let setHtml = '';
                    const fields = [
                        { label: 'Trạng thái chạy bot (isRunning)', k: 'isRunning' },
                        { label: 'Số vị thế tối đa (maxPositions)', k: 'maxPositions' },
                        { label: 'Vốn vào lệnh đầu (invValue)', k: 'invValue' },
                        { label: 'Vol tối thiểu lệnh Thường (minVol)', k: 'minVol' },
                        { label: 'Take Profit Thường % (posTP)', k: 'posTP' },
                        { label: 'Stop Loss Thường % (posSL)', k: 'posSL' },
                        { label: 'Khoảng cách DCA Thường % (posdca)', k: 'posdca' },
                        { label: 'Hệ số nhân vốn DCA Thường (heSoThuong)', k: 'heSoThuong' },
                        { label: 'Vol kích hoạt ĐỊA NGỤC (diangucvol)', k: 'diangucvol' },
                        { label: 'Take Profit ĐỊA NGỤC % (dianguctp)', k: 'dianguctp' },
                        { label: 'Stop Loss ĐỊA NGỤC % (diangucsl)', k: 'diangucsl' },
                        { label: 'Khoảng cách DCA ĐỊA NGỤC % (diangucdca)', k: 'diangucdca' },
                        { label: 'Hệ số nhân vốn DCA ĐỊA NGỤC (heSoDianguc)', k: 'heSoDianguc' },
                        { label: 'Giới hạn số lần DCA tối đa (maxDCA)', k: 'maxDCA' },
                    ];
                    fields.forEach(f => {
                        setHtml += \`<tr class="border-b border-slate-700 hover:bg-slate-750">
                            <td class="p-3 font-semibold">\${f.label}</td>
                            <td class="p-3 text-blue-300">\${s1[f.k]}</td>
                            <td class="p-3 text-purple-300">\${s2[f.k]}</td>
                        </tr>\`;
                    });
                    document.getElementById('settings-table-body').innerHTML = setHtml;

                    // Tab 3: Logs
                    let logHtml = '';
                    data.globalLogs.forEach(l => {
                        logHtml += \`<div class="hover:bg-slate-900 py-0.5"><span class="text-slate-500 mr-2">[\${l.time}]</span><span class="log-\${l.type}">\${l.msg}</span></div>\`;
                    });
                    document.getElementById('log-box').innerHTML = logHtml || '<div class="text-slate-600">Chưa có bản ghi nhật ký hệ thống...</div>';

                    // Tab 4: Active Positions
                    let actHtml = '';
                    const mergePos = [
                        ...data.activePositions1.map(p => ({...p, bot: 'BOT 1'})),
                        ...data.activePositions2.map(p => ({...p, bot: 'BOT 2'}))
                    ];
                    mergePos.forEach(p => {
                        const pnlColor = p.pnl >= 0 ? 'text-green-400' : 'text-red-400';
                        actHtml += \`<tr class="border-b border-slate-700 bg-slate-900/50 hover:bg-slate-750">
                            <td class="p-3 font-bold \${p.bot==='BOT 1'?'text-blue-400':'text-purple-400'}">\${p.bot}</td>
                            <td class="p-3 font-bold text-white">\${p.symbol}</td>
                            <td class="p-3 \${p.side==='LONG'?'text-green-400':'text-red-400'} font-bold">\${p.side}</td>
                            <td class="p-3">\${p.isDiangucMode ? '<span class="px-2 py-0.5 bg-red-900/50 text-red-400 rounded border border-red-700 font-bold text-xs">ĐỊA NGỤC</span>' : '<span class="px-2 py-0.5 bg-slate-700 text-slate-300 rounded text-xs">THƯỜNG</span>'}</td>
                            <td class="p-3">\${p.currentMargin.toFixed(2)}$ / \${p.leverage}x</td>
                            <td class="p-3 text-xs">\${p.firstEntry.toFixed(4)} <br>➔ \${p.avgEntry.toFixed(4)}</td>
                            <td class="p-3 font-semibold">\${p.livePrice.toFixed(4)}</td>
                            <td class="p-3 text-xs text-slate-400">TP: <span class="text-green-400">\${p.tp.toFixed(4)}</span><br>SL: <span class="text-red-400">\${p.sl.toFixed(4)}</span></td>
                            <td class="p-3 text-xs text-amber-300 font-medium">\${p.nextDCA.toFixed(4)} <br>(Lần: \${p.dcaCount})</td>
                            <td class="p-3 \text-sm font-bold \${pnlColor}">\${p.pnl.toFixed(2)}$ <br>(\${p.profitPercent.toFixed(2)}%)</td>
                        </tr>\`;
                    });
                    document.getElementById('active-positions-body').innerHTML = actHtml || '<tr><td colspan="10" class="p-4 text-center text-slate-500">Hệ thống đang quét... Không có vị thế mở trên sàn.</td></tr>';

                    // Tab 5: Trade History
                    let histHtml = '';
                    data.tradeHistory.forEach((h, idx) => {
                        let resBadge = '';
                        if(h.exitType === 'LÃI') resBadge = '<span class="px-2 py-0.5 bg-green-900 text-green-300 rounded font-bold">LÃI</span>';
                        else if(h.exitType === 'LỖ') resBadge = '<span class="px-2 py-0.5 bg-red-900 text-red-300 rounded font-bold">LỖ</span>';
                        else resBadge = '<span class="px-2 py-0.5 bg-sky-900 text-sky-300 rounded font-bold">AVG</span>';

                        let dcaStr = h.dcaHistory.map((d, i) => \`<div>L\${i+1}: \${d.price.toFixed(4)} (\${d.margin.toFixed(1)}$)</div>\`).join('');

                        histHtml += \`<tr class="border-b border-slate-800 hover:bg-slate-750 bg-slate-900/20 text-slate-300">
                            <td class="p-2">\${data.tradeHistory.length - idx}</td>
                            <td class="p-2 text-slate-400 text-xs">\${h.time}</td>
                            <td class="p-2 font-bold \${h.botId==='BOT_1'?'text-blue-400':'text-purple-400'}">\ squad \${h.botId}</td>
                            <td class="p-2 font-medium text-xs">\${h.mode}</td>
                            <td class="p-2 font-bold text-white">\${h.symbol}</td>
                            <td class="p-2 font-bold \${h.side==='LONG'?'text-green-400':'text-red-400'}">\${h.side}</td>
                            <td class="p-2">\${h.firstMargin.toFixed(2)}$</td>
                            <td class="p-2 font-mono">\${h.firstEntry.toFixed(4)}</td>
                            <td class="p-2 text-[10px] space-y-0.5">\${dcaStr || '<span class="text-slate-600">Không DCA</span>'}</td>
                            <td class="p-2 text-[10px] text-slate-400">TP: \${h.tp.toFixed(4)}<br>SL: \${h.sl.toFixed(4)}</td>
                            <td class="p-2 text-center">\${resBadge}</td>
                            <td class="p-2 font-bold \${h.pnl>=0?'text-green-400':'text-red-400'}">\${h.pnl.toFixed(2)}$</td>
                        </tr>\`;
                    });
                    document.getElementById('history-table-body').innerHTML = histHtml || '<tr><td colspan="12" class="p-4 text-center text-slate-600">Chưa ghi nhận lịch sử chốt lệnh nào phát sinh.</td></tr>';

                } catch (e) { console.error("Lỗi đồng bộ UI: ", e); }
            }

            switchTab(currentTab);
            updateDashboard();
            setInterval(updateDashboard, 1500);
        </script>
    </body>
    </html>
    `);
});

// =========================================================
// API CON PHỤC VỤ RIÊNG CHO 2 CỬA SỔ LOG BOT 1 & BOT 2 CŨ
// =========================================================
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
        
        console.log("🚀 Hệ thống lõi kép liên kết Giao diện Dashboard 5 Tab khởi tạo thành công.");
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
// VÒNG LẶP ĐIỀU PHỐI - ĐÈ VỊ THẾ CŨ KHI ĐẠT ĐỊA NGỤC
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
            if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
            const result = checkEntryCondition(c, bot1.botSettings, { ...sharedState, botLogs: bot1.status.botLogs }, bot1.botActivePositions);
            if (result) {
                if (!result.isDianguc && exchangeSymbolsWithPositions.has(c.symbol)) { continue; }
                entrySignal = result; break;
            }
        }

        if (entrySignal) {
            const symbol = entrySignal.symbol; const info = sharedState.exchangeInfo[symbol]; if (!info) return;

            if (entrySignal.isDianguc) {
                const activeExchangePos = posRisk.filter(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
                if (activeExchangePos.length > 0) {
                    addBotLog(bot1, `🔥 [ĐÈ ĐỊA NGỤC] Biến động cực đại! Phát hiện vị thế cũ của ${symbol}. Tiến hành Market Close cưỡng bức để chạy Địa Ngục!`, "warn");
                    addBotLog(bot2, `🔥 [ĐÈ ĐỊA NGỤC] Biến động cực đại! Phát hiện vị thế cũ của ${symbol}. Tiến hành Market Close cưỡng bức để chạy Địa Ngục!`, "warn");
                    for (const p of activeExchangePos) {
                        try { await bot1.exchange.createOrder(symbol, 'MARKET', p.positionSide === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: p.positionSide }); } catch(err){}
                    }
                    try {
                        const openOrders = await binancePrivate(bot1, '/fapi/v1/openOrders', 'GET', { symbol });
                        for (const o of openOrders) { await binancePrivate(bot1, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{}); }
                    } catch(e){}
                }
                bot1.botActivePositions.delete(`${symbol}_LONG`); bot1.botActivePositions.delete(`${symbol}_SHORT`);
                bot2.botActivePositions.delete(`${symbol}_LONG`); bot2.botActivePositions.delete(`${symbol}_SHORT`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            const acc = await binancePrivate(bot1, '/fapi/v2/account').catch(() => null); if (!acc) return; 
            const snapshotAvailable = parseFloat(acc.availableBalance || 0);
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null); if (!ticker) return;
            const currentPrice = parseFloat(ticker.data.price);
            
            const marginSetting = bot1.botSettings.invValue;
            let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

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

appServer.listen(2401, () => console.log('🌐 [MAIN SERVER UI] Truy cập Dashboard 5 Tab tại địa chỉ: http://localhost:2401'));
appBot1.listen(2402, () => console.log('📈 [BOT 1 CON UI] Đang chạy tại Port 2402'));
appBot2.listen(2403, () => console.log('📉 [BOT 2 CON UI] Đang chạy tại Port 2403'));
