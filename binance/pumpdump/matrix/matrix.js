import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const PORT = 6789;
const MIN_NOTIONAL_FORCE = 5.1;
const MAX_DCA_LEVEL = 999999; 

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
    if (!ms || ms < 0) return '00h 00m 00s';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const hStr = hours.toString().padStart(2, '0');
    const mStr = minutes.toString().padStart(2, '0');
    const sStr = seconds.toString().padStart(2, '0');
    return `${hStr}h ${mStr}s ${sStr}s`;
}

function formatPrice(val, defaultPrec = 4) {
    if (val === undefined || val === null || isNaN(val)) return '-';
    const num = parseFloat(val);
    if (num === 0) return '0';
    if (Math.abs(num) >= 1) {
        return num.toFixed(defaultPrec);
    }
    const str = num.toFixed(12);
    const match = str.match(/^0\.(0+)/);
    if (match) {
        const zeroCount = match[1].length;
        return num.toFixed(zeroCount + 4);
    }
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
const HISTORY_FILE = path.join(__dirname, 'history.json');
const DEMO_HISTORY_FILE = path.join(__dirname, 'demo_history.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    top24hList: [],
    topFundingList: [],
    topTrendList: [],
    exchangeInfo: null,
    masterLogs: [],
    demoLogs: [],
    demoHistory: [],
    historyRecords: { h24h: [], hFd: [], hVol: [], hTrend: [] },
    errorSpamGuard: {}, 
    pendingOrders: new Set(),
    lastClosedMargin: {},
    lastClosedPnl: {},
    websocketKlineCache: {} // symbol -> { m1: [], m5: [], m15: [], h1: [] }
};

function loadHistoryFromFile() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data) sharedState.historyRecords = data;
        }
        if (fs.existsSync(DEMO_HISTORY_FILE)) {
            const raw = fs.readFileSync(DEMO_HISTORY_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (Array.isArray(data)) sharedState.demoHistory = data;
        }
    } catch (e) {}
}

function saveHistoryToFile() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(sharedState.historyRecords, null, 2), 'utf-8');
        fs.writeFileSync(DEMO_HISTORY_FILE, JSON.stringify(sharedState.demoHistory, null, 2), 'utf-8');
    } catch (e) {}
}

function addHistoryRecord(modeKey, record) {
    if (!sharedState.historyRecords[modeKey]) sharedState.historyRecords[modeKey] = [];
    sharedState.historyRecords[modeKey].unshift(record);
    if (sharedState.historyRecords[modeKey].length > 100) sharedState.historyRecords[modeKey].pop();
    saveHistoryToFile();
}

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalized = { ...currentSettings };
    for (let key in reqBody) {
        const val = reqBody[key];
        const lowerKey = key.toLowerCase();
        if (['minvol', 'possl', 'posslduong', 'posdcaam', 'posdcaduong', 'hesodcaam', 'hesodcaduong', 'tpdcaam', 'tpdcaduong', 'minpnltpdcaduong', 'minfd', 'min24h'].includes(lowerKey)) {
            normalized[key] = parseFloat(val);
        } else if (['maxpositions', 'minlev'].includes(lowerKey)) {
            normalized[key] = parseInt(val);
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enablescantrend', 'enabletptrendprice', 'enablevoltrend', 'enabledemomode', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
            const boolVal = val === true || val === 'true' || val === 1 || val === '1';
            normalized[key] = boolVal;
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
        const info = sharedState.exchangeInfo[symbol];
        if (info.maxLeverage < currentMinLev) {
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
        enableScanTrend: false,
        enableTpTrendPrice: false,
        enableVolTrend: false,
        enableDemoMode: false,
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
    demoActivePositions: new Map(),
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

// TECHNICAL INDICATORS CALCULATION HELPERS
function calculateEMA(prices, period) {
    if (!prices || prices.length === 0) return [];
    let k = 2 / (period + 1);
    let emaArray = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
        emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
    }
    return emaArray;
}

function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 1;
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        let high = candles[i].high;
        let low = candles[i].low;
        let prevClose = candles[i - 1].close;
        let tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    let sum = trs.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (!closes || closes.length < slow + signal) return { macdLine: 0, signalLine: 0, histogram: 0, prevHistogram: 0 };
    let emaFast = calculateEMA(closes, fast);
    let emaSlow = calculateEMA(closes, slow);
    let macdLineArr = emaFast.map((v, i) => v - emaSlow[i]);
    let signalLineArr = calculateEMA(macdLineArr, signal);
    let histArr = macdLineArr.map((v, i) => v - signalLineArr[i]);
    let currentHist = histArr[histArr.length - 1] || 0;
    let prevHist = histArr[histArr.length - 2] || 0;
    let currentMacd = macdLineArr[macdLineArr.length - 1] || 0;
    let currentSignal = signalLineArr[signalLineArr.length - 1] || 0;
    return { macdLine: currentMacd, signalLine: currentSignal, histogram: currentHist, prevHistogram: prevHist };
}

function calculateSupertrend(candles, period = 10, multiplier = 3) {
    if (!candles || candles.length < period) return { isUp: true, line: 0 };
    let atr = calculateATR(candles, period);
    let hlc3 = candles.map(c => (c.high + c.low + c.close) / 3);
    let basicUpperBand = hlc3[hlc3.length - 1] + multiplier * atr;
    let basicLowerBand = hlc3[hlc3.length - 1] - multiplier * atr;
    let close = candles[candles.length - 1].close;
    let isUp = close > basicLowerBand;
    return { isUp, line: isUp ? basicLowerBand : basicUpperBand };
}

function getBaseDcaDuongPct(leverage) {
    const lev = parseFloat(leverage) || 50;
    if (lev >= 50) return 2.0;
    if (lev >= 30) return 3.5;
    if (lev >= 25) return 4.0;
    if (lev >= 20) return 5.0;
    if (lev >= 10) return 10.0;
    return 10.0;
}

function getEffectivePosDcaDuong(botInst, leverage) {
    const multiplier = botInst.botSettings.posDcaDuong !== undefined ? parseFloat(botInst.botSettings.posDcaDuong) : 1.0;
    const basePct = getBaseDcaDuongPct(leverage);
    return basePct * multiplier;
}

function calculatePositionFeeAndFunding(botInst, b, currentPrice) {
    const notional = (b.currentQty || 0) * currentPrice;
    const estimatedFee = notional * 0.0005 * 2;

    let accumulatedFunding = 0;
    if (b.fundingRate !== undefined && b.createdAt) {
        const hoursHeld = (Date.now() - b.createdAt) / (3600 * 1000);
        const fundingPeriods = hoursHeld / 8; 
        accumulatedFunding = notional * b.fundingRate * fundingPeriods;
    }

    return { estimatedFee, accumulatedFunding };
}

function getPairNetPnLDetails(botInst, b, currentPrice) {
    if (b.modeName === 'trend') {
        const dirB = b.side === 'LONG' ? 1 : -1;
        const bQty = b.currentQty || 0;
        const bAvgEntry = b.avgEntry || b.firstEntry || 0;
        const feeAndFd = calculatePositionFeeAndFunding(botInst, b, currentPrice);
        const bPnL = dirB * (currentPrice - bAvgEntry) * bQty;
        return { pairNetPnL: bPnL - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0), oppIsOpen: false };
    }

    const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppKey = `${b.symbol}_${oppSide}`;
    const oppPos = botInst.botActivePositions.get(oppKey);
    const dirB = b.side === 'LONG' ? 1 : -1;
    const dirOpp = oppSide === 'LONG' ? 1 : -1;

    let oppPnL = 0;
    let oppQty = 0;
    let oppAvgEntry = 0;
    let oppIsOpen = false;

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
    const totalFee = feeAndFd.estimatedFee;
    const negativeFdLoss = feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0;

    const bPnL = dirB * (currentPrice - bAvgEntry) * bQty;
    const pairNetPnL = bPnL + oppPnL - totalFee - negativeFdLoss;

    return {
        oppPos, oppPnL, oppQty, oppAvgEntry, oppIsOpen,
        fee: totalFee, fd: feeAndFd.accumulatedFunding, pairNetPnL,
        bQty, bAvgEntry, dirB, dirOpp
    };
}

function calculatePriceForTargetNetPnL(botInst, b, targetNetPnL, currentPrice) {
    const details = getPairNetPnLDetails(botInst, b, currentPrice);
    const { oppIsOpen, oppQty, oppAvgEntry, oppPnL, bQty, bAvgEntry, dirB, dirOpp } = details;

    let K = 0;
    let C = 0;

    if (b.modeName === 'trend') {
        K = (dirB * bQty) - (0.001 * bQty);
        C = -(dirB * bAvgEntry * bQty);
    } else if (oppIsOpen) {
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

function calculateSlDetails(botInst, b) {
    if (b.modeName === 'trend') {
        const firstMargin = b.firstMargin || 1;
        const slLimit = firstMargin * (botInst.botSettings.posSLDuong || 5.0);
        const currentPrice = b.livePrice || b.avgEntry;
        const targetSlPrice = calculatePriceForTargetNetPnL(botInst, b, -slLimit, currentPrice);
        return { targetSlPrice, estPnl: -slLimit, isEarlySL: false };
    }

    if (botInst.botSettings.enableEarlySL && (b.dcaDuongCount || 0) >= 1) {
        const earlySlTarget = b.side === 'LONG' 
            ? (b.avgEntry + (b.firstEntry * 0.007))
            : (b.avgEntry - (b.firstEntry * 0.007));
        const estPnl = (b.side === 'LONG' ? 1 : -1) * (earlySlTarget - b.avgEntry) * b.currentQty;
        return { targetSlPrice: earlySlTarget, estPnl, isEarlySL: true };
    }

    const isAmMode = (b.dcaType === 'AM') || (b.pnl < 0) || b.isLockedAm;
    const firstMargin = b.firstMargin || 1;
    const slLimitValue = isAmMode 
        ? (botInst.botSettings.posSL || 10.0) 
        : (firstMargin * (botInst.botSettings.posSLDuong || 5.0));

    const currentPrice = b.livePrice || b.avgEntry;
    const targetSlPrice = calculatePriceForTargetNetPnL(botInst, b, -slLimitValue, currentPrice);

    return { targetSlPrice: targetSlPrice, estPnl: -slLimitValue, isEarlySL: false };
}

function calculateTpTrendDetails(botInst, b) {
    const dir = b.side === 'LONG' ? 1 : -1;
    if (botInst.botSettings.enableTpTrendPrice) {
        const tpPct = botInst.botSettings.tpDcaDuong || 5.0;
        const targetPrice = b.firstEntry * (1 + dir * (tpPct / 100));
        const details = getPairNetPnLDetails(botInst, b, targetPrice);
        return { targetTpPrice: targetPrice, estPnl: details.pairNetPnL, badge: '✅ TP % Price' };
    } else {
        const minPnlHeSo = botInst.botSettings.minPnlTpDcaDuong !== undefined ? botInst.botSettings.minPnlTpDcaDuong : 10.0;
        const firstMargin = b.firstMargin || 1;
        const minPnlTp = firstMargin * minPnlHeSo;
        const currentPrice = b.livePrice || b.avgEntry;
        const targetPrice = calculatePriceForTargetNetPnL(botInst, b, minPnlTp, currentPrice);
        const details = getPairNetPnLDetails(botInst, b, targetPrice);
        return { targetTpPrice: targetPrice, estPnl: details.pairNetPnL, badge: '✅ TP PnL Min' };
    }
}

function calculateSlPhongHoDetails(botInst, b) {
    if (b.side === 'LONG' || b.modeName === 'trend') {
        return { formattedStr: '--' };
    }
    const slPrice = b.firstEntry * 2.01;
    const estPnl = -1 * (slPrice - b.avgEntry) * b.currentQty;
    return { slPrice, estPnl, formattedStr: `${formatPrice(slPrice)} (${estPnl.toFixed(2)}$)` };
}

let positionRiskCache = { data: null, lastUpdate: 0 };

async function getCachedPositionRisk(botInst, maxAgeMs = 300) {
    const now = Date.now();
    if (positionRiskCache.data && (now - positionRiskCache.lastUpdate < maxAgeMs)) {
        return positionRiskCache.data;
    }
    try {
        const data = await binancePrivate(botInst, '/fapi/v2/positionRisk');
        if (Array.isArray(data)) {
            positionRiskCache.data = data;
            positionRiskCache.lastUpdate = now;
            return data;
        }
    } catch (e) {
        if (positionRiskCache.data) return positionRiskCache.data;
    }
    return null;
}

let tickerCache = { data: {}, lastUpdate: 0 };
async function getCachedTickerPrice(symbol, maxAgeMs = 300) {
    const now = Date.now();
    if (tickerCache.data[symbol] && (now - tickerCache.data[symbol].lastUpdate < maxAgeMs)) {
        return tickerCache.data[symbol].price;
    }
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
    try {
        await botInst.exchange.setLeverage(maxLeverage, symbol);
        leverageSetCache.add(key);
    } catch (e) { }
}

function savePositionsToFile() {
    try {
        const data = Array.from(bot.botActivePositions.entries());
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
}

function loadPositionsFromFile() {
    try {
        if (!fs.existsSync(POSITIONS_FILE)) return;
        const raw = fs.readFileSync(POSITIONS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            bot.botActivePositions = new Map(data);
        }
    } catch (e) {}
}

function saveSettingsToFile() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(bot.botSettings, null, 2), 'utf-8');
    } catch (e) {}
}

function loadSettingsFromFile() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return;
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data) {
            bot.botSettings = parseNormalizedSettings(data, bot.botSettings);
            updatePermanentBlacklist();
        }
    } catch (e) {}
}

function addBotLog(botInst, msg, type = 'open', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        const last = botInst.logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        botInst.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };
    
    botInst.status.botLogs.unshift(logItem);
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
    
    const consoleMsg = msg.replace(/<[^>]*>/g, '');
    console.log(`[${time}][${botInst.id}][${type.toUpperCase()}] ${consoleMsg}`);
}

function addDemoLog(msg) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    sharedState.demoLogs.unshift({ time, msg });
    if (sharedState.demoLogs.length > 200) sharedState.demoLogs.pop();
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
        if (closeQueue.length > 0) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    isProcessingCloseQueue = false;
}

function queueClosePosition(botInst, b, markP, reasonStr) {
    const key = `${b.symbol}_${b.side}`;
    if (b.isClosing) return;
    b.isClosing = true;

    botInst.isProcessingDCA.add(key);
    checkAndAddBlacklist(b.symbol);

    closeQueue.push(async () => {
        try {
            const success = await executeClosePositionAndLog(botInst, b, markP, reasonStr);
            if (success) {
                botInst.botActivePositions.delete(key);
                savePositionsToFile();
                checkAndAddBlacklist(b.symbol);
            } else {
                b.isClosing = false;
            }
        } catch (e) {
            b.isClosing = false;
        } finally {
            botInst.isProcessingDCA.delete(key);
        }
    });

    processCloseQueue();
}

function queueClosePairPositions(botInst, b1, markP1, reasonStr1, b2, markP2, reasonStr2) {
    if (b1) { b1.isClosing = true; botInst.isProcessingDCA.add(`${b1.symbol}_${b1.side}`); checkAndAddBlacklist(b1.symbol); }
    if (b2) { b2.isClosing = true; botInst.isProcessingDCA.add(`${b2.symbol}_${b2.side}`); checkAndAddBlacklist(b2.symbol); }

    closeQueue.push(async () => {
        const closeTasks = [];
        if (b1) {
            closeTasks.push(executeClosePositionAndLog(botInst, b1, markP1, reasonStr1).then(success => {
                if (success) { botInst.botActivePositions.delete(`${b1.symbol}_${b1.side}`); savePositionsToFile(); checkAndAddBlacklist(b1.symbol); }
                else { b1.isClosing = false; }
            }).finally(() => botInst.isProcessingDCA.delete(`${b1.symbol}_${b1.side}`)));
        }
        if (b2) {
            closeTasks.push(executeClosePositionAndLog(botInst, b2, markP2, reasonStr2).then(success => {
                if (success) { botInst.botActivePositions.delete(`${b2.symbol}_${b2.side}`); savePositionsToFile(); checkAndAddBlacklist(b2.symbol); }
                else { b2.isClosing = false; }
            }).finally(() => botInst.isProcessingDCA.delete(`${b2.symbol}_${b2.side}`)));
        }
        await Promise.all(closeTasks);
    });

    processCloseQueue();
}

async function executeClosePositionAndLog(botInst, b, markP, reasonStr) {
    let finalPnL = 0;
    let orderClosedSuccessfully = false;
    checkAndAddBlacklist(b.symbol);

    sharedState.lastClosedMargin[`${b.symbol}_${b.side}`] = b.currentMargin || b.firstMargin;

    try {
        const posRisk = await getCachedPositionRisk(botInst, 0) || [];
        const realP = posRisk.find(p => p.symbol === b.symbol && p.positionSide === b.side && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        if (realP) {
            const exchangeQty = Math.abs(parseFloat(realP.positionAmt));
            const closeQty = Math.min(b.currentQty || exchangeQty, exchangeQty);
            try {
                await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', closeQty, undefined, { positionSide: b.side });
                orderClosedSuccessfully = true;
            } catch (err) {
                orderClosedSuccessfully = true;
            }
        } else {
            orderClosedSuccessfully = true;
        }
    } catch (e) {
        return false;
    }
    
    if (!orderClosedSuccessfully) return false;

    try {
        let trades = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                trades = await binancePrivate(botInst, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 15 });
                if (Array.isArray(trades) && trades.length > 0) break;
            } catch (errTrade) {}
            await new Promise(r => setTimeout(r, 800));
        }

        const closeSide = b.side === 'LONG' ? 'SELL' : 'BUY';
        const nowServer = Date.now() + botInst.timestampOffset;
        const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 60000);

        if (matchingTrades.length > 0) {
            finalPnL = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission || 0), 0);
        } else {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
            finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);
        }

        sharedState.lastClosedPnl[`${b.symbol}_${b.side}`] = finalPnL;
        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += finalPnL;

        if (finalPnL >= 0) botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
        else botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;

        const formattedSymbol = formatCoinName(b.symbol);
        addBotLog(botInst, `🔒 [CHỐT LÃI/LỖ | LÝ DO: ${reasonStr}] ${formattedSymbol} ${b.side} | Mode: [${b.modeName}] | Giá: ${formatPrice(markP)} | Net PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? "tp" : "sl");

        // Record to History Table by Mode
        let historyModeKey = 'hVol';
        if (b.modeName === '24h') historyModeKey = 'h24h';
        else if (b.modeName === 'fd') historyModeKey = 'hFd';
        else if (b.modeName === 'trend') historyModeKey = 'hTrend';

        addHistoryRecord(historyModeKey, {
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
            symbol: b.symbol,
            side: b.side,
            lev: b.leverage || 20,
            margin: b.currentMargin || b.firstMargin || 0,
            entry: b.avgEntry || b.firstEntry,
            closePrice: markP,
            pnl: finalPnL,
            indicators: b.modeName === 'trend' ? `EMA:${b.indEmaPass ? '✅' : '❌'} | Super:${b.indSuperPass ? '✅' : '❌'} | MACD:${b.indMacdPass ? '✅' : '❌'} | Vol:${b.indVolPass ? '✅' : '❌'}` : null
        });

    } catch (e) {}

    return true;
}

async function panicCloseAll(botInst, reasonLog) {
    try {
        const posRisk = await getCachedPositionRisk(botInst, 0) || [];
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        let count = 0;
        for (const p of active) {
            const side = p.positionSide;
            const qty = Math.abs(parseFloat(p.positionAmt));
            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            try {
                await botInst.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                count++;
            } catch (err) {}
        }
        botInst.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(botInst, `⚠️ [ĐÓNG TOÀN BỘ] Đã giải phóng tài khoản (${reasonLog}).`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function priceMonitor(botInst) {
    if (!botInst.status.isReady) return setTimeout(() => priceMonitor(botInst), 300);
    try {
        if (!botInst.botSettings.isRunning) return setTimeout(() => priceMonitor(botInst), 300);
        
        const posRisk = await getCachedPositionRisk(botInst, 300);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(() => priceMonitor(botInst), 300);

        const now = Date.now();
        
        for (let [key, b] of Array.from(botInst.botActivePositions.entries())) {
            if (b.isClosing) continue;

            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;

            if (realP) {
                const exchangeQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);

                b.currentQty = exchangeQty;
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.livePrice = markP;
                b.avgEntry = b.avgEntry || parseFloat(realP.entryPrice) || b.firstEntry;

                const dir = b.side === 'LONG' ? 1 : -1;
                b.profitPercent = dir * ((markP - b.avgEntry) / b.avgEntry) * 100;
                b.peakPrice = b.side === 'LONG' ? Math.max(b.peakPrice || b.firstEntry, markP) : Math.min(b.peakPrice || b.firstEntry, markP);

                const netDetails = getPairNetPnLDetails(botInst, b, markP);
                savePositionsToFile();

                // TREND MODE POSITION MANAGEMENT (NO DCA, CHECK TP & SL)
                if (b.modeName === 'trend') {
                    const tpDet = calculateTpTrendDetails(botInst, b);
                    const slDet = calculateSlDetails(botInst, b);

                    const hitTP = b.side === 'LONG' ? (markP >= tpDet.targetTpPrice) : (markP <= tpDet.targetTpPrice);
                    const hitSL = b.side === 'LONG' ? (markP <= slDet.targetSlPrice) : (markP >= slDet.targetSlPrice);

                    if (hitTP) {
                        queueClosePosition(botInst, b, markP, `CHỐT TP TREND (Giá: ${formatPrice(tpDet.targetTpPrice)})`);
                        continue;
                    }
                    if (hitSL || netDetails.pairNetPnL <= slDet.estPnl) {
                        queueClosePosition(botInst, b, markP, `CẮT LỖ SL TREND (PnL: ${netDetails.pairNetPnL.toFixed(2)}$)`);
                        continue;
                    }
                    continue;
                }

                // REGULAR MODES (24H, FD, VOL) WITH DCA AM / DUONG
                const totalDcaCount = (b.dcaAmCount || 0) + (b.dcaDuongCount || 0);
                let currentDcaMode = b.pnl < 0 ? 'AM' : 'DUONG';
                if (b.isLockedAm) currentDcaMode = 'AM';
                b.dcaType = currentDcaMode;

                const posDcaAm = botInst.botSettings.posDcaAm || 3.0;
                const posDcaDuong = getEffectivePosDcaDuong(botInst, b.leverage || 50);
                const firstE = b.firstEntry || b.avgEntry;

                b.nextDcaAm = firstE * (1 - dir * ((b.dcaAmCount + 1) * posDcaAm / 100));
                b.nextDcaDuong = firstE * (1 + dir * ((b.dcaDuongCount + 1) * posDcaDuong / 100));

                const slDetails = calculateSlDetails(botInst, b);
                b.sl = slDetails.targetSlPrice;

                if (currentDcaMode === 'AM') {
                    const tpDcaAmPct = botInst.botSettings.tpDcaAm || 10.0;
                    const targetTpPrice = b.avgEntry + dir * (b.firstEntry * (tpDcaAmPct / 100));
                    const hitInternalTP = b.side === 'LONG' ? (markP >= targetTpPrice) : (markP <= targetTpPrice);
                    if (hitInternalTP && netDetails.pairNetPnL >= 0) {
                        queueClosePosition(botInst, b, markP, "CHỐT TP DCA ÂM");
                        continue;
                    }
                }

                if (currentDcaMode === 'DUONG') {
                    const minPnlHeSo = botInst.botSettings.minPnlTpDcaDuong !== undefined ? botInst.botSettings.minPnlTpDcaDuong : 10.0;
                    const minPnlTp = (b.firstMargin || 1) * minPnlHeSo;
                    const baseTpPrice = calculatePriceForTargetNetPnL(botInst, b, minPnlTp, markP);
                    const hitTpDuong = b.side === 'LONG' ? (markP <= baseTpPrice) : (markP >= baseTpPrice);
                    if (hitTpDuong && netDetails.pairNetPnL >= minPnlTp) {
                        queueClosePosition(botInst, b, markP, `CHỐT TP DCA DƯƠNG (Net PnL: ${netDetails.pairNetPnL.toFixed(2)}$)`);
                        continue;
                    }
                }

                if (netDetails.pairNetPnL <= slDetails.estPnl) {
                    queueClosePosition(botInst, b, markP, `CẮT LỖ SL PNL CẶP (${netDetails.pairNetPnL.toFixed(2)}$)`);
                    continue;
                }

                const isDcaCooldown = b.lastDcaTime && (now - b.lastDcaTime < 8000);
                if (isDcaCooldown) continue;

                if (currentDcaMode === 'AM' && !b.isClosing) {
                    const hitDcaAm = b.side === 'LONG' ? (markP <= b.nextDcaAm) : (markP >= b.nextDcaAm);
                    if (hitDcaAm && !botInst.isProcessingDCA.has(lockKey)) {
                        botInst.isProcessingDCA.add(lockKey);
                        let marginToUse = (b.firstMargin || 1) * (botInst.botSettings.heSoDcaAm || 2.0);
                        openPosition(botInst, b.symbol, { ...b, dcaType: 'AM', margin: marginToUse }, b.side);
                        continue;
                    }
                }

                if (currentDcaMode === 'DUONG' && !b.isLockedAm && !b.isClosing) {
                    const hitDcaDuong = b.side === 'LONG' ? (markP >= b.nextDcaDuong) : (markP <= b.nextDcaDuong);
                    if (b.pnl > 0 && hitDcaDuong && !botInst.isProcessingDCA.has(lockKey)) {
                        botInst.isProcessingDCA.add(lockKey);
                        let marginToUse = (b.firstMargin || 1) * (botInst.botSettings.heSoDcaDuong || 2.0);
                        openPosition(botInst, b.symbol, { ...b, dcaType: 'DUONG', margin: marginToUse }, b.side);
                        continue;
                    }
                }
            } else {
                if (!botInst.isProcessingDCA.has(lockKey)) {
                    botInst.botActivePositions.delete(key); 
                    savePositionsToFile();
                    checkAndAddBlacklist(b.symbol);
                }
            }
        }
    } catch (e) {}
    setTimeout(() => priceMonitor(botInst), 300);
}

async function openPosition(botInst, symbol, dcaData = null, forcedSide = 'LONG', sharedQty = null, sharedMargin = null, sharedPrice = null, modeName = 'vol', extraLogInfo = '') {
    const side = forcedSide; 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    
    if (isDCA) {
        const activePos = botInst.botActivePositions.get(lockKey);
        if (!activePos || activePos.isClosing) {
            botInst.isProcessingDCA.delete(lockKey);
            return;
        }
    }

    if (botInst.isProcessingDCA.has(lockKey) && !isDCA) return;
    botInst.isProcessingDCA.add(lockKey); 

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) throw new Error("Coin không hỗ trợ");

        let qty = 0, margin = 0, currentPrice = 0;
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        if (isDCA) {
            currentPrice = await getCachedTickerPrice(symbol, 300);
            margin = dcaData.margin;
            let desiredQty = (margin * info.maxLeverage) / currentPrice;
            qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
            if (qty * currentPrice < actualMinNotional) qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            qty = Number(qty.toFixed(info.quantityPrecision)); 
        } else {
            qty = sharedQty;
            margin = sharedMargin;
            currentPrice = sharedPrice;
        }

        await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
        
        let order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            let actualFilledPrice = parseFloat(order.average || order.price || currentPrice);
            if (!actualFilledPrice || actualFilledPrice <= 0) actualFilledPrice = currentPrice;

            let cumulativeQty = qty;
            let cumulativeCost = qty * actualFilledPrice;
            let newAvgEntry = actualFilledPrice;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage;
            let totalMargin = actualMarginUsed;
            let dcaHistory = [];
            let dcaAmCount = 0;
            let dcaDuongCount = 0;

            if (isDCA) {
                cumulativeQty = dcaData.cumulativeQty + qty;
                cumulativeCost = dcaData.cumulativeCost + (qty * actualFilledPrice);
                newAvgEntry = cumulativeCost / cumulativeQty;
                totalMargin = (dcaData.currentMargin || dcaData.firstMargin || 0) + actualMarginUsed;
                dcaHistory = [...dcaData.dcaHistory, { price: actualFilledPrice, margin: actualMarginUsed, type: dcaData.dcaType }];
                dcaAmCount = dcaData.dcaType === 'AM' ? dcaData.dcaAmCount + 1 : dcaData.dcaAmCount;
                dcaDuongCount = dcaData.dcaType === 'DUONG' ? dcaData.dcaDuongCount + 1 : dcaData.dcaDuongCount;
            } else {
                dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed, type: 'ENTRY' }];
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const nowTime = Date.now();
            
            const posData = { 
                symbol, side, entryPrice: firstE, 
                dcaAmCount, dcaDuongCount, dcaCount: dcaAmCount + dcaDuongCount, 
                dcaType: isDCA ? dcaData.dcaType : 'DUONG',
                modeName: isDCA ? dcaData.modeName : modeName,
                fundingRate: 0,
                isLockedAm: false,
                leverage: info.maxLeverage, firstEntry: firstE, firstMargin: isDCA ? dcaData.firstMargin : totalMargin, 
                currentMargin: totalMargin, currentQty: cumulativeQty, 
                cumulativeQty: cumulativeQty, cumulativeCost: cumulativeCost, dcaHistory: dcaHistory,
                pnl: 0, profitPercent: 0, peakPrice: actualFilledPrice,
                avgEntry: newAvgEntry, livePrice: actualFilledPrice,
                createdAt: nowTime, lastActionTime: nowTime, lastDcaTime: nowTime,
                time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
            };

            botInst.botActivePositions.set(lockKey, posData);
            savePositionsToFile();

            const formattedSymbol = formatCoinName(symbol);
            if (!isDCA) {
                addBotLog(botInst, `[MỞ ${side} | CHẾ ĐỘ: ${modeName.toUpperCase()}] ${formattedSymbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${formatPrice(newAvgEntry)} ${extraLogInfo}`, "open"); 
            } else {
                addBotLog(botInst, `[DCA] ${formattedSymbol} ${side} | Margin: ${actualMarginUsed.toFixed(2)}$ | Tổng: ${totalMargin.toFixed(2)}$`, "dca"); 
            }
        }
    } catch (e) { 
        checkAndAddBlacklist(symbol);
    } finally { 
        setTimeout(() => botInst.isProcessingDCA.delete(lockKey), 1000); 
        sharedState.pendingOrders.delete(symbol);
    }
}

async function openPositionPair(botInst, symbol, modeName = 'vol', extraLogInfo = '') {
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;

    const currentPrice = await getCachedTickerPrice(symbol, 300).catch(() => null);
    if (!currentPrice) return;

    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);
    const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
    const snapshotAvailable = parseFloat(acc?.availableBalance || 100);
    const marginSetting = botInst.botSettings.invValue || "1%";
    let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

    let desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
    let finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
    if (finalQty * currentPrice < actualMinNotional) finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
    finalQty = Number(finalQty.toFixed(info.quantityPrecision));
    const finalMargin = (finalQty * currentPrice) / info.maxLeverage;

    await Promise.all([
        openPosition(botInst, symbol, null, 'LONG', finalQty, finalMargin, currentPrice, modeName, extraLogInfo),
        openPosition(botInst, symbol, null, 'SHORT', finalQty, finalMargin, currentPrice, modeName, extraLogInfo)
    ]);
}

// TREND MODE SINGLE POSITION OPENER & DEMO OPENER
async function openTrendPosition(botInst, symbol, side, extraInfo = '') {
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;
    const lockKey = `${symbol}_${side}`;
    if (botInst.botActivePositions.has(lockKey) || botInst.isProcessingDCA.has(lockKey)) return;

    const currentPrice = await getCachedTickerPrice(symbol, 300).catch(() => null);
    if (!currentPrice) return;

    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);
    let calculatedMargin = 10;

    if (botInst.botSettings.enableVolTrend) {
        let capitalInput = parseFloat(botInst.botSettings.invValue) || 100;
        calculatedMargin = capitalInput / info.maxLeverage;
    } else {
        const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
        const snapshotAvailable = parseFloat(acc?.availableBalance || 100);
        const marginSetting = botInst.botSettings.invValue || "1%";
        calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);
    }

    let desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
    let finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
    if (finalQty * currentPrice < actualMinNotional) finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
    finalQty = Number(finalQty.toFixed(info.quantityPrecision));
    const finalMargin = (finalQty * currentPrice) / info.maxLeverage;

    // DEMO MODE HANDLING
    if (botInst.botSettings.enableDemoMode) {
        const demoKey = `${symbol}_${side}`;
        if (botInst.demoActivePositions.has(demoKey)) return;
        const demoPos = {
            symbol, side, leverage: info.maxLeverage,
            margin: 1.0, entry: currentPrice, livePrice: currentPrice,
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
            createdAt: Date.now()
        };
        botInst.demoActivePositions.set(demoKey, demoPos);
        addDemoLog(`[DEMO MỞ ${side}] ${symbol} | Giá: ${formatPrice(currentPrice)} | Margin: $1.00 | ${extraInfo}`);
        return;
    }

    await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
    try {
        const order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', finalQty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        if (order) {
            let actualFilledPrice = parseFloat(order.average || order.price || currentPrice);
            const nowTime = Date.now();
            const posData = {
                symbol, side, entryPrice: actualFilledPrice,
                dcaAmCount: 0, dcaDuongCount: 0, dcaCount: 0, dcaType: 'TREND',
                modeName: 'trend', fundingRate: 0, isLockedAm: false,
                leverage: info.maxLeverage, firstEntry: actualFilledPrice, firstMargin: finalMargin,
                currentMargin: finalMargin, currentQty: finalQty, cumulativeQty: finalQty, cumulativeCost: finalQty * actualFilledPrice,
                dcaHistory: [{ price: actualFilledPrice, margin: finalMargin, type: 'TREND_ENTRY' }],
                pnl: 0, profitPercent: 0, peakPrice: actualFilledPrice,
                avgEntry: actualFilledPrice, livePrice: actualFilledPrice,
                createdAt: nowTime, lastActionTime: nowTime,
                time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
            };
            botInst.botActivePositions.set(lockKey, posData);
            savePositionsToFile();
            addBotLog(botInst, `[MỞ TREND ${side}] ${formatCoinName(symbol)} | Margin: ${finalMargin.toFixed(2)}$ | Entry: ${formatPrice(actualFilledPrice)} ${extraInfo}`, "open");
        }
    } catch (e) {
        checkAndAddBlacklist(symbol);
    }
}

// WEBSOCKET KLINES STREAM FOR ACCURATE INDICATOR CALCULATION
function initWebSocketKlines() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('open', () => {});
    ws.on('message', async (data) => {
        try {
            const arr = JSON.parse(data);
            if (!Array.isArray(arr)) return;
            // Periodically fetch klines for top coins to update indicators
        } catch (e) {}
    });
}

// BACKGROUND TASK FOR CALCULATING TREND INDICATORS AND TOP 10 COINS
async function runTrendAndIndicatorsScan() {
    if (!bot.botSettings.isRunning) return;
    try {
        const tickers = await binanceApi.get('/fapi/v1/ticker/24hr').then(r => r.data).catch(() => []);
        const validSymbols = tickers.filter(t => t.symbol.endsWith('USDT')).map(t => t.symbol);
        
        let scoredCoins = [];
        const currentMinLev = bot.botSettings.minLev || 50;

        for (const sym of validSymbols.slice(0, 40)) { // Sample top 40 to avoid rate limits
            const info = sharedState.exchangeInfo[sym];
            if (!info || info.maxLeverage < currentMinLev) continue;

            // Fetch klines for 1H, 15M, 5M
            const [k1h, k15m, k5m] = await Promise.all([
                binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=1h&limit=50`).then(r => r.data).catch(() => []),
                binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=15m&limit=30`).then(r => r.data).catch(() => []),
                binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=5m&limit=30`).then(r => r.data).catch(() => [])
            ]);

            if (k1h.length < 50 || k15m.length < 20 || k5m.length < 25) continue;

            const closes1h = k1h.map(k => parseFloat(k[4]));
            const ema50_1h = calculateEMA(closes1h, 50);
            const ema200_1h = calculateEMA(closes1h, 200);
            const lastClose1h = closes1h[closes1h.length - 1];
            const ema50Val = ema50_1h[ema50_1h.length - 1];
            const ema200Val = ema200_1h[ema200_1h.length - 1];

            // 1. EMA condition
            const emaLongPass = ema50Val > ema200Val && lastClose1h > ema200Val;
            const emaShortPass = ema50Val < ema200Val && lastClose1h < ema200Val;

            // 2. Supertrend 15m
            const candles15m = k15m.map(k => ({ high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
            const st = calculateSupertrend(candles15m, 10, 3);
            const lastClose15m = candles15m[candles15m.length - 1].close;
            const stLongPass = st.isUp && lastClose15m > st.line;
            const stShortPass = !st.isUp && lastClose15m < st.line;

            // 3. MACD 5m
            const closes5m = k5m.map(k => parseFloat(k[4]));
            const macd = calculateMACD(closes5m, 12, 26, 9);
            const macdLongPass = macd.macdLine > macd.signalLine && macd.histogram > macd.prevHistogram;
            const macdShortPass = macd.macdLine < macd.signalLine && macd.histogram < macd.prevHistogram;

            // 4. Volume 5m
            const vol5m = k5m.map(k => parseFloat(k[5]));
            const avgVol20 = vol5m.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
            const sigVol = vol5m[vol5m.length - 1];
            const volPass = sigVol >= 1.5 * avgVol20;

            // Mini line points (last 3 closes)
            const miniLineStr = `${formatPrice(closes5m[closes5m.length - 3])} ➔ ${formatPrice(closes5m[closes5m.length - 2])} ➔ ${formatPrice(closes5m[closes5m.length - 1])}`;

            let trendSide = null;
            let conditionsPassed = 0;
            if (emaLongPass) conditionsPassed++;
            if (stLongPass) conditionsPassed++;
            if (macdLongPass) conditionsPassed++;
            if (volPass) conditionsPassed++;

            let conditionsShortPassed = 0;
            if (emaShortPass) conditionsShortPassed++;
            if (stShortPass) conditionsShortPassed++;
            if (macdShortPass) conditionsShortPassed++;
            if (volPass) conditionsShortPassed++;

            if (emaLongPass && stLongPass && macdLongPass && volPass) trendSide = 'LONG';
            else if (emaShortPass && stShortPass && macdShortPass && volPass) trendSide = 'SHORT';

            scoredCoins.push({
                symbol: sym,
                price: lastClose1h,
                leverage: info.maxLeverage,
                score: Math.max(conditionsPassed, conditionsShortPassed),
                emaPass: emaLongPass || emaShortPass,
                superPass: stLongPass || stShortPass,
                macdPass: macdLongPass || macdShortPass,
                volPass: volPass,
                trendSide,
                miniLineStr
            });
        }

        scoredCoins.sort((a, b) => b.score - a.score);
        sharedState.topTrendList = scoredCoins.slice(0, 10);

        // Execute trend entries if Trend mode is enabled
        if (bot.botSettings.enableScanTrend) {
            for (const coin of sharedState.topTrendList) {
                if (coin.trendSide && !sharedState.blackList[coin.symbol]) {
                    await openTrendPosition(bot, coin.symbol, coin.trendSide, `| Trend Score: ${coin.score}/4`);
                    break;
                }
            }
        }

    } catch (e) {}
}

setInterval(runTrendAndIndicatorsScan, 15000);

// DEMO POSITION MONITOR (FOR DEMO MODE)
setInterval(() => {
    if (!bot.botSettings.enableDemoMode || bot.demoActivePositions.size === 0) return;
    for (const [key, p] of bot.demoActivePositions.entries()) {
        getCachedTickerPrice(p.symbol, 300).then(currentPrice => {
            const dir = p.side === 'LONG' ? 1 : -1;
            const pnl = dir * (currentPrice - p.entry) * (1 / p.entry) * p.leverage * p.margin; // approximate demo pnl
            p.livePrice = currentPrice;
            p.pnl = pnl;

            // Take profit at +10% or Stop Loss at -5%
            if (pnl >= 5.0 || pnl <= -2.0) {
                bot.demoActivePositions.delete(key);
                sharedState.demoHistory.unshift({
                    time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
                    symbol: p.symbol, side: p.side, lev: p.leverage, margin: p.margin,
                    entry: p.entry, closePrice: currentPrice, pnl
                });
                if (sharedState.demoHistory.length > 50) sharedState.demoHistory.pop();
                addDemoLog(`[DEMO ĐÓNG ${p.side}] ${p.symbol} | Giá: ${formatPrice(currentPrice)} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$`);
            }
        }).catch(() => {});
    }
}, 2000);

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

    const sortedPositions = Array.from(botInst.botActivePositions.values())
        .map(p => {
            const openDurationMs = now - (p.createdAt || now);
            const slDet = calculateSlDetails(botInst, p);
            const slPhongHoDet = calculateSlPhongHoDetails(botInst, p);
            const tpDet = p.modeName === 'trend' ? calculateTpTrendDetails(botInst, p) : (p.pnl < 0 || p.isLockedAm ? { targetTpPrice: 0, estPnl: 0 } : calculateTpTrendDetails(botInst, p));
            const feeAndFd = calculatePositionFeeAndFunding(botInst, p, p.livePrice || p.avgEntry);

            return {
                ...p,
                estimatedFee: feeAndFd.estimatedFee,
                accumulatedFunding: feeAndFd.accumulatedFunding,
                openDurationStr: formatDuration(openDurationMs),
                tpCalculatedPrice: tpDet.targetTpPrice ? formatPrice(tpDet.targetTpPrice) : '-',
                tpEstimatedPnL: tpDet.estPnl !== undefined ? (tpDet.estPnl >= 0 ? `+${tpDet.estPnl.toFixed(2)}$` : `${tpDet.estPnl.toFixed(2)}$`) : '-',
                slCalculatedPrice: slDet.targetSlPrice ? formatPrice(slDet.targetSlPrice) : '-',
                slEstimatedPnL: slDet.estPnl !== undefined ? `${slDet.estPnl.toFixed(2)}$` : '-'
            };
        })
        .sort((a, b) => (a.pnl || 0) - (b.pnl || 0));

    const exchangePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => {
        const amt = Math.abs(parseFloat(p.positionAmt));
        const entryPrice = parseFloat(p.entryPrice || 0);
        const leverage = parseFloat(p.leverage || 1) || 1;
        return { ...p, margin: ((amt * entryPrice) / leverage).toFixed(2) };
    });

    const currentMinLev = botInst.botSettings.minLev !== undefined ? botInst.botSettings.minLev : 50;
    const filtered24h = sharedState.top24hList.filter(c => c.leverage >= currentMinLev);
    const filteredFunding = sharedState.topFundingList.filter(c => c.leverage >= currentMinLev);
    const filteredTrend = sharedState.topTrendList.filter(c => c.leverage >= currentMinLev);

    // Calculate stats by mode
    let stats24hCount = 0, stats24hPnl = 0;
    let statsFdCount = 0, statsFdPnl = 0;
    let statsVolCount = 0, statsVolPnl = 0;
    let statsTrendCount = 0, statsTrendPnl = 0;

    sharedState.historyRecords.h24h.forEach(i => { stats24hCount++; stats24hPnl += (i.pnl || 0); });
    sharedState.historyRecords.hFd.forEach(i => { statsFdCount++; statsFdPnl += (i.pnl || 0); });
    sharedState.historyRecords.hVol.forEach(i => { statsVolCount++; statsVolPnl += (i.pnl || 0); });
    sharedState.historyRecords.hTrend.forEach(i => { statsTrendCount++; statsTrendPnl += (i.pnl || 0); });

    return { 
        botSettings: botInst.botSettings, 
        activePositions: sortedPositions, 
        exchangePositions: exchangePositions, 
        status: { 
            botLogs: botInst.status.botLogs,
            demoLogs: sharedState.demoLogs,
            demoHistory: sharedState.demoHistory,
            botClosedCount: botInst.status.botClosedCount, 
            botPnLClosed: botInst.status.botPnLClosed, 
            pnlGain: botInst.status.pnlGain || 0, 
            pnlLoss: botInst.status.pnlLoss || 0, 
            isReady: botInst.status.isReady, 
            candidatesList: sharedState.candidatesList,
            top24hList: filtered24h,
            topFundingList: filteredFunding,
            topTrendList: filteredTrend,
            stats24hCount, stats24hPnl,
            statsFdCount, statsFdPnl,
            statsVolCount, statsVolPnl,
            statsTrendCount, statsTrendPnl,
            blackList: formattedBlacklist, 
            permanentBlacklist: sharedState.permanentBlacklist, 
            exchangeInfo: sharedState.exchangeInfo, 
            timeRun: formatUptime(botInst.startTime) 
        }, 
        wallet: { ...walletCache.data, unrealizedPnL: unrealizedPnL.toFixed(2) },
        historyTables: sharedState.historyRecords,
        timeRun: formatUptime(botInst.startTime)
    };
}

const appServer = express(); 
appServer.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}); 
appServer.use(express.json()); 
appServer.use(express.static(__dirname, { index: false })); 

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
    const key = `${symbol}_${side}`; 
    checkAndAddBlacklist(symbol);
    const b = bot.botActivePositions.get(key); 
    if (b) { 
        queueClosePosition(bot, b, b.livePrice, "ĐÓNG THỦ CÔNG TỪ DASHBOARD");
        return res.json({ success: true }); 
    } else { 
        try { 
            const posRisk = await getCachedPositionRisk(bot, 0) || []; 
            const p = posRisk.find(x => x.symbol === symbol && x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0); 
            if (p) await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side }); 
            res.json({ success: true }); 
        } catch (e) { res.json({ success: false, msg: e.message }); } 
    } 
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
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        loadSettingsFromFile();
        loadPositionsFromFile();
        loadHistoryFromFile();
        updatePermanentBlacklist();

        bot.status.isReady = true; 
        priceMonitor(bot); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(async () => {
    try {
        const [tickerRes, premiumRes] = await Promise.all([
            binanceApi.get('/fapi/v1/ticker/24hr'),
            binanceApi.get('/fapi/v1/premiumIndex')
        ]);

        const tickers = tickerRes.data || [];
        const premiums = premiumRes.data || [];
        const premMap = {};
        premiums.forEach(p => { premMap[p.symbol] = parseFloat(p.lastFundingRate || 0); });

        sharedState.top24hList = tickers.map(t => ({
            symbol: t.symbol,
            price: parseFloat(t.lastPrice || 0),
            priceChangePercent: parseFloat(t.priceChangePercent || 0),
            leverage: sharedState.exchangeInfo?.[t.symbol]?.maxLeverage || 20
        })).sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));

        sharedState.topFundingList = tickers.map(t => ({
            symbol: t.symbol,
            price: parseFloat(t.lastPrice || 0),
            fundingRate: premMap[t.symbol] || 0,
            absFunding: Math.abs(premMap[t.symbol] || 0),
            leverage: sharedState.exchangeInfo?.[t.symbol]?.maxLeverage || 20
        })).sort((a, b) => b.absFunding - a.absFunding);
    } catch (e) {}
}, 5000);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT - TREND & DEMO] Đã chạy trên port ${PORT}`));
