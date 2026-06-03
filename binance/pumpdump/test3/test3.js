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
// KHỞI TẠO EXPRESS SERVER VÀ CẤU HÌNH CORS NATIVE
// =========================================================
const appServer = express(); appServer.use(express.json());
const appBot1 = express(); appBot1.use(express.json());
const appBot2 = express(); appBot2.use(express.json());

// Thêm CORS để Port 2401 kéo được dữ liệu API từ 2402 và 2403 công khai
const allowCors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST');
    next();
};
appBot1.use(allowCors);
appBot2.use(allowCors);

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

// ROUTE API CORES
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

appServer.get('/api/health', (req, res) => {
    res.json({ status: "running", bot1_positions: bot1.botActivePositions.size, bot2_positions: bot2.botActivePositions.size, blacklist_count: Object.keys(sharedState.blackList).length });
});

// =========================================================
// 🎛️ CORES ROUTE HTML WEB INTERFACE (GIAO DIỆN TÍCH HỢP SẴN)
// =========================================================
const uiTemplate = (title, mode) => `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
    <style>
        body { background-color: #0f172a; color: #e2e8f0; font-family: sans-serif; }
        .tab-btn.active { background-color: #3b82f6; color: white; border-bottom: 2px solid #2563eb; }
        .log-box::-webkit-scrollbar { width: 6px; }
        .log-box::-webkit-scrollbar-thumb { background-color: #475569; border-radius: 3px; }
    </style>
</head>
<body class="p-4 md:p-6">
    <div class="max-w-7xl mx-auto">
        <header class="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-slate-700 pb-4 mb-6 gap-4">
            <div>
                <h1 class="text-2xl md:text-3xl font-extrabold text-blue-400 flex items-center gap-2">🤖 ${title}</h1>
                <p class="text-xs md:text-sm text-slate-400 mt-1">Hệ thống quản trị và giám sát giao dịch tự động tích hợp</p>
            </div>
            <div class="flex flex-wrap gap-2 w-full md:w-auto">
                <button onclick="triggerAction('close_all')" class="flex-1 md:flex-none bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded text-sm transition">🚨 ĐÓNG TOÀN BỘ SÀN</button>
            </div>
        </header>

        <!-- 5 TAB HEADER -->
        <div class="flex border-b border-slate-700 mb-6 overflow-x-auto whitespace-nowrap scrollbar-none">
            <button onclick="switchTab('tab-overview')" id="btn-tab-overview" class="tab-btn px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white transition active">📊 Tổng Quan Ví & Trạng Thái</button>
            <button onclick="switchTab('tab-settings')" id="btn-tab-settings" class="tab-btn px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white transition">⚙️ Tham Số Cấu Hình</button>
            <button onclick="switchTab('tab-positions')" id="btn-tab-positions" class="tab-btn px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white transition">📈 Vị Thế Đang Chạy</button>
            <button onclick="switchTab('tab-blacklist')" id="btn-tab-blacklist" class="tab-btn px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white transition">🚫 Danh Sách Đen</button>
            <button onclick="switchTab('tab-logs')" id="btn-tab-logs" class="tab-btn px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white transition">📋 Nhật Ký Log Hệ Thống</button>
        </div>

        <!-- TAB CONTENT 1: OVERVIEW -->
        <div id="tab-overview" class="tab-content grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div class="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
                <h3 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">💰 Số Dư Tài Khoản</h3>
                <div class="text-2xl md:text-3xl font-bold text-emerald-400" id="lbl-wallet">0.00 $</div>
                <div class="text-xs text-slate-400 mt-2">Khả dụng: <span class="font-bold text-white" id="lbl-avail">0.00 $</span></div>
            </div>
            <div class="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
                <h3 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">📊 PnL Trạng Thái / Chốt Lời</h3>
                <div class="text-2xl md:text-3xl font-bold" id="lbl-unpnl">0.00 $</div>
                <div class="text-xs text-slate-400 mt-2">Đã chốt phiên: <span class="font-bold text-blue-400" id="lbl-closed-pnl">0.00 $</span> (<span id="lbl-closed-count">0</span> lệnh)</div>
            </div>
            <div class="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
                <h3 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">⚡ Trạng Thái Hoạt Động</h3>
                <div class="flex items-center gap-3 mt-1">
                    <span id="badge-running" class="px-3 py-1 text-xs font-bold rounded-full bg-red-900 text-red-300 border border-red-700">ĐANG DỪNG</span>
                    <button onclick="toggleBot()" id="btn-toggle" class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-1.5 px-3 rounded transition">BẬT BOT</button>
                </div>
                <div class="text-xs text-slate-400 mt-2">Số vị thế hiện tại: <span id="lbl-pos-count" class="text-white font-bold">0</span></div>
            </div>
        </div>

        <!-- TAB CONTENT 2: SETTINGS -->
        <div id="tab-settings" class="tab-content hidden bg-slate-800 p-4 md:p-6 rounded-xl border border-slate-700 shadow-lg mb-6">
            <h2 class="text-lg font-bold text-blue-400 mb-4 flex items-center gap-2">🛠️ Cấu hình Tham số hoạt động Realtime</h2>
            <form id="frm-settings" onsubmit="saveSettings(event)" class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Số vị thế Max</label>
                    <input type="number" name="maxPositions" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Vốn vào lệnh (Margin hoặc %Ví)</label>
                    <input type="text" name="invValue" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Vol biến động chuẩn (%)</label>
                    <input type="number" step="0.1" name="minVol" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Chốt lời Thường (%)</label>
                    <input type="number" step="0.1" name="posTP" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Cắt lỗ Thường (%)</label>
                    <input type="number" step="0.1" name="posSL" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Khoảng cách DCA Thường (%)</label>
                    <input type="number" step="0.1" name="posdca" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div class="border-t border-slate-700 pt-4 md:col-span-3">
                    <h4 class="text-sm font-bold text-red-400 mb-2">⚡ Tham Số Chế Độ Địa Ngục (Hell Signal)</h4>
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Vol Địa Ngục Kích Hoạt (%)</label>
                    <input type="number" step="0.1" name="diangucvol" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Chốt lời Địa Ngục (%)</label>
                    <input type="number" step="0.1" name="dianguctp" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Cắt lỗ Địa Ngục (%)</label>
                    <input type="number" step="0.1" name="diangucsl" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Khoảng cách DCA Địa Ngục (%)</label>
                    <input type="number" step="0.1" name="diangucdca" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div class="md:col-span-3 text-right">
                    <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded text-sm transition">💾 LƯU CẤU HÌNH NGAY</button>
                </div>
            </form>
        </div>

        <!-- TAB CONTENT 3: POSITIONS -->
        <div id="tab-positions" class="tab-content hidden bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden mb-6">
            <div class="overflow-x-auto">
                <table class="w-full text-left text-sm whitespace-nowrap">
                    <thead class="bg-slate-900 text-slate-400 text-xs font-bold uppercase tracking-wider">
                        <tr>
                            <th class="p-3">Cặp Coin</th>
                            <th class="p-3">Vị thế</th>
                            <th class="p-3">Chế độ</th>
                            <th class="p-3">Số Lần DCA</th>
                            <th class="p-3">Entry Đầu / Hiện tại</th>
                            <th class="p-3">Giá Hiện Tại</th>
                            <th class="p-3">Tổng Qty / Margin</th>
                            <th class="p-3">PnL (%)</th>
                            <th class="p-3 text-center">Thao Tác</th>
                        </tr>
                    </thead>
                    <tbody id="tbl-positions-body" class="divide-y divide-slate-700">
                        <!-- Render động bằng JS -->
                    </tbody>
                </table>
            </div>
        </div>

        <!-- TAB CONTENT 4: BLACKLIST -->
        <div id="tab-blacklist" class="tab-content hidden grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div class="bg-slate-800 p-4 rounded-xl border border-slate-700">
                <h3 class="font-bold text-sm uppercase tracking-wider text-amber-400 mb-3">🚫 Blacklist Tạm Thời (Gỡ sau 15p)</h3>
                <div class="grid grid-cols-3 gap-2" id="list-temp-blacklist"></div>
            </div>
            <div class="bg-slate-800 p-4 rounded-xl border border-slate-700">
                <h3 class="font-bold text-sm uppercase tracking-wider text-red-400 mb-3">🛑 Ban Vĩnh Viễn (Lỗi API/Đòn bẩy thấp)</h3>
                <div class="grid grid-cols-3 gap-2" id="list-perm-blacklist"></div>
            </div>
        </div>

        <!-- TAB CONTENT 5: LOGS -->
        <div id="tab-logs" class="tab-content hidden bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg mb-6">
            <div class="flex justify-between items-center mb-3">
                <h3 class="font-bold text-sm uppercase tracking-wider text-blue-400">📋 Nhật ký hoạt động Realtime</h3>
                <span class="text-xs text-slate-400">Hiển thị tối đa 200 dòng gần nhất</span>
            </div>
            <div id="log-box" class="log-box h-96 overflow-y-auto bg-slate-900 rounded p-3 font-mono text-xs md:text-sm leading-relaxed space-y-1">
                <!-- Log render động -->
            </div>
        </div>
    </div>

    <script>
        const MODE = "${mode}";
        const API_BASE = MODE === "MAIN" ? "http://localhost:2402" : ""; 
        let currentIsRunning = false;

        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
            document.getElementById(tabId).classList.remove('hidden');
            document.getElementById('btn-' + tabId).classList.add('active');
        }

        async function updateStatus() {
            try {
                // Nếu ở Main 2401 thì kéo dữ liệu từ Bot 1 làm đại diện, hoặc có thể tùy biến mở rộng kéo cả 2
                const targetUrl = MODE === "MAIN" ? "http://localhost:2402/api/status" : "/api/status";
                const res = await fetch(targetUrl);
                const data = await res.json();

                // Cập nhật ví
                document.getElementById('lbl-wallet').innerText = parseFloat(data.wallet.totalWalletBalance).toFixed(2) + " $";
                document.getElementById('lbl-avail').innerText = parseFloat(data.wallet.availableBalance).toFixed(2) + " $";
                
                const unPnl = parseFloat(data.wallet.totalUnrealizedProfit);
                const lblUnpnl = document.getElementById('lbl-unpnl');
                lblUnpnl.innerText = unPnl.toFixed(2) + " $";
                lblUnpnl.className = unPnl >= 0 ? "text-2xl md:text-3xl font-bold text-emerald-400" : "text-2xl md:text-3xl font-bold text-red-400";

                document.getElementById('lbl-closed-pnl').innerText = parseFloat(data.status.botPnLClosed).toFixed(2) + " $";
                document.getElementById('lbl-closed-count').innerText = data.status.botClosedCount;
                document.getElementById('lbl-pos-count').innerText = data.activePositions.length;

                // Cập nhật trạng thái Bot
                currentIsRunning = data.botSettings.isRunning;
                const badge = document.getElementById('badge-running');
                const btnToggle = document.getElementById('btn-toggle');
                if(currentIsRunning) {
                    badge.innerText = "ĐANG CHẠY QUÉT";
                    badge.className = "px-3 py-1 text-xs font-bold rounded-full bg-emerald-900 text-emerald-300 border border-emerald-700";
                    btnToggle.innerText = "DỪNG BOT";
                    btnToggle.className = "bg-red-600 hover:bg-red-700 text-white font-bold text-xs py-1.5 px-3 rounded transition";
                } else {
                    badge.innerText = "ĐANG DỪNG TRẠNG THÁI";
                    badge.className = "px-3 py-1 text-xs font-bold rounded-full bg-red-900 text-red-300 border border-red-700";
                    btnToggle.innerText = "BẬT BOT RUNNING";
                    btnToggle.className = "bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-1.5 px-3 rounded transition";
                }

                // Điền thông tin form settings nếu form đang trống chưa chạm vào
                const frm = document.getElementById('frm-settings');
                if (!frm.dataset.loaded) {
                    for (let key in data.botSettings) {
                        if (frm.elements[key]) frm.elements[key].value = data.botSettings[key];
                    }
                    frm.dataset.loaded = true;
                }

                // Cập nhật bảng Vị thế đang chạy
                const tbody = document.getElementById('tbl-positions-body');
                tbody.innerHTML = '';
                if(data.activePositions.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="9" class="p-4 text-center text-slate-500">Không có vị thế giao dịch nào đang mở rộng</td></tr>';
                } else {
                    data.activePositions.forEach(p => {
                        const tr = document.createElement('tr');
                        const pnlColor = p.pnl >= 0 ? "text-emerald-400" : "text-red-400";
                        const sideColor = p.side === "LONG" ? "bg-emerald-950 text-emerald-400 border border-emerald-800" : "bg-red-950 text-red-400 border border-red-800";
                        
                        tr.innerHTML = \`
                            <td class="p-3 font-bold text-white">\${p.symbol}</td>
                            <td class="p-3"><span class="px-2 py-0.5 text-xs font-bold rounded \${sideColor}">\${p.side}</span></td>
                            <td class="p-3 text-xs">\${p.isDiangucMode ? '🔥 ĐỊA NGỤC' : '⚙️ THƯỜNG'}</td>
                            <td class="p-3 font-semibold text-amber-400">\${p.dcaCount} Lần</td>
                            <td class="p-3 text-xs text-slate-400">Entry: \${p.firstEntry.toFixed(4)}<br>Avg: <span class="text-white font-semibold">\${p.avgEntry.toFixed(4)}</span></td>
                            <td class="p-3 font-mono font-semibold">\${p.livePrice.toFixed(4)}</td>
                            <td class="p-3 text-xs text-slate-400">Qty: \${p.currentQty}<br>Margin: <span class="text-white font-semibold">\${p.currentMargin.toFixed(2)}$</span></td>
                            <td class="p-3 font-bold \${pnlColor}">\${p.pnl.toFixed(2)}$ (\${p.profitPercent.toFixed(2)}%)</td>
                            <td class="p-3 text-center">
                                <button onclick="closeSinglePosition('\${p.symbol}', '\${p.side}')" class="bg-red-900 hover:bg-red-800 text-red-200 border border-red-700 text-xs py-1 px-2 rounded transition">ĐÓNG</button>
                            </td>
                        \`;
                        tbody.appendChild(tr);
                    });
                }

                // Cập nhật danh sách đen Blacklist
                const tempBox = document.getElementById('list-temp-blacklist');
                tempBox.innerHTML = '';
                Object.keys(data.status.blackList).forEach(sym => {
                    tempBox.innerHTML += \`<span class="bg-amber-950 text-amber-300 border border-amber-800 text-xs font-mono px-2 py-1 rounded text-center">\${sym} (\${data.status.blackList[sym]}s)</span>\`;
                });
                if(Object.keys(data.status.blackList).length === 0) tempBox.innerHTML = '<span class="text-xs text-slate-500">Trống</span>';

                const permBox = document.getElementById('list-perm-blacklist');
                permBox.innerHTML = '';
                Object.keys(data.status.permanentBlacklist).forEach(sym => {
                    permBox.innerHTML += \`<span class="bg-red-950 text-red-300 border border-red-900 text-xs font-mono px-2 py-1 rounded text-center">\${sym}</span>\`;
                });
                if(Object.keys(data.status.permanentBlacklist).length === 0) permBox.innerHTML = '<span class="text-xs text-slate-500">Trống</span>';

                // Cập nhật Box Logs
                const logBox = document.getElementById('log-box');
                logBox.innerHTML = '';
                data.status.botLogs.forEach(l => {
                    let color = "text-slate-300";
                    if(l.type === "open") color = "text-emerald-400 font-semibold";
                    if(l.type === "dca") color = "text-amber-400 font-semibold";
                    if(l.type === "success") color = "text-blue-400 font-bold";
                    if(l.type === "error" || l.type === "sl") color = "text-red-400 font-bold";
                    if(l.type === "warn") color = "text-yellow-500";
                    
                    logBox.innerHTML += \`<div class="\${color}">[\${l.time}] \${l.msg}</div>\`;
                });

            } catch(e) {}
        }

        async function triggerAction(endpoint) {
            if(!confirm("Xác nhận thực hiện hành động này?")) return;
            const baseUrl = MODE === "MAIN" ? "http://localhost:2402" : "";
            await fetch(baseUrl + "/api/" + endpoint, { method: "POST" });
            updateStatus();
        }

        async function toggleBot() {
            const baseUrl = MODE === "MAIN" ? "http://localhost:2402" : "";
            await fetch(baseUrl + "/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isRunning: !currentIsRunning })
            });
            updateStatus();
        }

        async function closeSinglePosition(symbol, side) {
            if(!confirm(\`Chốt vị thế \${symbol} \${side}?\`)) return;
            const baseUrl = MODE === "MAIN" ? "http://localhost:2402" : "";
            await fetch(baseUrl + "/api/close_position", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ symbol, side })
            });
            updateStatus();
        }

        async function saveSettings(e) {
            e.preventDefault();
            const formData = new FormData(e.target);
            const obj = {};
            formData.forEach((val, key) => { obj[key] = val; });
            
            const baseUrl = MODE === "MAIN" ? "http://localhost:2402" : "";
            const res = await fetch(baseUrl + "/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(obj)
            });
            const data = await res.json();
            if(data.success) alert("Đã cập nhật tham số cấu hình hệ thống!");
            updateStatus();
        }

        setInterval(updateStatus, 2000);
        window.onload = updateStatus;
    </script>
</body>
</html>
`;

// Giao diện cho 3 cổng Port
appServer.get('/', (req, res) => res.send(uiTemplate("TRUNG TÂM QUẢN TRỊ - MAIN 5 TAB SERVER", "MAIN")));
appBot1.get('/', (req, res) => res.send(uiTemplate("BẢNG THEO DÕI ĐIỀU KHIỂN - BOT 1 UI", "BOT")));
appBot2.get('/', (req, res) => res.send(uiTemplate("BẢNG THEO DÕI ĐIỀU KHIỂN - BOT 2 UI", "BOT")));

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

appServer.listen(2401, () => console.log('🌐 [MAIN SERVER UI] Truy cập Dashboard 5 Tab tại địa chỉ: http://localhost:2401'));
appBot1.listen(2402, () => console.log('📈 [BOT 1 UI] Đang chạy Web theo dõi Bot 1 tại Port 2402'));
appBot2.listen(2403, () => console.log('📉 [BOT 2 UI] Đang chạy Web theo dõi Bot 2 tại Port 2403'));
