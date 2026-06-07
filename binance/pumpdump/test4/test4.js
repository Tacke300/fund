import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],            
    DIA_NGUC: ['M1', 'M5', 'M15']    
};

const ANTI_LIQUIDATION_LIMIT = 5; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  
const MAX_DCA_LEVEL = 999999;     

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

// =========================================================
// KHỞI TẠO CẤU TRÚC 2 BOT (BOT 1: PORT 1811 | BOT 2: PORT 1812)
// =========================================================
let bot1 = {
    id: "BOT_1",
    sideMode: "NORMAL", 
    botSettings: { 
        isRunning: false, dcaTypeThuong: 'DUONG', dcaTypeDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botHistory: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
    botActivePositions: new Map(), 
    isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

let bot2 = {
    id: "BOT_2",
    sideMode: "REVERSED", 
    botSettings: { 
        isRunning: false, dcaTypeThuong: 'DUONG', dcaTypeDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
        dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 
    },
    status: { botLogs: [], botHistory: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
    botActivePositions: new Map(), 
    isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

function addBotLog(bot, msg, type = 'info', throttleKey = null, isDianguc = false) {
    if (throttleKey) {
        const now = Date.now(); if (now - bot.logThrottle.get(throttleKey) < 10000) return;
        bot.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    bot.status.botLogs.unshift({ time, msg, type, isDianguc });
    if (bot.status.botLogs.length > 150) bot.status.botLogs.pop();
    console.log(`[${time}][${bot.id}] ${msg}`);
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

function checkAndAddBlacklist(symbol) {
    const hasBot1 = bot1.botActivePositions.has(`${symbol}_LONG`) || bot1.botActivePositions.has(`${symbol}_SHORT`);
    const hasBot2 = bot2.botActivePositions.has(`${symbol}_LONG`) || bot2.botActivePositions.has(`${symbol}_SHORT`);
    if (!hasBot1 && !hasBot2) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
    }
}

// =========================================================
// ĐÓNG VỊ THẾ & LƯU LỊCH SỬ SÂU ĐẨY SANG DASHBOARD
// =========================================================
async function closePositionAndLog(bot, b, markP, reasonStr) {
    try {
        await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        await new Promise(r => setTimeout(r, 2000));
        
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

        // Đẩy thông tin cấu trúc sâu vào mảng History của Bot
        bot.status.botHistory.unshift({
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
            symbol: b.symbol, side: b.side, leverage: b.leverage,
            firstEntry: parseFloat(b.firstEntry).toFixed(6),
            avgEntry: parseFloat(b.avgEntry).toFixed(6),
            finalPnL: finalPnL, isDiangucMode: b.isDiangucMode,
            dcaCount: b.dcaCount, dcaHistory: b.dcaHistory || []
        });
        if (bot.status.botHistory.length > 100) bot.status.botHistory.pop();

        addBotLog(bot, `🔒 [${reasonStr}] Đóng ${b.symbol} | PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? "success" : "sl", null, b.isDiangucMode);
        
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) { addBotLog(bot, `❌ Lỗi đóng ${b.symbol}: ${e.message}`, "error", null, b.isDiangucMode); }
}

// =========================================================
// MONITOR MONITOR MONITOR MONITOR MONITOR MONITOR MONITOR
// =========================================================
async function priceMonitor(bot) {
    if (!bot.status.isReady) return setTimeout(() => priceMonitor(bot), 1000);
    try {
        if (!bot.botSettings.isRunning) return setTimeout(() => priceMonitor(bot), 1000);
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
        
        for (let [key, b] of bot.botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;
            const dcaType = b.isDiangucMode ? bot.botSettings.dcaTypeDianguc : bot.botSettings.dcaTypeThuong;
            const maxDcaSetting = parseInt(bot.botSettings.maxDCA);

            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                b.currentQty = currentQty; b.livePrice = markP; b.pnl = parseFloat(realP.unRealizedProfit);
                b.profitPercent = b.side === 'LONG' ? ((markP - b.avgEntry) / b.avgEntry) * 100 : ((b.avgEntry - markP) / b.avgEntry) * 100;

                const dcaThreshold = b.isDiangucMode ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
                const slPercent = b.isDiangucMode ? parseFloat(bot.botSettings.diangucsl) : parseFloat(bot.botSettings.posSL);

                if (b.side === 'LONG') {
                    b.nextDcaDuong = b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100)));
                    b.nextDcaAm = b.firstEntry * (1 - ((b.dcaCount + 1) * (slPercent / 100)));
                } else {
                    b.nextDcaDuong = b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100)));
                    b.nextDcaAm = b.firstEntry * (1 + ((b.dcaCount + 1) * (slPercent / 100)));
                }
                b.nextDCA = dcaType === 'AM' ? b.nextDcaAm : b.nextDcaDuong;

                if (dcaType === 'DUONG') {
                    let shouldCloseMarket = false;
                    if (b.dcaCount > 0 && ((b.side === 'LONG' && markP >= (b.avgEntry * (1 + b.dcaCount / 100))) || (b.side === 'SHORT' && markP <= (b.avgEntry * (1 - b.dcaCount / 100))))) {
                        shouldCloseMarket = true;
                    }
                    if (shouldCloseMarket) {
                        bot.botActivePositions.delete(key);
                        await closePositionAndLog(bot, b, markP, "TRAILING DCA DƯƠNG");
                        checkAndAddBlacklist(b.symbol); continue;
                    }
                    if (((b.side === 'LONG' && markP >= b.nextDcaDuong) || (b.side === 'SHORT' && markP <= b.nextDcaDuong)) && b.dcaCount < maxDcaSetting && !bot.isProcessingDCA.has(lockKey)) {
                        const jump = b.dcaCount + 1;
                        const coefMode = b.isDiangucMode ? parseFloat(bot.botSettings.heSoDianguc || 3) : parseFloat(bot.botSettings.heSoThuong || 2);
                        openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * jump * 2 * coefMode }, b.side);
                    }
                }
            } else {
                if (bot.isProcessingDCA.has(lockKey)) continue;
                await new Promise(r => setTimeout(r, 2000));
                const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
                const nowServer = Date.now() + bot.timestampOffset;
                const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 25000);
                
                let finalPnLFromSàn = 0;
                const feeVolDeduction = (b.currentQty * b.avgEntry * 0.001);
                if (matchingTrades.length > 0) finalPnLFromSàn = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0) - feeVolDeduction;
                else finalPnLFromSàn = (b.pnl || 0) - feeVolDeduction;

                bot.botActivePositions.delete(key);

                if (finalPnLFromSàn < -0.1 && dcaType === 'AM' && b.dcaCount < maxDcaSetting) {
                    const jump = b.dcaCount + 1;
                    const coefMode = b.isDiangucMode ? parseFloat(bot.botSettings.heSoDianguc || 3) : parseFloat(bot.botSettings.heSoThuong || 2);
                    addBotLog(bot, `⚠️ Trúng SL lệnh gốc ${b.symbol}. Đè DCA ÂM cấp ${jump}!`, "warn", null, b.isDiangucMode);
                    await openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * jump * 2 * coefMode, isDcaAmExecuted: true }, b.side);
                } else {
                    bot.status.botClosedCount++; bot.status.botPnLClosed += finalPnLFromSàn;
                    bot.status.botHistory.unshift({
                        time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
                        symbol: b.symbol, side: b.side, leverage: b.leverage,
                        firstEntry: parseFloat(b.firstEntry).toFixed(6), avgEntry: parseFloat(b.avgEntry).toFixed(6),
                        finalPnL: finalPnLFromSàn, isDiangucMode: b.isDiangucMode, dcaCount: b.dcaCount, dcaHistory: b.dcaHistory || []
                    });
                    addBotLog(bot, `🔒 Sàn quét dứt chuỗi ${b.symbol} | PnL: ${finalPnLFromSàn.toFixed(2)}$`, finalPnLFromSàn >= 0 ? "success" : "sl", null, b.isDiangucMode);
                    checkAndAddBlacklist(b.symbol);
                }
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 1000);
}

// =========================================================
// MỞ VỊ THẾ LIVE & GHI NHẬN TIME/MARGIN SÂU
// =========================================================
async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isDiangucSignal = false) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); const isDCA = dcaData !== null; const lockKey = `${symbol}_${side}`;
    if (bot.isProcessingDCA.has(lockKey)) return; bot.isProcessingDCA.add(lockKey);
    try {
        const info = sharedState.exchangeInfo[symbol]; if(!info) return;
        let qty = 0, margin = 0, currentPrice = 0;

        if (isDCA) {
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`); currentPrice = parseFloat(ticker.data.price); margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else { qty = sharedQty; margin = sharedMargin; currentPrice = sharedPrice; }

        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            const currentModeIsHell = isDCA ? dcaData.isDiangucMode : isDiangucSignal;
            const dcaType = currentModeIsHell ? bot.botSettings.dcaTypeDianguc : bot.botSettings.dcaTypeThuong;
            
            let cumulativeQty = qty; let cumulativeCost = qty * actualFilledPrice; let newAvgEntry = actualFilledPrice;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage; let totalMargin = actualMarginUsed;
            let dcaHistory = [];

            if (isDCA) {
                cumulativeQty = (dcaData.cumulativeQty || dcaData.currentQty) + qty;
                cumulativeCost = (dcaData.cumulativeCost || (dcaData.currentQty * dcaData.avgEntry)) + (qty * actualFilledPrice);
                newAvgEntry = cumulativeCost / cumulativeQty; totalMargin = dcaData.currentMargin + actualMarginUsed;
                dcaHistory = [...(dcaData.dcaHistory || []), { price: actualFilledPrice, margin: actualMarginUsed }];
            } else { dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed }]; }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry; const dcaCount = dcaData ? dcaData.dcaCount : 0;
            const dcaThreshold = currentModeIsHell ? parseFloat(bot.botSettings.diangucdca) : parseFloat(bot.botSettings.posdca);
            const slPercent = currentModeIsHell ? parseFloat(bot.botSettings.diangucsl) : parseFloat(bot.botSettings.posSL);
            const tpPercent = currentModeIsHell ? parseFloat(bot.botSettings.dianguctp) : parseFloat(bot.botSettings.posTP);

            let finalTP, finalSL, nextDCA; const dir = (side === 'LONG' ? 1 : -1);
            if (dcaType === 'DUONG') {
                nextDCA = firstE * (1 + dir * ((dcaCount + 1) * dcaThreshold / 100));
                finalTP = isDCA ? dcaData.tp : newAvgEntry * (1 + dir * (tpPercent / 100)); finalSL = isDCA ? dcaData.sl : newAvgEntry * (1 - dir * (slPercent / 100));
            } else {
                nextDCA = firstE * (1 - dir * ((dcaCount + 1) * slPercent / 100)); finalSL = nextDCA; finalTP = newAvgEntry * (1 + dir * (tpPercent / 100));
            }

            await syncTPSL(bot, symbol, side, info, finalTP, finalSL);

            bot.botActivePositions.set(lockKey, { 
                symbol, side, leverage: info.maxLeverage, firstEntry: firstE, avgEntry: newAvgEntry,
                firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: totalMargin,
                currentQty: (dcaType === 'AM' && isDCA) ? qty : cumulativeQty, cumulativeQty, cumulativeCost,
                dcaCount, dcaHistory, isDiangucMode: currentModeIsHell, pnl: 0, profitPercent: 0,
                tp: finalTP, sl: finalSL, nextDCA, livePrice: actualFilledPrice, isDcaAmExecuted: dcaType === 'AM',
                openTime: dcaData ? dcaData.openTime : new Date().toLocaleTimeString('vi-VN', { hour12: false })
            });
            addBotLog(bot, `🚀 [MỞ/DCA KHỚP LỆNH] ${symbol} ${side} Cấp ${dcaCount}`, "open", null, currentModeIsHell);
        }
    } catch (e) { addBotLog(bot, `❌ Lỗi mở vị thế: ${e.message}`, "error"); }
    finally { setTimeout(() => bot.isProcessingDCA.delete(lockKey), 3000); }
}

async function syncTPSL(bot, symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
        await bot.exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'CONTRACT_PRICE' });
        await bot.exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'CONTRACT_PRICE' });
    } catch (e) { }
}

async function panicCloseAll(bot, reasonLog) {
    try {
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        for (const p of active) {
            await bot.exchange.createOrder(p.symbol, 'MARKET', p.positionSide === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: p.positionSide }).catch(()=>{});
        }
        bot.botActivePositions.clear(); addBotLog(bot, `⚠️ Đóng khẩn cấp toàn bộ vị thế: ${reasonLog}`, "warn");
        return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function checkMarginLimits(bot) {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return;
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0); const availUsdt = parseFloat(acc.availableBalance || 0);
        if (totalWallet > 0) {
            const availPercent = (availUsdt / totalWallet) * 100;
            if (availPercent <= ANTI_LIQUIDATION_LIMIT) {
                await panicCloseAll(bot, "CHỐNG CHÁY 5%"); bot.isMarginProtected = true; bot.botSettings.isRunning = false; return;
            }
            if (!bot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
                bot.isMarginProtected = true; addBotLog(bot, `⚠️ Vượt giới hạn an toàn ví < ${MARGIN_PROTECT_LIMIT}%. Dừng quét chuỗi lệnh!`, "warn");
            } else if (bot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                bot.isMarginProtected = false;
            }
        }
    }
}

// =========================================================
// EXPRESS SERVER GATEWAY & ĐỒNG BỘ CORS TRUYỀN DỮ LIỆU
// =========================================================
const appServer = express(); const appBot1 = express(); const appBot2 = express();

function allowCors(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

appServer.use(allowCors); appServer.use(express.json());
appBot1.use(allowCors); appBot1.use(express.json());
appBot2.use(allowCors); appBot2.use(express.json());

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'sever.html')));

async function buildStatusResponse(bot, cacheObj) {
    const now = Date.now();
    if (now - cacheObj.lastUpdate > 3000) {
        const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
        if (acc) {
            cacheObj.data = { totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) };
            cacheObj.lastUpdate = now;
        }
    }
    return { botSettings: bot.botSettings, activePositions: Array.from(bot.botActivePositions.values()), status: { botLogs: bot.status.botLogs, botHistory: bot.status.botHistory, botClosedCount: bot.status.botClosedCount, botPnLClosed: bot.status.botPnLClosed, isReady: bot.status.isReady }, wallet: cacheObj.data };
}

appBot1.post('/api/settings', (req, res) => { bot1.botSettings = parseNormalizedSettings(req.body, bot1.botSettings); res.json({ success: true }); });
appBot2.post('/api/settings', (req, res) => { bot2.botSettings = parseNormalizedSettings(req.body, bot2.botSettings); res.json({ success: true }); });

appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1, walletCache1)));
appBot1.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot1, "UI PANIC BOT 1")));

appBot2.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot2, walletCache2)));
appBot2.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot2, "UI PANIC BOT 2")));

async function init() {
    try {
        await bot1.exchange.loadMarkets(); await bot2.exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(bot1, '/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            const b = brk.find(x => x.symbol === s.symbol); const maxLev = b?.brackets[0]?.initialLeverage || 20;
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; bot1.status.isReady = true; bot2.status.isReady = true;
        priceMonitor(bot1); priceMonitor(bot2);
        console.log("🔥 Hệ thống Core Trading đã sẵn sàng hoạt động!");
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
// VÒNG LẶP QUÉT TÍN HIỆU VÀ ĐÁNH KHỚP LỆNH CHUỖI
// =========================================================
setInterval(async () => {
    await checkMarginLimits(bot1); await checkMarginLimits(bot2);
    if (!bot1.status.isReady || !bot2.status.isReady || !bot1.botSettings.isRunning || !bot2.botSettings.isRunning) return;

    if (bot1.botActivePositions.size < bot1.botSettings.maxPositions && bot2.botActivePositions.size < bot2.botSettings.maxPositions && bot1.isProcessingDCA.size === 0 && bot2.isProcessingDCA.size === 0) {
        let entrySignal = null;
        for (const c of sharedState.candidatesList) {
            if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue;
            const diangucVol = parseFloat(bot1.botSettings.diangucvol); const minVol = parseFloat(bot1.botSettings.minVol);
            const m1 = parseFloat(c.c1 || 0); const m5 = parseFloat(c.c5 || 0); const m15 = parseFloat(c.c15 || 0);

            let isHell = Math.abs(m1) >= diangucVol || Math.abs(m5) >= diangucVol || Math.abs(m15) >= diangucVol;
            let hellSide = m1 > 0 || m5 > 0 || m15 > 0 ? 'LONG' : 'SHORT';

            if (isHell) {
                entrySignal = { symbol: c.symbol, side: hellSide, isDianguc: true }; break;
            }
            if (!entrySignal && (Math.abs(m1) >= minVol || Math.abs(m5) >= minVol)) {
                entrySignal = { symbol: c.symbol, side: m1 > 0 || m5 > 0 ? 'LONG' : 'SHORT', isDianguc: false }; break;
            }
        }

        if (entrySignal) {
            const symbol = entrySignal.symbol; const info = sharedState.exchangeInfo[symbol]; if (!info) return;
            const acc = await binancePrivate(bot1, '/fapi/v2/account').catch(() => null); if (!acc) return;
            
            const snapshotAvailable = parseFloat(acc.availableBalance || 0);
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null); if (!ticker) return;
            const currentPrice = parseFloat(ticker.data.price);
            
            let calculatedMargin = bot1.botSettings.invValue.toString().includes('%') ? (snapshotAvailable * parseFloat(bot1.botSettings.invValue) / 100) : parseFloat(bot1.botSettings.invValue);
            const desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
            const finalQty = Math.ceil(Math.max(desiredQty, 5.05 / currentPrice) / info.stepSize) * info.stepSize;
            const finalMargin = (finalQty * currentPrice) / info.maxLeverage;

            const sideForBot1 = bot1.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;
            const sideForBot2 = bot2.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;

            openPosition(bot1, symbol, null, sideForBot1, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
            setTimeout(() => { openPosition(bot2, symbol, null, sideForBot2, finalQty, finalMargin, currentPrice, entrySignal.isDianguc); }, 1500);
        }
    }
}, 3000);

appServer.listen(1810, () => console.log('🌐 [MAIN SERVER] Giao diện Live tại Port 1810'));
appBot1.listen(1811, () => console.log('📈 [BOT 1] API running at Port 1811'));
appBot2.listen(1812, () => console.log('📉 [BOT 2] API running at Port 1812'));
