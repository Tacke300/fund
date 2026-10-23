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
const DEMO_PORT = 6790;
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
const DEMO_STATE_FILE = path.join(__dirname, 'demo_state.json');

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
    pendingOrders: new Set(),
    lastClosedPnl: {}
};

// --- TECHNICAL INDICATORS CALCULATOR ---
function calculateEMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i][2];
        const low = candles[i][3];
        const prevClose = candles[i - 1][4];
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
    if (prices.length < slow + signal) return { macdLine: 0, signalLine: 0, histogram: 0, prevHistogram: 0 };
    
    // Simple approximation for speed/robustness
    const fastEma = calculateEMA(prices, fast);
    const slowEma = calculateEMA(prices, slow);
    const macdLine = fastEma - slowEma;
    
    // Compute historical MACD for signal & histogram
    let macdLines = [];
    for (let i = slow; i < prices.length; i++) {
        const f = calculateEMA(prices.slice(0, i + 1), fast);
        const s = calculateEMA(prices.slice(0, i + 1), slow);
        macdLines.push(f - s);
    }
    const signalLine = calculateEMA(macdLines, signal);
    const prevSignalLine = calculateEMA(macdLines.slice(0, -1), signal);
    
    const histogram = macdLine - signalLine;
    const prevHistogram = (macdLines[macdLines.length - 2] || macdLine) - prevSignalLine;
    
    return { macdLine, signalLine, histogram, prevHistogram };
}

function calculateSupertrend(candles, atrPeriod = 10, multiplier = 3) {
    if (candles.length < atrPeriod + 1) return { isUp: true, value: 0 };
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const atr = trs.slice(-atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
    const currentCandle = candles[candles.length - 1];
    const hl2 = (currentCandle[2] + currentCandle[3]) / 2;
    const upperBasic = hl2 + (multiplier * atr);
    const lowerBasic = hl2 - (multiplier * atr);
    const close = currentCandle[4];
    const isUp = close > lowerBasic;
    return { isUp, value: isUp ? lowerBasic : upperBasic };
}

// --- DEMO STATE ---
let demoState = {
    walletBalance: 10000.0,
    availableBalance: 10000.0,
    activePositions: new Map(),
    closedCount: 0,
    pnlClosed: 0,
    pnlGain: 0,
    pnlLoss: 0,
    history: [],
    logs: []
};

function saveDemoState() {
    try {
        const data = {
            walletBalance: demoState.walletBalance,
            availableBalance: demoState.availableBalance,
            activePositions: Array.from(demoState.activePositions.entries()),
            closedCount: demoState.closedCount,
            pnlClosed: demoState.pnlClosed,
            pnlGain: demoState.pnlGain,
            pnlLoss: demoState.pnlLoss,
            history: demoState.history,
            logs: demoState.logs
        };
        fs.writeFileSync(DEMO_STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
}

function loadDemoState() {
    try {
        if (!fs.existsSync(DEMO_STATE_FILE)) return;
        const raw = fs.readFileSync(DEMO_STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data) {
            demoState.walletBalance = data.walletBalance || 10000.0;
            demoState.availableBalance = data.availableBalance || 10000.0;
            demoState.activePositions = new Map(data.activePositions || []);
            demoState.closedCount = data.closedCount || 0;
            demoState.pnlClosed = data.pnlClosed || 0;
            demoState.pnlGain = data.pnlGain || 0;
            demoState.pnlLoss = data.pnlLoss || 0;
            demoState.history = data.history || [];
            demoState.logs = data.logs || [];
        }
    } catch (e) {}
}
loadDemoState();

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalized = { ...currentSettings };
    for (let key in reqBody) {
        const val = reqBody[key];
        const lowerKey = key.toLowerCase();
        if (['minvol', 'possl', 'posslduong', 'posdcaam', 'posdcaduong', 'hesodcaam', 'hesodcaduong', 'tpdcaam', 'tpdcaduong', 'minpnltpdcaduong', 'minfd', 'min24h'].includes(lowerKey)) {
            normalized[key] = parseFloat(val);
        } else if (['maxpositions', 'minlev'].includes(lowerKey)) {
            normalized[key] = parseInt(val);
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enablescantrend', 'tptrendprice', 'voltrend', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam', 'enabledemomode'].includes(lowerKey)) {
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
        tpTrendPrice: false,
        volTrend: false,
        scanNamesInput: "",
        minFd: 1.0,
        min24h: 0.0,
        enableEarlySL: false,
        lockDcaAmMode: false,
        closeOppositeDcaAm: false,
        enableDemoMode: false,
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
        oppPos,
        oppPnL,
        oppQty,
        oppAvgEntry,
        oppIsOpen,
        fee: totalFee,
        fd: feeAndFd.accumulatedFunding,
        pairNetPnL,
        bQty,
        bAvgEntry,
        dirB,
        dirOpp
    };
}

function calculatePriceForTargetNetPnL(botInst, b, targetNetPnL, currentPrice) {
    const details = getPairNetPnLDetails(botInst, b, currentPrice);
    const { oppIsOpen, oppQty, oppAvgEntry, oppPnL, bQty, bAvgEntry, dirB, dirOpp } = details;

    let K = 0;
    let C = 0;

    if (oppIsOpen) {
        K = (dirB * bQty) + (dirOpp * oppQty) - (0.001 * (bQty + oppQty));
        C = -(dirB * bAvgEntry * bQty) - (dirOpp * oppAvgEntry * oppQty);
    } else {
        K = (dirB * bQty) - (0.001 * bQty);
        C = -(dirB * bAvgEntry * bQty) + oppPnL;
    }

    if (Math.abs(K) < 1e-8) {
        return currentPrice;
    }

    const targetPrice = (targetNetPnL - C) / K;
    return targetPrice > 0 ? targetPrice : currentPrice;
}

function calculateSlDetails(botInst, b) {
    if (b.modeName === 'trend') {
        const firstMargin = b.firstMargin || 1;
        const slLimit = firstMargin * (botInst.botSettings.posSLDuong || 5.0);
        const currentPrice = b.livePrice || b.avgEntry;
        const dir = b.side === 'LONG' ? 1 : -1;
        // SL for trend mode based on SL PnL
        const targetSlPrice = b.avgEntry - dir * (slLimit / (b.currentQty || 1));
        return { targetSlPrice, estPnl: -slLimit };
    }

    if (botInst.botSettings.enableEarlySL && (b.dcaDuongCount || 0) >= 1) {
        const earlySlTarget = b.side === 'LONG' 
            ? (b.avgEntry + (b.firstEntry * 0.007))
            : (b.avgEntry - (b.firstEntry * 0.007));
        const estPnl = (b.side === 'LONG' ? 1 : -1) * (earlySlTarget - b.avgEntry) * b.currentQty;
        return { targetSlPrice: earlySlTarget, estPnl };
    }

    const isAmMode = (b.dcaType === 'AM') || (b.pnl < 0) || b.isLockedAm;
    const firstMargin = b.firstMargin || 1;
    const slLimitValue = isAmMode 
        ? (botInst.botSettings.posSL || 10.0) 
        : (firstMargin * (botInst.botSettings.posSLDuong || 5.0));

    const currentPrice = b.livePrice || b.avgEntry;
    const targetSlPrice = calculatePriceForTargetNetPnL(botInst, b, -slLimitValue, currentPrice);

    return { targetSlPrice: targetSlPrice, estPnl: -slLimitValue };
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
    const logItem = { time, msg, type, botId: botInst.id };
    
    botInst.status.botLogs.unshift(logItem);
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
    
    const consoleMsg = msg.replace(/<[^>]*>/g, '');
    console.log(`[${time}][${botInst.id}][${type.toUpperCase()}] ${consoleMsg}`);
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
        try {
            await task();
        } catch (e) {}
        if (closeQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
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

async function executeClosePositionAndLog(botInst, b, markP, reasonStr) {
    let finalPnL = 0;
    let orderClosedSuccessfully = false;

    checkAndAddBlacklist(b.symbol);

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

    await new Promise(resolve => setTimeout(resolve, 2000));

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
        
        const matchingTrades = trades.filter(t => 
            t.positionSide === b.side && 
            (t.side === closeSide || (b.side === 'LONG' ? t.buyer === false : t.buyer === true)) &&
            (nowServer - t.time) < 60000
        );

        if (matchingTrades.length > 0) {
            finalPnL = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission || 0), 0);
        } else {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
            finalPnL = pnlRaw - feeAndFd.estimatedFee;
        }

        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += finalPnL;

        if (finalPnL >= 0) {
            botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
        } else {
            botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
        }

        const formattedSymbol = formatCoinName(b.symbol);
        addBotLog(botInst, `🔒 [ĐÓNG LỆNH | ${reasonStr}] ${formattedSymbol} ${b.side} | Giá chốt: ${formatPrice(markP)} | PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? "tp" : "sl");
        
    } catch (e) {}

    return true;
}

async function panicCloseAll(botInst, reasonLog) {
    try {
        const posRisk = await getCachedPositionRisk(botInst, 0) || [];
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        if (active.length === 0 && botInst.botActivePositions.size === 0) {
            return { success: true, count: 0 };
        }
        let count = 0;
        for (const p of active) {
            const side = p.positionSide;
            const qty = Math.abs(parseFloat(p.positionAmt));
            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            
            checkAndAddBlacklist(p.symbol);

            try {
                await botInst.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                count++;
            } catch (err) { }
        }
        botInst.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(botInst, `⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] (${reasonLog}).`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

// --- PRICE MONITOR & TREND EXIT CHECK ---
async function priceMonitor(botInst) {
    if (!botInst.status.isReady) return setTimeout(() => priceMonitor(botInst), 300);
    try {
        if (!botInst.botSettings.isRunning) return setTimeout(() => priceMonitor(botInst), 300);
        
        const posRisk = await getCachedPositionRisk(botInst, 300);
        if (!posRisk || !Array.isArray(posRisk)) {
            return setTimeout(() => priceMonitor(botInst), 300);
        }

        for (let [key, b] of Array.from(botInst.botActivePositions.entries())) {
            if (b.isClosing) continue;

            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const markP = parseFloat(realP.markPrice);
                b.currentQty = Math.abs(parseFloat(realP.positionAmt));
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.livePrice = markP;
                b.avgEntry = parseFloat(realP.entryPrice) || b.firstEntry;

                // Check Trend Mode Reversal Exit Rule:
                // "Nếu chưa đạt tp mà ema nến 1h đóng bị đảo chiều => cắt lệnh nếu pnl đã lãi & vẫn giữ lệnh nếu pnl đang âm"
                if (b.modeName === 'trend') {
                    try {
                        const ohlcv1h = await binanceApi.get(`/fapi/v1/klines?symbol=${b.symbol}&interval=1h&limit=250`);
                        const candles1h = ohlcv1h.data.map(c => [c[0], parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4])]);
                        const closes1h = candles1h.map(c => c[4]);
                        const ema50_1h = calculateEMA(closes1h, 50);
                        const ema200_1h = calculateEMA(closes1h, 200);
                        const isEmaBullish = ema50_1h > ema200_1h;

                        const hasReversed = (b.side === 'LONG' && !isEmaBullish) || (b.side === 'SHORT' && isEmaBullish);
                        if (hasReversed) {
                            if (b.pnl > 0) {
                                queueClosePosition(botInst, b, markP, "CẮT LỆNH TREND DO EMA 1H ĐẢO CHIỀU (LÃI)");
                                continue;
                            }
                        }
                    } catch (e) {}

                    // TP Trend Check
                    if (botInst.botSettings.tpTrendPrice && b.tpPrice) {
                        const hitTp = b.side === 'LONG' ? (markP >= b.tpPrice) : (markP <= b.tpPrice);
                        if (hitTp) {
                            queueClosePosition(botInst, b, markP, "CHỐT TP TREND % PRICE");
                            continue;
                        }
                    }
                }

                savePositionsToFile();
            } else {
                botInst.botActivePositions.delete(key);
                savePositionsToFile();
            }
        }
    } catch (e) {}
    
    setTimeout(() => priceMonitor(botInst), 300);
}

// --- OPEN TREND POSITION ---
async function openTrendPosition(botInst, trendItem) {
    const symbol = trendItem.symbol;
    const side = trendItem.direction;
    const lockKey = `${symbol}_${side}`;

    if (botInst.botActivePositions.has(lockKey) || botInst.isProcessingDCA.has(lockKey)) return;
    botInst.isProcessingDCA.add(lockKey);

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) return;

        const currentPrice = await getCachedTickerPrice(symbol, 300);
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
        const availBal = parseFloat(acc?.availableBalance || 0);
        const invInput = botInst.botSettings.invValue || "1%";

        let qty = 0, margin = 0;
        if (botInst.botSettings.volTrend) {
            // Vốn nhập tính là khối lượng => Chia max lev
            const requestedVol = invInput.toString().includes('%') ? (availBal * parseFloat(invInput) / 100) : parseFloat(invInput);
            qty = Math.floor(requestedVol / info.stepSize) * info.stepSize;
            margin = (qty * currentPrice) / info.maxLeverage;
        } else {
            margin = invInput.toString().includes('%') ? (availBal * parseFloat(invInput) / 100) : parseFloat(invInput);
            let desiredQty = (margin * info.maxLeverage) / currentPrice;
            qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
        }

        if (qty * currentPrice < actualMinNotional) {
            qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
        qty = Number(qty.toFixed(info.quantityPrecision));
        margin = (qty * currentPrice) / info.maxLeverage;

        await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
        const order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        let filledPrice = currentPrice;
        if (order && order.average) filledPrice = parseFloat(order.average);

        const dir = side === 'LONG' ? 1 : -1;
        const tpPrice = botInst.botSettings.tpTrendPrice ? filledPrice + dir * (filledPrice * 0.05) : 0;
        const slPrice = filledPrice - dir * (filledPrice * 0.03);

        const nowTime = Date.now();
        const posData = {
            symbol, side, entryPrice: filledPrice, tp: tpPrice, sl: slPrice,
            modeName: 'trend',
            leverage: info.maxLeverage,
            firstEntry: filledPrice,
            firstMargin: margin,
            currentMargin: margin,
            currentQty: qty,
            pnl: 0,
            avgEntry: filledPrice,
            livePrice: filledPrice,
            tpPrice,
            indicators: trendItem,
            createdAt: nowTime,
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
        };

        botInst.botActivePositions.set(lockKey, posData);
        savePositionsToFile();
        addBotLog(botInst, `🚀 [MỞ LỆNH TREND ${side}] ${formatCoinName(symbol)} | Margin: ${margin.toFixed(2)}$ | Entry: ${formatPrice(filledPrice)}`, "open");

    } catch (e) {
        checkAndAddBlacklist(symbol);
    } finally {
        setTimeout(() => botInst.isProcessingDCA.delete(lockKey), 1000);
    }
}

// --- SCANNER FOR TREND MODE ---
async function scanTrendCoins(botInst) {
    if (!botInst.botSettings.isRunning || !botInst.botSettings.enableScanTrend || !sharedState.exchangeInfo) return;
    try {
        const symbols = Object.keys(sharedState.exchangeInfo).slice(0, 40); // Scan top symbols
        let evaluatedCoins = [];

        for (const sym of symbols) {
            if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym]) continue;
            const info = sharedState.exchangeInfo[sym];
            if (info.maxLeverage < (botInst.botSettings.minLev || 20)) continue;

            try {
                // Fetch klines via websocket / rest fast
                const [res1h, res15m, res5m] = await Promise.all([
                    binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=1h&limit=250`),
                    binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=15m&limit=100`),
                    binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=5m&limit=50`)
                ]);

                const c1h = res1h.data.map(c => [c[0], parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4]), parseFloat(c[5])]);
                const c15m = res15m.data.map(c => [c[0], parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4]), parseFloat(c[5])]);
                const c5m = res5m.data.map(c => [c[0], parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4]), parseFloat(c[5])]);

                const closes1h = c1h.map(c => c[4]);
                const close5m = c5m[c5m.length - 1][4];

                // 1. EMA 50 & 200 (1H)
                const ema50_1h = calculateEMA(closes1h, 50);
                const ema200_1h = calculateEMA(closes1h, 200);
                const lastClose1h = closes1h[closes1h.length - 1];
                const isLongEMA = ema50_1h > ema200_1h && lastClose1h > ema200_1h;
                const isShortEMA = ema50_1h < ema200_1h && lastClose1h < ema200_1h;
                if (!isLongEMA && !isShortEMA) continue;
                const direction = isLongEMA ? 'LONG' : 'SHORT';

                // 2. Supertrend (15m)
                const st = calculateSupertrend(c15m, 10, 3);
                const isSupertrendValid = direction === 'LONG' ? (st.isUp && close5m > st.value) : (!st.isUp && close5m < st.value);

                // 3. MACD (5m)
                const closes5m = c5m.map(c => c[4]);
                const macdObj = calculateMACD(closes5m, 12, 26, 9);
                const isMacdValid = direction === 'LONG' ? (macdObj.macdLine > macdObj.signalLine && macdObj.histogram > macdObj.prevHistogram) : (macdObj.macdLine < macdObj.signalLine && macdObj.histogram < macdObj.prevHistogram);

                // 4. Volume (5m) >= 1.5 * avg 20 vols
                const vols5m = c5m.map(c => c[5]);
                const currentVol = vols5m[vols5m.length - 1];
                const avgVol20 = vols5m.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
                const isVolValid = currentVol >= 1.5 * avgVol20;

                // 5. Breakout (5m, 20 closed candles)
                const prev20Highs = c5m.slice(-21, -1).map(c => c[2]);
                const prev20Lows = c5m.slice(-21, -1).map(c => c[3]);
                const highestHigh = Math.max(...prev20Highs);
                const lowestLow = Math.min(...prev20Lows);
                const isBreakout = direction === 'LONG' ? (close5m > highestHigh) : (close5m < lowestLow);

                // 6. Anti-chasing (ATR(14), EMA50 on 5m <= 1.5 ATR)
                const atr14_5m = calculateATR(c5m, 14);
                const ema50_5m = calculateEMA(closes5m, 50);
                const chaseDiff = Math.abs(close5m - ema50_5m);
                const isAntiChasing = atr14_5m > 0 ? (chaseDiff / atr14_5m <= 1.5) : true;

                let score = 0;
                if (isLongEMA || isShortEMA) score++;
                if (isSupertrendValid) score++;
                if (isMacdValid) score++;
                if (isVolValid) score++;
                if (isBreakout) score++;
                if (isAntiChasing) score++;

                evaluatedCoins.push({
                    symbol: sym,
                    direction,
                    leverage: info.maxLeverage,
                    price: close5m,
                    ema: isLongEMA || isShortEMA,
                    supertrend: isSupertrendValid,
                    macd: isMacdValid,
                    vol: isVolValid,
                    breakout: isBreakout,
                    antiChasing: isAntiChasing,
                    score
                });
            } catch (err) {}
        }

        evaluatedCoins.sort((a, b) => b.score - a.score);
        sharedState.topTrendList = evaluatedCoins.slice(0, 10);

        // If top coin meets all conditions, open trend position
        const bestCoin = evaluatedCoins[0];
        if (bestCoin && bestCoin.score === 6) {
            const maxPos = botInst.botSettings.maxPositions || 3;
            const currentTrendCount = Array.from(botInst.botActivePositions.values()).filter(p => p.modeName === 'trend').length;
            if (currentTrendCount < maxPos) {
                await openTrendPosition(botInst, bestCoin);
            }
        }
    } catch (e) {}
}

setInterval(() => {
    scanTrendCoins(bot);
}, 10000);

// --- DEMO APP & ROUTING (PORT 6790) ---
const demoApp = express();
demoApp.use(allowCors);
demoApp.use(express.json());

demoApp.get('/api/demo_status', (req, res) => {
    let unrealizedPnL = 0;
    demoState.activePositions.forEach(p => { unrealizedPnL += (p.pnl || 0); });
    res.json({
        wallet: {
            totalWalletBalance: demoState.walletBalance.toFixed(2),
            availableBalance: demoState.availableBalance.toFixed(2),
            unrealizedPnL: unrealizedPnL.toFixed(2)
        },
        status: {
            openCount: demoState.activePositions.size,
            closedCount: demoState.closedCount,
            pnlClosed: demoState.pnlClosed,
            pnlGain: demoState.pnlGain,
            pnlLoss: demoState.pnlLoss
        },
        activePositions: Array.from(demoState.activePositions.values()),
        history: demoState.history,
        logs: demoState.logs
    });
});

demoApp.post('/api/demo_reset', (req, res) => {
    demoState.walletBalance = 10000.0;
    demoState.availableBalance = 10000.0;
    demoState.activePositions.clear();
    demoState.closedCount = 0;
    demoState.pnlClosed = 0;
    demoState.pnlGain = 0;
    demoState.pnlLoss = 0;
    demoState.history = [];
    demoState.logs = [];
    saveDemoState();
    res.json({ success: true });
});

demoApp.listen(DEMO_PORT, () => console.log(`🧪 [DEMO BOT] Đang chạy trên port ${DEMO_PORT}`));

// --- MAIN EXPRESS APP (PORT 6789) ---
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

    const sortedPositions = Array.from(botInst.botActivePositions.values())
        .map(p => {
            const openDurationMs = now - (p.createdAt || now);
            const slDet = calculateSlDetails(botInst, p);

            return {
                ...p,
                openDurationStr: formatDuration(openDurationMs),
                tpCalculatedPrice: p.tpPrice ? formatPrice(p.tpPrice) : '-',
                tpEstimatedPnL: '-',
                slCalculatedPrice: slDet.targetSlPrice ? formatPrice(slDet.targetSlPrice) : '-',
                slEstimatedPnL: `${slDet.estPnl.toFixed(2)}$`
            };
        });

    const exchangePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => {
        const amt = Math.abs(parseFloat(p.positionAmt));
        const entryPrice = parseFloat(p.entryPrice || 0);
        const leverage = parseFloat(p.leverage || 1) || 1;
        const margin = (amt * entryPrice) / leverage;
        return { ...p, margin: margin.toFixed(2) };
    });

    const currentMinLev = botInst.botSettings.minLev !== undefined ? botInst.botSettings.minLev : 50;
    const filtered24h = sharedState.top24hList.filter(c => c.leverage >= currentMinLev);
    const filteredFunding = sharedState.topFundingList.filter(c => c.leverage >= currentMinLev);
    const filteredTrend = sharedState.topTrendList.filter(c => c.leverage >= currentMinLev);

    return { 
        botSettings: botInst.botSettings, 
        activePositions: sortedPositions, 
        exchangePositions: exchangePositions, 
        status: { 
            botLogs: botInst.status.botLogs, 
            botClosedCount: botInst.status.botClosedCount, 
            botPnLClosed: botInst.status.botPnLClosed, 
            pnlGain: botInst.status.pnlGain || 0, 
            pnlLoss: botInst.status.pnlLoss || 0, 
            isReady: botInst.status.isReady, 
            candidatesList: sharedState.candidatesList,
            top24hList: filtered24h,
            topFundingList: filteredFunding,
            topTrendList: filteredTrend,
            blackList: formattedBlacklist, 
            timeRun: formatUptime(botInst.startTime) 
        }, 
        wallet: {
            ...walletCache.data,
            unrealizedPnL: unrealizedPnL.toFixed(2)
        }
    };
}

appServer.post('/api/settings', (req, res) => {
    bot.botSettings = parseNormalizedSettings(req.body, bot.botSettings);
    saveSettingsToFile();
    updatePermanentBlacklist();
    res.json({ success: true, msg: "Cập nhật cấu hình thành công!" });
});

appServer.get('/api/status', async (req, res) => {
    res.json(await buildStatusResponse(bot));
});

appServer.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot, "ĐÓNG TOÀN BỘ TỪ DASHBOARD")));

appServer.post('/api/close_position', async (req, res) => { 
    const { symbol, side } = req.body; 
    const key = `${symbol}_${side}`; 
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
        updatePermanentBlacklist();

        bot.status.isReady = true; 
        priceMonitor(bot); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT] Đã chạy trên port ${PORT}`));
