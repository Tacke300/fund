import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================
// ⚙️ CẤU HÌNH CỐT LÕI (CHỈNH SỬA TẠI ĐÂY)
// =========================================================
const ASYMMETRIC_TP_PERCENT = 0.5; // Chốt sớm 0.5% khi Bot đối thủ đã TP (Dành cho DCA Âm chưa nhồi)
const MIN_NOTIONAL_FORCE = 5.1;    // Mức giới hạn lệnh nhỏ nhất (Ngoại trừ các coin Binance ép lên 10$)
const MAX_DCA_LEVEL = 999999; 

function getMaxDcaLimit(dcaType, side) {
    if (dcaType === 'DUONG') return MAX_DCA_LEVEL; 
    if (side === 'LONG') return MAX_DCA_LEVEL; 
    if (side === 'SHORT') return 3;             
    return MAX_DCA_LEVEL;
}

// =========================================================
// CẤU HÌNH KHUNG THỜI GIAN QUÉT & TRẠNG THÁI CACHE
// =========================================================
const SCAN_CONFIG = { THUONG: ['M1', 'M5'], DIA_NGUC: ['M1', 'M5', 'M15'] };
const ANTI_LIQUIDATION_LIMIT = 10; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  

let walletCache1 = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };
let walletCache2 = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {}, permanentBlacklist: {}, candidatesList: [], exchangeInfo: null,
    dcaAmOpponentClosedProfit: {} // Kích hoạt cờ chốt chéo 0.5%
};

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        const lowerKey = key.toLowerCase();
        let val = reqBody[key];
        
        if (lowerKey === 'dcatypethuong' || lowerKey === 'typedcathuong') normalizedBody.dcaTypeThuong = val.toUpperCase(); 
        else if (lowerKey === 'dcatypedianguc' || lowerKey === 'typedcadianguc') normalizedBody.dcaTypeDianguc = val.toUpperCase(); 
        else if (typeof val === 'string' && !isNaN(val) && val.trim() !== '' && !val.includes('%')) {
            normalizedBody[key] = Number(parseFloat(val).toFixed(4)); // Ép cứng kiểu Number chống ghép chuỗi
        } else normalizedBody[key] = val;
    }
    return { ...currentSettings, ...normalizedBody };
}

let bot1 = {
    id: "BOT_1", sideMode: "NORMAL", startTime: Date.now(),
    botSettings: { isRunning: false, dcaTypeThuong: 'DUONG', typeDcaThuong: 'DUONG', dcaTypeDianguc: 'AM', typeDcaDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

let bot2 = {
    id: "BOT_2", sideMode: "REVERSED", startTime: Date.now(),
    botSettings: { isRunning: false, dcaTypeThuong: 'DUONG', typeDcaThuong: 'DUONG', dcaTypeDianguc: 'AM', typeDcaDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

function addBotLog(bot, msg, type = 'info', throttleKey = null, isDianguc = false) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    let uiMsg = msg;
    if (isDianguc && !msg.includes('<span')) uiMsg = `<span style="color: #ef4444; font-weight: 600;">[ĐỊA NGỤC] ${msg}</span>`;
    bot.status.botLogs.unshift({ time, msg: uiMsg, type, isDianguc });
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    console.log(`${isDianguc ? '\x1b[31m' : ''}[${time}][${bot.id}][${type.toUpperCase()}] ${msg}${isDianguc ? '\x1b[0m' : ''}`);
}

async function binancePrivate(bot, endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + bot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        return (await bot.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` })).data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            bot.timestampOffset = (await axios.get('https://fapi.binance.com/fapi/v1/time')).data.serverTime - Date.now();
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
    const hasActive = bot1.botActivePositions.has(`${symbol}_LONG`) || bot1.botActivePositions.has(`${symbol}_SHORT`) || bot2.botActivePositions.has(`${symbol}_LONG`) || bot2.botActivePositions.has(`${symbol}_SHORT`);
    if (!hasActive) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
        addBotLog(bot1, `🚫 [BLACKLIST] Đã chặn ${symbol} 15 phút.`, "warn");
        addBotLog(bot2, `🚫 [BLACKLIST] Đã chặn ${symbol} 15 phút.`, "warn");
    }
}

async function closePositionAndLog(bot, b, markP, reasonStr) {
    try {
        const info = sharedState.exchangeInfo[b.symbol];
        await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        
        let finalPnL = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
        finalPnL -= (b.currentQty * markP * 0.001); // Trừ phí

        bot.status.botClosedCount++;
        bot.status.botPnLClosed += finalPnL;
        if (finalPnL >= 0) bot.status.pnlGain = (bot.status.pnlGain || 0) + finalPnL;
        else bot.status.pnlLoss = (bot.status.pnlLoss || 0) + finalPnL;

        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | Giá chốt: ${markP.toFixed(info.pricePrecision)} | PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? "success" : "sl", null, b.isDiangucMode);
        
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol }).catch(() => []);
        for (const o of openOrders.filter(o => o.positionSide === b.side)) await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
    } catch (e) { addBotLog(bot, `❌ Lỗi đóng vị thế ${b.symbol}: ${e.message}`, "error", null, b.isDiangucMode); }
}

async function panicCloseAll(bot, reasonLog) {
    try {
        const active = (await binancePrivate(bot, '/fapi/v2/positionRisk')).filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        let count = 0;
        for (const p of active) {
            const side = p.positionSide, qty = Math.abs(parseFloat(p.positionAmt)), key = `${p.symbol}_${side}`;
            try {
                await bot.exchange.createOrder(p.symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
                count++;
                if (bot.botActivePositions.has(key)) {
                    let finalPnL = parseFloat(p.unRealizedProfit || 0) - (qty * parseFloat(p.markPrice) * 0.001);
                    bot.status.botPnLClosed += finalPnL;
                    if (finalPnL >= 0) bot.status.pnlGain += finalPnL; else bot.status.pnlLoss += finalPnL;
                }
            } catch (err) { }
        }
        bot.botActivePositions.clear();
        addBotLog(bot, `⚠️ [CHỐNG THANH LÝ] Đóng sạch ${count} vị thế (${reasonLog}).`, "warn");
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
            const dcaType = b.isDiangucMode ? bot.botSettings.dcaTypeDianguc : bot.botSettings.dcaTypeThuong;
            const maxDcaSetting = getMaxDcaLimit(dcaType, b.side);

            if (realP) {
                const markP = parseFloat(realP.markPrice);
                b.currentQty = Math.abs(parseFloat(realP.positionAmt));
                b.livePrice = markP;

                // ⚡ 1. CHỐNG TREO 60 PHÚT
                if (Date.now() - (b.lastActionTime || b.createdAt) > 60 * 60 * 1000) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "TREO LỆNH >60P KHÔNG TP/SL");
                    checkAndAddBlacklist(b.symbol);
                    continue;
                }

                // ⚡ 2. CHỐT TP CỨNG
                if ((b.side === 'LONG' && markP >= b.tp) || (b.side === 'SHORT' && markP <= b.tp)) {
                    bot.botActivePositions.delete(key);
                    if (dcaType === 'AM' && b.dcaCount === 0) sharedState.dcaAmOpponentClosedProfit[b.symbol] = true;
                    await closePositionAndLog(bot, b, markP, "CHỐT TP CỨNG NỘI BỘ");
                    checkAndAddBlacklist(b.symbol);
                    continue;
                }

                // ⚡ 3. CẮT LỖ SL CỨNG 
                if ((b.side === 'LONG' && markP <= b.sl) || (b.side === 'SHORT' && markP >= b.sl)) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "CẮT LỖ SL KẾT THÚC CHUỖI");
                    checkAndAddBlacklist(b.symbol);
                    continue;
                }

                // ⚡ 4. CHỐT SỚM CHÉO 0.5% (CHỈ DCA ÂM CHƯA NHỒI LỆNH)
                if (dcaType === 'AM' && b.dcaCount === 0 && sharedState.dcaAmOpponentClosedProfit[b.symbol]) {
                    const currentProfit = b.side === 'LONG' ? ((markP - b.firstEntry) / b.firstEntry) * 100 : ((b.firstEntry - markP) / b.firstEntry) * 100;
                    if (currentProfit >= ASYMMETRIC_TP_PERCENT) {
                        bot.botActivePositions.delete(key);
                        await closePositionAndLog(bot, b, markP, `CHỐT CỨU BỒ ${ASYMMETRIC_TP_PERCENT}% (BOT KIA ĐÃ TP)`);
                        checkAndAddBlacklist(b.symbol);
                        continue;
                    }
                }

                // ⚡ 5. LOGIC DCA
                if (dcaType === 'DUONG') {
                    if (b.dcaCount > 0 && ((b.side === 'LONG' && markP <= b.avgEntry + (b.firstEntry * 0.001)) || (b.side === 'SHORT' && markP >= b.avgEntry - (b.firstEntry * 0.001)))) {
                        bot.botActivePositions.delete(key); 
                        await closePositionAndLog(bot, b, markP, "CHỐT HÒA TRAILING (DCA DƯƠNG)");
                        checkAndAddBlacklist(b.symbol); 
                        continue;
                    }
                    if (((b.side === 'LONG' && markP >= b.nextDCA) || (b.side === 'SHORT' && markP <= b.nextDCA)) && b.dcaCount < maxDcaSetting && !bot.isProcessingDCA.has(lockKey)) {
                        openPosition(bot, b.symbol, { ...b, dcaCount: b.dcaCount + 1, margin: b.firstMargin * (b.dcaCount + 1) * 2 * (b.isDiangucMode ? bot.botSettings.heSoDianguc : bot.botSettings.heSoThuong) }, b.side);
                    }
                } else {
                    if (((b.side === 'LONG' && markP <= b.nextDCA) || (b.side === 'SHORT' && markP >= b.nextDCA))) {
                        if (b.dcaCount < maxDcaSetting && !bot.isProcessingDCA.has(lockKey)) {
                            addBotLog(bot, `📉 Đang lỗ. Kích hoạt DCA ÂM trực tiếp cấp ${b.dcaCount + 1}!`, "warn", null, b.isDiangucMode);
                            openPosition(bot, b.symbol, { ...b, dcaCount: b.dcaCount + 1, margin: b.firstMargin * (b.dcaCount + 1) * 2 * (b.isDiangucMode ? bot.botSettings.heSoDianguc : bot.botSettings.heSoThuong) }, b.side);
                        } else if (b.dcaCount >= maxDcaSetting) {
                            bot.botActivePositions.delete(key);
                            await closePositionAndLog(bot, b, markP, "CẮT LỖ (ĐÃ HẾT LƯỢT DCA)");
                            checkAndAddBlacklist(b.symbol);
                        }
                    }
                }
            } else {
                if (!bot.isProcessingDCA.has(lockKey)) { bot.botActivePositions.delete(key); checkAndAddBlacklist(b.symbol); }
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 500); 
}

async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isDiangucSignal = false) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    if (bot.isProcessingDCA.has(lockKey)) return;
    bot.isProcessingDCA.add(lockKey); 
    
    try {
        const info = sharedState.exchangeInfo[symbol];
        if(!info) throw new Error("Coin không hỗ trợ");

        let qty = 0, margin = 0, currentPrice = 0;
        
        if (isDCA) {
            currentPrice = Number((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
            margin = dcaData.margin;
            const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || 5.0);
            
            let desiredQty = (margin * info.maxLeverage) / currentPrice;
            qty = Math.floor(Math.max(desiredQty, actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            if (qty * currentPrice < actualMinNotional) qty += info.stepSize;
        } else {
            qty = sharedQty; margin = sharedMargin; currentPrice = sharedPrice;
        }

        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualFilledPrice = Number(order.average || order.price || currentPrice);
            const isHell = isDCA ? dcaData.isDiangucMode : isDiangucSignal;
            const dcaType = isHell ? bot.botSettings.dcaTypeDianguc : bot.botSettings.dcaTypeThuong;
            
            let cumulativeQty = qty, cumulativeCost = qty * actualFilledPrice, newAvgEntry = actualFilledPrice, totalMargin = (qty * actualFilledPrice) / info.maxLeverage, dcaHistory = [];

            if (isDCA) {
                cumulativeQty = dcaData.cumulativeQty + qty;
                cumulativeCost = dcaData.cumulativeCost + (qty * actualFilledPrice);
                newAvgEntry = cumulativeCost / cumulativeQty;
                totalMargin = dcaData.currentMargin + totalMargin;
                dcaHistory = [...dcaData.dcaHistory, { price: actualFilledPrice, margin: (qty * actualFilledPrice) / info.maxLeverage }];
            } else {
                dcaHistory = [{ price: actualFilledPrice, margin: totalMargin }];
                sharedState.dcaAmOpponentClosedProfit[symbol] = false;
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            const dir = (side === 'LONG' ? 1 : -1);

            const tpPercent = Number(isHell ? bot.botSettings.dianguctp : bot.botSettings.posTP);
            const slPercent = Number(isHell ? bot.botSettings.diangucsl : bot.botSettings.posSL);
            const dcaThreshold = Number(isHell ? bot.botSettings.diangucdca : bot.botSettings.posdca);

            let finalTP, finalSL, nextDCA;

            if (dcaType === 'DUONG') {
                nextDCA = firstE + (dir * firstE * ((dcaCount + 1) * dcaThreshold / 100)); 
                if (!isDCA) {
                    finalTP = actualFilledPrice + (dir * actualFilledPrice * (tpPercent / 100));
                    finalSL = actualFilledPrice - (dir * actualFilledPrice * (slPercent / 100)); 
                } else { finalTP = dcaData.tp; finalSL = dcaData.sl; }
            } else { // DCA ÂM
                nextDCA = firstE - (dir * firstE * ((dcaCount + 1) * dcaThreshold / 100)); 
                // TP CHUẨN ĐÉT: Giá AVG Mới cộng/trừ với [Giá trị % TP tính từ Giá Entry Đầu Tiên]
                finalTP = newAvgEntry + (dir * firstE * (tpPercent / 100));
                finalSL = firstE - (dir * firstE * (slPercent / 100)); // SL giữ nguyên cắt máu từ gốc
            }

            bot.botActivePositions.set(lockKey, { 
                symbol, side, tp: finalTP, sl: finalSL, dcaCount, firstEntry: firstE, firstMargin: isDCA ? dcaData.firstMargin : totalMargin, 
                currentQty: cumulativeQty, cumulativeQty, cumulativeCost, dcaHistory, isDiangucMode: isHell, avgEntry: newAvgEntry, nextDCA, 
                createdAt: isDCA ? dcaData.createdAt : Date.now(), lastActionTime: Date.now()
            });
            
            if (!isDCA) {
                addBotLog(bot, `[MỞ ${side}][${isHell ? "ĐỊA NGỤC" : "THƯỜNG"}] ${symbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(info.pricePrecision)} | TP Mới: ${finalTP.toFixed(info.pricePrecision)} | Mốc SL: ${finalSL.toFixed(info.pricePrecision)}`, "open", null, isHell); 
            } else {
                addBotLog(bot, `[${dcaType === 'AM' ? "DCA ÂM" : "DCA DƯƠNG"}] ${symbol} | Cấp ${dcaCount} | Avg Mới: ${newAvgEntry.toFixed(info.pricePrecision)} | Mốc TP dời về: ${finalTP.toFixed(info.pricePrecision)}`, "dca", null, isHell); 
            }
        }
    } catch (e) { 
        if (e.message.includes('2019') || e.message.includes('Notional')) addBotLog(bot, `❌ [CẢNH BÁO MIN SÀN] Coin ${symbol} yêu cầu vốn mở to hơn! Lỗi: ${e.message}`, "error"); 
        else addBotLog(bot, `❌ [LỖI MỞ LỆNH] ${symbol}: ${e.message}`, "error"); 
    } finally { setTimeout(() => bot.isProcessingDCA.delete(lockKey), 1000); }
}

async function checkMarginLimits(bot) {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return;
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    if (acc && parseFloat(acc.totalMarginBalance) > 0) {
        const availPercent = (parseFloat(acc.availableBalance) / parseFloat(acc.totalMarginBalance)) * 100;
        if (availPercent <= ANTI_LIQUIDATION_LIMIT) { await panicCloseAll(bot, `CHỐNG THANH LÝ ${ANTI_LIQUIDATION_LIMIT}%`); bot.isMarginProtected = false; return; }
        if (!bot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) bot.isMarginProtected = true; 
        else if (bot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) bot.isMarginProtected = false; 
    }
}

// ... KHÚC CODE EXPRESS SERVER UI TỪ CÁC BẢN TRƯỚC GIỮ NGUYÊN (appServer, appBot1, appBot2, init()...)
// Do độ dài giới hạn, ông ghép phần UI server của file cũ xuống dưới đuôi nhé.

// =========================================================
// VÒNG LẶP CHÍNH THỰC THI (DELAY 300MS)
// =========================================================
setInterval(async () => {
    await checkMarginLimits(bot1); await checkMarginLimits(bot2);
    if (!bot1.status.isReady || !bot2.status.isReady) return;

    const canBot1Run = bot1.botSettings.isRunning && !bot1.isMarginProtected && (bot1.botActivePositions.size < bot1.botSettings.maxPositions) && (bot1.isProcessingDCA.size === 0);
    const canBot2Run = bot2.botSettings.isRunning && !bot2.isMarginProtected && (bot2.botActivePositions.size < bot2.botSettings.maxPositions) && (bot2.isProcessingDCA.size === 0);
    if (!canBot1Run && !canBot2Run) return;

    const posRisk = await binancePrivate(bot1, '/fapi/v2/positionRisk').catch(() => []);
    const exchangeSymbols = new Set(posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => p.symbol));

    let entrySignal = null;
    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
        
        const m1 = parseFloat(c.c1 || 0), m5 = parseFloat(c.c5 || 0), m15 = parseFloat(c.c15 || 0);
        let isHell = false, hellSide = 'SHORT';
        for (const tf of SCAN_CONFIG.DIA_NGUC) {
            const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
            if (Math.abs(val) >= bot1.botSettings.diangucvol) { isHell = true; hellSide = val > 0 ? 'LONG' : 'SHORT'; break; }
        }

        const hasNormalPos = (bot1.botSettings.isRunning && Array.from(bot1.botActivePositions.values()).some(p => p.symbol === c.symbol && !p.isDiangucMode)) || (bot2.botSettings.isRunning && Array.from(bot2.botActivePositions.values()).some(p => p.symbol === c.symbol && !p.isDiangucMode));
        if (isHell) { entrySignal = { symbol: c.symbol, side: hellSide, isDianguc: true, override: hasNormalPos }; break; }

        if (!entrySignal && !exchangeSymbols.has(c.symbol)) {
            let isNormal = false, normalSide = 'SHORT';
            for (const tf of SCAN_CONFIG.THUONG) {
                const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
                if (Math.abs(val) >= bot1.botSettings.minVol) { isNormal = true; normalSide = val > 0 ? 'LONG' : 'SHORT'; break; }
            }
            if (isNormal) { entrySignal = { symbol: c.symbol, side: normalSide, isDianguc: false, override: false }; break; }
        }
    }

    if (entrySignal) {
        if (entrySignal.override) {
            const forceClose = async (bot) => {
                const pr = await binancePrivate(bot, '/fapi/v2/positionRisk', 'GET', { symbol: entrySignal.symbol }).catch(() => []);
                for (const p of pr.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)) await bot.exchange.createOrder(p.symbol, 'MARKET', p.positionSide === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: p.positionSide }).catch(() => {});
                bot.botActivePositions.forEach((v, k) => { if (v.symbol === entrySignal.symbol) bot.botActivePositions.delete(k); });
            };
            await Promise.all([forceClose(bot1), forceClose(bot2)]);
            await new Promise(r => setTimeout(r, 500)); 
        }

        const info = sharedState.exchangeInfo[entrySignal.symbol];
        if (!info) return;

        const acc = await binancePrivate(bot1, '/fapi/v2/account').catch(() => null);
        if (!acc) return; 
        
        const currentPrice = Number((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${entrySignal.symbol}`)).data.price);
        let calculatedMargin = bot1.botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(bot1.botSettings.invValue) / 100) : parseFloat(bot1.botSettings.invValue);

        // ĐỒNG BỘ SIZE - CHỐNG VỌT $11
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || 5.0);
        let desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
        let finalQty = Math.floor(Math.max(desiredQty, actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        if (finalQty * currentPrice < actualMinNotional) finalQty += info.stepSize;
        finalQty = parseFloat(finalQty.toFixed(info.quantityPrecision)); // Cắt gọn phần thập phân
        
        const finalMargin = (finalQty * currentPrice) / info.maxLeverage;

        if (canBot1Run) openPosition(bot1, entrySignal.symbol, null, bot1.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
        if (canBot2Run) {
            const side2 = bot2.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;
            if (canBot1Run) setTimeout(() => { openPosition(bot2, entrySignal.symbol, null, side2, finalQty, finalMargin, currentPrice, entrySignal.isDianguc); }, 300); // Kích nổ 300ms
            else openPosition(bot2, entrySignal.symbol, null, side2, finalQty, finalMargin, currentPrice, entrySignal.isDianguc);
        }
    }
}, 3000);
