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
    lastClosedPnl: {}
};

// --- TECHNICAL INDICATORS & WEBSOCKET KLINES ENGINE ---
const klineCache = {
    '1h': {},
    '15m': {},
    '5m': {}
};
let wsKlinesInitialized = false;

function calculateEMA(data, period) {
    if (!data || data.length === 0) return [];
    const k = 2 / (period + 1);
    let emaArray = [];
    let sum = 0;
    for (let i = 0; i < Math.min(period, data.length); i++) {
        sum += data[i];
        emaArray.push(sum / (i + 1));
    }
    let prevEMA = emaArray[emaArray.length - 1];
    for (let i = period; i < data.length; i++) {
        prevEMA = (data[i] * k) + (prevEMA * (1 - k));
        emaArray.push(prevEMA);
    }
    return emaArray;
}

function calculateATR(highs, lows, closes, period = 14) {
    if (highs.length < period + 1) return 0;
    let trs = [];
    for (let i = 0; i < highs.length; i++) {
        const h = highs[i];
        const l = lows[i];
        const prevC = i > 0 ? closes[i - 1] : h;
        const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        trs.push(tr);
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

function calculateSupertrend(highs, lows, closes, period = 10, multiplier = 3) {
    if (closes.length < period) return { direction: 'UP', line: closes[closes.length - 1] };
    let atr = calculateATR(highs, lows, closes, period);
    let hl2 = highs.map((h, i) => (h + lows[i]) / 2);
    let basicUpper = hl2.map((val, i) => val + multiplier * atr);
    let basicLower = hl2.map((val, i) => val - multiplier * atr);
    
    let finalUpper = [basicUpper[0]];
    let finalLower = [basicLower[0]];
    let trend = [true];

    for (let i = 1; i < closes.length; i++) {
        let fu = basicUpper[i] < finalUpper[i - 1] || closes[i - 1] > finalUpper[i - 1] ? basicUpper[i] : finalUpper[i - 1];
        let fl = basicLower[i] > finalLower[i - 1] || closes[i - 1] < finalLower[i - 1] ? basicLower[i] : finalLower[i - 1];
        finalUpper.push(fu);
        finalLower.push(fl);

        let t = trend[i - 1];
        if (t && closes[i] < fl) t = false;
        else if (!t && closes[i] > fu) t = true;
        trend.push(t);
    }

    const lastIdx = closes.length - 1;
    const isUp = trend[lastIdx];
    return {
        direction: isUp ? 'UP' : 'DOWN',
        line: isUp ? finalLower[lastIdx] : finalUpper[lastIdx]
    };
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return { line: 0, signal: 0, histogram: 0, prevHistogram: 0 };
    const fastEMA = calculateEMA(closes, fast);
    const slowEMA = calculateEMA(closes, slow);
    let macdLine = [];
    for (let i = 0; i < closes.length; i++) {
        macdLine.push((fastEMA[i] || 0) - (slowEMA[i] || 0));
    }
    const signalLine = calculateEMA(macdLine, signal);
    const hist = macdLine.map((m, i) => m - (signalLine[i] || 0));
    const currH = hist[hist.length - 1] || 0;
    const prevH = hist[hist.length - 2] || 0;
    return {
        line: macdLine[macdLine.length - 1] || 0,
        signal: signalLine[signalLine.length - 1] || 0,
        histogram: currH,
        prevHistogram: prevH
    };
}

function initWebSocketKlines() {
    if (wsKlinesInitialized) return;
    wsKlinesInitialized = true;

    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    // Connect individual symbol kline streams via combined stream or individual WS
    // To keep robust and efficient, we connect to stream for top symbols or generic combined stream if available,
    // or fetch initial klines via REST and update via WebSocket.
    setInterval(async () => {
        if (!sharedState.exchangeInfo) return;
        const symbols = Object.keys(sharedState.exchangeInfo);
        // Fetch klines for analysis periodically or via WS streams
    }, 5000);

    // Let's establish a robust WebSocket stream for klines for active / top symbols
    connectCombinedKlinesWs();
}

function connectCombinedKlinesWs() {
    if (!sharedState.exchangeInfo) {
        setTimeout(connectCombinedKlinesWs, 2000);
        return;
    }
    const symbols = Object.keys(sharedState.exchangeInfo).slice(0, 60); // top 60 symbols
    const streams = [];
    symbols.forEach(s => {
        const lower = s.toLowerCase();
        streams.push(`${lower}@kline_1h`);
        streams.push(`${lower}@kline_15m`);
        streams.push(`${lower}@kline_5m`);
    });

    // Binance stream URL max length or batching
    // We can open multiple WS or fetch klines via CCXT/REST periodically to guarantee zero rate limit issues
    setInterval(async () => {
        try {
            for (const sym of symbols.slice(0, 30)) {
                const [r1h, r15m, r5m] = await Promise.all([
                    binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=1h&limit=210`).catch(() => null),
                    r15mCall => binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=15m&limit=50`).catch(() => null),
                    r5mCall => binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=5m&limit=30`).catch(() => null)
                ]);
                if (r1h && r1h.data) {
                    klineCache['1h'][sym] = r1h.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
                }
                if (r15m && r15m.data) {
                    klineCache['15m'][sym] = r15m.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
                }
                if (r5m && r5m.data) {
                    klineCache['5m'][sym] = r5m.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
                }
                await new Promise(r => setTimeout(r, 100));
            }
        } catch (e) {}
    }, 10000);
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
        } else if (['enablescantrend', 'enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'tptrendprice', 'voltrend', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
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
        enableScanTrend: false,
        enableScanVol: true,
        enableScan24h: false,
        enableScanFunding: false,
        enableScanName: false,
        scanNamesInput: "",
        minFd: 1.0,
        min24h: 0.0,
        tpTrendPrice: false,
        volTrend: false,
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

function calculateDcaDuongMargin(botInst, b) {
    const oppositeSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppKey = `${b.symbol}_${oppositeSide}`;
    const oppPos = botInst.botActivePositions.get(oppKey);
    const heSo = botInst.botSettings.heSoDcaDuong || 2.0;

    if (oppPos) {
        const oppTotalMargin = oppPos.currentMargin || oppPos.firstMargin || 0;
        return oppTotalMargin * heSo;
    }

    return (b.firstMargin || 1) * heSo;
}

function calculateDcaAmMargin(botInst, b) {
    const heSo = botInst.botSettings.heSoDcaAm || 2.0;
    return (b.firstMargin || 1) * heSo;
}

function calculateTpDcaDuongDetails(botInst, b) {
    const tpDcaDuongPct = botInst.botSettings.tpDcaDuong || 10.0;
    const minPnlHeSo = botInst.botSettings.minPnlTpDcaDuong !== undefined ? botInst.botSettings.minPnlTpDcaDuong : 10.0;
    const firstMargin = b.firstMargin || 1;
    const minPnlTp = firstMargin * minPnlHeSo;
    const dir = b.side === 'LONG' ? 1 : -1;

    const currentPrice = b.livePrice || b.avgEntry || b.firstEntry;
    const baseTpPrice = calculatePriceForTargetNetPnL(botInst, b, minPnlTp, currentPrice);

    const peak = b.peakPrice || b.firstEntry || currentPrice;
    const peakTpPrice = dir === 1 
        ? (peak * (1 - tpDcaDuongPct / 100)) 
        : (peak * (1 + tpDcaDuongPct / 100));

    const peakTpNetDetails = getPairNetPnLDetails(botInst, b, peakTpPrice);
    const estPnl = peakTpNetDetails.pairNetPnL;

    const satisfiesPnlAndOffset = dir === 1 ? (peakTpPrice >= baseTpPrice) : (peakTpPrice <= baseTpPrice);

    if (b.lockedTpPrice !== undefined) {
        const lockedNetDetails = getPairNetPnLDetails(botInst, b, b.lockedTpPrice);
        if (lockedNetDetails.pairNetPnL < minPnlTp || !satisfiesPnlAndOffset) {
            b.lockedTpPrice = undefined; 
        }
    }

    let targetTpPrice = 0;
    if (b.lockedTpPrice !== undefined) {
        targetTpPrice = b.lockedTpPrice;
    } else {
        targetTpPrice = dir === 1 
            ? Math.max(baseTpPrice, peakTpPrice) 
            : Math.min(baseTpPrice, peakTpPrice);
    }

    let badge = "✅";
    if (!satisfiesPnlAndOffset || estPnl < minPnlTp) {
        badge += ' <span style="color: #a855f7; font-weight: bold;" title="Chưa đủ PnL chốt tối thiểu">❌</span>';
    }

    return { targetTpPrice, estPnl, badge };
}

function calculateTpDcaAmDetails(botInst, b) {
    const tpDcaAmPct = botInst.botSettings.tpDcaAm || 10.0;
    const dir = b.side === 'LONG' ? 1 : -1;
    const targetTpPrice = b.avgEntry + dir * (b.firstEntry * (tpDcaAmPct / 100));
    const netDetails = getPairNetPnLDetails(botInst, b, targetTpPrice);
    const estPnl = netDetails.pairNetPnL;
    return { targetTpPrice, estPnl };
}

function calculateSlDetails(botInst, b) {
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

function calculateSlPhongHoDetails(botInst, b) {
    if (b.side === 'LONG') {
        return { formattedStr: '--' };
    }
    const slPrice = b.firstEntry * 2.01;
    const estPnl = -1 * (slPrice - b.avgEntry) * b.currentQty;
    return { 
        slPrice, 
        estPnl, 
        formattedStr: `${formatPrice(slPrice)} (${estPnl.toFixed(2)}$)` 
    };
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
    
    sharedState.masterLogs.unshift({ time, msg: `[${botInst.id}] ${msg}`, type });
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    
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
                const errMsg = err?.response?.data?.msg || err?.message || String(err);
                if (errMsg.includes('2022') || errMsg.includes('ReduceOnly Order would be rejected')) {
                    orderClosedSuccessfully = true;
                } else {
                    return false;
                }
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
            finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);
        }

        sharedState.lastClosedPnl[`${b.symbol}_${b.side}`] = finalPnL;

        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += finalPnL;

        if (finalPnL >= 0) {
            botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
        } else {
            botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
        }

        let logType = finalPnL >= 0 ? "tp" : "sl";
        let detailTag = finalPnL >= 0 ? "CHỐT LÃI" : "CẮT LỖ";

        const formattedSymbol = formatCoinName(b.symbol);
        addBotLog(botInst, `🔒 [${detailTag} | LÝ DO: ${reasonStr}] ${formattedSymbol} ${b.side} | Chế độ: [${b.modeName || 'vol'}] | Giá chốt: ${formatPrice(markP)} | Net PnL: ${finalPnL.toFixed(2)}$`, logType);
        
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
            const key = `${p.symbol}_${side}`;
            
            checkAndAddBlacklist(p.symbol);

            try {
                await botInst.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                count++;
            } catch (err) { }
        }
        botInst.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(botInst, `⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] Đã giải phóng tài khoản (${reasonLog}).`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function priceMonitor(botInst) {
    if (!botInst.status.isReady) return setTimeout(() => priceMonitor(botInst), 300);
    try {
        if (!botInst.botSettings.isRunning) return setTimeout(() => priceMonitor(botInst), 300);
        
        const posRisk = await getCachedPositionRisk(botInst, 300);
        if (!posRisk || !Array.isArray(posRisk)) {
            return setTimeout(() => priceMonitor(botInst), 300);
        }

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

                const currentAvgEntry = b.avgEntry || parseFloat(realP.entryPrice) || b.firstEntry;
                b.avgEntry = currentAvgEntry;

                if (b.side === 'LONG') {
                    b.profitPercent = ((markP - currentAvgEntry) / currentAvgEntry) * 100;
                } else {
                    b.profitPercent = ((currentAvgEntry - markP) / currentAvgEntry) * 100;
                }

                const netDetails = getPairNetPnLDetails(botInst, b, markP);

                savePositionsToFile();

                // TREND MODE POSITION MONITORING LOGIC
                if (b.modeName === 'trend') {
                    // Check SL PnL
                    const slLimit = (b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0);
                    if (netDetails.pairNetPnL <= -slLimit) {
                        queueClosePosition(botInst, b, markP, `TREND SL PNL (${netDetails.pairNetPnL.toFixed(2)}$)`);
                        continue;
                    }
                    // Check TP if tpTrendPrice enabled
                    if (botInst.botSettings.tpTrendPrice) {
                        const tpPct = botInst.botSettings.tpDcaDuong || 10.0;
                        const targetTp = b.side === 'LONG' ? b.firstEntry * (1 + tpPct / 100) : b.firstEntry * (1 - tpPct / 100);
                        const hitTp = b.side === 'LONG' ? markP >= targetTp : markP <= targetTp;
                        if (hitTp) {
                            queueClosePosition(botInst, b, markP, `TREND TP %PRICE CHẠY ĐẠT ${tpPct}%`);
                            continue;
                        }
                    }
                    // Check EMA 1h reversal check: Nếu chưa đạt TP mà ema nến 1h đóng bị đảo chiều => cắt lệnh nếu pnl đã lãi & vẫn giữ lệnh nếu pnl đang âm
                    const klines1h = klineCache['1h'][b.symbol];
                    if (klines1h && klines1h.length > 50) {
                        const closes = klines1h.map(k => k.close);
                        const ema50Arr = calculateEMA(closes, 50);
                        const ema200Arr = calculateEMA(closes, 200);
                        const lastE50 = ema50Arr[ema50Arr.length - 1];
                        const lastE200 = ema200Arr[ema200Arr.length - 1];
                        const isEmaBullish = lastE50 > lastE200;
                        const isEmaBearish = lastE50 < lastE200;

                        const hasReversed = (b.side === 'LONG' && isEmaBearish) || (b.side === 'SHORT' && isEmaBullish);
                        if (hasReversed) {
                            if (b.pnl >= 0) {
                                queueClosePosition(botInst, b, markP, `TREND CẮT LỆNH DO EMA 1H ĐẢO CHIỀU (PnL Lãi: ${b.pnl.toFixed(2)}$)`);
                                continue;
                            }
                        }
                    }
                    continue; // Skip standard DCA logic for trend mode
                }

                // Standard DCA / TP / SL logic for non-trend positions
                const isAmMode = (b.pnl < 0);
                const slLimit = isAmMode ? (botInst.botSettings.posSL || 10.0) : ((b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0));

                if (netDetails.pairNetPnL <= -slLimit) {
                    queueClosePosition(botInst, b, markP, `CẮT LỖ SL PNL CẶP`);
                    continue;
                }
            } else {
                if (!botInst.isProcessingDCA.has(lockKey)) {
                    botInst.botActivePositions.delete(key); 
                    savePositionsToFile();
                    checkAndAddBlacklist(b.symbol);
                }
            }
        }
    } catch (e) { }
    
    setTimeout(() => priceMonitor(botInst), 300);
}

async function openPosition(botInst, symbol, dcaData = null, forcedSide = 'LONG', sharedQty = null, sharedMargin = null, sharedPrice = null, modeName = 'vol', extraLogInfo = '') {
    const side = forcedSide; 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;

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
            if (qty * currentPrice < actualMinNotional) {
                qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
            qty = Number(qty.toFixed(info.quantityPrecision)); 
        } else {
            qty = sharedQty;
            margin = sharedMargin;
            currentPrice = sharedPrice;
        }

        await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
        
        let order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            let actualFilledPrice = currentPrice;
            let cumulativeQty = qty;
            let cumulativeCost = qty * actualFilledPrice;
            let newAvgEntry = actualFilledPrice;
            let actualMarginUsed = margin;

            const nowTime = Date.now();
            
            const posData = { 
                symbol, side, entryPrice: newAvgEntry, 
                modeName: modeName,
                fundingRate: 0,
                leverage: info.maxLeverage, firstEntry: newAvgEntry, firstMargin: actualMarginUsed, 
                currentMargin: actualMarginUsed, currentQty: cumulativeQty, 
                cumulativeQty: cumulativeQty, cumulativeCost: cumulativeCost, dcaHistory: [{ price: actualFilledPrice, margin: actualMarginUsed, type: 'ENTRY' }],
                pnl: 0, profitPercent: 0, peakPrice: actualFilledPrice,
                avgEntry: newAvgEntry, livePrice: actualFilledPrice,
                createdAt: nowTime,
                lastActionTime: nowTime, 
                time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
            };

            botInst.botActivePositions.set(lockKey, posData);
            savePositionsToFile();

            addBotLog(botInst, `[MỞ ${side} | CHẾ ĐỘ: ${modeName.toUpperCase()}] ${formatCoinName(symbol)} | Margin: ${actualMarginUsed.toFixed(2)}$ | Entry: ${formatPrice(newAvgEntry)} ${extraLogInfo}`, "open"); 
        }
    } catch (e) { 
        checkAndAddBlacklist(symbol);
    } finally { 
        setTimeout(() => {
            botInst.isProcessingDCA.delete(lockKey);
        }, 1000); 
        sharedState.pendingOrders.delete(symbol);
    }
}

async function checkMarginLimits(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return;
    const now = Date.now();
    if (!walletCache.data || (now - walletCache.lastUpdate > 3000)) {
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

    const sortedPositions = Array.from(botInst.botActivePositions.values())
        .map(p => {
            const openDurationMs = now - (p.createdAt || now);
            const slDet = calculateSlDetails(botInst, p);
            const tpDet = p.modeName === 'trend' ? { targetTpPrice: '-', estPnl: '-' } : calculateTpDcaDuongDetails(botInst, p);
            const feeAndFd = calculatePositionFeeAndFunding(botInst, p, p.livePrice || p.avgEntry);

            return {
                ...p,
                estimatedFee: feeAndFd.estimatedFee,
                accumulatedFunding: feeAndFd.accumulatedFunding,
                openDurationStr: formatDuration(openDurationMs),
                tpCalculatedPrice: tpDet.targetTpPrice,
                tpEstimatedPnL: '-',
                slCalculatedPrice: slDet.targetSlPrice ? formatPrice(slDet.targetSlPrice) : '-',
                slEstimatedPnL: slDet.estPnl !== undefined ? `${slDet.estPnl.toFixed(2)}$` : '-'
            };
        })
        .sort((a, b) => (a.pnl || 0) - (b.pnl || 0));

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
            permanentBlacklist: sharedState.permanentBlacklist, 
            exchangeInfo: sharedState.exchangeInfo, 
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

appServer.get('/api/status', async (req, res) => {
    const data = await buildStatusResponse(bot);
    res.json(data);
});

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
        updatePermanentBlacklist();

        initWebSocketKlines();

        await new Promise(r => setTimeout(r, 1500));
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

        // --- EVALUATE TREND MODE CONDITIONS FOR ALL SYMBOLS ---
        if (bot.botSettings.enableScanTrend && sharedState.exchangeInfo) {
            let trendCandidates = [];
            for (const sym of Object.keys(sharedState.exchangeInfo)) {
                const k1h = klineCache['1h'][sym];
                const k15m = klineCache['15m'][sym];
                const k5m = klineCache['5m'][sym];
                if (!k1h || k1h.length < 210 || !k15m || k15m.length < 50 || !k5m || k5m.length < 50) continue;

                // 1. EMA (50, 200, 1H)
                const closes1h = k1h.map(k => k.close);
                const ema50_1h = calculateEMA(closes1h, 50);
                const ema200_1h = calculateEMA(closes1h, 200);
                const e50 = ema50_1h[ema50_1h.length - 1];
                const e200 = ema200_1h[ema200_1h.length - 1];
                const lastC1h = closes1h[closes1h.length - 1];
                const isLongEma = e50 > e200 && lastC1h > e200;
                const isShortEma = e50 < e200 && lastC1h < e200;
                const emaPass = isLongEma || isShortEma;
                const direction = isLongEma ? 'LONG' : (isShortEma ? 'SHORT' : null);
                if (!direction) continue;

                // 2. Supertrend (ATR=10, Mult=3, 15m)
                const highs15 = k15m.map(k => k.high);
                const lows15 = k15m.map(k => k.low);
                const closes15 = k15m.map(k => k.close);
                const st = calculateSupertrend(highs15, lows15, closes15, 10, 3);
                const stPass = (direction === 'LONG' && st.direction === 'UP' && closes15[closes15.length - 1] > st.line) ||
                               (direction === 'SHORT' && st.direction === 'DOWN' && closes15[closes15.length - 1] < st.line);

                // 3. MACD (12, 26, 9, 5m)
                const closes5m = k5m.map(k => k.close);
                const macd = calculateMACD(closes5m, 12, 26, 9);
                const macdPass = (direction === 'LONG' && macd.line > macd.signal && macd.histogram > macd.prevHistogram) ||
                                 (direction === 'SHORT' && macd.line < macd.signal && macd.histogram < macd.prevHistogram);

                // 4. Volume (5m, >= 1.5 * avg 20 prev volumes)
                const vols5m = k5m.map(k => k.volume);
                const currVol = vols5m[vols5m.length - 1];
                const prev20Vols = vols5m.slice(vols5m.length - 21, vols5m.length - 1);
                const avgVol20 = prev20Vols.reduce((a, b) => a + b, 0) / (prev20Vols.length || 1);
                const volPass = currVol >= 1.5 * avgVol20;

                // 5. Breakout & 6. Anti-late entry (ATR)
                const highs5m = k5m.map(k => k.high);
                const lows5m = k5m.map(k => k.low);
                const prev20Highs = highs5m.slice(highs5m.length - 21, highs5m.length - 1);
                const prev20Lows = lows5m.slice(lows5m.length - 21, lows5m.length - 1);
                const highestHigh20 = Math.max(...prev20Highs);
                const lowestLow20 = Math.min(...prev20Lows);
                const breakoutPass = (direction === 'LONG' && lastC1h >= highestHigh20) || (direction === 'SHORT' && lastC1h <= lowestLow20);

                const atr14_5m = calculateATR(highs5m, lows5m, closes5m, 14);
                const ema50_5m = calculateEMA(closes5m, 50);
                const currEma50_5m = ema50_5m[ema50_5m.length - 1] || currC = closes5m[closes5m.length - 1];
                const currPrice = closes5m[closes5m.length - 1];
                const distanceAtr = direction === 'LONG' ? (currPrice - currEma50_5m) / atr14_5m : (currEma50_5m - currPrice) / atr14_5m;
                const antiLatePass = distanceAtr <= 1.5;

                const score = (emaPass ? 1 : 0) + (stPass ? 1 : 0) + (macdPass ? 1 : 0) + (volPass ? 1 : 0) + (breakoutPass ? 1 : 0) + (antiLatePass ? 1 : 0);
                const detailText = `EMA50:${e50.toFixed(2)} EMA200:${e200.toFixed(2)} | MACD Hist:${macd.histogram.toFixed(4)}`;
                const info = sharedState.exchangeInfo[sym];

                trendCandidates.push({
                    symbol: sym,
                    direction,
                    price: currPrice,
                    leverage: info?.maxLeverage || 20,
                    score,
                    detailText,
                    emaPass,
                    superPass: stPass,
                    macdPass,
                    volPass
                });
            }

            // Sort by priority: EMA, Super, MACD, Vol (highest score and conditions)
            trendCandidates.sort((a, b) => b.score - a.score);
            sharedState.topTrendList = trendCandidates;
        }

    } catch (e) {}
}, 5000);

let isScanning = false;

setInterval(async () => {
    if (isScanning) return;
    isScanning = true;

    try {
        await checkMarginLimits(bot);
        if (!bot.status.isReady || !bot.botSettings.isRunning) return;

        const maxPosSetting = bot.botSettings.maxPositions || 3;
        const uniqueActiveSymbols = new Set(Array.from(bot.botActivePositions.values()).map(p => p.symbol));

        // --- TREND MODE EXECUTION ---
        if (bot.botSettings.enableScanTrend) {
            const activeTrendCount = Array.from(bot.botActivePositions.values()).filter(p => p.modeName === 'trend').length;
            if (activeTrendCount < maxPosSetting && sharedState.topTrendList.length > 0) {
                for (const item of sharedState.topTrendList) {
                    const sym = item.symbol;
                    if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
                    if (uniqueActiveSymbols.has(sym)) continue;
                    if (item.score < 4) continue; // Require strong confirmation

                    const info = sharedState.exchangeInfo[sym];
                    if (!info) continue;

                    sharedState.pendingOrders.add(sym);
                    setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);

                    // Calculate margin / qty based on volTrend setting
                    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
                    const availBal = parseFloat(acc?.availableBalance || 0);
                    const marginSetting = bot.botSettings.invValue || "1%";
                    let calculatedMargin = marginSetting.toString().includes('%') ? (availBal * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

                    if (bot.botSettings.volTrend) {
                        // Capital input treated as volume => margin = volume / maxLev
                        const volumeInput = parseFloat(marginSetting) || 100;
                        calculatedMargin = volumeInput / info.maxLeverage;
                    }

                    let desiredQty = (calculatedMargin * info.maxLeverage) / item.price;
                    let finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
                    const finalMargin = (finalQty * item.price) / info.maxLeverage;

                    await openPosition(bot, sym, null, item.direction, finalQty, finalMargin, item.price, 'trend', `| TREND SCORE: ${item.score}/6`);
                    break;
                }
            }
        }

    } finally {
        isScanning = false;
    }
}, 500);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT] Đã chạy trên port ${PORT}`));
