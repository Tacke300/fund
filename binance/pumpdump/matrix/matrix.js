import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';
import WebSocket from 'ws';

const PORT_REAL = 6789;
const PORT_DEMO = 6790;
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const POSITIONS_FILE_REAL = path.join(__dirname, 'positions_real.json');
const SETTINGS_FILE_REAL = path.join(__dirname, 'settings_real.json');
const POSITIONS_FILE_DEMO = path.join(__dirname, 'positions_demo.json');
const SETTINGS_FILE_DEMO = path.join(__dirname, 'settings_demo.json');

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
    errorSpamGuard: {}, 
    pendingOrders: new Set(),
    lastClosedMargin: {},
    lastClosedPnl: {},
    wsCandles: {
        '1h': {},
        '15m': {},
        '5m': {}
    }
};

// WEBSOCKET CANDLES STREAM TO AVOID RATE LIMIT
function initWebSocketStreams() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('open', () => {
        console.log("🟢 [WS STREAMS] Connected to Binance miniTicker stream");
    });
    ws.on('error', (err) => {
        console.error("🔴 [WS ERROR]", err.message);
    });
    ws.on('close', () => {
        setTimeout(initWebSocketStreams, 5000);
    });

    // Subscribe to kline streams for top active coins or fetch via REST periodically
}

async function fetchInitialKlines() {
    try {
        if (!sharedState.exchangeInfo) return;
        const symbols = Object.keys(sharedState.exchangeInfo).slice(0, 40); // Top 40 symbols
        for (const symbol of symbols) {
            try {
                const [r1h, r15m, r5m] = await Promise.all([
                    axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=250`).catch(() => null),
                    axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`).catch(() => null),
                    axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`).catch(() => null)
                ]);

                if (r1h && r1h.data) sharedState.wsCandles['1h'][symbol] = r1h.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
                if (r15m && r15m.data) sharedState.wsCandles['15m'][symbol] = r15m.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
                if (r5m && r5m.data) sharedState.wsCandles['5m'][symbol] = r5m.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
            } catch (e) {}
            await new Promise(r => setTimeout(r, 100));
        }
    } catch (e) {}
}

// Indicator Calculation Functions
function calculateEMA(data, period) {
    if (!data || data.length === 0) return [];
    let k = 2 / (period + 1);
    let emaArray = [];
    let sum = 0;
    for (let i = 0; i < Math.min(period, data.length); i++) {
        sum += data[i].close;
    }
    let prevEMA = sum / Math.min(period, data.length);
    emaArray.push(prevEMA);
    for (let i = 1; i < data.length; i++) {
        let val = (data[i].close * k) + (prevEMA * (1 - k));
        emaArray.push(val);
        prevEMA = val;
    }
    return emaArray;
}

function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 0;
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

function calculateSupertrend(candles, atrPeriod = 10, multiplier = 3) {
    if (!candles || candles.length < atrPeriod + 1) return { trend: 'UP', line: 0 };
    let atr = calculateATR(candles, atrPeriod);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const hl2 = (last.high + last.low) / 2;
    let basicUpper = hl2 + multiplier * atr;
    let basicLower = hl2 - multiplier * atr;
    let trend = last.close > basicLower ? 'UP' : 'DOWN';
    return { trend, line: trend === 'UP' ? basicLower : basicUpper };
}

function calculateMACD(candles, fast = 12, slow = 26, signal = 9) {
    if (!candles || candles.length < slow + signal) return { macdLine: 0, signalLine: 0, histogram: 0, prevHistogram: 0 };
    const closes = candles;
    let emaFast = calculateEMA(closes, fast);
    let emaSlow = calculateEMA(closes, slow);
    let macdLineArr = [];
    for (let i = 0; i < closes.length; i++) {
        macdLineArr.push((emaFast[i] || 0) - (emaSlow[i] || 0));
    }
    let signalLineArr = calculateEMA(macdLineArr.map(v => ({ close: v })), signal);
    let currentMacd = macdLineArr[macdLineArr.length - 1];
    let currentSignal = signalLineArr[signalLineArr.length - 1] || 0;
    let currentHist = currentMacd - currentSignal;
    let prevMacd = macdLineArr[macdLineArr.length - 2] || 0;
    let prevSignal = signalLineArr[signalLineArr.length - 2] || 0;
    let prevHist = prevMacd - prevSignal;
    return { macdLine: currentMacd, signalLine: currentSignal, histogram: currentHist, prevHistogram: prevHist };
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
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enabletrendmode', 'enabletptrendprice', 'enablevoltrend', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
            const boolVal = val === true || val === 'true' || val === 1 || val === '1';
            normalized[key] = boolVal;
        } else {
            normalized[key] = val; 
        }
    }
    return normalized;
}

function updatePermanentBlacklist(botInst) {
    if (!sharedState.exchangeInfo) return;
    const currentMinLev = botInst.botSettings.minLev !== undefined ? botInst.botSettings.minLev : 50;
    sharedState.permanentBlacklist = {};
    for (const symbol in sharedState.exchangeInfo) {
        const info = sharedState.exchangeInfo[symbol];
        if (info.maxLeverage < currentMinLev) {
            sharedState.permanentBlacklist[symbol] = true;
        }
    }
}

function createBotInstance(id, isDemo = false) {
    return {
        id,
        isDemo,
        startTime: Date.now(),
        walletBalanceDemo: 10000.0,
        botSettings: {
            isRunning: false,
            enableScanVol: true,
            enableScan24h: false,
            enableScanFunding: false,
            enableScanName: false,
            enableTrendMode: false,
            enableTpTrendPrice: false,
            enableVolTrend: false,
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
        status: { 
            botLogs: [], 
            botClosedCount: 0, 
            botPnLClosed: 0, 
            pnlGain: 0, 
            pnlLoss: 0, 
            isReady: false,
            modeStats: {
                '24h': { count: 0, pnl: 0 },
                'fd': { count: 0, pnl: 0 },
                'vol': { count: 0, pnl: 0 },
                'trend': { count: 0, pnl: 0 }
            },
            historyByMode: {
                '24h': [],
                'fd': [],
                'vol': [],
                'trend': []
            }
        },
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
}

let botReal = createBotInstance("LUFFY_BOT_REAL", false);
let botDemo = createBotInstance("LUFFY_BOT_DEMO", true);

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
        accumulatedFunding = notional * b.fundingRate * (hoursHeld / 8);
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
        const pairNetPnL = bPnL - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);
        return { oppPos: null, oppPnL: 0, oppQty: 0, oppAvgEntry: 0, oppIsOpen: false, fee: feeAndFd.estimatedFee, fd: feeAndFd.accumulatedFunding, pairNetPnL, bQty, bAvgEntry, dirB, dirOpp: 0 };
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

    return { oppPos, oppPnL, oppQty, oppAvgEntry, oppIsOpen, fee: totalFee, fd: feeAndFd.accumulatedFunding, pairNetPnL, bQty, bAvgEntry, dirB, dirOpp };
}

function calculateSlDetails(botInst, b) {
    if (b.modeName === 'trend') {
        const slLimit = botInst.botSettings.posSL || 10.0;
        const dir = b.side === 'LONG' ? 1 : -1;
        const targetSlPrice = b.avgEntry - dir * (b.firstEntry * (slLimit / 100)); // approximate based on SL %
        return { targetSlPrice, estPnl: -slLimit, isEarlySL: false };
    }

    if (botInst.botSettings.enableEarlySL && (b.dcaDuongCount || 0) >= 1) {
        const earlySlTarget = b.side === 'LONG' ? (b.avgEntry + (b.firstEntry * 0.007)) : (b.avgEntry - (b.firstEntry * 0.007));
        const estPnl = (b.side === 'LONG' ? 1 : -1) * (earlySlTarget - b.avgEntry) * b.currentQty;
        return { targetSlPrice: earlySlTarget, estPnl, isEarlySL: true };
    }

    const isAmMode = (b.dcaType === 'AM') || (b.pnl < 0) || b.isLockedAm;
    const firstMargin = b.firstMargin || 1;
    const slLimitValue = isAmMode ? (botInst.botSettings.posSL || 10.0) : (firstMargin * (botInst.botSettings.posSLDuong || 5.0));
    const currentPrice = b.livePrice || b.avgEntry;
    
    // Approximate SL price based on PnL limit
    const dir = b.side === 'LONG' ? 1 : -1;
    const targetSlPrice = b.avgEntry - dir * (slLimitValue / (b.currentQty || 1));
    return { targetSlPrice, estPnl: -slLimitValue, isEarlySL: false };
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
    if (botInst.isDemo) {
        // Return active positions for demo formatted as positionRisk
        return Array.from(botInst.botActivePositions.values()).map(p => ({
            symbol: p.symbol,
            positionSide: p.side,
            positionAmt: p.currentQty * (p.side === 'LONG' ? 1 : -1),
            entryPrice: p.avgEntry,
            markPrice: p.livePrice,
            unRealizedProfit: p.pnl,
            leverage: p.leverage
        }));
    }

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
    if (botInst.isDemo) return;
    const key = `${botInst.id}_${symbol}_${maxLeverage}`;
    if (leverageSetCache.has(key)) return;
    try {
        await botInst.exchange.setLeverage(maxLeverage, symbol);
        leverageSetCache.add(key);
    } catch (e) { }
}

function savePositionsToFile(botInst) {
    try {
        const file = botInst.isDemo ? POSITIONS_FILE_DEMO : POSITIONS_FILE_REAL;
        const data = Array.from(botInst.botActivePositions.entries());
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
}

function loadPositionsFromFile(botInst) {
    try {
        const file = botInst.isDemo ? POSITIONS_FILE_DEMO : POSITIONS_FILE_REAL;
        if (!fs.existsSync(file)) return;
        const raw = fs.readFileSync(file, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            botInst.botActivePositions = new Map(data);
        }
    } catch (e) {}
}

function saveSettingsToFile(botInst) {
    try {
        const file = botInst.isDemo ? SETTINGS_FILE_DEMO : SETTINGS_FILE_REAL;
        fs.writeFileSync(file, JSON.stringify(botInst.botSettings, null, 2), 'utf-8');
    } catch (e) {}
}

function loadSettingsFromFile(botInst) {
    try {
        const file = botInst.isDemo ? SETTINGS_FILE_DEMO : SETTINGS_FILE_REAL;
        if (!fs.existsSync(file)) return;
        const raw = fs.readFileSync(file, 'utf-8');
        const data = JSON.parse(raw);
        if (data) {
            botInst.botSettings = parseNormalizedSettings(data, botInst.botSettings);
            updatePermanentBlacklist(botInst);
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
    if (botInst.isDemo) return {};
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
            await new Promise(resolve => setTimeout(resolve, 1000));
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
                savePositionsToFile(botInst);
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
    checkAndAddBlacklist(b.symbol);

    if (botInst.isDemo) {
        const dir = b.side === 'LONG' ? 1 : -1;
        const rawPnl = dir * (markP - b.avgEntry) * b.currentQty;
        const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
        finalPnL = rawPnl - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);
        
        botInst.walletBalanceDemo += (b.currentMargin || b.firstMargin || 0) + finalPnL;
        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += finalPnL;

        const mode = b.modeName || 'vol';
        if (botInst.status.modeStats[mode]) {
            botInst.status.modeStats[mode].count++;
            botInst.status.modeStats[mode].pnl += finalPnL;
        }

        if (botInst.status.historyByMode[mode]) {
            botInst.status.historyByMode[mode].unshift({
                time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
                symbol: b.symbol,
                side: b.side,
                margin: b.currentMargin || b.firstMargin,
                leverage: b.leverage,
                avgEntry: b.avgEntry,
                closePrice: markP,
                pnl: finalPnL,
                indicators: b.indicators || null
            });
            if (botInst.status.historyByMode[mode].length > 50) botInst.status.historyByMode[mode].pop();
        }

        if (finalPnL >= 0) botInst.status.pnlGain += finalPnL;
        else botInst.status.pnlLoss += finalPnL;

        addBotLog(botInst, `🔒 [DEMO CHỐT | LÝ DO: ${reasonStr}] ${formatCoinName(b.symbol)} ${b.side} | Giá chốt: ${formatPrice(markP)} | PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? 'tp' : 'sl');
        return true;
    }

    try {
        const closeQty = b.currentQty;
        await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', closeQty, undefined, { positionSide: b.side });
    } catch (e) {
        return false;
    }

    let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
    const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
    finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);

    botInst.status.botClosedCount++;
    botInst.status.botPnLClosed += finalPnL;

    const mode = b.modeName || 'vol';
    if (botInst.status.modeStats[mode]) {
        botInst.status.modeStats[mode].count++;
        botInst.status.modeStats[mode].pnl += finalPnL;
    }

    if (botInst.status.historyByMode[mode]) {
        botInst.status.historyByMode[mode].unshift({
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
            symbol: b.symbol,
            side: b.side,
            margin: b.currentMargin || b.firstMargin,
            leverage: b.leverage,
            avgEntry: b.avgEntry,
            closePrice: markP,
            pnl: finalPnL,
            indicators: b.indicators || null
        });
        if (botInst.status.historyByMode[mode].length > 50) botInst.status.historyByMode[mode].pop();
    }

    if (finalPnL >= 0) botInst.status.pnlGain += finalPnL;
    else botInst.status.pnlLoss += finalPnL;

    addBotLog(botInst, `🔒 [CHỐT LÃI/LỖ | LÝ DO: ${reasonStr}] ${formatCoinName(b.symbol)} ${b.side} | PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? 'tp' : 'sl');
    return true;
}

async function panicCloseAll(botInst, reasonLog) {
    try {
        for (const [key, b] of botInst.botActivePositions.entries()) {
            await executeClosePositionAndLog(botInst, b, b.livePrice || b.avgEntry, reasonLog);
        }
        botInst.botActivePositions.clear();
        savePositionsToFile(botInst);
        addBotLog(botInst, `⚠️ [ĐÓNG TOÀN BỘ] (${reasonLog})`, "warn");
        return { success: true, count: 0 };
    } catch (e) { return { success: false, msg: e.message }; }
}

// Trend Mode Evaluation Engine
function evaluateTrendConditions(symbol) {
    const candles1h = sharedState.wsCandles['1h'][symbol];
    const candles15m = sharedState.wsCandles['15m'][symbol];
    const candles5m = sharedState.wsCandles['5m'][symbol];

    if (!candles1h || candles1h.length < 200 || !candles15m || candles15m.length < 20 || !candles5m || candles5m.length < 30) {
        return null;
    }

    // 1. EMA 1H
    const ema50Arr = calculateEMA(candles1h, 50);
    const ema200Arr = calculateEMA(candles1h, 200);
    const ema50 = ema50Arr[ema50Arr.length - 1];
    const ema200 = ema200Arr[ema200Arr.length - 1];
    const close1h = candles1h[candles1h.length - 1].close;

    const isEmaLong = ema50 > ema200 && close1h > ema200;
    const isEmaShort = ema50 < ema200 && close1h < ema200;

    if (!isEmaLong && !isEmaShort) return null;
    const direction = isEmaLong ? 'LONG' : 'SHORT';

    // 2. Supertrend 15m
    const st = calculateSupertrend(candles15m, 10, 3);
    const close15m = candles15m[candles15m.length - 1].close;
    const isSuperLong = st.trend === 'UP' && close15m > st.line;
    const isSuperShort = st.trend === 'DOWN' && close15m < st.line;

    if (direction === 'LONG' && !isSuperLong) return null;
    if (direction === 'SHORT' && !isSuperShort) return null;

    // 3. MACD 5m
    const macd = calculateMACD(candles5m, 12, 26, 9);
    const isMacdLong = macd.macdLine > macd.signalLine && macd.histogram > macd.prevHistogram;
    const isMacdShort = macd.macdLine < macd.signalLine && macd.histogram < macd.prevHistogram;

    if (direction === 'LONG' && !isMacdLong) return null;
    if (direction === 'SHORT' && !isMacdShort) return null;

    // 4. Volume 5m
    const lastVol = candles5m[candles5m.length - 1].volume;
    const avgVol20 = candles5m.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20;
    const isVolValid = lastVol >= 1.5 * avgVol20;

    if (!isVolValid) return null;

    // 5. Price Breakout 5m (20 candles)
    const prev20 = candles5m.slice(-21, -1);
    const highestHigh = Math.max(...prev20.map(c => c.high));
    const lowestLow = Math.min(...prev20.map(c => c.low));
    const lastClose = candles5m[candles5m.length - 1].close;

    const isBreakoutLong = direction === 'LONG' && lastClose > highestHigh;
    const isBreakoutShort = direction === 'SHORT' && lastClose < lowestLow;

    if (!isBreakoutLong && !isBreakoutShort) return null;

    // 6. Anti-chasing late entry (EMA50 5m, ATR 5m)
    const ema50_5mArr = calculateEMA(candles5m, 50);
    const ema50_5m = ema50_5mArr[ema50_5mArr.length - 1];
    const atr5m = calculateATR(candles5m, 14);
    const entryPrice = lastClose;

    const chaseDistance = direction === 'LONG' ? (entryPrice - ema50_5m) / atr5m : (ema50_5m - entryPrice) / atr5m;
    if (chaseDistance > 1.5) return null;

    return {
        symbol,
        direction,
        price: entryPrice,
        indicators: { ema: true, super: true, macd: true, vol: isVolValid }
    };
}

async function priceMonitor(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return setTimeout(() => priceMonitor(botInst), 300);
    try {
        const posRisk = await getCachedPositionRisk(botInst, 300);
        if (!posRisk || !Array.isArray(posRisk)) return setTimeout(() => priceMonitor(botInst), 300);

        for (let [key, b] of Array.from(botInst.botActivePositions.entries())) {
            if (b.isClosing) continue;
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide || p.side}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (!realP) {
                botInst.botActivePositions.delete(key);
                savePositionsToFile(botInst);
                continue;
            }

            const markP = parseFloat(realP.markPrice || realP.entryPrice);
            b.livePrice = markP;
            const dir = b.side === 'LONG' ? 1 : -1;
            b.pnl = dir * (markP - b.avgEntry) * b.currentQty;

            // Trend Mode reversal check: if 1H EMA candle closes reversed => cut if in profit
            if (b.modeName === 'trend') {
                const candles1h = sharedState.wsCandles['1h'][b.symbol];
                if (candles1h && candles1h.length > 200) {
                    const ema50Arr = calculateEMA(candles1h, 50);
                    const ema200Arr = calculateEMA(candles1h, 200);
                    const ema50 = ema50Arr[ema50Arr.length - 1];
                    const ema200 = ema200Arr[ema200Arr.length - 1];
                    const isReversedLong = b.side === 'LONG' && ema50 < ema200;
                    const isReversedShort = b.side === 'SHORT' && ema50 > ema200;

                    if ((isReversedLong || isReversedShort) && b.pnl > 0) {
                        queueClosePosition(botInst, b, markP, "TREND 1H EMA ĐẢO CHIỀU & ĐÃ LÃI");
                        continue;
                    }
                }
            }

            // Check TP / SL for Trend mode
            const slLimit = botInst.botSettings.posSL || 10.0;
            if (b.pnl <= -slLimit) {
                queueClosePosition(botInst, b, markP, "SL PnL ĐẠT NGƯỠNG");
                continue;
            }

            // TP check
            let tpTargetPrice = b.tp;
            const hitTp = b.side === 'LONG' ? markP >= tpTargetPrice : markP <= tpTargetPrice;
            if (hitTp) {
                queueClosePosition(botInst, b, markP, "TP TREND ĐẠT");
                continue;
            }

            savePositionsToFile(botInst);
        }
    } catch (e) {}
    setTimeout(() => priceMonitor(botInst), 300);
}

async function openPosition(botInst, symbol, side, modeName = 'trend', indicators = null) {
    const lockKey = `${symbol}_${side}`;
    if (botInst.botActivePositions.has(lockKey) || botInst.isProcessingDCA.has(lockKey)) return;
    botInst.isProcessingDCA.add(lockKey);

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) return;
        const currentPrice = await getCachedTickerPrice(symbol, 300);

        let margin = 10;
        let qty = 0;
        const invSetting = botInst.botSettings.invValue || "1%";
        
        if (botInst.isDemo) {
            margin = invSetting.toString().includes('%') ? (botInst.walletBalanceDemo * parseFloat(invSetting) / 100) : parseFloat(invSetting);
            if (botInst.walletBalanceDemo < margin) return;
            botInst.walletBalanceDemo -= margin;
        } else {
            margin = 15; // default for real if not calculated from account
        }

        if (botInst.botSettings.enableVolTrend) {
            // Capital input is treated as volume => margin = volume / maxLev
            const volumeInput = parseFloat(invSetting) || 100;
            qty = volumeInput / currentPrice;
            margin = (qty * currentPrice) / info.maxLeverage;
        } else {
            qty = (margin * info.maxLeverage) / currentPrice;
        }

        qty = Math.floor(qty / info.stepSize) * info.stepSize;
        qty = Number(qty.toFixed(info.quantityPrecision));

        if (!botInst.isDemo) {
            await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
            await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
        }

        const dir = side === 'LONG' ? 1 : -1;
        const tpPct = 10.0; // default trend tp %
        const slPct = botInst.botSettings.posSL || 10.0;
        
        let finalTP = currentPrice + dir * (currentPrice * (tpPct / 100));
        let finalSL = currentPrice - dir * (currentPrice * (slPct / 100));

        if (botInst.botSettings.enableTpTrendPrice) {
            finalTP = currentPrice + dir * (currentPrice * (5.0 / 100)); // 5% price target
        }

        const posData = {
            symbol,
            side,
            entryPrice: currentPrice,
            avgEntry: currentPrice,
            firstEntry: currentPrice,
            livePrice: currentPrice,
            currentQty: qty,
            firstMargin: margin,
            currentMargin: margin,
            leverage: info.maxLeverage,
            tp: finalTP,
            sl: finalSL,
            pnl: 0,
            modeName,
            indicators,
            createdAt: Date.now(),
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
        };

        botInst.botActivePositions.set(lockKey, posData);
        savePositionsToFile(botInst);
        addBotLog(botInst, `🚀 [MỞ LỆNH TREND] ${formatCoinName(symbol)} ${side} | Margin: ${margin.toFixed(2)}$ | Entry: ${formatPrice(currentPrice)}`, "open");

    } catch (e) {
    } finally {
        botInst.isProcessingDCA.delete(lockKey);
    }
}

// REST & Web Server Setup
function setupServer(botInst, port, title) {
    const app = express();
    app.use(express.json());
    app.use(express.static(__dirname, { index: false }));

    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    app.post('/api/settings', (req, res) => {
        botInst.botSettings = parseNormalizedSettings(req.body, botInst.botSettings);
        saveSettingsToFile(botInst);
        updatePermanentBlacklist(botInst);
        res.json({ success: true, msg: "Cập nhật cấu hình thành công!" });
    });

    app.get('/api/status', async (req, res) => {
        const now = Date.now();
        let wallet = {
            totalWalletBalance: botInst.isDemo ? botInst.walletBalanceDemo.toFixed(2) : "1000.00",
            totalMarginBalance: botInst.isDemo ? botInst.walletBalanceDemo.toFixed(2) : "1000.00",
            availableBalance: botInst.isDemo ? botInst.walletBalanceDemo.toFixed(2) : "1000.00",
            unrealizedPnL: "0.00"
        };

        let unrealizedPnL = 0;
        botInst.botActivePositions.forEach(p => { unrealizedPnL += (p.pnl || 0); });
        wallet.unrealizedPnL = unrealizedPnL.toFixed(2);

        const sortedPositions = Array.from(botInst.botActivePositions.values()).map(p => ({
            ...p,
            openDurationStr: formatDuration(now - p.createdAt),
            tpCalculatedPrice: formatPrice(p.tp),
            slCalculatedPrice: formatPrice(p.sl),
            tpEstimatedPnL: "+10.00$",
            slEstimatedPnL: "-10.00$"
        }));

        const exchangePositions = botInst.isDemo ? sortedPositions.map(p => ({
            symbol: p.symbol,
            positionSide: p.side,
            positionAmt: p.currentQty * (p.side === 'LONG' ? 1 : -1),
            entryPrice: p.avgEntry,
            markPrice: p.livePrice,
            unRealizedProfit: p.pnl,
            leverage: p.leverage,
            margin: p.currentMargin.toFixed(2)
        })) : [];

        res.json({
            botSettings: botInst.botSettings,
            activePositions: sortedPositions,
            exchangePositions,
            status: {
                botLogs: botInst.status.botLogs,
                botClosedCount: botInst.status.botClosedCount,
                botPnLClosed: botInst.status.botPnLClosed,
                pnlGain: botInst.status.pnlGain,
                pnlLoss: botInst.status.pnlLoss,
                isReady: botInst.status.isReady,
                modeStats: botInst.status.modeStats,
                historyByMode: botInst.status.historyByMode,
                topTrendList: sharedState.topTrendList,
                top24hList: sharedState.top24hList,
                topFundingList: sharedState.topFundingList,
                candidatesList: sharedState.candidatesList,
                blackList: {},
                timeRun: formatUptime(botInst.startTime)
            },
            wallet,
            timeRun: formatUptime(botInst.startTime)
        });
    });

    app.post('/api/close_all', async (req, res) => {
        const result = await panicCloseAll(botInst, "ĐÓNG TOÀN BỘ TỪ DASHBOARD");
        res.json(result);
    });

    app.post('/api/close_position', async (req, res) => {
        const { symbol, side } = req.body;
        const key = `${symbol}_${side}`;
        const b = botInst.botActivePositions.get(key);
        if (b) {
            queueClosePosition(botInst, b, b.livePrice || b.avgEntry, "ĐÓNG THỦ CÔNG");
            res.json({ success: true });
        } else {
            res.json({ success: false, msg: "Không tìm thấy vị thế" });
        }
    });

    app.post('/api/demo_reset', (req, res) => {
        if (botInst.isDemo) {
            botInst.walletBalanceDemo = 10000.0;
            botInst.botActivePositions.clear();
            botInst.status.botClosedCount = 0;
            botInst.status.botPnLClosed = 0;
            botInst.status.pnlGain = 0;
            botInst.status.pnlLoss = 0;
            botInst.status.historyByMode = { '24h': [], 'fd': [], 'vol': [], 'trend': [] };
            savePositionsToFile(botInst);
            res.json({ success: true });
        } else {
            res.json({ success: false, msg: "Chỉ áp dụng cho tài khoản demo" });
        }
    });

    app.listen(port, () => {
        console.log(`🚀 [${title}] Đang chạy trên port ${port}`);
    });
}

async function initBot() {
    try {
        await botReal.exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(botReal, '/fapi/v1/leverageBracket');
        const temp = {};

        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            const b = brk?.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets?.[0]?.initialLeverage || 20;
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize || 0.001),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0),
                maxLeverage: maxLev
            };
        });
        sharedState.exchangeInfo = temp;

        loadSettingsFromFile(botReal);
        loadPositionsFromFile(botReal);
        loadSettingsFromFile(botDemo);
        loadPositionsFromFile(botDemo);

        updatePermanentBlacklist(botReal);
        updatePermanentBlacklist(botDemo);

        await fetchInitialKlines();

        botReal.status.isReady = true;
        botDemo.status.isReady = true;

        priceMonitor(botReal);
        priceMonitor(botDemo);

        initWebSocketStreams();

        setupServer(botReal, PORT_REAL, "LUFFY BOT REAL");
        setupServer(botDemo, PORT_DEMO, "LUFFY BOT DEMO (PORT 6790)");

    } catch (e) {
        setTimeout(initBot, 5000);
    }
}

// Background Scan Loop for Trend Mode & Others
setInterval(async () => {
    try {
        if (!sharedState.exchangeInfo) return;
        const trendCandidates = [];
        const currentMinLev = botReal.botSettings.minLev || 20;

        for (const symbol in sharedState.exchangeInfo) {
            const info = sharedState.exchangeInfo[symbol];
            if (info.maxLeverage < currentMinLev) continue;

            const res = evaluateTrendConditions(symbol);
            if (res) {
                trendCandidates.push({
                    symbol,
                    leverage: info.maxLeverage,
                    price: res.price,
                    direction: res.direction,
                    ...res.indicators
                });
            }
        }

        sharedState.topTrendList = trendCandidates.slice(0, 10);

        // Execute Trend mode bot opening if enabled
        for (const botInst of [botReal, botDemo]) {
            if (!botInst.status.isReady || !botInst.botSettings.isRunning || !botInst.botSettings.enableTrendMode) continue;
            const maxPos = botInst.botSettings.maxPositions || 3;
            const currentTrendCount = Array.from(botInst.botActivePositions.values()).filter(p => p.modeName === 'trend').length;

            if (currentTrendCount < maxPos && trendCandidates.length > 0) {
                const bestCoin = trendCandidates[0];
                const lockKey = `${bestCoin.symbol}_${bestCoin.direction}`;
                if (!botInst.botActivePositions.has(lockKey)) {
                    await openPosition(botInst, bestCoin.symbol, bestCoin.direction, 'trend', bestCoin);
                }
            }
        }
    } catch (e) {}
}, 3000);

initBot();
