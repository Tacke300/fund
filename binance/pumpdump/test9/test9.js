import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MIN_NOTIONAL_FORCE = 5.1;
const MAX_DCA_LEVEL = 999999; 
const ASYMMETRIC_TP_PERCENT = 0.5;

function getMaxDcaLimit(dcaType, side) {
    if (dcaType === 'DUONG') return MAX_DCA_LEVEL; 
    if (side === 'LONG') return MAX_DCA_LEVEL; 
    if (side === 'SHORT') return 999;             
    return MAX_DCA_LEVEL;
}

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],            
    DIA_NGUC: ['M1', 'M5', 'M15']    
};

const ANTI_LIQUIDATION_LIMIT = 10; 
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  

const globalStartTime = Date.now();

function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

let walletCache1 = { data: { totalWalletBalance: "0", totalMarginBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };
let walletCache2 = { data: { totalWalletBalance: "0", totalMarginBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const POSITIONS_FILE = path.join(__dirname, 'positions.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const CACHE_FILE = path.join(__dirname, 'cache.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    dcaAmOpponentClosedProfit: {},
    masterLogs: [],
    errorSpamGuard: {}, 
    pendingOrders: new Set() 
};

// CACHE FILE SYSTEM
let systemCache = {
    leverage: {},
    account: {
        bot1: { data: null, lastUpdate: 0 },
        bot2: { data: null, lastUpdate: 0 }
    },
    ticker: {}
};

function saveCacheToFile() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(systemCache, null, 2), 'utf-8');
    } catch (e) {}
}

function loadCacheFromFile() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return;
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data) {
            if (data.leverage) systemCache.leverage = data.leverage;
            if (data.account) systemCache.account = data.account;
            if (data.ticker) systemCache.ticker = data.ticker;
        }
    } catch (e) {}
}

async function setLeverageCached(bot, symbol, targetLeverage) {
    const key = `${bot.id}_${symbol}_${targetLeverage}`;
    if (systemCache.leverage[key]) return;
    try {
        await bot.exchange.setLeverage(targetLeverage, symbol);
        systemCache.leverage[key] = true;
        saveCacheToFile();
    } catch (e) {
        if (!e.message?.includes('Set leverage failed')) {
            systemCache.leverage[key] = true;
            saveCacheToFile();
        } else {
            throw e;
        }
    }
}

async function getCachedAccountData(bot, maxAgeMs = 3000) {
    const cacheKey = bot.id === 'BOT_1' ? 'bot1' : 'bot2';
    const cache = systemCache.account[cacheKey];
    const now = Date.now();

    if (cache && cache.data && (now - cache.lastUpdate < maxAgeMs)) {
        return cache.data;
    }

    try {
        const acc = await binancePrivate(bot, '/fapi/v2/account');
        if (acc && acc.totalWalletBalance !== undefined) {
            systemCache.account[cacheKey] = { data: acc, lastUpdate: now };
            saveCacheToFile();
            return acc;
        }
    } catch (e) {
        if (cache && cache.data) return cache.data;
    }
    return null;
}

async function getCachedTickerPrice(symbol, maxAgeMs = 1500) {
    const now = Date.now();
    const cached = systemCache.ticker[symbol];
    if (cached && (now - cached.time < maxAgeMs)) {
        return cached.price;
    }
    try {
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);
        if (!isNaN(price) && price > 0) {
            systemCache.ticker[symbol] = { price, time: now };
            saveCacheToFile();
            return price;
        }
    } catch (e) {
        if (cached) return cached.price;
    }
    return null;
}

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        const lowerKey = key.toLowerCase();
        const val = reqBody[key];

        if (lowerKey === 'dcatypethuong' || lowerKey === 'typedcathuong') {
            normalizedBody.dcaTypeThuong = val.toUpperCase();
            normalizedBody.typeDcaThuong = val.toUpperCase();
        }
        else if (lowerKey === 'dcatypedianguc' || lowerKey === 'typedcadianguc') {
            normalizedBody.dcaTypeDianguc = val.toUpperCase();
            normalizedBody.typeDcaDianguc = val.toUpperCase();
        }
        else if (['hesothuong', 'hesodianguc', 'minvol', 'postp', 'possl', 'dianguctp', 'diangucsl', 'diangucdca', 'posdca', 'diangucvol', 'maxpnlpausepct', 'maxpnlresumepct'].includes(lowerKey)) {
            normalizedBody[key] = parseFloat(val);
        }
        else if (['maxpositions', 'maxdca'].includes(lowerKey)) {
            normalizedBody[key] = parseInt(val);
        }
        else {
            normalizedBody[key] = val; 
        }
    }
    return { ...currentSettings, ...normalizedBody };
}

let bot1 = {
    id: "BOT_1", sideMode: "NORMAL", startTime: Date.now(),
    botSettings: { isRunning: false, maxPnlPausePct: 5.0, maxPnlResumePct: 2.5, dcaTypeThuong: 'DUONG', typeDcaThuong: 'DUONG', dcaTypeDianguc: 'AM', typeDcaDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false, isPnlPaused: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

let bot2 = {
    id: "BOT_2", sideMode: "REVERSED", startTime: Date.now(),
    botSettings: { isRunning: false, maxPnlPausePct: 5.0, maxPnlResumePct: 2.5, dcaTypeThuong: 'DUONG', typeDcaThuong: 'DUONG', dcaTypeDianguc: 'AM', typeDcaDianguc: 'AM', maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false, isPnlPaused: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

// CACHE BẢO VỆ RATE LIMIT VÀ CHỐNG MẤT DỮ LIỆU SÀN
let positionRiskCache = {
    bot1: { data: null, lastUpdate: 0 },
    bot2: { data: null, lastUpdate: 0 }
};

async function getCachedPositionRisk(bot, maxAgeMs = 1500) {
    const cacheKey = bot.id === 'BOT_1' ? 'bot1' : 'bot2';
    const cache = positionRiskCache[cacheKey];
    const now = Date.now();

    if (cache.data && (now - cache.lastUpdate < maxAgeMs)) {
        return cache.data;
    }

    try {
        const data = await binancePrivate(bot, '/fapi/v2/positionRisk');
        if (Array.isArray(data)) {
            cache.data = data;
            cache.lastUpdate = now;
            return data;
        }
    } catch (e) {
        if (cache.data) return cache.data;
    }
    return null;
}

// BẢO TOÀN DỮ LIỆU VỊ THẾ VÀO FILE POSITION.JSON
function savePositionsToFile() {
    try {
        const data = {
            bot1: Array.from(bot1.botActivePositions.entries()),
            bot2: Array.from(bot2.botActivePositions.entries())
        };
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error("Lỗi khi ghi vị thế vào position.json:", e.message);
    }
}

function loadPositionsFromFile() {
    try {
        if (!fs.existsSync(POSITIONS_FILE)) return;
        const raw = fs.readFileSync(POSITIONS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data.bot1 && Array.isArray(data.bot1)) {
            bot1.botActivePositions = new Map(data.bot1);
        }
        if (data.bot2 && Array.isArray(data.bot2)) {
            bot2.botActivePositions = new Map(data.bot2);
        }
    } catch (e) {
        console.error("Lỗi khi đọc vị thế từ position.json:", e.message);
    }
}

function saveSettingsToFile() {
    try {
        const data = {
            bot1: bot1.botSettings,
            bot2: bot2.botSettings
        };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
}

function loadSettingsFromFile() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return;
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data.bot1) bot1.botSettings = parseNormalizedSettings(data.bot1, bot1.botSettings);
        if (data.bot2) bot2.botSettings = parseNormalizedSettings(data.bot2, bot2.botSettings);
    } catch (e) {}
}

function addBotLog(bot, msg, type = 'open', throttleKey = null, isDianguc = false) {
    if (throttleKey) {
        const now = Date.now();
        const last = bot.logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        bot.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    
    let uiMsg = msg;
    const logItem = { time, msg: uiMsg, type, isDianguc, botId: bot.id };
    
    bot.status.botLogs.unshift(logItem);
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    
    sharedState.masterLogs.unshift({ time, msg: `[${bot.id}] ${uiMsg}`, type, isDianguc });
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    
    let consolePrefix = `[${time}][${bot.id}][${type.toUpperCase()}]`;
    let consoleOutput = `${consolePrefix} ${msg}`;
    if (isDianguc) {
        consoleOutput = `\x1b[38;5;208m${consolePrefix} [ĐỊA NGỤC] ${msg}\x1b[0m`;
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
}, 2000);

function checkAndAddBlacklist(symbol) {
    const hasBot1 = bot1.botActivePositions.has(`${symbol}_LONG`) || bot1.botActivePositions.has(`${symbol}_SHORT`);
    const hasBot2 = bot2.botActivePositions.has(`${symbol}_LONG`) || bot2.botActivePositions.has(`${symbol}_SHORT`);
    if (!hasBot1 && !hasBot2) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
    }
}

// HÀNG CHỜ ĐÓNG LỆNH CÁCH NHAU 5 GIÂY
const closeQueue = [];
let isProcessingCloseQueue = false;

async function processCloseQueue() {
    if (isProcessingCloseQueue) return;
    isProcessingCloseQueue = true;

    while (closeQueue.length > 0) {
        const task = closeQueue.shift();
        try {
            await task();
        } catch (e) {
            console.error("Lỗi khi xử lý hàng chờ đóng vị thế:", e.message);
        }
        if (closeQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    isProcessingCloseQueue = false;
}

function queueClosePosition(bot, b, markP, reasonStr) {
    const key = `${b.symbol}_${b.side}`;
    if (b.isClosing) return;
    b.isClosing = true;

    closeQueue.push(async () => {
        try {
            const success = await executeClosePositionAndLog(bot, b, markP, reasonStr);
            if (success) {
                bot.botActivePositions.delete(key);
                savePositionsToFile();
                checkAndAddBlacklist(b.symbol);
            } else {
                b.isClosing = false;
            }
        } catch (e) {
            b.isClosing = false;
        }
    });

    processCloseQueue();
}

async function executeClosePositionAndLog(bot, b, markP, reasonStr) {
    const info = sharedState.exchangeInfo[b.symbol];
    const pPrec = info ? info.pricePrecision : 6; 
    let finalPnL = 0;
    let orderClosedSuccessfully = false;

    try {
        const posRisk = await getCachedPositionRisk(bot, 0) || [];
        const realP = posRisk.find(p => p.symbol === b.symbol && p.positionSide === b.side && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        if (realP) {
            const exchangeQty = Math.abs(parseFloat(realP.positionAmt));
            const closeQty = Math.min(b.currentQty || exchangeQty, exchangeQty);
            try {
                await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', closeQty, undefined, { positionSide: b.side });
                orderClosedSuccessfully = true;
            } catch (err) {
                const errMsg = err?.response?.data?.msg || err?.message || String(err);
                if (errMsg.includes('2022') || errMsg.includes('ReduceOnly Order would be rejected')) {
                    orderClosedSuccessfully = true;
                } else {
                    addBotLog(bot, `⚠️ Lỗi gửi lệnh Market đóng ${b.symbol}: ${errMsg}`, "warn", null, b.isDiangucMode);
                    return false;
                }
            }
        } else {
            orderClosedSuccessfully = true;
        }
    } catch (e) {
        const errMsg = e?.response?.data?.msg || e?.message || String(e);
        addBotLog(bot, `❌ Thất bại khi đóng vị thế sàn ${b.symbol}: ${errMsg}`, "error", null, b.isDiangucMode);
        return false;
    }
    
    if (!orderClosedSuccessfully) return false;

    try {
        await new Promise(resolve => setTimeout(resolve, 1500)); 
        const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
        const nowServer = Date.now() + bot.timestampOffset;
        const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 35000);
        
        const estFee = (b.currentQty * markP * 0.0005 * 2); 

        if (matchingTrades.length > 0) {
            finalPnL = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission || 0), 0);
        } else {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            finalPnL = pnlRaw - estFee;
        }

        bot.status.botClosedCount++;
        bot.status.botPnLClosed += finalPnL;

        if (finalPnL >= 0) {
            bot.status.pnlGain = (bot.status.pnlGain || 0) + finalPnL;
        } else {
            bot.status.pnlLoss = (bot.status.pnlLoss || 0) + finalPnL;
        }

        let isExplicitTP = reasonStr.includes("TP") || reasonStr.includes("TRAILING") || reasonStr.includes("SỚM");
        let isExplicitSL = reasonStr.includes("SL") || reasonStr.includes("CẮT LỖ") || reasonStr.includes("HẾT LƯỢT");

        let logType = "tp";
        let detailTag = "CHỐT LÃI TP";

        if (isExplicitSL || (!isExplicitTP && finalPnL < 0)) {
            logType = "sl";
            detailTag = "CẮT LỖ SL";
        } else if (isExplicitTP && finalPnL < 0) {
            logType = "warn";
            detailTag = "CHỐT TP SÀN/NỘI BỘ (ÂM PNL DO PHÍ TAKER/TRƯỢT GIÁ)";
        } else if (reasonStr.includes("AVG") || reasonStr.includes("TRAILING")) {
            logType = "avg";
            detailTag = "CHỐT TRAILING AVG";
        }

        addBotLog(bot, `🔒 [${detailTag} | LÝ DO: ${reasonStr}] ${b.symbol} ${b.side} | Giá chốt: ${markP.toFixed(pPrec)} | Net PnL: ${finalPnL.toFixed(2)}$`, logType, null, b.isDiangucMode);
        
    } catch (e) {
        const errMsg = e?.response?.data?.msg || e?.message || String(e);
        addBotLog(bot, `❌ Lỗi xử lý/ghi log PnL cho ${b.symbol}: ${errMsg}`, "error", null, b.isDiangucMode);
    }

    try {
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol }).catch(() => []);
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {}

    return true;
}

async function closePositionAndLog(bot, b, markP, reasonStr) {
    return await executeClosePositionAndLog(bot, b, markP, reasonStr);
}

async function panicCloseAll(bot, reasonLog) {
    try {
        const posRisk = await getCachedPositionRisk(bot, 0) || [];
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        let count = 0;
        for (const p of active) {
            const side = p.positionSide;
            const qty = Math.abs(parseFloat(p.positionAmt));
            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            const key = `${p.symbol}_${side}`;
            try {
                if (bot.botActivePositions.has(key)) {
                    await bot.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                    count++;
                    
                    const b = bot.botActivePositions.get(key);
                    if (b) {
                        let pnlRaw = parseFloat(p.unRealizedProfit || 0);
                        const feeVolDeduction = (qty * parseFloat(p.markPrice) * 0.0005);
                        let finalPnL = pnlRaw - feeVolDeduction;

                        bot.status.botClosedCount++;
                        bot.status.botPnLClosed += finalPnL;
                        if (finalPnL >= 0) {
                            bot.status.pnlGain = (bot.status.pnlGain || 0) + finalPnL;
                        } else {
                            bot.status.pnlLoss = (bot.status.pnlLoss || 0) + finalPnL;
                        }
                    }
                }
            } catch (err) { }
        }
        bot.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(bot, `⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] Đã giải phóng tài khoản (${reasonLog}).`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function priceMonitor(bot) {
    if (!bot.status.isReady) return setTimeout(() => priceMonitor(bot), 1000);
    try {
        if (!bot.botSettings.isRunning) return setTimeout(() => priceMonitor(bot), 1000);
        
        const posRisk = await getCachedPositionRisk(bot, 1500);
        if (!posRisk || !Array.isArray(posRisk)) {
            return setTimeout(() => priceMonitor(bot), 1000);
        }

        const now = Date.now();
        const otherBot = bot.id === 'BOT_1' ? bot2 : bot1;
        
        for (let [key, b] of Array.from(bot.botActivePositions.entries())) {
            if (b.isClosing) continue;

            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;
            const targetDcaLevel = b.dcaCount + 1;
            const dcaLockKey = `${b.symbol}_${b.side}_LEVEL_${targetDcaLevel}`;

            const dcaType = b.isDiangucMode ? (bot.botSettings.typeDcaDianguc || bot.botSettings.dcaTypeDianguc) : (bot.botSettings.typeDcaThuong || bot.botSettings.dcaTypeThuong);
            const maxDcaSetting = getMaxDcaLimit(dcaType, b.side);

            if (realP) {
                const exchangeQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                const otherHasKey = otherBot.botActivePositions.has(key);
                if (!otherHasKey) {
                    b.currentQty = exchangeQty;
                    b.pnl = parseFloat(realP.unRealizedProfit);
                } else {
                    const otherQty = otherBot.botActivePositions.get(key)?.currentQty || 0;
                    const totalTracked = b.currentQty + otherQty;
                    if (totalTracked > 0) {
                        b.pnl = parseFloat(realP.unRealizedProfit) * (b.currentQty / totalTracked);
                    } else {
                        b.pnl = parseFloat(realP.unRealizedProfit) / 2;
                    }
                }

                b.livePrice = markP;

                if (b.side === 'LONG') b.profitPercent = ((markP - b.avgEntry) / b.avgEntry) * 100;
                else b.profitPercent = ((b.avgEntry - markP) / b.avgEntry) * 100;

                const lastActionTime = b.lastActionTime || b.createdAt || now;

                if (dcaType === 'AM' && b.dcaCount === 0 && sharedState.dcaAmOpponentClosedProfit[b.symbol] === true) {
                    if (b.profitPercent >= ASYMMETRIC_TP_PERCENT && b.pnl > 0) {
                        queueClosePosition(bot, b, markP, "CHỐT SỚM AN TOÀN (ĐỐI THỦ ĐÃ TP)");
                        continue;
                    }
                }

                const hitInternalTP = b.side === 'LONG' ? (markP >= b.tp) : (markP <= b.tp);
                const isPnlPositive = b.pnl > 0;

                if (hitInternalTP) {
                    if (isPnlPositive) {
                        if (dcaType === 'AM' && b.dcaCount === 0) {
                            sharedState.dcaAmOpponentClosedProfit[b.symbol] = true;
                        }
                        queueClosePosition(bot, b, markP, "CHỐT TP NỘI BỘ (PNL DƯƠNG)");
                        continue;
                    }
                }

                const hitInternalSL = b.side === 'LONG' ? (markP <= b.sl) : (markP >= b.sl);
                if (hitInternalSL) {
                    queueClosePosition(bot, b, markP, "CẮT LỖ SL NỘI BỘ");
                    continue;
                }

                const isDcaCooldown = b.lastDcaTime && (now - b.lastDcaTime < 8000);

                if (dcaType === 'DUONG') {
                    let shouldCloseMarket = false;
                    if (b.dcaCount > 0) { 
                        const trailingOffset = b.firstEntry * 0.0015; 
                        if (b.side === 'LONG' && markP <= (b.avgEntry + trailingOffset)) shouldCloseMarket = true;
                        if (b.side === 'SHORT' && markP >= (b.avgEntry - trailingOffset)) shouldCloseMarket = true;
                    }

                    if (shouldCloseMarket && b.pnl > 0) {
                        queueClosePosition(bot, b, markP, "CHỐT TRAILING AVG (DCA DƯƠNG)");
                        continue;
                    }

                    const hitDcaDuong = (b.side === 'LONG' && markP >= b.nextDCA) || (b.side === 'SHORT' && markP <= b.nextDCA);
                    if (hitDcaDuong && b.dcaCount < maxDcaSetting && !isDcaCooldown) {
                        if (!bot.isProcessingDCA.has(lockKey) && !bot.isProcessingDCA.has(dcaLockKey)) {
                            bot.isProcessingDCA.add(dcaLockKey);
                            const jump = b.dcaCount + 1;
                            const coefMode = b.isDiangucMode ? bot.botSettings.heSoDianguc : bot.botSettings.heSoThuong;
                            
                            let marginToUse = b.firstMargin * coefMode; 
                            openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                        }
                    }
                } else {
                    const hitDcaAm = (b.side === 'LONG' && markP <= b.nextDCA) || (b.side === 'SHORT' && markP >= b.nextDCA);
                    if (hitDcaAm) {
                        if (b.dcaCount < maxDcaSetting) {
                            if (!bot.isProcessingDCA.has(lockKey) && !bot.isProcessingDCA.has(dcaLockKey) && !isDcaCooldown) {
                                bot.isProcessingDCA.add(dcaLockKey);
                                const jump = b.dcaCount + 1;
                                const coefMode = b.isDiangucMode ? bot.botSettings.heSoDianguc : bot.botSettings.heSoThuong;
                                
                                let marginToUse = b.firstMargin * coefMode; 
                                openPosition(bot, b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                            }
                        } else {
                            queueClosePosition(bot, b, markP, "CẮT LỖ SL NỘI BỘ (HẾT LƯỢT DCA)");
                            continue;
                        }
                    }
                }
            } 
            else {
                if (!bot.isProcessingDCA.has(lockKey)) {
                    bot.botActivePositions.delete(key); 
                    savePositionsToFile();
                    checkAndAddBlacklist(b.symbol);
                }
            }
        }
    } catch (e) { }
    
    setTimeout(() => priceMonitor(bot), 1000); 
}

async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isDiangucSignal = false, signalVols = null) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    const dcaLevel = dcaData ? dcaData.dcaCount : 0;
    const dcaLockKey = `${symbol}_${side}_LEVEL_${dcaLevel}`;
    
    if (bot.isProcessingDCA.has(lockKey) && !isDCA) return;
    bot.isProcessingDCA.add(lockKey); 
    if (isDCA) bot.isProcessingDCA.add(dcaLockKey);
    
    let finalTP, finalSL;

    try {
        const info = sharedState.exchangeInfo[symbol];
        if(!info) throw new Error("Coin không hỗ trợ");
        const pPrec = info.pricePrecision; 

        let qty = 0, margin = 0, currentPrice = 0;
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        if (isDCA) {
            currentPrice = await getCachedTickerPrice(symbol, 1000);
            if (!currentPrice) {
                const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
                currentPrice = parseFloat(ticker.data.price);
            }
            margin = dcaData.margin;
            
            let desiredQty = (margin * info.maxLeverage) / currentPrice;
            qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
            
            if (qty * currentPrice < actualMinNotional) {
                qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
            qty = Number(qty.toFixed(info.quantityPrecision)); 
        } else {
            qty = sharedQty;
            margin = sharedMargin;
            currentPrice = sharedPrice;
        }

        await setLeverageCached(bot, symbol, info.maxLeverage);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(resolve => setTimeout(resolve, 3000));

            let actualFilledPrice = currentPrice;
            try {
                const posRisk = await getCachedPositionRisk(bot, 0) || [];
                const realP = posRisk.find(p => p.symbol === symbol && p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
                if (realP && parseFloat(realP.entryPrice) > 0) {
                    actualFilledPrice = parseFloat(realP.entryPrice);
                } else if (order.average || order.price || parseFloat(order.info?.avgPrice)) {
                    actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice);
                }
            } catch (err) {
                actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            }

            const currentModeIsHell = isDCA ? dcaData.isDiangucMode : isDiangucSignal;
            const dcaType = currentModeIsHell ? bot.botSettings.typeDcaDianguc : bot.botSettings.dcaTypeThuong;
            
            let cumulativeQty = qty;
            let cumulativeCost = qty * actualFilledPrice;
            let newAvgEntry = actualFilledPrice;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage;
            let totalMargin = actualMarginUsed;
            let dcaHistory = [];

            if (isDCA) {
                cumulativeQty = dcaData.cumulativeQty + qty;
                cumulativeCost = dcaData.cumulativeCost + (qty * actualFilledPrice);
                newAvgEntry = cumulativeCost / cumulativeQty;
                totalMargin = dcaData.currentMargin + actualMarginUsed;
                dcaHistory = [...dcaData.dcaHistory, { price: actualFilledPrice, margin: actualMarginUsed }];
            } else {
                dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed }];
                sharedState.dcaAmOpponentClosedProfit[symbol] = false;
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            
            const dcaThreshold = currentModeIsHell ? bot.botSettings.diangucdca : bot.botSettings.posdca;
            const slPercent = currentModeIsHell ? bot.botSettings.diangucsl : bot.botSettings.posSL;
            const tpPercent = currentModeIsHell ? bot.botSettings.dianguctp : bot.botSettings.posTP;

            let nextDCA;
            const dir = (side === 'LONG' ? 1 : -1);

            if (dcaType === 'DUONG') {
                nextDCA = firstE * (1 + dir * ((dcaCount + 1) * dcaThreshold / 100)); 
                if (!isDCA) {
                    finalTP = newAvgEntry * (1 + dir * (tpPercent / 100));
                    finalSL = newAvgEntry * (1 - dir * (slPercent / 100)); 
                } else {
                    finalTP = dcaData.tp; finalSL = dcaData.sl; 
                }
            } else {
                nextDCA = firstE * (1 - dir * ((dcaCount + 1) * dcaThreshold / 100)); 
                const baseProfitFromOriginalEntry = firstE * (tpPercent / 100);
                finalTP = newAvgEntry + dir * baseProfitFromOriginalEntry;
                finalSL = firstE * (1 - dir * (slPercent / 100));
            }

            const nowTime = Date.now();
            bot.botActivePositions.set(lockKey, { 
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, dcaCount: dcaCount, 
                leverage: info.maxLeverage, firstEntry: firstE, firstMargin: isDCA ? dcaData.firstMargin : totalMargin, 
                currentMargin: totalMargin, currentQty: cumulativeQty, 
                cumulativeQty: cumulativeQty, cumulativeCost: cumulativeCost, dcaHistory: dcaHistory,
                isDiangucMode: currentModeIsHell, pnl: 0, profitPercent: 0, 
                avgEntry: newAvgEntry, nextDCA: nextDCA, livePrice: actualFilledPrice,
                createdAt: dcaData ? (dcaData.createdAt || nowTime) : nowTime,
                lastActionTime: nowTime, 
                lastDcaTime: nowTime,
                time: dcaData ? (dcaData.time || new Date().toLocaleTimeString('vi-VN', { hour12: false })) : new Date().toLocaleTimeString('vi-VN', { hour12: false })
            });
            
            savePositionsToFile();

            if (!isDCA) {
                let volStr = signalVols ? ` | M1: ${signalVols.m1} M5: ${signalVols.m5} M15: ${signalVols.m15}` : '';
                const logStr = `[MỞ ${side}][CHẾ ĐỘ: ${currentModeIsHell ? "ĐỊA NGỤC" : "THƯỜNG"}] ${symbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry Sàn: ${newAvgEntry.toFixed(pPrec)}${volStr} | Mốc DCA kế: ${nextDCA.toFixed(pPrec)} | TP Bộ nhớ: ${finalTP.toFixed(pPrec)} | SL Bộ nhớ: ${finalSL.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "open", null, currentModeIsHell); 
            } else {
                const historyPricesStr = dcaHistory.map(h => h.price.toFixed(pPrec)).join(' ➔ ');
                const logStr = `[DCA] ${symbol} | Cấp ${dcaCount} | Vốn tổng: ${totalMargin.toFixed(2)}$ | Chuỗi giá: [ ${historyPricesStr} ] | Avg Mới: ${newAvgEntry.toFixed(pPrec)} | TP Mới: ${finalTP.toFixed(pPrec)} | SL Giữ nguyên: ${finalSL.toFixed(pPrec)}`;
                addBotLog(bot, logStr, "dca", null, currentModeIsHell); 
            }
        }
    } catch (e) { 
        const errKey = `${symbol}_${e.message}`;
        const now = Date.now();
        const errMsgDetails = e?.response?.data?.msg || e?.stack || e?.message || String(e);
        if (!sharedState.errorSpamGuard[errKey] || now - sharedState.errorSpamGuard[errKey] > 3600000) { 
            sharedState.errorSpamGuard[errKey] = now;
            if (e.message?.includes('2019') || e.message?.includes('Notional')) {
                addBotLog(bot, `❌ [MIN SÀN CHẶN] ${symbol} yêu cầu volume to hơn! Chi tiết: ${errMsgDetails}`, "error"); 
            } else {
                addBotLog(bot, `❌ [LỖI MỞ LỆNH] ${symbol}: ${errMsgDetails}`, "error"); 
            }
        }
        checkAndAddBlacklist(symbol);
    } finally { 
        setTimeout(() => {
            bot.isProcessingDCA.delete(lockKey);
            if (dcaLockKey) bot.isProcessingDCA.delete(dcaLockKey);
        }, 1000); 
        sharedState.pendingOrders.delete(symbol);
    }
}

async function checkPnlPauseStatus(bot, walletData) {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return;
    const totalWallet = parseFloat(walletData.totalWalletBalance || 0);
    const totalUnl = parseFloat(walletData.totalUnrealizedProfit || 0);
    
    if (totalWallet <= 0) return;
    
    const pnlRatio = (totalUnl / totalWallet) * 100; 
    const maxPause = bot.botSettings.maxPnlPausePct || 5.0;
    const maxResume = bot.botSettings.maxPnlResumePct || 2.5;

    if (!bot.isPnlPaused && pnlRatio <= -maxPause) {
        bot.isPnlPaused = true;
        addBotLog(bot, `🛑 [CẢNH BÁO PNL ÂM TRÂN] PnL chưa ghi nhận âm ${pnlRatio.toFixed(2)}% (vượt mốc -${maxPause}% vốn). TẠM DỪNG QUÉT LỆNH MỚI!`, "warn");
    } else if (bot.isPnlPaused && pnlRatio >= -maxResume) {
        bot.isPnlPaused = false;
        addBotLog(bot, `✅ [PHỤC HỒI PNL] PnL chưa ghi nhận đã hồi về ${pnlRatio.toFixed(2)}% (trên mốc -${maxResume}% vốn). KHÔI PHỤC QUÉT LỆNH MỚI!`, "open");
    }
}

async function checkMarginLimits(bot) {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return;
    const acc = await getCachedAccountData(bot, 4000);
    if (acc && parseFloat(acc.totalMarginBalance) > 0) {
        const availPercent = (parseFloat(acc.availableBalance) / parseFloat(acc.totalMarginBalance)) * 100;
        if (availPercent <= ANTI_LIQUIDATION_LIMIT) { 
            await panicCloseAll(bot, `CHỐNG THANH LÝ ${ANTI_LIQUIDATION_LIMIT}%`); 
            bot.isMarginProtected = false; 
            return; 
        }
        if (!bot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
            bot.isMarginProtected = true; addBotLog(bot, `⚠️ CẢNH BÁO: Khả dụng giảm dưới ${MARGIN_PROTECT_LIMIT}%. Dừng quét lệnh mới!`, "warn");
        } else if (bot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            bot.isMarginProtected = false; addBotLog(bot, `✅ Khả dụng phục hồi trên ${MARGIN_RECOVER_LIMIT}%. Mở lại quét lệnh.`, "open");
        }
    }
}

function allowCors(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

const appServer = express(); appServer.use(allowCors); appServer.use(express.json()); appServer.use(express.static(__dirname, { index: false })); 
const appBot1 = express(); appBot1.use(allowCors); appBot1.use(express.json()); appBot1.use(express.static(__dirname));
const appBot2 = express(); appBot2.use(allowCors); appBot2.use(express.json()); appBot2.use(express.static(__dirname));

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'sever.html')));

async function buildStatusResponse(bot, cacheObj) {
    const now = Date.now();
    if (now - cacheObj.lastUpdate > 8000) {
        const acc = await getCachedAccountData(bot, 4000);
        if (acc) {
            cacheObj.data = { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
            };
            cacheObj.lastUpdate = now;
        }
    }

    await checkPnlPauseStatus(bot, cacheObj.data);

    const posRisk = await getCachedPositionRisk(bot, 2000) || [];
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }

    let b1Unrealized = 0;
    bot1.botActivePositions.forEach(p => { b1Unrealized += (p.pnl || 0); });
    
    let b2Unrealized = 0;
    bot2.botActivePositions.forEach(p => { b2Unrealized += (p.pnl || 0); });

    const sortedPositions = Array.from(bot.botActivePositions.values())
        .map(p => {
            const openDurationMs = now - (p.createdAt || now);
            return {
                ...p,
                openDurationStr: formatDuration(openDurationMs)
            };
        })
        .sort((a, b) => (a.pnl || 0) - (b.pnl || 0));

    const botPositionKeys = new Set(bot.botActivePositions.keys());
    const botExchangePositions = posRisk.filter(p => botPositionKeys.has(`${p.symbol}_${p.positionSide}`) && Math.abs(parseFloat(p.positionAmt)) > 0);

    return { 
        botSettings: bot.botSettings, 
        activePositions: sortedPositions, 
        exchangePositions: botExchangePositions, 
        status: { 
            botLogs: bot.status.botLogs, 
            botClosedCount: bot.status.botClosedCount, 
            botPnLClosed: bot.status.botPnLClosed, 
            pnlGain: bot.status.pnlGain || 0, 
            pnlLoss: bot.status.pnlLoss || 0, 
            isReady: bot.status.isReady, 
            isPnlPaused: bot.isPnlPaused,
            candidatesList: sharedState.candidatesList, 
            blackList: formattedBlacklist, 
            permanentBlacklist: sharedState.permanentBlacklist, 
            exchangeInfo: sharedState.exchangeInfo, 
            timeRun: formatUptime(bot.startTime) 
        }, 
        wallet: {
            ...cacheObj.data,
            bot1UnrealizedPnL: b1Unrealized.toFixed(2),
            bot2UnrealizedPnL: b2Unrealized.toFixed(2)
        }, 
        timeRun: formatUptime(bot.startTime)
    };
}

const handleQuickCloseSymbol = async (bot, req, res) => {
    const { symbol } = req.body;
    let foundSide = null;
    for (let [key, b] of bot.botActivePositions) { if (b.symbol === symbol) { foundSide = b.side; break; } }
    if (!foundSide) {
        const otherBot = bot.id === 'BOT_1' ? bot2 : bot1;
        const otherHas = Array.from(otherBot.botActivePositions.values()).some(b => b.symbol === symbol);
        if (!otherHas) {
            try {
                const posRisk = await getCachedPositionRisk(bot, 0) || [];
                const p = posRisk.find(x => x.symbol === symbol && Math.abs(parseFloat(x.positionAmt)) > 0);
                if (p) foundSide = p.positionSide;
            } catch(e){}
        }
    }
    if (!foundSide) return res.json({ success: false, msg: "Không thấy vị thế" });
    const key = `${symbol}_${foundSide}`; const b = bot.botActivePositions.get(key);
    if (b) {
        queueClosePosition(bot, b, b.livePrice, "ĐÓNG NHANH TỪ UI");
        return res.json({ success: true });
    } else {
        try {
            const posRisk = await getCachedPositionRisk(bot, 0) || [];
            const p = posRisk.find(x => x.symbol === symbol && x.positionSide === foundSide && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) await bot.exchange.createOrder(symbol, 'MARKET', foundSide === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: foundSide });
            res.json({ success: true });
        } catch (e) { res.json({ success: false, msg: e.message }); }
    }
};

appServer.post('/api/settings', (req, res) => {
    bot1.botSettings = parseNormalizedSettings(req.body, bot1.botSettings);
    bot2.botSettings = parseNormalizedSettings(req.body, bot2.botSettings);
    saveSettingsToFile();
    res.json({ success: true, msg: "Cập nhật cấu hình hệ thống thành công!" });
});

appServer.get('/api/status', async (req, res) => {
    const masterData = await buildStatusResponse(bot1, walletCache1);
    masterData.status.botLogs = sharedState.masterLogs; 
    
    const posRisk = await getCachedPositionRisk(bot1, 2000) || [];
    masterData.exchangePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
    
    res.json(masterData);
});

appBot1.post('/api/settings', (req, res) => { 
    bot1.botSettings = parseNormalizedSettings(req.body, bot1.botSettings);
    saveSettingsToFile();
    res.json({ success: true, msg: "Cập nhật riêng lẻ Bot 1 thành công!" }); 
});
appBot2.post('/api/settings', (req, res) => { 
    bot2.botSettings = parseNormalizedSettings(req.body, bot2.botSettings);
    saveSettingsToFile();
    res.json({ success: true, msg: "Cập nhật riêng lẻ Bot 2 thành công!" }); 
});

appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1, walletCache1)));
appBot1.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot1, "PANIC CLOSE BOT 1")));
appBot1.post('/api/close_position', async (req, res) => { 
    const { symbol, side } = req.body; 
    const key = `${symbol}_${side}`; 
    const b = bot1.botActivePositions.get(key); 
    if (b) { 
        queueClosePosition(bot1, b, b.livePrice, "ĐÓNG THỦ CÔNG");
        return res.json({ success: true }); 
    } else { 
        if (bot2.botActivePositions.has(key)) {
            return res.json({ success: false, msg: "Vị thế thuộc về Bot 2" });
        }
        try { 
            const posRisk = await getCachedPositionRisk(bot1, 0) || []; 
            const p = posRisk.find(x => x.symbol === symbol && x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0); 
            if (p) await bot1.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side }); 
            res.json({ success: true }); 
        } catch (e) { res.json({ success: false, msg: e.message }); } 
    } 
});
appBot1.post('/api/close_symbol', (req, res) => handleQuickCloseSymbol(bot1, req, res));

appBot2.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot2, walletCache2)));
appBot2.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot2, "PANIC CLOSE BOT 2")));
appBot2.post('/api/close_position', async (req, res) => { 
    const { symbol, side } = req.body; 
    const key = `${symbol}_${side}`; 
    const b = bot2.botActivePositions.get(key); 
    if (b) { 
        queueClosePosition(bot2, b, b.livePrice, "ĐÓNG THỦ CÔNG");
        return res.json({ success: true }); 
    } else { 
        if (bot1.botActivePositions.has(key)) {
            return res.json({ success: false, msg: "Vị thế thuộc về Bot 1" });
        }
        try { 
            const posRisk = await getCachedPositionRisk(bot2, 0) || []; 
            const p = posRisk.find(x => x.symbol === symbol && x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0); 
            if (p) await bot2.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side }); 
            res.json({ success: true }); 
        } catch (e) { res.json({ success: false, msg: e.message }); } 
    } 
});
appBot2.post('/api/close_symbol', (req, res) => handleQuickCloseSymbol(bot2, req, res));

function adoptOrphanPosition(targetBot, realP) {
    const symbol = realP.symbol;
    const side = realP.positionSide || (parseFloat(realP.positionAmt) > 0 ? 'LONG' : 'SHORT');
    const key = `${symbol}_${side}`;
    const qty = Math.abs(parseFloat(realP.positionAmt));
    const entryPrice = parseFloat(realP.entryPrice);
    const leverage = parseInt(realP.leverage) || 20;

    const isDiangucMode = false;
    const dcaType = isDiangucMode ? (targetBot.botSettings.typeDcaDianguc || targetBot.botSettings.dcaTypeDianguc) : (targetBot.botSettings.typeDcaThuong || targetBot.botSettings.dcaTypeThuong);
    const slPercent = isDiangucMode ? targetBot.botSettings.diangucsl : targetBot.botSettings.posSL;
    const tpPercent = isDiangucMode ? targetBot.botSettings.dianguctp : targetBot.botSettings.posTP;
    const dcaThreshold = isDiangucMode ? targetBot.botSettings.diangucdca : targetBot.botSettings.posdca;

    const dir = (side === 'LONG' ? 1 : -1);
    let finalTP, finalSL, nextDCA;

    if (dcaType === 'DUONG') {
        nextDCA = entryPrice * (1 + dir * (dcaThreshold / 100));
        finalTP = entryPrice * (1 + dir * (tpPercent / 100));
        finalSL = entryPrice * (1 - dir * (slPercent / 100));
    } else {
        nextDCA = entryPrice * (1 - dir * (dcaThreshold / 100));
        finalTP = entryPrice * (1 + dir * (tpPercent / 100));
        finalSL = entryPrice * (1 - dir * (slPercent / 100));
    }

    const nowTime = Date.now();
    const totalMargin = (qty * entryPrice) / leverage;

    targetBot.botActivePositions.set(key, {
        symbol,
        side,
        entryPrice: entryPrice,
        tp: finalTP,
        sl: finalSL,
        dcaCount: 0,
        leverage: leverage,
        firstEntry: entryPrice,
        firstMargin: totalMargin,
        currentMargin: totalMargin,
        currentQty: qty,
        cumulativeQty: qty,
        cumulativeCost: qty * entryPrice,
        dcaHistory: [{ price: entryPrice, margin: totalMargin }],
        isDiangucMode: false,
        pnl: parseFloat(realP.unRealizedProfit || 0),
        profitPercent: 0,
        avgEntry: entryPrice,
        nextDCA: nextDCA,
        livePrice: parseFloat(realP.markPrice || entryPrice),
        createdAt: nowTime,
        lastActionTime: nowTime,
        lastDcaTime: nowTime,
        time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
    });

    addBotLog(targetBot, `📥 [TIẾP QUẢN VỊ THẾ SÀN -> ${targetBot.id}] Khôi phục vị thế thả trôi ${symbol} ${side} | Qty: ${qty} | Avg Entry: ${entryPrice} | TP: ${finalTP.toFixed(4)} | SL: ${finalSL.toFixed(4)}`, "warn");
}

async function syncPositionsWithExchange() {
    try {
        const posRisk = await binancePrivate(bot1, '/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return;

        const realActivePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        const activeKeysOnExchange = new Set(realActivePositions.map(p => `${p.symbol}_${p.positionSide}`));

        // 1. Dọn dẹp Bot 1
        for (let [key, pos] of Array.from(bot1.botActivePositions.entries())) {
            if (!activeKeysOnExchange.has(key)) {
                bot1.botActivePositions.delete(key);
            } else {
                const realP = realActivePositions.find(p => `${p.symbol}_${p.positionSide}` === key);
                if (realP) {
                    pos.avgEntry = parseFloat(realP.entryPrice);
                    pos.livePrice = parseFloat(realP.markPrice);
                    if (!bot2.botActivePositions.has(key)) {
                        pos.currentQty = Math.abs(parseFloat(realP.positionAmt));
                        pos.pnl = parseFloat(realP.unRealizedProfit);
                    }
                }
            }
        }

        // 2. Dọn dẹp Bot 2 độc lập
        for (let [key, pos] of Array.from(bot2.botActivePositions.entries())) {
            if (!activeKeysOnExchange.has(key)) {
                bot2.botActivePositions.delete(key);
            } else {
                const realP = realActivePositions.find(p => `${p.symbol}_${p.positionSide}` === key);
                if (realP) {
                    pos.avgEntry = parseFloat(realP.entryPrice);
                    pos.livePrice = parseFloat(realP.markPrice);
                    if (!bot1.botActivePositions.has(key)) {
                        pos.currentQty = Math.abs(parseFloat(realP.positionAmt));
                        pos.pnl = parseFloat(realP.unRealizedProfit);
                    }
                }
            }
        }

        // 3. Đưa coin thả trôi thực sự chưa được theo dõi vào bot độc lập phù hợp (Khôi phục từ từ có delay tránh spam API)
        for (const p of realActivePositions) {
            const key = `${p.symbol}_${p.positionSide}`;

            // Nếu vị thế đã được Bot 1 hoặc Bot 2 quản lý -> bỏ qua
            if (bot1.botActivePositions.has(key) || bot2.botActivePositions.has(key)) continue;

            // QUAN TRỌNG: Nếu một trong 2 bot đang trong quá trình mở lệnh/DCA vị thế này -> BỎ QUA, không nhận vơ!
            if (bot1.isProcessingDCA.has(key) || bot2.isProcessingDCA.has(key)) continue;

            let adopted = false;
            // Phân bổ vị thế thả trôi độc lập nếu bot đang chạy
            if (bot1.botSettings.isRunning && !bot2.botSettings.isRunning) {
                adoptOrphanPosition(bot1, p);
                adopted = true;
            } else if (bot2.botSettings.isRunning && !bot1.botSettings.isRunning) {
                adoptOrphanPosition(bot2, p);
                adopted = true;
            } else if (bot1.botSettings.isRunning && bot2.botSettings.isRunning) {
                const b1CanAdopt = bot1.botActivePositions.size < bot1.botSettings.maxPositions;
                const b2CanAdopt = bot2.botActivePositions.size < bot2.botSettings.maxPositions;

                if (b1CanAdopt && !b2CanAdopt) {
                    adoptOrphanPosition(bot1, p);
                    adopted = true;
                } else if (b2CanAdopt && !b1CanAdopt) {
                    adoptOrphanPosition(bot2, p);
                    adopted = true;
                } else if (b1CanAdopt && b2CanAdopt) {
                    const b1HasSymbol = Array.from(bot1.botActivePositions.values()).some(pos => pos.symbol === p.symbol);
                    const b2HasSymbol = Array.from(bot2.botActivePositions.values()).some(pos => pos.symbol === p.symbol);

                    if (!b1HasSymbol && b2HasSymbol) {
                        adoptOrphanPosition(bot1, p);
                        adopted = true;
                    } else if (!b2HasSymbol && b1HasSymbol) {
                        adoptOrphanPosition(bot2, p);
                        adopted = true;
                    } else {
                        adoptOrphanPosition(bot1, p);
                        adopted = true;
                    }
                }
            }

            if (adopted) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        savePositionsToFile();
    } catch (e) {
        console.error("Lỗi đồng bộ vị thế:", e.message);
    }
}

async function init() {
    try {
        await bot1.exchange.loadMarkets(); 
        await bot2.exchange.loadMarkets();
        
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(bot1, '/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol); 
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { sharedState.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        loadSettingsFromFile();
        loadPositionsFromFile();
        loadCacheFromFile();

        await new Promise(r => setTimeout(r, 1500));
        await syncPositionsWithExchange();

        bot1.status.isReady = true; 
        bot2.status.isReady = true;
        priceMonitor(bot1); 
        priceMonitor(bot2); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(async () => {
    if (bot1.status.isReady && bot2.status.isReady) {
        await syncPositionsWithExchange();
    }
}, 10000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(async () => {
    await checkMarginLimits(bot1); await checkMarginLimits(bot2);
    if (!bot1.status.isReady || !bot2.status.isReady) return;

    const canBot1Run = bot1.botSettings.isRunning && !bot1.isMarginProtected && !bot1.isPnlPaused && (bot1.botActivePositions.size < bot1.botSettings.maxPositions) && (bot1.isProcessingDCA.size === 0);
    const canBot2Run = bot2.botSettings.isRunning && !bot2.isMarginProtected && !bot2.isPnlPaused && (bot2.botActivePositions.size < bot2.botSettings.maxPositions) && (bot2.isProcessingDCA.size === 0);

    if (!canBot1Run && !canBot2Run) return;

    const targetBotForRisk = bot1.botSettings.isRunning ? bot1 : (bot2.botSettings.isRunning ? bot2 : null);
    if (!targetBotForRisk) return;

    const posRisk = await getCachedPositionRisk(targetBotForRisk, 1500) || [];
    const exchangeSymbolsWithPositions = new Set(posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => p.symbol));

    let minDiangucVol = 999;
    let minScanVol = 999;
    if (canBot1Run) {
        minDiangucVol = Math.min(minDiangucVol, bot1.botSettings.diangucvol || 15);
        minScanVol = Math.min(minScanVol, bot1.botSettings.minVol || 7);
    }
    if (canBot2Run) {
        minDiangucVol = Math.min(minDiangucVol, bot2.botSettings.diangucvol || 15);
        minScanVol = Math.min(minScanVol, bot2.botSettings.minVol || 7);
    }
    if (minDiangucVol === 999) minDiangucVol = 15;
    if (minScanVol === 999) minScanVol = 7;

    let entrySignal = null;
    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol] || sharedState.pendingOrders.has(c.symbol)) continue; 

        const m1 = parseFloat(c.c1 ?? c.m1 ?? c.v1 ?? 0); 
        const m5 = parseFloat(c.c5 ?? c.m5 ?? c.v5 ?? 0); 
        const m15 = parseFloat(c.c15 ?? c.m15 ?? c.v15 ?? 0);
        let vols = { m1, m5, m15 };
        
        let isHell = false; let hellSide = 'SHORT';
        for (const tf of SCAN_CONFIG.DIA_NGUC) {
            const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
            if (Math.abs(val) >= minDiangucVol) { isHell = true; hellSide = val > 0 ? 'LONG' : 'SHORT'; break; }
        }

        const b1Active = Array.from(bot1.botActivePositions.values()).filter(p => p.symbol === c.symbol);
        const b2Active = Array.from(bot2.botActivePositions.values()).filter(p => p.symbol === c.symbol);
        const hasNormalPos = (bot1.botSettings.isRunning && b1Active.some(p => !p.isDiangucMode)) || (bot2.botSettings.isRunning && b2Active.some(p => !p.isDiangucMode));
        
        const manualPos = posRisk.filter(p => p.symbol === c.symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
        const trackedCount = (bot1.botSettings.isRunning ? b1Active.length : 0) + (bot2.botSettings.isRunning ? b2Active.length : 0);
        const hasManualNotTracked = manualPos.length > trackedCount;

        if (isHell) {
            const needsOverride = hasNormalPos || hasManualNotTracked;
            entrySignal = { symbol: c.symbol, side: hellSide, isDianguc: true, override: needsOverride, vols };
            break; 
        }

        if (!entrySignal && !exchangeSymbolsWithPositions.has(c.symbol)) {
            let isNormal = false; let normalSide = 'SHORT';
            for (const tf of SCAN_CONFIG.THUONG) {
                const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
                if (Math.abs(val) >= minScanVol) { isNormal = true; normalSide = val > 0 ? 'LONG' : 'SHORT'; break; }
            }
            if (isNormal) {
                entrySignal = { symbol: c.symbol, side: normalSide, isDianguc: false, override: false, vols };
                break;
            }
        }
    }

    if (entrySignal) {
        const symbol = entrySignal.symbol;

        if (sharedState.pendingOrders.has(symbol)) return;
        sharedState.pendingOrders.add(symbol);
        setTimeout(() => sharedState.pendingOrders.delete(symbol), 8000); 

        if (entrySignal.override) {
            if (bot1.botSettings.isRunning) addBotLog(bot1, `🔥 ĐỊA NGỤC KÍCH HOẠT! Giải phóng vị thế cũ tại ${symbol}.`, "warn", null, true);
            if (bot2.botSettings.isRunning) addBotLog(bot2, `🔥 ĐỊA NGỤC KÍCH HOẠT! Giải phóng vị thế cũ tại ${symbol}.`, "warn", null, true);
            
            const forceCloseSymbol = async (bot) => {
                if (!bot.botSettings.isRunning) return;
                const pr = await getCachedPositionRisk(bot, 0) || [];
                for (const p of pr.filter(x => x.symbol === symbol)) {
                    const amt = parseFloat(p.positionAmt);
                    if (Math.abs(amt) > 0) {
                        const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                        await bot.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide }).catch(() => {});
                    }
                }
                bot.botActivePositions.forEach((v, k) => { if (v.symbol === symbol) bot.botActivePositions.delete(k); });
                savePositionsToFile();
            };
            
            await Promise.all([forceCloseSymbol(bot1), forceCloseSymbol(bot2)]);
            await new Promise(r => setTimeout(r, 500)); 
        }

        const info = sharedState.exchangeInfo[symbol];
        if (!info) {
            sharedState.pendingOrders.delete(symbol);
            return;
        }

        const currentPrice = await getCachedTickerPrice(symbol, 1500);
        if (!currentPrice) {
            sharedState.pendingOrders.delete(symbol);
            return;
        }
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        const calcBotParams = async (botInstance) => {
            const acc = await getCachedAccountData(botInstance, 3000);
            if (!acc) return null;
            const snapshotAvailable = parseFloat(acc.availableBalance || 0);
            const marginSetting = botInstance.botSettings.invValue || "1%";
            let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

            let desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
            let finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
            if (finalQty * currentPrice < actualMinNotional) {
                finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
            finalQty = Number(finalQty.toFixed(info.quantityPrecision));
            const finalMargin = (finalQty * currentPrice) / info.maxLeverage;
            return { finalQty, finalMargin };
        };

        if (canBot1Run) {
            const sideForBot1 = bot1.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;
            const p1 = await calcBotParams(bot1);
            if (p1) openPosition(bot1, symbol, null, sideForBot1, p1.finalQty, p1.finalMargin, currentPrice, entrySignal.isDianguc, entrySignal.vols);
        }

        if (canBot2Run) {
            const sideForBot2 = bot2.sideMode === 'REVERSED' ? (entrySignal.side === 'LONG' ? 'SHORT' : 'LONG') : entrySignal.side;
            const p2 = await calcBotParams(bot2);
            if (p2) {
                if (canBot1Run) {
                    setTimeout(() => { openPosition(bot2, symbol, null, sideForBot2, p2.finalQty, p2.finalMargin, currentPrice, entrySignal.isDianguc, entrySignal.vols); }, 1000);
                } else {
                    openPosition(bot2, symbol, null, sideForBot2, p2.finalQty, p2.finalMargin, currentPrice, entrySignal.isDianguc, entrySignal.vols);
                }
            }
        }
    }
}, 2500); 

appServer.listen(1033, () => console.log('🌐 [MAIN MASTER] Port 7444'));
appBot1.listen(1034, () => console.log('📈 [BOT 1 UI] Port 7445'));
appBot2.listen(1035, () => console.log('📉 [BOT 2 UI] Port 7446'));
