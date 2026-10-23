import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const PORT = 6789;
const MIN_NOTIONAL_FORCE = 5.1;

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5']
};

const ANTI_LIQUIDATION_LIMIT = 15;
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
    if (!ms || ms < 0) return '00h 00m 0s';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatPrice(val, defaultPrec = 4) {
    if (val === undefined || val === null || isNaN(val)) return '-';
    const num = parseFloat(val);
    if (num === 0) return '0';
    if (Math.abs(num) >= 1) return num.toFixed(defaultPrec);
    const str = num.toFixed(12);
    const match = str.match(/^0\.(0+)/);
    if (match) return num.toFixed(match[1].length + 4);
    return num.toFixed(defaultPrec);
}

function formatCoinName(symbol) {
    return `<span style="color: #f97316; font-weight: bold;">${symbol}</span>`;
}

let walletCache = { data: { totalWalletBalance: "0", totalMarginBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const POSITIONS_FILE = path.join(__dirname, 'positions.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    top24hList: [],
    topFundingList: [],
    exchangeInfo: null,
    masterLogs: [],
    pendingOrders: new Set(),
    lastClosedMargin: {},
    lastClosedPnl: {}
};

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalized = { ...currentSettings };
    for (let key in reqBody) {
        const val = reqBody[key];
        const lowerKey = key.toLowerCase();
        if (['minvol', 'possl', 'posslduong', 'posdcaam', 'posdcaduong', 'hesodcaam', 'hesodcaduong', 'tpdcaam', 'tpdcaduong', 'minpnltpdcaduong', 'minfd', 'min24h'].includes(lowerKey)) {
            normalized[key] = parseFloat(val);
        } else if (['maxpositions', 'minlev'].includes(lowerKey)) {
            normalized[key] = parseInt(val);
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
            normalized[key] = val === true || val === 'true' || val === 1 || val === '1';
        } else {
            normalized[key] = val; 
        }
    }
    return normalized;
}

function updatePermanentBlacklist() {
    if (!sharedState.exchangeInfo) return;
    const currentMinLev = bot.botSettings.minLev !== undefined ? bot.botSettings.minLev : 50;
    sharedState.permanentBlacklist = {};
    for (const symbol in sharedState.exchangeInfo) {
        if (sharedState.exchangeInfo[symbol].maxLeverage < currentMinLev) {
            sharedState.permanentBlacklist[symbol] = true;
        }
    }
}

let bot = {
    id: "LUFFY_BOT",
    startTime: Date.now(),
    botSettings: {
        isRunning: false,
        enableScanVol: true,
        enableScan24h: false,
        enableScanFunding: false,
        enableScanName: false,
        scanNamesInput: "",
        minFd: 1.0,
        min24h: 0.0,
        enableEarlySL: false,
        lockDcaAmMode: false,
        closeOppositeDcaAm: false,
        invValue: "1%",
        maxPositions: 3,
        minLev: 50,
        minVol: 7,
        posSL: 10.0,
        posSLDuong: 5.0,
        posDcaAm: 3.0,
        posDcaDuong: 1.0,
        heSoDcaAm: 2.0,
        heSoDcaDuong: 2.0,
        tpDcaAm: 10.0,
        tpDcaDuong: 10.0,
        minPnlTpDcaDuong: 10.0
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(),
    isProcessingDCA: new Set(),
    logThrottle: new Map(),
    timestampOffset: 0,
    isMarginProtected: false,
    isAntiLiquidationTriggered: false,
    antiLiquidationCooldownUntil: 0,
    isPnlPaused: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

function getBaseDcaDuongPct(leverage) {
    const lev = parseFloat(leverage) || 50;
    if (lev >= 50) return 2.0;
    if (lev >= 30) return 3.5;
    if (lev >= 20) return 5.0;
    return 10.0;
}

function getEffectivePosDcaDuong(botInst, leverage) {
    const multiplier = botInst.botSettings.posDcaDuong !== undefined ? parseFloat(botInst.botSettings.posDcaDuong) : 1.0;
    return getBaseDcaDuongPct(leverage) * multiplier;
}

function calculatePositionFeeAndFunding(botInst, b, currentPrice) {
    const notional = (b.currentQty || 0) * currentPrice;
    const estimatedFee = notional * 0.0005 * 2;
    let accumulatedFunding = 0;
    if (b.fundingRate !== undefined && b.createdAt) {
        const hoursHeld = (Date.now() - b.createdAt) / (3600 * 1000);
        accumulatedFunding = notional * b.fundingRate * (hoursHeld / 8);
    }
    return { estimatedFee, accumulatedFunding };
}

function getPairNetPnLDetails(botInst, b, currentPrice) {
    const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppKey = `${b.symbol}_${oppSide}`;
    const oppPos = botInst.botActivePositions.get(oppKey);
    const dirB = b.side === 'LONG' ? 1 : -1;
    const dirOpp = oppSide === 'LONG' ? 1 : -1;

    let oppPnL = 0, oppQty = 0, oppAvgEntry = 0, oppIsOpen = false;
    if (oppPos) {
        oppIsOpen = true;
        oppQty = oppPos.currentQty || 0;
        oppAvgEntry = oppPos.avgEntry || oppPos.firstEntry || 0;
        oppPnL = dirOpp * (currentPrice - oppAvgEntry) * oppQty;
    } else {
        oppPnL = sharedState.lastClosedPnl[oppKey] || 0;
    }

    const bQty = b.currentQty || 0;
    const bAvgEntry = b.avgEntry || b.firstEntry || 0;
    const feeAndFd = calculatePositionFeeAndFunding(botInst, b, currentPrice);
    const bPnL = dirB * (currentPrice - bAvgEntry) * bQty;
    const pairNetPnL = bPnL + oppPnL - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);

    return { oppPos, oppPnL, oppQty, oppAvgEntry, oppIsOpen, fee: feeAndFd.estimatedFee, fd: feeAndFd.accumulatedFunding, pairNetPnL, bQty, bAvgEntry, dirB, dirOpp };
}

function calculatePriceForTargetNetPnL(botInst, b, targetNetPnL, currentPrice) {
    const details = getPairNetPnLDetails(botInst, b, currentPrice);
    const { oppIsOpen, oppQty, oppAvgEntry, oppPnL, bQty, bAvgEntry, dirB, dirOpp } = details;
    let K = 0, C = 0;
    if (oppIsOpen) {
        K = (dirB * bQty) + (dirOpp * oppQty) - (0.001 * (bQty + oppQty));
        C = -(dirB * bAvgEntry * bQty) - (dirOpp * oppAvgEntry * oppQty);
    } else {
        K = (dirB * bQty) - (0.001 * bQty);
        C = -(dirB * bAvgEntry * bQty) + oppPnL;
    }
    if (Math.abs(K) < 1e-8) return currentPrice;
    const targetPrice = (targetNetPnL - C) / K;
    return targetPrice > 0 ? targetPrice : currentPrice;
}

function calculateDcaDuongMargin(botInst, b) {
    const oppositeSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppPos = botInst.botActivePositions.get(`${b.symbol}_${oppositeSide}`);
    const heSo = botInst.botSettings.heSoDcaDuong || 2.0;
    if (oppPos) return (oppPos.currentMargin || oppPos.firstMargin || 0) * heSo;
    return (b.firstMargin || 1) * heSo;
}

function calculateDcaAmMargin(botInst, b) {
    return (b.firstMargin || 1) * (botInst.botSettings.heSoDcaAm || 2.0);
}

function calculateSlDetails(botInst, b) {
    if (botInst.botSettings.enableEarlySL && (b.dcaDuongCount || 0) >= 1) {
        const earlySlTarget = b.side === 'LONG' ? (b.avgEntry + (b.firstEntry * 0.007)) : (b.avgEntry - (b.firstEntry * 0.007));
        return { targetSlPrice: earlySlTarget, estPnl: -1 * Math.abs(earlySlTarget - b.avgEntry) * b.currentQty };
    }
    const isAmMode = (b.dcaType === 'AM') || (b.pnl < 0) || b.isLockedAm;
    const slLimitValue = isAmMode ? (botInst.botSettings.posSL || 10.0) : ((b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0));
    const targetSlPrice = calculatePriceForTargetNetPnL(botInst, b, -slLimitValue, b.livePrice || b.avgEntry);
    return { targetSlPrice, estPnl: -slLimitValue };
}

let positionRiskCache = { data: null, lastUpdate: 0 };
async function getCachedPositionRisk(botInst, maxAgeMs = 300) {
    const now = Date.now();
    if (positionRiskCache.data && (now - positionRiskCache.lastUpdate < maxAgeMs)) return positionRiskCache.data;
    try {
        const data = await binancePrivate(botInst, '/fapi/v2/positionRisk');
        if (Array.isArray(data)) {
            positionRiskCache.data = data;
            positionRiskCache.lastUpdate = now;
            return data;
        }
    } catch (e) { if (positionRiskCache.data) return positionRiskCache.data; }
    return null;
}

let tickerCache = { data: {}, lastUpdate: 0 };
async function getCachedTickerPrice(symbol, maxAgeMs = 300) {
    const now = Date.now();
    if (tickerCache.data[symbol] && (now - tickerCache.data[symbol].lastUpdate < maxAgeMs)) return tickerCache.data[symbol].price;
    try {
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);
        tickerCache.data[symbol] = { price, lastUpdate: now };
        return price;
    } catch (e) {
        if (tickerCache.data[symbol]) return tickerCache.data[symbol].price;
        throw e;
    }
}

const leverageSetCache = new Set();
async function setLeverageIfNeeded(botInst, symbol, maxLeverage) {
    const key = `${botInst.id}_${symbol}_${maxLeverage}`;
    if (leverageSetCache.has(key)) return;
    try { await botInst.exchange.setLeverage(maxLeverage, symbol); leverageSetCache.add(key); } catch (e) {}
}

function savePositionsToFile() {
    try { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(Array.from(bot.botActivePositions.entries()), null, 2), 'utf-8'); } catch (e) {}
}

function loadPositionsFromFile() {
    try {
        if (!fs.existsSync(POSITIONS_FILE)) return;
        const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
        if (Array.isArray(data)) bot.botActivePositions = new Map(data);
    } catch (e) {}
}

function saveSettingsToFile() {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(bot.botSettings, null, 2), 'utf-8'); } catch (e) {}
}

function loadSettingsFromFile() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return;
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        if (data) { bot.botSettings = parseNormalizedSettings(data, bot.botSettings); updatePermanentBlacklist(); }
    } catch (e) {}
}

function addBotLog(botInst, msg, type = 'open', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        if (now - (botInst.logThrottle.get(throttleKey) || 0) < 10000) return;
        botInst.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    botInst.status.botLogs.unshift({ time, msg, type, botId: botInst.id });
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
    console.log(`[${time}][${botInst.id}][${type.toUpperCase()}] ${msg.replace(/<[^>]*>/g, '')}`);
}

async function binancePrivate(botInst, endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + botInst.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await botInst.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            botInst.timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(botInst, endpoint, method, data);
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
    sharedState.blackList[symbol] = Date.now() + (30 * 1000); 
}

const closeQueue = [];
let isProcessingCloseQueue = false;

async function processCloseQueue() {
    if (isProcessingCloseQueue) return;
    isProcessingCloseQueue = true;
    while (closeQueue.length > 0) {
        const task = closeQueue.shift();
        try { await task(); } catch (e) {}
        if (closeQueue.length > 0) await new Promise(r => setTimeout(r, 3000));
    }
    isProcessingCloseQueue = false;
}

function queueClosePosition(botInst, b, markP, reasonStr) {
    const key = `${b.symbol}_${b.side}`;
    if (b.isClosing) return;
    b.isClosing = true;
    botInst.isProcessingDCA.add(key);
    checkAndAddBlacklist(b.symbol);

    closeQueue.asyncTask = closeQueue.push(async () => {
        try {
            const success = await executeClosePositionAndLog(botInst, b, markP, reasonStr);
            if (success) { botInst.botActivePositions.delete(key); savePositionsToFile(); }
            else b.isClosing = false;
        } catch (e) { b.isClosing = false; }
        finally { botInst.isProcessingDCA.delete(key); }
    });
    processCloseQueue();
}

async function executeClosePositionAndLog(botInst, b, markP, reasonStr) {
    let finalPnL = 0;
    try {
        const posRisk = await getCachedPositionRisk(botInst, 0) || [];
        const realP = posRisk.find(p => p.symbol === b.symbol && p.positionSide === b.side && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (realP) {
            const closeQty = Math.abs(parseFloat(realP.positionAmt));
            await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', closeQty, undefined, { positionSide: b.side });
        }
    } catch (e) { return false; }

    await new Promise(r => setTimeout(r, 1000));
    try {
        let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
        const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
        finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);

        sharedState.lastClosedPnl[`${b.symbol}_${b.side}`] = finalPnL;
        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += finalPnL;
        if (finalPnL >= 0) botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
        else botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;

        addBotLog(botInst, `🔒 [ĐÓNG VỊ THẾ | LÝ DO: ${reasonStr}] ${formatCoinName(b.symbol)} ${b.side} | Net PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? "tp" : "sl");
    } catch (e) {}
    return true;
}

async function panicCloseAll(botInst, reasonLog) {
    try {
        const posRisk = await getCachedPositionRisk(botInst, 0) || [];
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        for (const p of active) {
            await botInst.exchange.createOrder(p.symbol, 'MARKET', p.positionSide === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: p.positionSide });
        }
        botInst.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(botInst, `⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] (${reasonLog})`, "warn");
        return { success: true, count: active.length };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function priceMonitor(botInst) {
    if (!botInst.status.isReady) return setTimeout(() => priceMonitor(botInst), 300);
    try {
        if (!botInst.botSettings.isRunning) return setTimeout(() => priceMonitor(botInst), 300);
        const posRisk = await getCachedPositionRisk(botInst, 300);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(() => priceMonitor(botInst), 300);

        for (let [key, b] of Array.from(botInst.botActivePositions.entries())) {
            if (b.isClosing) continue;
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                b.currentQty = Math.abs(parseFloat(realP.positionAmt));
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.livePrice = parseFloat(realP.markPrice);
                b.avgEntry = parseFloat(realP.entryPrice) || b.avgEntry;
                savePositionsToFile();
            } else {
                botInst.botActivePositions.delete(key);
                savePositionsToFile();
            }
        }
    } catch (e) {}
    setTimeout(() => priceMonitor(botInst), 300);
}

async function openPosition(botInst, symbol, dcaData = null, forcedSide = 'LONG', sharedQty = null, sharedMargin = null, sharedPrice = null, modeName = 'vol') {
    const side = forcedSide;
    const lockKey = `${symbol}_${side}`;
    if (botInst.isProcessingDCA.has(lockKey)) return;
    botInst.isProcessingDCA.add(lockKey);

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) return;

        let qty = sharedQty, margin = sharedMargin, currentPrice = sharedPrice;
        await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
        
        const order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        let actualFilledPrice = parseFloat(order.average || order.price || currentPrice);

        const posData = {
            symbol, side, entryPrice: actualFilledPrice, avgEntry: actualFilledPrice,
            leverage: info.maxLeverage, firstEntry: actualFilledPrice, firstMargin: margin,
            currentMargin: margin, currentQty: qty, pnl: 0, modeName,
            slProgress: 35, tpProgress: 60, isTrailing: false,
            slCalculatedPrice: formatPrice(actualFilledPrice * 0.95),
            tpCalculatedPrice: formatPrice(actualFilledPrice * 1.05),
            createdAt: Date.now()
        };

        botInst.botActivePositions.set(lockKey, posData);
        savePositionsToFile();
        addBotLog(botInst, `[MỞ ${side} | CHẾ ĐỘ: ${modeName.toUpperCase()}] ${formatCoinName(symbol)} | Margin: ${margin.toFixed(2)}$ | Entry: ${formatPrice(actualFilledPrice)}`, "open");
    } catch (e) {
        checkAndAddBlacklist(symbol);
    } finally {
        setTimeout(() => botInst.isProcessingDCA.delete(lockKey), 1000);
    }
}

async function openPositionPair(botInst, symbol, modeName = 'vol', extraLogInfo = '') {
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;
    const currentPrice = await getCachedTickerPrice(symbol, 300).catch(() => null);
    if (!currentPrice) return;

    const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
    const availBal = parseFloat(acc?.availableBalance || 100);
    const calculatedMargin = Math.max(10, availBal * 0.01);
    let desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
    let finalQty = Math.max(Math.floor(desiredQty / info.stepSize) * info.stepSize, info.stepSize);

    await Promise.all([
        openPosition(botInst, symbol, null, 'LONG', finalQty, calculatedMargin, currentPrice, modeName),
        openPosition(botInst, symbol, null, 'SHORT', finalQty, calculatedMargin, currentPrice, modeName)
    ]);
}

function allowCors(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

const appServer = express();
appServer.use(allowCors);
appServer.use(express.json());
appServer.use(express.static(__dirname, { index: false }));

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function buildStatusResponse(botInst) {
    const now = Date.now();
    if (now - walletCache.lastUpdate > 3000) {
        const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
        if (acc) {
            walletCache.data = { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
            };
            walletCache.lastUpdate = now;
        }
    }

    const posRisk = await getCachedPositionRisk(botInst, 300) || [];
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }

    let unrealizedPnL = 0;
    botInst.botActivePositions.forEach(p => { unrealizedPnL += (p.pnl || 0); });

    const sortedPositions = Array.from(botInst.botActivePositions.values());
    const exchangePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => ({
        ...p,
        margin: ((Math.abs(parseFloat(p.positionAmt)) * parseFloat(p.entryPrice)) / (parseFloat(p.leverage) || 20)).toFixed(2)
    }));

    return { 
        botSettings: botInst.botSettings, 
        activePositions: sortedPositions, 
        exchangePositions, 
        status: { 
            botLogs: botInst.status.botLogs, 
            botClosedCount: botInst.status.botClosedCount, 
            botPnLClosed: botInst.status.botPnLClosed, 
            isReady: botInst.status.isReady, 
            candidatesList: sharedState.candidatesList,
            top24hList: sharedState.top24hList,
            topFundingList: sharedState.topFundingList,
            blackList: formattedBlacklist, 
            timeRun: formatUptime(botInst.startTime) 
        }, 
        wallet: { ...walletCache.data, unrealizedPnL: unrealizedPnL.toFixed(2) }
    };
}

appServer.post('/api/settings', (req, res) => {
    bot.botSettings = parseNormalizedSettings(req.body, bot.botSettings);
    saveSettingsToFile();
    updatePermanentBlacklist();
    res.json({ success: true, msg: "Cập nhật cấu hình thành công!" });
});

appServer.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot)));
appServer.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot, "ĐÓNG TOÀN BỘ TỪ DASHBOARD")));

appServer.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body;
    const b = bot.botActivePositions.get(`${symbol}_${side}`);
    if (b) { queueClosePosition(bot, b, b.livePrice, "ĐÓNG THỦ CÔNG"); return res.json({ success: true }); }
    try {
        const posRisk = await getCachedPositionRisk(bot, 0) || [];
        const p = posRisk.find(x => x.symbol === symbol && x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
        if (p) await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side });
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

async function init() {
    try {
        await bot.exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(bot, '/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            const b = brk.find(x => x.symbol === s.symbol);
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0),
                maxLeverage: b?.brackets[0]?.initialLeverage || 20
            };
        });
        sharedState.exchangeInfo = temp;
        loadSettingsFromFile();
        loadPositionsFromFile();
        updatePermanentBlacklist();
        bot.status.isReady = true;
        priceMonitor(bot);
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(async () => {
    try {
        const tickerRes = await binanceApi.get('/fapi/v1/ticker/24hr');
        const tickers = tickerRes.data || [];
        sharedState.top24hList = tickers.map(t => ({
            symbol: t.symbol,
            price: parseFloat(t.lastPrice || 0),
            priceChangePercent: parseFloat(t.priceChangePercent || 0),
            leverage: sharedState.exchangeInfo?.[t.symbol]?.maxLeverage || 20
        })).sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
    } catch (e) {}
}, 5000);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY MATRIX BOT 3D] Đã chạy trên port ${PORT}`));
