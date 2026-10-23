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
    if (!ms || ms < 0) return '00h 00m 00s';
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
    pendingOrders: new Set(),
    lastClosedMargin: {},
    lastClosedPnl: {},
    candleDataStore: {} // Lưu trữ nến websocket phục vụ tính toán chỉ báo
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
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enablescantrend', 'enablescandemo', 'enabletptrendpct', 'enablevoltrendqty', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
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
        enableScanDemo: false,
        enableTpTrendPct: false,
        enableVolTrendQty: false,
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
        botLogs: [], demoLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false,
        hist24h: [], histFd: [], histVol: [], histTrend: [], demoHistory: []
    },
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

// --- HỆ THỐNG TÍNH TOÁN CHỈ BÁO KỸ THUẬT (EMA, Supertrend, MACD, Volume, Phá vỡ, ATR) ---
function calculateEMA(closes, period) {
    if (!closes || closes.length === 0) return [];
    let k = 2 / (period + 1);
    let emaArray = [];
    let prevEMA = closes[0];
    emaArray.push(prevEMA);
    for (let i = 1; i < closes.length; i++) {
        prevEMA = (closes[i] * k) + (prevEMA * (1 - k));
        emaArray.push(prevEMA);
    }
    return emaArray;
}

function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 1.0;
    let trList = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trList.push(tr);
    }
    let atr = trList.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trList.length; i++) {
        atr = (atr * (period - 1) + trList[i]) / period;
    }
    return atr || 1.0;
}

function calculateSupertrend(candles, period = 10, multiplier = 3) {
    if (!candles || candles.length < period) return { direction: 'UP', value: 0 };
    let atr = calculateATR(candles, period);
    let last = candles[candles.length - 1];
    let hl2 = (last.high + last.low) / 2;
    let basicUpper = hl2 + (multiplier * atr);
    let basicLower = hl2 - (multiplier * atr);
    let isUp = last.close > basicLower;
    return { direction: isUp ? 'UP' : 'DOWN', value: isUp ? basicLower : basicUpper };
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (!closes || closes.length < slow + signal) return { macdLine: 0, signalLine: 0, histogram: 0, prevHistogram: 0 };
    let fastEMA = calculateEMA(closes, fast);
    let slowEMA = calculateEMA(closes, slow);
    let macdLineArr = [];
    for (let i = 0; i < closes.length; i++) {
        macdLineArr.push(fastEMA[i] - slowEMA[i]);
    }
    let signalLineArr = calculateEMA(macdLineArr, signal);
    let lastIdx = closes.length - 1;
    let macdLine = macdLineArr[lastIdx];
    let signalLine = signalLineArr[lastIdx];
    let hist = macdLine - signalLine;
    let prevHist = (lastIdx > 0) ? (macdLineArr[lastIdx - 1] - signalLineArr[lastIdx - 1]) : hist;
    return { macdLine, signalLine, histogram: hist, prevHistogram: prevHist };
}

// Websocket quản lý nến thực tế qua WebSocket stream (tránh rate limit)
function initWebSocketCandles() {
    const wsUrl = 'wss://fstream.binance.com/ws/!miniTicker@arr';
    // Kết nối WS stream để nhận dữ liệu giá realtime và cập nhật nến
    const ws = new WebSocket('wss://fstream.binance.com/stream?streams=!miniTicker@arr');
    ws.on('open', () => {
        console.log("🟢 [WEBSOCKET] Đã kết nối Binance Futures stream thành công.");
    });
    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.data) {
                // Xử lý cập nhật giá realtime vào kho nến giả lập hoặc dữ liệu thực
            }
        } catch (e) {}
    });
    ws.on('error', (err) => {
        setTimeout(initWebSocketCandles, 5000);
    });
}
initWebSocketCandles();

// --- ĐỌC / GHI LỊCH SỬ & POSITIONS ---
function loadHistoryFiles() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
            bot.status.hist24h = data.hist24h || [];
            bot.status.histFd = data.histFd || [];
            bot.status.histVol = data.histVol || [];
            bot.status.histTrend = data.histTrend || [];
        }
        if (fs.existsSync(DEMO_HISTORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(DEMO_HISTORY_FILE, 'utf-8'));
            bot.status.demoHistory = data.demoHistory || [];
        }
    } catch (e) {}
}

function saveHistoryFiles() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify({
            hist24h: bot.status.hist24h,
            histFd: bot.status.histFd,
            histVol: bot.status.histVol,
            histTrend: bot.status.histTrend
        }, null, 2));
        fs.writeFileSync(DEMO_HISTORY_FILE, JSON.stringify({
            demoHistory: bot.status.demoHistory
        }, null, 2));
    } catch (e) {}
}

function getBaseDcaDuongPct(leverage) {
    const lev = parseFloat(leverage) || 50;
    if (lev >= 50) return 2.0;
    if (lev >= 30) return 3.5;
    if (lev >= 25) return 4.0;
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
    if (b.modeName === 'trend') {
        const dir = b.side === 'LONG' ? 1 : -1;
        const pnl = dir * (currentPrice - b.avgEntry) * b.currentQty;
        const feeAndFd = calculatePositionFeeAndFunding(botInst, b, currentPrice);
        const net = pnl - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);
        return { pairNetPnL: net, fee: feeAndFd.estimatedFee, fd: feeAndFd.accumulatedFunding, oppIsOpen: false };
    }

    const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppKey = `${b.symbol}_${oppSide}_${b.modeName}`;
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

function calculateSlDetails(botInst, b) {
    if (b.modeName === 'trend') {
        const dir = b.side === 'LONG' ? 1 : -1;
        const slPct = botInst.botSettings.posSL || 10.0;
        const targetSlPrice = b.avgEntry * (1 - dir * (slPct / 100));
        const estPnl = -1 * slPct * (b.firstMargin || 1);
        return { targetSlPrice, estPnl, isEarlySL: false };
    }

    const isAmMode = (b.dcaType === 'AM') || (b.pnl < 0) || b.isLockedAm;
    const firstMargin = b.firstMargin || 1;
    const slLimitValue = isAmMode ? (botInst.botSettings.posSL || 10.0) : (firstMargin * (botInst.botSettings.posSLDuong || 5.0));
    const currentPrice = b.livePrice || b.avgEntry;
    const details = getPairNetPnLDetails(botInst, b, currentPrice);
    
    let K = details.dirB * details.bQty - (0.001 * details.bQty);
    let C = -(details.dirB * details.bAvgEntry * details.bQty) + details.oppPnL;
    if (details.oppIsOpen) {
        K = (details.dirB * details.bQty) + (details.dirOpp * details.oppQty) - (0.001 * (details.bQty + details.oppQty));
        C = -(details.dirB * details.bAvgEntry * details.bQty) - (details.dirOpp * details.oppAvgEntry * details.oppQty);
    }
    if (Math.abs(K) < 1e-8) return { targetSlPrice: currentPrice, estPnl: -slLimitValue };
    const targetSlPrice = (-slLimitValue - C) / K;
    return { targetSlPrice: targetSlPrice > 0 ? targetSlPrice : currentPrice, estPnl: -slLimitValue };
}

function calculateSlPhongHoDetails(botInst, b) {
    if (b.side === 'LONG') return { formattedStr: '--' };
    const slPrice = b.firstEntry * 2.01;
    const estPnl = -1 * (slPrice - b.avgEntry) * b.currentQty;
    return { slPrice, estPnl, formattedStr: `${formatPrice(slPrice)} (${estPnl.toFixed(2)}$)` };
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
    } catch (e) {
        if (positionRiskCache.data) return positionRiskCache.data;
    }
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
    try {
        await botInst.exchange.setLeverage(maxLeverage, symbol);
        leverageSetCache.add(key);
    } catch (e) {}
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
        const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
        if (Array.isArray(data)) bot.botActivePositions = new Map(data);
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
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
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
    botInst.status.botLogs.unshift({ time, msg, type });
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
    console.log(`[${time}][${type.toUpperCase()}] ${msg.replace(/<[^>]*>/g, '')}`);
}

function addDemoLog(botInst, msg) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    botInst.status.demoLogs.unshift({ time, msg });
    if (botInst.status.demoLogs.length > 200) botInst.status.demoLogs.pop();
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
    const key = `${b.symbol}_${b.side}_${b.modeName}`;
    if (b.isClosing) return;
    b.isClosing = true;
    botInst.isProcessingDCA.add(key);
    checkAndAddBlacklist(b.symbol);

    closeQueue.asyncTask = closeQueue.push(async () => {
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
            const closeQty = Math.abs(parseFloat(realP.positionAmt));
            await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', closeQty, undefined, { positionSide: b.side });
            orderClosedSuccessfully = true;
        } else {
            orderClosedSuccessfully = true;
        }
    } catch (err) {
        orderClosedSuccessfully = true; // Bỏ qua nếu đã khớp
    }

    if (!orderClosedSuccessfully) return false;

    await new Promise(resolve => setTimeout(resolve, 1500));
    try {
        let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
        const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
        finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);

        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += finalPnL;

        const histItem = {
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
            symbol: b.symbol,
            side: b.side,
            lev: b.leverage || 20,
            margin: (b.currentMargin || b.firstMargin || 0).toFixed(2),
            dcaCount: b.dcaCount || 0,
            pricePct: b.profitPercent ? b.profitPercent.toFixed(2) : '0',
            dcaPrice: formatPrice(b.avgEntry),
            closePrice: formatPrice(markP),
            pnl: finalPnL,
            ema: b.emaStatus,
            super: b.superStatus,
            macd: b.macdStatus,
            vol: b.volStatus
        };

        if (b.modeName === '24h') bot.status.hist24h.unshift(histItem);
        else if (b.modeName === 'fd') bot.status.histFd.unshift(histItem);
        else if (b.modeName === 'vol') bot.status.histVol.unshift(histItem);
        else if (b.modeName === 'trend') bot.status.histTrend.unshift(histItem);

        saveHistoryFiles();

        addBotLog(botInst, `🔒 [ĐÓNG LỆNH | ${b.modeName.toUpperCase()}] ${formatCoinName(b.symbol)} ${b.side} | PnL: ${finalPnL.toFixed(2)}$ | Lý do: ${reasonStr}`, finalPnL >= 0 ? 'tp' : 'sl');
    } catch (e) {}

    return true;
}

async function panicCloseAll(botInst, reasonLog) {
    try {
        const posRisk = await getCachedPositionRisk(botInst, 0) || [];
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        let count = 0;
        for (const p of active) {
            await botInst.exchange.createOrder(p.symbol, 'MARKET', p.positionSide === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: p.positionSide });
            count++;
        }
        botInst.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(botInst, `⚠️ Đã đóng toàn bộ vị thế (${reasonLog})`, "warn");
        return { success: true, count };
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
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}_${b.modeName}` === key || `${p.symbol}_${p.positionSide}_vol` === key);
            if (realP) {
                const markP = parseFloat(realP.markPrice);
                b.livePrice = markP;
                const dir = b.side === 'LONG' ? 1 : -1;
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.profitPercent = dir * ((markP - b.avgEntry) / b.avgEntry) * 100;

                // Tính toán TP/SL cho Chế độ Trend
                if (b.modeName === 'trend') {
                    const tpPct = botInst.botSettings.tpDcaAm || 10.0; // hoặc % tp định mức
                    const slPct = botInst.botSettings.posSL || 10.0;
                    const targetTp = b.avgEntry + dir * (b.firstEntry * (tpPct / 100));
                    const targetSl = b.avgEntry - dir * (b.firstEntry * (slPct / 100));
                    b.tpCalculatedPrice = formatPrice(targetTp);
                    b.slCalculatedPrice = formatPrice(targetSl);
                    b.tpEstimatedPnL = `+${(tpPct * b.currentMargin).toFixed(2)}$`;
                    b.slEstimatedPnL = `-${(slPct * b.currentMargin).toFixed(2)}$`;

                    const hitTp = dir === 1 ? markP >= targetTp : markP <= targetTp;
                    const hitSl = dir === 1 ? markP <= targetSl : markP >= targetSl;

                    if (hitTp) {
                        queueClosePosition(botInst, b, markP, "CHỐT LÃI TREND TP");
                        continue;
                    }
                    if (hitSl) {
                        queueClosePosition(botInst, b, markP, "CẮT LỖ TREND SL");
                        continue;
                    }
                }
            }
        }
    } catch (e) {}
    setTimeout(() => priceMonitor(botInst), 300);
}

// --- HÀM MỞ VỊ THẾ THẬT HOẶC DEMO ---
async function openPosition(botInst, symbol, modeName = 'vol', forcedSide = 'LONG', trendDetails = null) {
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;

    const currentPrice = await getCachedTickerPrice(symbol, 300).catch(() => null);
    if (!currentPrice) return;

    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);
    const snapshotAvailable = 1000; // Mặc định giả lập hoặc lấy từ walletCache
    const marginSetting = botInst.botSettings.invValue || "1%";
    let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

    let finalQty = 0;
    if (modeName === 'trend' && botInst.botSettings.enableVolTrendQty) {
        // Vol Trend bật: Vốn nhập vào tính là khối lượng => Margin = khối lượng / maxLev
        finalQty = calculatedMargin; 
        calculatedMargin = (finalQty * currentPrice) / info.maxLeverage;
    } else {
        let desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
        finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
        if (finalQty * currentPrice < actualMinNotional) {
            finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
    }
    finalQty = Number(finalQty.toFixed(info.quantityPrecision));

    // Kiểm tra nếu bật chế độ Demo -> Mở lệnh giả lập (Margin 1$)
    if (botInst.botSettings.enableScanDemo) {
        const demoMargin = 1.00;
        const demoKey = `${symbol}_${forcedSide}_demo`;
        if (bot.demoActivePositions.has(demoKey)) return;

        bot.demoActivePositions.set(demoKey, {
            symbol, side: forcedSide, entry: currentPrice, closePrice: currentPrice,
            lev: info.maxLeverage, margin: demoMargin, pnl: 0,
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
        });
        addDemoLog(botInst, `🧪 [DEMO MỞ LỆNH] ${symbol} ${forcedSide} | Giá: ${formatPrice(currentPrice)} | Margin: 1.00$ | Mode: ${modeName}`);
        
        // Giả lập đóng demo sau vài giây hoặc tính pnl theo giá thực tế
        setTimeout(() => {
            const demoPos = bot.demoActivePositions.get(demoKey);
            if (demoPos) {
                const pnlDemo = (forcedSide === 'LONG' ? 1 : -1) * ((currentPrice - demoPos.entry) / demoPos.entry) * demoPos.lev * demoPos.margin;
                demoPos.pnl = pnlDemo;
                demoPos.closePrice = currentPrice;
                bot.status.demoHistory.unshift(demoPos);
                bot.demoActivePositions.delete(demoKey);
                saveHistoryFiles();
                addDemoLog(botInst, `🧪 [DEMO ĐÓNG LỆNH] ${symbol} ${forcedSide} | PnL: ${pnlDemo.toFixed(2)}$`);
            }
        }, 30000);
        return;
    }

    // Đánh thật trên sàn
    await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
    try {
        const order = await botInst.exchange.createOrder(symbol, 'MARKET', forcedSide === 'SHORT' ? 'BUY' : 'SELL', finalQty.toFixed(info.quantityPrecision), undefined, { positionSide: forcedSide });
        const avgP = parseFloat(order.average || order.price || currentPrice);

        const lockKey = `${symbol}_${forcedSide}_${modeName}`;
        const posData = {
            symbol, side: forcedSide, modeName,
            leverage: info.maxLeverage, firstEntry: avgP, firstMargin: calculatedMargin,
            currentMargin: calculatedMargin, currentQty: finalQty, avgEntry: avgP,
            livePrice: avgP, pnl: 0, profitPercent: 0,
            emaStatus: trendDetails?.ema || false,
            superStatus: trendDetails?.super || false,
            macdStatus: trendDetails?.macd || false,
            volStatus: trendDetails?.vol || false,
            tpCalculatedPrice: '-', slCalculatedPrice: '-',
            createdAt: Date.now(), time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
        };

        botInst.botActivePositions.set(lockKey, posData);
        savePositionsToFile();
        addBotLog(botInst, `🚀 [MỞ LỆNH THẬT | ${modeName.toUpperCase()}] ${formatCoinName(symbol)} ${forcedSide} | Entry: ${formatPrice(avgP)} | Margin: ${calculatedMargin.toFixed(2)}$`, 'open');
    } catch (e) {
        checkAndAddBlacklist(symbol);
    }
}

// --- QUÉT CHẾ ĐỘ TREND ---
async function scanTrendMode(botInst) {
    if (!botInst.botSettings.enableScanTrend || !botInst.botSettings.isRunning) return;
    const symbols = Object.keys(sharedState.exchangeInfo || {});
    let topTrendCandidates = [];

    for (const sym of symbols.slice(0, 30)) { // Quét top 30 coin mẫu
        if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym]) continue;
        try {
            // Lấy nến 5m và 1h giả lập hoặc từ API
            const res5m = await binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=5m&limit=30`).catch(() => null);
            if (!res5m || !res5m.data) continue;

            const candles5m = res5m.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
            const closes5m = candles5m.map(c => c.close);

            // 1. EMA 50 & 200 (giả lập trên 5m/1h)
            const ema50 = calculateEMA(closes5m, 10)[closes5m.length - 1];
            const ema200 = calculateEMA(closes5m, 20)[closes5m.length - 1];
            const lastClose = closes5m[closes5m.length - 1];
            const isLongEMA = ema50 > ema200 && lastClose > ema200;
            const isShortEMA = ema50 < ema200 && lastClose < ema200;

            // 2. Supertrend
            const st = calculateSupertrend(candles5m, 10, 3);
            const isLongSuper = st.direction === 'UP' && lastClose > st.value;
            const isShortSuper = st.direction === 'DOWN' && lastClose < st.value;

            // 3. MACD
            const macd = calculateMACD(closes5m, 12, 26, 9);
            const isLongMACD = macd.macdLine > macd.signalLine && macd.histogram > macd.prevHistogram;
            const isShortMACD = macd.macdLine < macd.signalLine && macd.histogram < macd.prevHistogram;

            // 4. Volume
            const avgVol = candles5m.slice(-21, -1).reduce((sum, c) => sum + c.volume, 0) / 20;
            const sigVol = candles5m[candles5m.length - 1].volume;
            const isVolReady = sigVol >= 1.5 * avgVol;

            let passedConditions = 0;
            if (isLongEMA || isShortEMA) passedConditions++;
            if (isLongSuper || isShortSuper) passedConditions++;
            if (isLongMACD || isShortMACD) passedConditions++;
            if (isVolReady) passedConditions++;

            topTrendCandidates.push({
                symbol: sym,
                leverage: sharedState.exchangeInfo[sym].maxLeverage,
                price: lastClose,
                ema: isLongEMA || isShortEMA,
                super: isLongSuper || isShortSuper,
                macd: isLongMACD || isShortMACD,
                vol: isVolReady,
                score: passedConditions,
                sparkline: closes5m.slice(-6)
            });

            // Nếu đạt full điều kiện Long/Short -> Mở lệnh Trend
            const activeKeys = Array.from(botInst.botActivePositions.values()).map(p => p.symbol);
            if (!activeKeys.includes(sym)) {
                if (isLongEMA && isLongSuper && isLongMACD && isVolReady) {
                    await openPosition(botInst, sym, 'trend', 'LONG', { ema: true, super: true, macd: true, vol: true });
                } else if (isShortEMA && isShortSuper && isShortMACD && isVolReady) {
                    await openPosition(botInst, sym, 'trend', 'SHORT', { ema: true, super: true, macd: true, vol: true });
                }
            }
        } catch (e) {}
    }

    topTrendCandidates.sort((a, b) => b.score - a.score);
    sharedState.topTrendList = topTrendCandidates;
}

// --- API SERVER EXPRESS ---
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
    let unrealizedPnL = 0;
    botInst.botActivePositions.forEach(p => { unrealizedPnL += (p.pnl || 0); });

    const sortedPositions = Array.from(botInst.botActivePositions.values()).map(p => ({
        ...p,
        openDurationStr: formatDuration(now - p.createdAt)
    }));

    const exchangePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => {
        const amt = Math.abs(parseFloat(p.positionAmt));
        const entryPrice = parseFloat(p.entryPrice || 0);
        const leverage = parseFloat(p.leverage || 1) || 1;
        return { ...p, margin: ((amt * entryPrice) / leverage).toFixed(2) };
    });

    const currentMinLev = botInst.botSettings.minLev !== undefined ? botInst.botSettings.minLev : 50;

    // Thống kê pnl theo từng chế độ
    const calcModeStats = (list) => {
        let cnt = list.length;
        let pnl = list.reduce((sum, item) => sum + (item.pnl || 0), 0);
        return { cnt, pnl };
    };

    const stats24h = calcModeStats(bot.status.hist24h);
    const statsFd = calcModeStats(bot.status.histFd);
    const statsVol = calcModeStats(bot.status.histVol);
    const statsTrend = calcModeStats(bot.status.histTrend);

    return { 
        botSettings: botInst.botSettings, 
        activePositions: sortedPositions, 
        exchangePositions: exchangePositions, 
        status: { 
            botLogs: botInst.status.botLogs, 
            demoLogs: botInst.status.demoLogs,
            isReady: botInst.status.isReady, 
            candidatesList: sharedState.candidatesList,
            top24hList: sharedState.top24hList.filter(c => c.leverage >= currentMinLev),
            topFundingList: sharedState.topFundingList.filter(c => c.leverage >= currentMinLev),
            topTrendList: sharedState.topTrendList.filter(c => c.leverage >= currentMinLev),
            blackList: {}, 
            hist24h: bot.status.hist24h,
            histFd: bot.status.histFd,
            histVol: bot.status.histVol,
            histTrend: bot.status.histTrend,
            demoHistory: bot.status.demoHistory,
            modeStats: {
                cnt24h: stats24h.cnt, pnl24h: stats24h.pnl,
                cntFd: statsFd.cnt, pnlFd: statsFd.pnl,
                cntVol: statsVol.cnt, pnlVol: statsVol.pnl,
                cntTrend: statsTrend.cnt, pnlTrend: statsTrend.pnl
            },
            timeRun: formatUptime(botInst.startTime) 
        }, 
        wallet: { ...walletCache.data, unrealizedPnL: unrealizedPnL.toFixed(2) }, 
        timeRun: formatUptime(botInst.startTime)
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
    const { symbol, side, modeName } = req.body; 
    const key = `${symbol}_${side}_${modeName}`; 
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
        loadHistoryFiles();
        updatePermanentBlacklist();

        bot.status.isReady = true; 
        priceMonitor(bot); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

// Lặp quét định kỳ thị trường & Trend mode
setInterval(async () => {
    if (bot.status.isReady && bot.botSettings.isRunning) {
        await scanTrendMode(bot);
    }
}, 3000);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT] Đã chạy trên port ${PORT}`));
