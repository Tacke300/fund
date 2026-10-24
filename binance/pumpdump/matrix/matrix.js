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

const PORT = 4404;
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
    lastClosedPnl: {},
    klineCache: {
        '1h': {},
        '15m': {},
        '5m': {}
    }
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
        } else if (['enabletrendmode', 'tptrendprice', 'voltrend', 'enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
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
        enableTrendMode: false,
        tpTrendPrice: false,
        volTrend: false,
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

// TECHNICAL INDICATOR CALCULATION FUNCTIONS (EMA, Supertrend, MACD, ATR, etc.)
function calculateEMA(prices, period) {
    if (!prices || prices.length === 0) return [];
    const k = 2 / (period + 1);
    let emaArray = [];
    let sum = 0;
    const initialLen = Math.min(period, prices.length);
    for (let i = 0; i < initialLen; i++) {
        sum += prices[i];
    }
    let prevEMA = sum / initialLen;
    emaArray.push(prevEMA);
    for (let i = 1; i < prices.length; i++) {
        const val = (prices[i] * k) + (prevEMA * (1 - k));
        emaArray.push(val);
        prevEMA = val;
    }
    return emaArray;
}

function calculateATR(highs, lows, closes, period = 14) {
    if (highs.length < 2) return [];
    let trs = [highs[0] - lows[0]];
    for (let i = 1; i < highs.length; i++) {
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
        trs.push(tr);
    }
    let atr = [];
    let sum = 0;
    for (let i = 0; i < Math.min(period, trs.length); i++) {
        sum += trs[i];
    }
    let prevATR = sum / Math.min(period, trs.length);
    atr.push(prevATR);
    for (let i = 1; i < trs.length; i++) {
        prevATR = (prevATR * (period - 1) + trs[i]) / period;
        atr.push(prevATR);
    }
    return atr;
}

function calculateSupertrend(highs, lows, closes, atrPeriod = 10, multiplier = 3) {
    const atr = calculateATR(highs, lows, closes, atrPeriod);
    let supertrends = [];
    let directions = []; // 1 for up, -1 for down
    let upperBand = 0, lowerBand = 0;
    let dir = 1;

    for (let i = 0; i < closes.length; i++) {
        if (i < atrPeriod) {
            supertrends.push(closes[i]);
            directions.push(1);
            continue;
        }
        const hl2 = (highs[i] + lows[i]) / 2;
        const currentAtr = atr[i] || atr[atr.length - 1];
        let basicUpper = hl2 + (multiplier * currentAtr);
        let basicLower = hl2 - (multiplier * currentAtr);

        if (i === atrPeriod) {
            upperBand = basicUpper;
            lowerBand = basicLower;
        } else {
            upperBand = basicUpper < upperBand || closes[i - 1] > upperBand ? basicUpper : upperBand;
            lowerBand = basicLower > lowerBand || closes[i - 1] < lowerBand ? basicLower : lowerBand;
        }

        if (dir === 1) {
            if (closes[i] < lowerBand) {
                dir = -1;
            }
        } else {
            if (closes[i] > upperBand) {
                dir = 1;
            }
        }
        directions.push(dir);
        supertrends.push(dir === 1 ? lowerBand : upperBand);
    }
    return { supertrends, directions };
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = calculateEMA(closes, fast);
    const emaSlow = calculateEMA(closes, slow);
    let macdLine = [];
    for (let i = 0; i < closes.length; i++) {
        macdLine.push((emaFast[i] || 0) - (emaSlow[i] || 0));
    }
    const signalLine = calculateEMA(macdLine, signal);
    let histogram = [];
    for (let i = 0; i < closes.length; i++) {
        histogram.push((macdLine[i] || 0) - (signalLine[i] || 0));
    }
    return { macdLine, signalLine, histogram };
}

// WEBSOCKET KLINE CONNECTOR TO AVOID RATE LIMIT
let wsKlines = null;
function initKlineWebSockets() {
    try {
        const streams = [];
        // Subscribe to 1h, 15m, 5m klines for all trading pairs if possible or top symbols
        // To be safe and lightweight, we connect to Binance futures combined stream or individual streams when needed.
        // Let's connect to combined stream for top volume / exchange symbols.
        const wsUrl = 'wss://fstream.binance.com/ws';
        wsKlines = new WebSocket(wsUrl);

        wsKlines.on('open', () => {
            // Subscribe to top symbols 1h, 15m, 5m streams
            setTimeout(() => {
                if (sharedState.exchangeInfo) {
                    const symbols = Object.keys(sharedState.exchangeInfo).slice(0, 50).map(s => `${s.toLowerCase()}@kline_1h`).concat(
                        Object.keys(sharedState.exchangeInfo).slice(0, 50).map(s => `${s.toLowerCase()}@kline_15m`),
                        Object.keys(sharedState.exchangeInfo).slice(0, 50).map(s => `${s.toLowerCase()}@kline_5m`)
                    );
                    // Send in chunks
                    for (let i = 0; i < symbols.length; i += 50) {
                        const chunk = symbols.slice(i, i + 50);
                        wsKlines.send(JSON.stringify({
                            method: "SUBSCRIBE",
                            params: chunk,
                            id: Date.now() + i
                        }));
                    }
                }
            }, 2000);
        });

        wsKlines.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.k) {
                    const k = msg.k;
                    const sym = k.s;
                    const tf = k.interval;
                    if (!sharedState.klineCache[tf]) sharedState.klineCache[tf] = {};
                    if (!sharedState.klineCache[tf][sym]) sharedState.klineCache[tf][sym] = [];
                    
                    const klineObj = {
                        t: k.t,
                        open: parseFloat(k.o),
                        high: parseFloat(k.h),
                        low: parseFloat(k.l),
                        close: parseFloat(k.c),
                        volume: parseFloat(k.v),
                        closed: k.x
                    };
                    
                    const list = sharedState.klineCache[tf][sym];
                    if (list.length > 0 && list[list.length - 1].t === klineObj.t) {
                        list[list.length - 1] = klineObj;
                    } else {
                        list.push(klineObj);
                        if (list.length > 200) list.shift();
                    }
                }
            } catch (e) {}
        });

        wsKlines.on('error', () => {});
        wsKlines.on('close', () => {
            setTimeout(initKlineWebSockets, 5000);
        });
    } catch (e) {}
}

// Fallback REST fetch klines if websocket cache is empty
async function getHistoricalKlines(symbol, interval, limit = 100) {
    if (sharedState.klineCache[interval] && sharedState.klineCache[interval][symbol] && sharedState.klineCache[interval][symbol].length >= 30) {
        return sharedState.klineCache[interval][symbol];
    }
    try {
        const res = await binanceApi.get(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        const formatted = res.data.map(k => ({
            t: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            closed: true
        }));
        if (!sharedState.klineCache[interval]) sharedState.klineCache[interval] = {};
        sharedState.klineCache[interval][symbol] = formatted;
        return formatted;
    } catch (e) {
        return [];
    }
}

// EVALUATE TREND CONDITIONS FOR A SYMBOL
async function evaluateTrendForSymbol(symbol) {
    const klines1h = await getHistoricalKlines(symbol, '1h', 250);
    const klines15m = await getHistoricalKlines(symbol, '15m', 100);
    const klines5m = await getHistoricalKlines(symbol, '5m', 100);

    if (klines1h.length < 200 || klines15m.length < 50 || klines5m.length < 50) {
        return null;
    }

    const closes1h = klines1h.map(k => k.close);
    const ema50_1h = calculateEMA(closes1h, 50);
    const ema200_1h = calculateEMA(closes1h, 200);
    const curEma50_1h = ema50_1h[ema50_1h.length - 1];
    const curEma200_1h = ema200_1h[ema200_1h.length - 1];
    const close1h = closes1h[closes1h.length - 1];

    // 1. EMA 1H
    const isEmaLong = curEma50_1h > curEma200_1h && close1h > curEma200_1h;
    const isEmaShort = curEma50_1h < curEma200_1h && close1h < curEma200_1h;
    if (!isEmaLong && !isEmaShort) return null;
    const trendSide = isEmaLong ? 'LONG' : 'SHORT';

    // 2. Supertrend 15m
    const highs15m = klines15m.map(k => k.high);
    const lows15m = klines15m.map(k => k.low);
    const closes15m = klines15m.map(k => k.close);
    const st = calculateSupertrend(highs15m, lows15m, closes15m, 10, 3);
    const stDir = st.directions[st.directions.length - 1];
    const close15m = closes15m[closes15m.length - 1];
    const stLine = st.supertrends[st.supertrends.length - 1];
    const isSuperLong = stDir === 1 && close15m > stLine;
    const isSuperShort = stDir === -1 && close15m < stLine;
    if (trendSide === 'LONG' && !isSuperLong) return null;
    if (trendSide === 'SHORT' && !isSuperShort) return null;

    // 3. MACD 5m
    const closes5m = klines5m.map(k => k.close);
    const macd = calculateMACD(closes5m, 12, 26, 9);
    const curMacd = macd.macdLine[macd.macdLine.length - 1];
    const curSignal = macd.signalLine[macd.signalLine.length - 1];
    const curHist = macd.histogram[macd.histogram.length - 1];
    const prevHist = macd.histogram[macd.histogram.length - 2] || 0;
    const isMacdLong = curMacd > curSignal && curHist > prevHist;
    const isMacdShort = curMacd < curSignal && curHist < prevHist;
    if (trendSide === 'LONG' && !isMacdLong) return null;
    if (trendSide === 'SHORT' && !isMacdShort) return null;

    // 4. Volume 5m
    const vols5m = klines5m.map(k => k.volume);
    const signalVol = vols5m[vols5m.length - 1];
    let sumVol20 = 0;
    for (let i = Math.max(0, vols5m.length - 21); i < vols5m.length - 1; i++) {
        sumVol20 += vols5m[i];
    }
    const avgVol20 = sumVol20 / Math.min(20, vols5m.length - 1);
    const isVolPass = signalVol >= 1.5 * avgVol20;
    if (!isVolPass) return null;

    // 5. Breakout 5m (last 20 closed candles before current)
    const recent20 = klines5m.slice(Math.max(0, klines5m.length - 21), klines5m.length - 1);
    const maxHigh20 = Math.max(...recent20.map(k => k.high));
    const minLow20 = Math.min(...recent20.map(k => k.low));
    const sigClose = klines5m[klines5m.length - 1].close;
    const isBreakoutLong = sigClose > maxHigh20;
    const isBreakoutShort = sigClose < minLow20;
    if (trendSide === 'LONG' && !isBreakoutLong) return null;
    if (trendSide === 'SHORT' && !isBreakoutShort) return null;

    // 6. Anti-late entry (ATR 14, EMA 50 on 5m)
    const ema50_5m = calculateEMA(closes5m, 50);
    const curEma50_5m = ema50_5m[ema50_5m.length - 1];
    const highs5m = klines5m.map(k => k.high);
    const lows5m = klines5m.map(k => k.low);
    const atr14_5m = calculateATR(highs5m, lows5m, closes5m, 14);
    const curAtr = atr14_5m[atr14_5m.length - 1] || 1;
    const distance = trendSide === 'LONG' ? (sigClose - curEma50_5m) / curAtr : (curEma50_5m - sigClose) / curAtr;
    if (distance > 1.5) return null; // Too late

    const score = 4; // EMA, Supertrend, MACD, Vol all passed
    const info = sharedState.exchangeInfo[symbol];

    return {
        symbol,
        side: trendSide,
        price: sigClose,
        leverage: info?.maxLeverage || 20,
        emaPass: true,
        superPass: true,
        macdPass: true,
        volPass: true,
        score
    };
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
        const slLimitValue = firstMargin * (botInst.botSettings.posSLDuong || 5.0);
        const currentPrice = b.livePrice || b.avgEntry;
        const dir = b.side === 'LONG' ? 1 : -1;
        const targetSlPrice = currentPrice - dir * (slLimitValue / (b.currentQty || 1));
        return { targetSlPrice, estPnl: -slLimitValue, isEarlySL: false };
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
    } catch (e) {
        try {
            const data = Array.from(bot.botActivePositions.entries());
            fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
        } catch (err) {
            console.error("Lỗi khi ghi vị thế vào position.json:", err.message);
        }
    }
}

function loadPositionsFromFile() {
    try {
        if (!fs.existsSync(POSITIONS_FILE)) return;
        const raw = fs.readFileSync(POSITIONS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            bot.botActivePositions = new Map(data);
        }
    } catch (e) {
        console.error("Lỗi khi đọc vị thế từ position.json:", e.message);
    }
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
        } catch (e) {
            console.error("Lỗi khi xử lý hàng chờ đóng vị thế:", e.message);
        }
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
                    addBotLog(botInst, `⚠️ Lỗi gửi lệnh Market đóng ${formatCoinName(b.symbol)}: ${errMsg}`, "warn");
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
            finalPnL = pnlRaw;
        }

        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += finalPnL;

        if (finalPnL >= 0) {
            botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
        } else {
            botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
        }

        const formattedSymbol = formatCoinName(b.symbol);
        addBotLog(botInst, `🔒 [ĐÓNG LỆNH | LÝ DO: ${reasonStr}] ${formattedSymbol} ${b.side} | Chế độ: [${b.modeName}] | Giá chốt: ${formatPrice(markP)} | PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? 'tp' : 'sl');
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
            if (realP) {
                const exchangeQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);

                b.currentQty = exchangeQty;
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.livePrice = markP;
                b.avgEntry = parseFloat(realP.entryPrice) || b.firstEntry;

                const dir = b.side === 'LONG' ? 1 : -1;

                // TREND MODE REVERSAL CHECK & TP/SL CHECK
                if (b.modeName === 'trend') {
                    // Check if 1h EMA closed in reverse direction
                    const klines1h = await getHistoricalKlines(b.symbol, '1h', 50);
                    if (klines1h.length >= 200) {
                        const closes1h = klines1h.map(k => k.close);
                        const ema50 = calculateEMA(closes1h, 50);
                        const ema200 = calculateEMA(closes1h, 200);
                        const curEma50 = ema50[ema50.length - 1];
                        const curEma200 = ema200[ema200.length - 1];
                        const isReversedLong = b.side === 'LONG' && curEma50 < curEma200;
                        const isReversedShort = b.side === 'SHORT' && curEma50 > curEma200;

                        if (isReversedLong || isReversedShort) {
                            if (b.pnl >= 0) {
                                queueClosePosition(botInst, b, markP, "EMA 1H ĐẢO CHIỀU KHI PNL LÃI");
                                continue;
                            }
                        }
                    }

                    // TP Check for Trend Mode
                    if (botInst.botSettings.tpTrendPrice) {
                        const tpPct = botInst.botSettings.tpDcaDuong || 10.0;
                        const targetTpPrice = b.side === 'LONG' ? b.firstEntry * (1 + tpPct / 100) : b.firstEntry * (1 - tpPct / 100);
                        const hitTp = b.side === 'LONG' ? markP >= targetTpPrice : markP <= targetTpPrice;
                        if (hitTp) {
                            queueClosePosition(botInst, b, markP, `CHỐT TP TREND % PRICE (${tpPct}%)`);
                            continue;
                        }
                    } else {
                        // Uses min tp dca duong logic
                        const minPnlTp = (b.firstMargin || 1) * (botInst.botSettings.minPnlTpDcaDuong || 10.0);
                        if (b.pnl >= minPnlTp) {
                            queueClosePosition(botInst, b, markP, "CHỐT TP TREND MIN PNL DƯƠNG");
                            continue;
                        }
                    }

                    // SL Check for Trend Mode
                    const firstMargin = b.firstMargin || 1;
                    const slLimit = firstMargin * (botInst.botSettings.posSLDuong || 5.0);
                    if (b.pnl <= -slLimit) {
                        queueClosePosition(botInst, b, markP, `CẮT LỖ SL TREND PNL (${b.pnl.toFixed(2)}$ <= -${slLimit}$)`);
                        continue;
                    }
                    continue;
                }

                // Standard DCA modes monitoring... (omitted or kept as original)
            } else {
                botInst.botActivePositions.delete(key);
                savePositionsToFile();
            }
        }
    } catch (e) {}
    
    setTimeout(() => priceMonitor(botInst), 300);
}

async function openTrendPosition(botInst, trendItem) {
    const symbol = trendItem.symbol;
    const side = trendItem.side;
    const lockKey = `${symbol}_${side}`;
    if (botInst.isProcessingDCA.has(lockKey)) return;
    botInst.isProcessingDCA.add(lockKey);

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) return;

        const currentPrice = await getCachedTickerPrice(symbol, 300);
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
        const availBal = parseFloat(acc?.availableBalance || 0);

        let qty = 0;
        let margin = 0;

        if (botInst.botSettings.volTrend) {
            // Capital input is volume/quantity directly
            const rawVol = parseFloat(botInst.botSettings.invValue) || 1.0;
            qty = Math.floor(rawVol / info.stepSize) * info.stepSize;
            margin = (qty * currentPrice) / info.maxLeverage;
        } else {
            const marginSetting = botInst.botSettings.invValue || "1%";
            margin = marginSetting.toString().includes('%') ? (availBal * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);
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
        
        let actualFilledPrice = currentPrice;
        if (order && order.average) actualFilledPrice = parseFloat(order.average);

        const nowTime = Date.now();
        const posData = {
            symbol,
            side,
            entryPrice: actualFilledPrice,
            leverage: info.maxLeverage,
            firstEntry: actualFilledPrice,
            firstMargin: margin,
            currentMargin: margin,
            currentQty: qty,
            pnl: 0,
            avgEntry: actualFilledPrice,
            livePrice: actualFilledPrice,
            modeName: 'trend',
            indicatorInfo: 'EMA + Supertrend + MACD + Vol',
            createdAt: nowTime,
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
        };

        botInst.botActivePositions.set(lockKey, posData);
        savePositionsToFile();
        addBotLog(botInst, `🌊 [MỞ TREND ${side}] ${formatCoinName(symbol)} | Margin: ${margin.toFixed(2)}$ | Entry: ${formatPrice(actualFilledPrice)}`, "open");

    } catch (e) {
        checkAndAddBlacklist(symbol);
    } finally {
        setTimeout(() => botInst.isProcessingDCA.delete(lockKey), 1000);
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
                tpCalculatedPrice: p.modeName === 'trend' ? (botInst.botSettings.tpTrendPrice ? formatPrice(p.side === 'LONG' ? p.firstEntry * (1 + (botInst.botSettings.tpDcaDuong || 10) / 100) : p.firstEntry * (1 - (botInst.botSettings.tpDcaDuong || 10) / 100)) : 'Theo Min PnL Dương') : '-',
                slCalculatedPrice: formatPrice(slDet.targetSlPrice),
                estimatedFee: 0,
                accumulatedFunding: 0
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
        wallet: { ...walletCache.data, unrealizedPnL: unrealizedPnL.toFixed(2) }
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

        initKlineWebSockets();

        bot.status.isReady = true; 
        priceMonitor(bot); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

// BACKGROUND SCANNER FOR TREND & OTHER MODES
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

        // Calculate Top Trend immediately as requested
        const trendCandidates = [];
        const sampleSymbols = Object.keys(sharedState.exchangeInfo || {}).slice(0, 30);
        for (const sym of sampleSymbols) {
            const res = await evaluateTrendForSymbol(sym);
            if (res) trendCandidates.push(res);
        }
        trendCandidates.sort((a, b) => b.score - a.score);
        sharedState.topTrendList = trendCandidates;

    } catch (e) {}
}, 10000);

let isScanning = false;
setInterval(async () => {
    if (isScanning) return;
    isScanning = true;

    try {
        await checkMarginLimits(bot);
        if (!bot.status.isReady || !bot.botSettings.isRunning) return;

        const maxPosSetting = bot.botSettings.maxPositions || 3;
        const uniqueActiveSymbols = new Set(Array.from(bot.botActivePositions.values()).map(p => p.symbol));

        // TREND MODE EXECUTION
        if (bot.botSettings.enableTrendMode) {
            const currentTrendPositions = Array.from(bot.botActivePositions.values()).filter(p => p.modeName === 'trend');
            if (currentTrendPositions.length < maxPosSetting) {
                for (const trendItem of sharedState.topTrendList) {
                    if (sharedState.blackList[trendItem.symbol] || sharedState.permanentBlacklist[trendItem.symbol]) continue;
                    if (uniqueActiveSymbols.has(trendItem.symbol)) continue;

                    await openTrendPosition(bot, trendItem);
                    break;
                }
            }
        }
    } finally {
        isScanning = false;
    }
}, 3000);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT] Đã chạy trên port ${PORT}`));
