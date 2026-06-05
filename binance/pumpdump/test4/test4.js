import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================
// ⚙️ CẤU HÌNH KHUNG THỜI GIAN VÀ GIỚI HẠN DCA TỐI ĐA (CỐ ĐỊNH)
// =========================================================
const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],            
    DIA_NGUC: ['M1', 'M5', 'M15']    
};

const MAX_DCA_AM_LEVEL = 3;       
const MAX_DCA_DUONG_LEVEL = 10;   

const ANTI_LIQUIDATION_LIMIT = 5; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = { blackList: {}, permanentBlacklist: {}, candidatesList: [], exchangeInfo: null };

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
            } else normalizedBody[key] = val;
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

    const timeframes = { 'M1': parseFloat(candidate.c1 || 0), 'M5': parseFloat(candidate.c5 || 0), 'M15': parseFloat(candidate.c15 || 0) };

    for (const tf of SCAN_CONFIG.DIA_NGUC) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= diangucVol) return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: tf, isDianguc: true };
    }

    for (const tf of SCAN_CONFIG.THUONG) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= minVol) return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: tf, isDianguc: false };
    }
    return null;
}

// =========================================================
// 🎨 HÀM LOG PHÂN TÁCH MÀU THEO YÊU CẦU ĐỊA NGỤC / DCA
// =========================================================
function addBotLog(bot, msg, type = 'info', isHellMode = false, throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        if (now - (bot.logThrottle.get(throttleKey) || 0) < 10000) return; 
        bot.logThrottle.set(throttleKey, now);
    }

    // Fix: Mọi log liên quan tới vị thế mở địa ngục auto đổi type thành 'hell' (Màu xanh dương)
    if (isHellMode) type = 'hell';

    let colorEscape = '\x1b[37m'; // Trắng mặc định (Cho DCA)
    if (type === 'open' || type === 'success') colorEscape = '\x1b[32m'; // Xanh lá
    if (type === 'sl' || type === 'error') colorEscape = '\x1b[31m';    // Đỏ
    if (type === 'warn') colorEscape = '\x1b[33m';                       // Vàng
    if (type === 'hell') colorEscape = '\x1b[34m';                       // Xanh dương độc quyền Địa Ngục

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    bot.status.botLogs.unshift({ time, msg, type });
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    
    console.log(`${colorEscape}[${time}][${bot.id}][${type.toUpperCase()}] ${msg}\x1b[0m`);
}

let bot1 = {
    id: "BOT_1", sideMode: "NORMAL", 
    botSettings: { 
        isRunning: false, dcaTypeThuong: 'DUONG', dcaTypeDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_DUONG_LEVEL,
        heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
    botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 59000, adjustForTimeDifference: false } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

let bot2 = {
    id: "BOT_2", sideMode: "REVERSED", 
    botSettings: { 
        isRunning: false, dcaTypeThuong: 'DUONG', dcaTypeDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_DUONG_LEVEL,
        heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
    botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 59000, adjustForTimeDifference: false } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

bot1.exchange.milliseconds = () => Date.now() + bot1.timestampOffset;
bot2.exchange.milliseconds = () => Date.now() + bot2.timestampOffset;

async function syncSystemTime(bot) {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time', { timeout: 5000 });
        bot.timestampOffset = res.data.serverTime - Date.now() - 500;
    } catch (err) { console.log(`⚠️ Lỗi lấy thời gian: ${err.message}`); }
}

async function binancePrivate(bot, endpoint, method = 'GET', data = {}, retries = 3) {
    try {
        const timestamp = Date.now() + bot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 59000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await bot.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        const errorCode = e.response?.data?.code;
        if ((errorCode === -1021 || errorCode === -1022) && retries > 0) {
            await syncSystemTime(bot); await new Promise(resolve => setTimeout(resolve, 500));
            return binancePrivate(bot, endpoint, method, data, retries - 1);
        }
        throw e;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const symbol in sharedState.blackList) { if (now > sharedState.blackList[symbol]) delete sharedState.blackList[symbol]; }
}, 1000);

function checkAndAddBlacklist(symbol) {
    if (!bot1.botActivePositions.has(`${symbol}_LONG`) && !bot1.botActivePositions.has(`${symbol}_SHORT`) && 
        !bot2.botActivePositions.has(`${symbol}_LONG`) && !bot2.botActivePositions.has(`${symbol}_SHORT`)) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
    }
}

function triggerDcaAm(bot, b) {
    const jump = b.dcaCount + 1;
    const coef = b.isDiangucMode ? parseFloat(bot.botSettings.heSoDianguc || 3) : parseFloat(bot.botSettings.heSoThuong || 2);
    const nextMargin = (jump * 2) * coef * b.firstMargin;
    
    addBotLog(bot, `🔄 [DCA ÂM LẦN ${jump}] ${b.symbol} cán SL. Tiếp tục mở vị thế dca với Margin: ${nextMargin.toFixed(2)}$`, "dca", b.isDiangucMode);
    openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: nextMargin, isDcaAm: true }, b.side);
}

async function closePositionAndLog(bot, b, markP, reasonStr) {
    try {
        await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
        const matchingTrades = trades.filter(t => t.positionSide === b.side && ((Date.now() + bot.timestampOffset) - t.time) < 20000);
        let finalPnL = matchingTrades.length > 0 ? matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0) : ((b.side === 'LONG' ? (markP - b.avgEntry) : (b.avgEntry - markP)) * b.currentQty) - (b.currentQty * markP * 0.001);

        bot.status.botClosedCount++; bot.status.botPnLClosed += finalPnL;
        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | PnL Tổng: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? "success" : "sl", b.isDiangucMode);
        
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
        for (const o of openOrders.filter(o => o.positionSide === b.side)) { await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{}); }
    } catch (e) { addBotLog(bot, `❌ Lỗi đóng ${b.symbol}: ${e.message}`, "error", b.isDiangucMode); }
}

async function panicCloseAll(bot, reasonLog) {
    try {
        const active = (await binancePrivate(bot, '/fapi/v2/positionRisk')).filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        let count = 0;
        for (const p of active) {
            try { await bot.exchange.createOrder(p.symbol, 'MARKET', p.positionSide === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: p.positionSide }); count++; } catch (err) { }
        }
        bot.botActivePositions.clear(); addBotLog(bot, `⚠️ Đã đóng toàn bộ ${count} vị thế (${reasonLog})`, "warn");
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
            const currentDcaType = b.isDiangucMode ? bot.botSettings.dcaTypeDianguc : bot.botSettings.dcaTypeThuong;

            if (realP) {
                const markP = parseFloat(realP.markPrice);
                b.currentQty = Math.abs(parseFloat(realP.positionAmt)); b.livePrice = markP;
                b.pnl = parseFloat(realP.unRealizedProfit); b.avgEntry = parseFloat(realP.entryPrice);

                const hitTP = b.side === 'LONG' ? (markP >= b.tp) : (markP <= b.tp);
                const hitSL = b.side === 'LONG' ? (markP <= b.sl) : (markP >= b.sl);

                if (hitTP || hitSL) {
                    if (!b.tpSlHitTime) {
                        b.tpSlHitTime = Date.now(); b.hitReason = hitTP ? "TP NỘI BỘ" : "SL NỘI BỘ";
                    } else if (Date.now() - b.tpSlHitTime >= 5000) {
                        bot.botActivePositions.delete(key);
                        await closePositionAndLog(bot, b, markP, `HỘ VỆ 5S - ${b.hitReason}`);
                        
                        const isSL = b.hitReason.includes('SL');
                        if (isSL && currentDcaType === 'AM' && b.dcaCount < MAX_DCA_AM_LEVEL) triggerDcaAm(bot, b);
                        else checkAndAddBlacklist(b.symbol); 
                        continue;
                    }
                } else { b.tpSlHitTime = null; b.hitReason = null; }

                if (currentDcaType === 'DUONG') {
                    const dcaThreshold = b.isDiangucMode ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
                    b.nextDCA = b.side === 'LONG' ? b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100))) : b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100)));

                    let shouldCloseMarket = false;
                    if (b.dcaCount > 0) {
                        const offset = b.firstEntry * ((b.dcaCount + 1) / 100); 
                        if (b.side === 'LONG') {
                            if (markP <= (b.avgEntry + offset)) shouldCloseMarket = true;
                        } else {
                            if (markP >= (b.avgEntry - offset)) shouldCloseMarket = true;
                        }
                    }

                    if (shouldCloseMarket) {
                        bot.botActivePositions.delete(key);
                        await closePositionAndLog(bot, b, markP, "CHỐT TRAILING AVG (DCA DƯƠNG)");
                        checkAndAddBlacklist(b.symbol); 
                        continue;
                    }

                    const jump = b.dcaCount + 1;
                    const hitNextDCA = (b.side === 'LONG' && markP >= b.nextDCA) || (b.side === 'SHORT' && markP <= b.nextDCA);

                    if (hitNextDCA && jump <= bot.botSettings.maxDCA) {
                        const coef = b.isDiangucMode ? parseFloat(bot.botSettings.heSoDianguc || 3) : parseFloat(bot.botSettings.heSoThuong || 2);
                        openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * coef, isDcaAm: false }, b.side);
                    }
                }
            } else {
                if (bot.isProcessingDCA.has(lockKey)) continue;
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
                const matchingTrades = trades.filter(t => t.positionSide === b.side && ((Date.now() + bot.timestampOffset) - t.time) < 25000);
                const finalPnLFromSàn = matchingTrades.length > 0 ? matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0) : (b.pnl || 0);
                
                bot.status.botClosedCount++; bot.status.botPnLClosed += finalPnLFromSàn;
                bot.botActivePositions.delete(key);

                if (finalPnLFromSàn < 0 && currentDcaType === 'AM' && b.dcaCount < MAX_DCA_AM_LEVEL) {
                    addBotLog(bot, `🔒 [ĐÓNG SÀN - SL] ${b.symbol} ${b.side} | PnL: ${finalPnLFromSàn.toFixed(2)}$`, "sl", b.isDiangucMode);
                    triggerDcaAm(bot, b);
                } else {
                    addBotLog(bot, `🔒 [ĐÓNG SÀN - TP/SL] ${b.symbol} ${b.side} | PnL: ${finalPnLFromSàn.toFixed(2)}$`, finalPnLFromSàn >= 0 ? "success" : "sl", b.isDiangucMode);
                    checkAndAddBlacklist(b.symbol); 
                }
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 1000);
}

async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isDiangucSignal = false, retries = 3) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const lockKey = `${symbol}_${side}`;
    const isDcaDuong = dcaData !== null && !dcaData.isDcaAm;
    const isDcaAm = dcaData !== null && dcaData.isDcaAm;
    
    if (!isDcaDuong && !isDcaAm && bot.isProcessingDCA.has(lockKey)) return;
    bot.isProcessingDCA.add(lockKey); 
    
    try {
        const info = sharedState.exchangeInfo[symbol];
        let qty = 0, margin = 0, currentPrice = 0;

        if (dcaData) {
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            currentPrice = parseFloat(ticker.data.price); margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            qty = sharedQty; margin = sharedMargin; currentPrice = sharedPrice;
        }

        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', parseFloat(qty.toFixed(info.quantityPrecision)), undefined, { positionSide: side });
        
        if (order) {
            const actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            let newAvgEntry = actualFilledPrice, totalQty = qty, actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage, totalMargin = actualMarginUsed, dcaHistory = [];

            if (isDcaDuong) {
                totalQty = dcaData.currentQty + qty;
                newAvgEntry = ((dcaData.currentQty * dcaData.avgEntry) + (qty * actualFilledPrice)) / totalQty;
                totalMargin = dcaData.currentMargin + actualMarginUsed;
                dcaHistory = [...(dcaData.dcaHistory || []), { price: actualFilledPrice, margin: actualMarginUsed, type: 'DUONG' }];
            } else {
                if (isDcaAm) dcaHistory = [...(dcaData.dcaHistory || []), { price: actualFilledPrice, margin: actualMarginUsed, type: 'AM' }];
                else dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed }];
            }

            const currentModeIsHell = (isDcaDuong || isDcaAm) ? dcaData.isDiangucMode : isDiangucSignal;
            let finalTP, finalSL;

            if (!isDcaDuong) { 
                const dir = (side === 'LONG' ? 1 : -1);
                const tpPercent = currentModeIsHell ? parseFloat(bot.botSettings.dianguctp) : parseFloat(bot.botSettings.posTP);
                const slPercent = currentModeIsHell ? parseFloat(bot.botSettings.diangucsl) : parseFloat(bot.botSettings.posSL);

                finalTP = newAvgEntry + (dir * ((totalQty * newAvgEntry * (tpPercent / 100)) / totalQty));
                finalSL = newAvgEntry * (1 - (dir * (slPercent / 100)));
                try {
                    const sync = await syncTPSL(bot, symbol, side, info, finalTP, finalSL);
                    finalTP = sync.tp || finalTP; finalSL = sync.sl || finalSL;
                } catch (e) {}
            } else {
                finalTP = dcaData.tp; finalSL = dcaData.sl;
            }

            bot.botActivePositions.set(lockKey, { 
                symbol, side, entryPrice: (isDcaDuong || isDcaAm) ? dcaData.firstEntry : newAvgEntry, tp: finalTP, sl: finalSL, 
                dcaCount: (isDcaDuong || isDcaAm) ? dcaData.dcaCount : 0, leverage: info.maxLeverage, 
                firstEntry: (isDcaDuong || isDcaAm) ? dcaData.firstEntry : newAvgEntry, 
                firstMargin: (isDcaDuong || isDcaAm) ? dcaData.firstMargin : actualMarginUsed, 
                currentMargin: totalMargin, currentQty: totalQty, dcaHistory: dcaHistory, isDiangucMode: currentModeIsHell, 
                pnl: 0, profitPercent: 0, avgEntry: newAvgEntry, livePrice: actualFilledPrice, tpSlHitTime: null, hitReason: null
            });
            
            if (!isDcaDuong && !isDcaAm) {
                addBotLog(bot, `[MỞ ${side}] ${symbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(info.pricePrecision)}`, "open", currentModeIsHell); 
            } else {
                const logLabel = isDcaAm ? `DCA ÂM LẦN ${dcaData.dcaCount}` : `DCA DƯƠNG LẦN ${dcaData.dcaCount}`;
                addBotLog(bot, `[${logLabel}] ${symbol} | Thêm Margin: ${actualMarginUsed.toFixed(2)}$ | Giá: ${actualFilledPrice.toFixed(info.pricePrecision)}`, "dca", currentModeIsHell); 
            }
        }
    } catch (e) { 
        if ((e.response?.data?.code === -1021 || e.message.includes('-1021')) && retries > 0) {
            await syncSystemTime(bot); bot.isProcessingDCA.delete(lockKey);
            await new Promise(resolve => setTimeout(resolve, 800));
            return openPosition(bot, symbol, dcaData, forcedSide, sharedQty, sharedMargin, sharedPrice, isDiangucSignal, retries - 1);
        } else {
            sharedState.blackList[symbol] = Date.now() + (5 * 60 * 1000);
            addBotLog(bot, `❌ Lỗi vào lệnh ${symbol}: ${e.message}`, "error", dcaData ? dcaData.isDiangucMode : isDiangucSignal); 
        }
    } finally { setTimeout(() => bot.isProcessingDCA.delete(lockKey), 3000); }
}

async function syncTPSL(bot, symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        await bot.exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: parseFloat(tpPrice.toFixed(info.pricePrecision)), closePosition: true, workingType: 'CONTRACT_PRICE' });
        await bot.exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: parseFloat(slPrice.toFixed(info.pricePrecision)), closePosition: true, workingType: 'CONTRACT_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: tpPrice, sl: slPrice }; }
}

async function checkMarginLimits(bot) {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return;
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0), availUsdt = parseFloat(acc.availableBalance || 0);
        if (totalWallet > 0) {
            const availPercent = (availUsdt / totalWallet) * 100;
            if (availPercent <= ANTI_LIQUIDATION_LIMIT) {
                addBotLog(bot, `🚨 Khả dụng ${availPercent.toFixed(2)}%. ĐÓNG CHỐNG THANH LÝ!`, "error");
                await panicCloseAll(bot, "CHỐNG THANH LÝ 5%");
                bot.isMarginProtected = true; bot.botSettings.isRunning = false; return; 
            }
            if (!bot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) bot.isMarginProtected = true;
            else if (bot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) bot.isMarginProtected = false;
        }
    }
}

// =========================================================
// 🌐 KHÔI PHỤC HOÀN TOÀN KHỐI API CHO PORT 2402 VÀ PORT 2403
// =========================================================
const appBot1 = express(); appBot1.use(express.json());
const appBot2 = express(); appBot2.use(express.json());

// Routes cho Bot 1 (Cổng 2402)
appBot1.get('/api/status', (req, res) => res.json({ id: bot1.id, sideMode: bot1.sideMode, settings: bot1.botSettings, status: bot1.status, activePositions: Array.from(bot1.botActivePositions.values()) }));
appBot1.post('/api/settings', (req, res) => { bot1.botSettings = parseNormalizedSettings(req.body, bot1.botSettings); res.json({ success: true, settings: bot1.botSettings }); });
appBot1.post('/api/control', async (req, res) => {
    if (req.body.action === 'start') bot1.botSettings.isRunning = true;
    if (req.body.action === 'stop') bot1.botSettings.isRunning = false;
    if (req.body.action === 'panic') await panicCloseAll(bot1, 'PANIC TỪ UI');
    res.json({ success: true });
});

// Routes cho Bot 2 (Cổng 2403)
appBot2.get('/api/status', (req, res) => res.json({ id: bot2.id, sideMode: bot2.sideMode, settings: bot2.botSettings, status: bot2.status, activePositions: Array.from(bot2.botActivePositions.values()) }));
appBot2.post('/api/settings', (req, res) => { bot2.botSettings = parseNormalizedSettings(req.body, bot2.botSettings); res.json({ success: true, settings: bot2.botSettings }); });
appBot2.post('/api/control', async (req, res) => {
    if (req.body.action === 'start') bot2.botSettings.isRunning = true;
    if (req.body.action === 'stop') bot2.botSettings.isRunning = false;
    if (req.body.action === 'panic') await panicCloseAll(bot2, 'PANIC TỪ UI');
    res.json({ success: true });
});

async function init() {
    try {
        await syncSystemTime(bot1); await syncSystemTime(bot2);
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
        sharedState.exchangeInfo = temp; bot1.status.isReady = true; bot2.status.isReady = true;
        priceMonitor(bot1); priceMonitor(bot2); 
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
    if (!bot1.status.isReady || !bot2.status.isReady || !bot1.botSettings.isRunning || !bot2.botSettings.isRunning) return;

    if (bot1.botActivePositions.size < bot1.botSettings.maxPositions && bot2.botActivePositions.size < bot2.botSettings.maxPositions && bot1.isProcessingDCA.size === 0 && bot2.isProcessingDCA.size === 0) {
        const posRisk = await binancePrivate(bot1, '/fapi/v2/positionRisk').catch(() => []);
        const exchangeSymbolsWithPositions = new Set(posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => p.symbol));

        let entrySignal = null;
        for (const c of sharedState.candidatesList) {
            if (exchangeSymbolsWithPositions.has(c.symbol) || sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
            const result = checkEntryCondition(c, bot1.botSettings, { ...sharedState, botLogs: bot1.status.botLogs }, bot1.botActivePositions);
            if (result) { 
                if ((bot1.isMarginProtected || bot2.isMarginProtected) && !result.isDianguc) continue;
                entrySignal = result; break; 
            }
        }

        if (entrySignal) {
            const info = sharedState.exchangeInfo[entrySignal.symbol];
            if (!info) return;

            const acc = await binancePrivate(bot1, '/fapi/v2/account').catch(() => null);
            if (!acc) return; const snapshotAvailable = parseFloat(acc.availableBalance || 0);

            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${entrySignal.symbol}`).catch(() => null);
            if (!ticker) return; const currentPrice = parseFloat(ticker.data.price);
            
            const marginSetting = bot1.botSettings.invValue;
            let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

            const desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
            const finalQty = Math.ceil(Math.max(desiredQty, 5.05 / currentPrice) / info.stepSize) * info.stepSize;
            const finalMargin = (finalQty * currentPrice) / info.maxLeverage;

            openPosition(bot1, entrySignal.symbol, null, bot1.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
            openPosition(bot2, entrySignal.symbol, null, bot2.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
        }
    }
}, 3000); 

appBot1.listen(2402, () => console.log('🚀 BOT 1 API đang lắng nghe tại Port 2402'));
appBot2.listen(2403, () => console.log('🚀 BOT 2 API đang lắng nghe tại Port 2403'));
