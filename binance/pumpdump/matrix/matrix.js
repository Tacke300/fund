

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

const PORT = 6776;
const MIN_NOTIONAL_FORCE = 5.1;
const MAX_DCA_LEVEL = 999999; 

// ==========================================
// CẤU HÌNH THÔNG SỐ CHỈ BÁO CHO CHẾ ĐỘ TREND
// ==========================================
const TREND_INDICATOR_CONFIG = {
    EMA_FAST: 10,
    EMA_SLOW: 25,
    EMA_TF: '5m',
    ST_ATR_PERIOD: 10,
    ST_MULTIPLIER: 3.0,
    ST_TF_1: '1m',
    ST_TF_2: '3m',
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,
    MACD_TF: '1m',
    VOL_LOOKBACK: 10,
    VOL_MULTIPLIER: 5.0, // Volume nến tín hiệu >= 5 lần trung bình 10 nến trước
    VOL_TF: '1m',
    BREAKOUT_LOOKBACK: 10,
    BREAKOUT_TF: '1m',
    ANTI_CHASE_ATR_PERIOD: 14,
    ANTI_CHASE_MAX_RATIO: 5.0, // Ngưỡng ATR chống đuổi giá
    ANTI_CHASE_TF: '5m',
    MIN_VOLATILITY_PCT: 3.0 // Biến động cùng chiều ít nhất 3% trong 3 khung 1p, 5p, 15p
};

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

// ==========================================
// BỘ HÀM TÍNH CHỈ BÁO NỘI BỘ (NODEJS)
// ==========================================
function calcEMA(values, period) {
    if (!values || values.length < period) return [];
    const k = 2 / (period + 1);
    const emaArray = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    emaArray[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
        emaArray[i] = (values[i] * k) + (emaArray[i - 1] * (1 - k));
    }
    return emaArray;
}

function calcTR(highs, lows, closes) {
    const tr = [highs[0] - lows[0]];
    for (let i = 1; i < highs.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }
    return tr;
}

function calcATR(highs, lows, closes, period = 14) {
    const tr = calcTR(highs, lows, closes);
    if (tr.length < period) return [];
    const atr = new Array(tr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    atr[period - 1] = sum / period;
    for (let i = period; i < tr.length; i++) {
        atr[i] = ((atr[i - 1] * (period - 1)) + tr[i]) / period;
    }
    return atr;
}

function calcSupertrend(highs, lows, closes, period = 10, multiplier = 3.0) {
    const atr = calcATR(highs, lows, closes, period);
    const len = closes.length;
    const supertrend = new Array(len).fill(null);
    const direction = new Array(len).fill(null);

    const basicUpper = [];
    const basicLower = [];
    for (let i = 0; i < len; i++) {
        if (atr[i] === null) {
            basicUpper.push(null);
            basicLower.push(null);
        } else {
            const hl2 = (highs[i] + lows[i]) / 2;
            basicUpper.push(hl2 + (multiplier * atr[i]));
            basicLower.push(hl2 - (multiplier * atr[i]));
        }
    }

    const finalUpper = new Array(len).fill(0);
    const finalLower = new Array(len).fill(0);

    for (let i = period - 1; i < len; i++) {
        if (i === period - 1) {
            finalUpper[i] = basicUpper[i];
            finalLower[i] = basicLower[i];
            direction[i] = closes[i] > finalUpper[i] ? 1 : -1;
            supertrend[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i];
            continue;
        }

        finalUpper[i] = (basicUpper[i] < finalUpper[i - 1] || closes[i - 1] > finalUpper[i - 1]) 
            ? basicUpper[i] 
            : finalUpper[i - 1];

        finalLower[i] = (basicLower[i] > finalLower[i - 1] || closes[i - 1] < finalLower[i - 1]) 
            ? basicLower[i] 
            : finalLower[i - 1];

        const prevDir = direction[i - 1];
        if (prevDir === 1) {
            direction[i] = closes[i] < finalLower[i] ? -1 : 1;
        } else {
            direction[i] = closes[i] > finalUpper[i] ? 1 : -1;
        }

        supertrend[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i];
    }

    return { supertrend, direction };
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = calcEMA(closes, fast);
    const emaSlow = calcEMA(closes, slow);
    const len = closes.length;
    const macdLine = new Array(len).fill(null);

    const validStart = slow - 1;
    for (let i = validStart; i < len; i++) {
        if (emaFast[i] !== null && emaSlow[i] !== null) {
            macdLine[i] = emaFast[i] - emaSlow[i];
        }
    }

    const compactMacd = [];
    const mapping = [];
    for (let i = 0; i < len; i++) {
        if (macdLine[i] !== null) {
            compactMacd.push(macdLine[i]);
            mapping.push(i);
        }
    }

    const compactSignal = calcEMA(compactMacd, signal);
    const signalLine = new Array(len).fill(null);
    const histogram = new Array(len).fill(null);

    for (let j = 0; j < compactSignal.length; j++) {
        if (compactSignal[j] !== null) {
            const originalIdx = mapping[j];
            signalLine[originalIdx] = compactSignal[j];
            histogram[originalIdx] = macdLine[originalIdx] - compactSignal[j];
        }
    }

    return { macdLine, signalLine, histogram };
}

const klineCache = new Map();
async function fetchClosedKlines(symbol, interval, limit = 50) {
    const cacheKey = `${symbol}_${interval}`;
    const cached = klineCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.time < 2000)) {
        return cached.data;
    }
    if (isRateLimited()) {
        return cached ? cached.data : null;
    }
    try {
        const res = await binanceApi.get(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        if (Array.isArray(res.data) && res.data.length > 5) {
            const closedOnly = res.data.slice(0, -1);
            klineCache.set(cacheKey, { data: closedOnly, time: now });
            return closedOnly;
        }
    } catch (e) {
        if (cached) return cached.data;
    }
    return cached ? cached.data : null;
}

// ==========================================
// QUẢN LÝ RATE LIMIT 429 & 418 TOÀN CỤC
// ==========================================
let rateLimitBannedUntil = 0;
let lastRateLimitStatus = 0;

function isRateLimited() {
    return Date.now() < rateLimitBannedUntil;
}

function handleRateLimit(status, headers = {}, data = {}) {
    if (status === 429 || status === 418) {
        lastRateLimitStatus = status;
        let retrySeconds = 0;
        if (headers && headers['retry-after']) {
            retrySeconds = parseInt(headers['retry-after'], 10);
        }
        if (!retrySeconds && data && (data.retryAfter || data.msg)) {
            const match = String(data.msg || '').match(/(\d+)\s*(?:ms|s|second)/i);
            if (match) retrySeconds = parseInt(match[1], 10);
        }
        if (!retrySeconds || isNaN(retrySeconds) || retrySeconds <= 0) {
            retrySeconds = status === 418 ? 120 : 30;
        }
        rateLimitBannedUntil = Date.now() + (retrySeconds * 1000);
        const banMsg = `🚨 [BINANCE RATE LIMIT ${status}] Tạm hoãn mọi REST request trong ${retrySeconds}s (hết hạn lúc ${new Date(rateLimitBannedUntil).toLocaleTimeString()})`;
        console.error(banMsg);
        addBotLog(bot, banMsg, "error", "rate_limit_alert");
    }
}

const liveMarkPrices = new Map();
const recentTradePnL = new Map();

const openingSymbols = new Map(); 
const symbolOpenCooldown = new Map(); 

let walletCache = { data: { totalWalletBalance: "0", totalMarginBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };
let walletLastRestUpdate = 0;
let positionRiskCache = { data: null, lastUpdate: 0 };
let tickerCache = { data: {}, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const POSITIONS_FILE = path.join(__dirname, 'positions.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

function setupAxiosInterceptors(instance) {
    instance.interceptors.request.use(async (config) => {
        if (isRateLimited()) {
            const waitMs = Math.max(500, rateLimitBannedUntil - Date.now());
            await new Promise(r => setTimeout(r, waitMs));
        }
        return config;
    });

    instance.interceptors.response.use(
        (res) => {
            const usedWeight = res.headers?.['x-mbx-used-weight-1m'];
            if (usedWeight && parseInt(usedWeight, 10) > 2000) {
                rateLimitBannedUntil = Math.max(rateLimitBannedUntil, Date.now() + 2000);
            }
            return res;
        },
        (err) => {
            const status = err.response?.status;
            if (status === 429 || status === 418) {
                handleRateLimit(status, err.response?.headers, err.response?.data);
            }
            return Promise.reject(err);
        }
    );
}

setupAxiosInterceptors(binanceApi);

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
    modeStats: {
        vol: { open: 0, closed: 0, pnl: 0 },
        '24h': { open: 0, closed: 0, pnl: 0 },
        funding: { open: 0, closed: 0, pnl: 0 },
        name: { open: 0, closed: 0, pnl: 0 },
        trend: { open: 0, closed: 0, pnl: 0 }
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
        } else if (['isrunning', 'enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enablescantrend', 'enabletrenddcaam', 'enabletrenddcaduong', 'enabletrendhedge', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
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
        enableTrendDcaAm: false,
        enableTrendDcaDuong: false,
        enableTrendHedge: false,
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
    exchange: new ccxt.binance({ 
        apiKey: API_KEY, 
        secret: SECRET_KEY, 
        enableRateLimit: true, 
        options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
    }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

setupAxiosInterceptors(bot.binanceApi);

function getCcxtSymbol(botInst, rawSymbol) {
    if (!rawSymbol) return rawSymbol;
    if (botInst.exchange.markets && botInst.exchange.markets[rawSymbol]) {
        return rawSymbol;
    }
    if (botInst.exchange.markets) {
        for (const [k, m] of Object.entries(botInst.exchange.markets)) {
            if (m.id === rawSymbol) return m.symbol;
        }
    }
    return rawSymbol;
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
    const isSingleTrendMode = b.modeName === 'trend';
    const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppKey = `${b.symbol}_${oppSide}`;
    const oppPos = botInst.botActivePositions.get(oppKey);
    const dirB = b.side === 'LONG' ? 1 : -1;
    const dirOpp = oppSide === 'LONG' ? 1 : -1;

    let oppPnL = 0;
    let oppQty = 0;
    let oppAvgEntry = 0;
    let oppIsOpen = false;

    if (!isSingleTrendMode) {
        if (oppPos) {
            oppIsOpen = true;
            oppQty = oppPos.currentQty || 0;
            oppAvgEntry = oppPos.avgEntry || oppPos.firstEntry || 0;
            oppPnL = dirOpp * (currentPrice - oppAvgEntry) * oppQty;
        } else if (botInst.botSettings.closeOppositeDcaAm) {
            oppPnL = sharedState.lastClosedPnl[oppKey] || 0;
        }
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

    const netDetailsAtTarget = getPairNetPnLDetails(botInst, b, targetTpPrice);
    const estPnl = netDetailsAtTarget.pairNetPnL;

    let badge = "✅";
    if (!satisfiesPnlAndOffset || estPnl < minPnlTp) {
        badge += ' <span style="color: #a855f7; font-weight: bold;" title="Chưa đủ PnL chốt tối thiểu (đã trừ fee/fd)">❌</span>';
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

    const slPnlLimit = parseFloat(botInst.botSettings.posSL) || 10.0;
    const slMarginLimit = (b.firstMargin || 1) * (parseFloat(botInst.botSettings.posSLDuong) || 5.0);
    const nearestSlLimit = Math.min(slPnlLimit, slMarginLimit);

    const currentPrice = b.livePrice || b.avgEntry;
    const targetSlPrice = calculatePriceForTargetNetPnL(botInst, b, -nearestSlLimit, currentPrice);

    return { targetSlPrice: targetSlPrice, estPnl: -nearestSlLimit, isEarlySL: false };
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

function recalculateAllActivePositions(botInst) {
    for (let [key, b] of botInst.botActivePositions.entries()) {
        const posDcaAm = botInst.botSettings.posDcaAm || 3.0;
        const posDcaDuong = getEffectivePosDcaDuong(botInst, b.leverage || 50);
        const dir = (b.side === 'LONG' ? 1 : -1);
        const firstE = b.firstEntry || b.avgEntry;

        b.nextDcaAm = firstE * (1 - dir * ((b.dcaAmCount + 1) * posDcaAm / 100));
        b.nextDcaDuong = firstE * (1 + dir * ((b.dcaDuongCount + 1) * posDcaDuong / 100));
        b.nextDcaAmMargin = calculateDcaAmMargin(botInst, b);
        b.nextDcaDuongMargin = calculateDcaDuongMargin(botInst, b);

        const slDet = calculateSlDetails(botInst, b);
        b.sl = slDet.targetSlPrice;

        let tpDet = null;
        if ((b.dcaAmCount || 0) > 0 || b.isLockedAm) {
            tpDet = calculateTpDcaAmDetails(botInst, b);
        } else {
            tpDet = calculateTpDcaDuongDetails(botInst, b);
        }
        b.tp = tpDet.targetTpPrice;
    }
    savePositionsToFile();
}

async function getCachedPositionRisk(botInst, maxAgeMs = 1000) {
    const now = Date.now();
    if (positionRiskCache.data && (now - positionRiskCache.lastUpdate < maxAgeMs)) {
        return positionRiskCache.data;
    }
    if (isRateLimited() && positionRiskCache.data) {
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
    return positionRiskCache.data || [];
}

async function getCachedTickerPrice(symbol, maxAgeMs = 1000) {
    const wsData = liveMarkPrices.get(symbol);
    if (wsData && (Date.now() - wsData.time < 4000) && wsData.price > 0) {
        return wsData.price;
    }

    const now = Date.now();
    if (tickerCache.data[symbol] && (now - tickerCache.data[symbol].lastUpdate < maxAgeMs)) {
        return tickerCache.data[symbol].price;
    }

    if (isRateLimited() && wsData) {
        return wsData.price;
    }

    try {
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);
        tickerCache.data[symbol] = { price, lastUpdate: now };
        return price;
    } catch (e) {
        if (wsData) return wsData.price;
        if (tickerCache.data[symbol]) return tickerCache.data[symbol].price;
        throw e;
    }
}

const leverageSetCache = new Set();
async function setLeverageIfNeeded(botInst, symbol, maxLeverage) {
    const key = `${botInst.id}_${symbol}_${maxLeverage}`;
    if (leverageSetCache.has(key)) return;
    try {
        const ccxtSymbol = getCcxtSymbol(botInst, symbol);
        await botInst.exchange.setLeverage(maxLeverage, ccxtSymbol);
        leverageSetCache.add(key);
    } catch (e) {
        if (e.name === 'RateLimitExceeded' || e.name === 'DDoSProtection' || e.message?.includes('429') || e.message?.includes('418')) {
            handleRateLimit(429, null, null);
        }
        try {
            await binancePrivate(botInst, '/fapi/v1/leverage', 'POST', { symbol, leverage: maxLeverage });
            leverageSetCache.add(key);
        } catch (err2) {}
    }
}

function savePositionsToFile() {
    try {
        const data = Array.from(bot.botActivePositions.entries())
            .filter(([key, pos]) => pos && pos.isBotOpened === true);
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error("Lỗi khi ghi vị thế vào positions.json:", e.message);
    }
}

function loadPositionsFromFile() {
    try {
        if (!fs.existsSync(POSITIONS_FILE)) return;
        const raw = fs.readFileSync(POSITIONS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            const filtered = data.filter(([key, pos]) => pos && pos.isBotOpened === true);
            bot.botActivePositions = new Map(filtered);
        }
    } catch (e) {
        console.error("Lỗi khi đọc vị thế từ positions.json:", e.message);
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
            bot.botSettings.isRunning = false;
            updatePermanentBlacklist();
        }
    } catch (e) {}
}

function addBotLog(botInst, msg, type = 'open', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        const last = botInst.logThrottle.get(throttleKey) || 0;
        if (now - last < 30000) return;
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
    if (isRateLimited()) {
        const waitMs = Math.max(1000, rateLimitBannedUntil - Date.now());
        throw new Error(`Đang bị Rate Limit (${lastRateLimitStatus}), thời gian chờ còn lại: ${Math.ceil(waitMs / 1000)}s`);
    }

    try {
        const timestamp = Date.now() + botInst.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await botInst.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });

        const usedWeight = response.headers?.['x-mbx-used-weight-1m'];
        if (usedWeight && parseInt(usedWeight, 10) > 2000) {
            rateLimitBannedUntil = Math.max(rateLimitBannedUntil, Date.now() + 2000);
        }

        return response.data;
    } catch (e) {
        const status = e.response?.status;
        if (status === 429 || status === 418) {
            handleRateLimit(status, e.response?.headers, e.response?.data);
        }
        if (e.response?.data?.code === -1021) {
            try {
                const t = await axios.get('https://fapi.binance.com/fapi/v1/time', { timeout: 5000 });
                botInst.timestampOffset = t.data.serverTime - Date.now();
                return binancePrivate(botInst, endpoint, method, data);
            } catch (errT) {}
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

// Thêm coin lỗi vào Blacklist 5 phút
function checkAndAddBlacklist(symbol) {
    sharedState.blackList[symbol] = Date.now() + (5 * 60 * 1000); 
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
            await new Promise(resolve => setTimeout(resolve, 1500));
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

function queueClosePairPositions(botInst, b1, markP1, reasonStr1, b2, markP2, reasonStr2) {
    if (b1) {
        b1.isClosing = true;
        botInst.isProcessingDCA.add(`${b1.symbol}_${b1.side}`);
        checkAndAddBlacklist(b1.symbol);
    }
    if (b2) {
        b2.isClosing = true;
        botInst.isProcessingDCA.add(`${b2.symbol}_${b2.side}`);
        checkAndAddBlacklist(b2.symbol);
    }

    closeQueue.push(async () => {
        const closeTasks = [];
        if (b1) {
            closeTasks.push((async () => {
                try {
                    const success = await executeClosePositionAndLog(botInst, b1, markP1, reasonStr1);
                    if (success) {
                        botInst.botActivePositions.delete(`${b1.symbol}_${b1.side}`);
                        savePositionsToFile();
                        checkAndAddBlacklist(b1.symbol);
                    } else {
                        b1.isClosing = false;
                    }
                } catch (e) {
                    b1.isClosing = false;
                } finally {
                    botInst.isProcessingDCA.delete(`${b1.symbol}_${b1.side}`);
                }
            })());
        }
        if (b2) {
            closeTasks.push((async () => {
                try {
                    const success = await executeClosePositionAndLog(botInst, b2, markP2, reasonStr2);
                    if (success) {
                        botInst.botActivePositions.delete(`${b2.symbol}_${b2.side}`);
                        savePositionsToFile();
                        checkAndAddBlacklist(b2.symbol);
                    } else {
                        b2.isClosing = false;
                    }
                } catch (e) {
                    b2.isClosing = false;
                } finally {
                    botInst.isProcessingDCA.delete(`${b2.symbol}_${b2.side}`);
                }
            })());
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
            const ccxtSymbol = getCcxtSymbol(botInst, b.symbol);
            const closeSide = b.side === 'LONG' ? 'SELL' : 'BUY';

            try {
                await botInst.exchange.createOrder(ccxtSymbol, 'MARKET', closeSide, closeQty, undefined, { positionSide: b.side });
                orderClosedSuccessfully = true;
            } catch (err) {
                if (err.name === 'RateLimitExceeded' || err.name === 'DDoSProtection' || err.message?.includes('429') || err.message?.includes('418')) {
                    handleRateLimit(err.message?.includes('418') ? 418 : 429, null, null);
                }
                const errMsg = err?.response?.data?.msg || err?.message || String(err);
                if (errMsg.includes('2022') || errMsg.includes('ReduceOnly Order would be rejected')) {
                    orderClosedSuccessfully = true;
                } else {
                    try {
                        await binancePrivate(botInst, '/fapi/v1/order', 'POST', {
                            symbol: b.symbol,
                            side: closeSide,
                            positionSide: b.side,
                            type: 'MARKET',
                            quantity: closeQty
                        });
                        orderClosedSuccessfully = true;
                    } catch (errDirect) {
                        const directMsg = errDirect?.response?.data?.msg || errDirect?.message || String(errDirect);
                        if (directMsg.includes('2022') || directMsg.includes('ReduceOnly')) {
                            orderClosedSuccessfully = true;
                        } else {
                            addBotLog(botInst, `⚠️ Lỗi gửi lệnh Market đóng ${formatCoinName(b.symbol)}: ${directMsg}`, "warn");
                            return false;
                        }
                    }
                }
            }
        } else {
            orderClosedSuccessfully = true;
        }
    } catch (e) {
        const errMsg = e?.response?.data?.msg || e?.message || String(e);
        addBotLog(botInst, `❌ Thất bại khi đóng vị thế sàn ${formatCoinName(b.symbol)}: ${errMsg}`, "error");
        return false;
    }
    
    if (!orderClosedSuccessfully) return false;

    try {
        await new Promise(r => setTimeout(r, 400));
        const doubleCheckRisk = await binancePrivate(botInst, '/fapi/v2/positionRisk', 'GET', { symbol: b.symbol }).catch(() => null);
        if (Array.isArray(doubleCheckRisk)) {
            const leftoverP = doubleCheckRisk.find(p => p.symbol === b.symbol && p.positionSide === b.side && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (leftoverP) {
                const leftoverQty = Math.abs(parseFloat(leftoverP.positionAmt));
                if (leftoverQty > 0) {
                    addBotLog(botInst, `⚠️ [QUÉT VỊ THẾ SÓT] Phát hiện vị thế sót ${formatCoinName(b.symbol)} ${b.side} (Qty: ${leftoverQty}). Đang đóng quét sạch...`, "warn");
                    const ccxtSymbol = getCcxtSymbol(botInst, b.symbol);
                    const closeSide = b.side === 'LONG' ? 'SELL' : 'BUY';
                    await botInst.exchange.createOrder(ccxtSymbol, 'MARKET', closeSide, leftoverQty, undefined, { positionSide: b.side }).catch(() => {});
                }
            }
        }
    } catch (sweepErr) {}

    const tradeKey = `${b.symbol}_${b.side}`;
    const cachedTrade = recentTradePnL.get(tradeKey);

    if (cachedTrade && (Date.now() - cachedTrade.time < 15000)) {
        finalPnL = cachedTrade.realizedPnl - cachedTrade.commission;
        recentTradePnL.delete(tradeKey);
    } else {
        try {
            await new Promise(r => setTimeout(r, 500));
            const trades = await binancePrivate(botInst, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 5 });
            const closeSide = b.side === 'LONG' ? 'SELL' : 'BUY';
            const nowServer = Date.now() + botInst.timestampOffset;
            
            const matchingTrades = (trades || []).filter(t => 
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
        } catch (errTrade) {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
            finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);
        }
    }

    sharedState.lastClosedPnl[`${b.symbol}_${b.side}`] = finalPnL;
    botInst.status.botClosedCount++;
    botInst.status.botPnLClosed += finalPnL;

    const modeKey = b.modeName || 'vol';
    if (!sharedState.modeStats[modeKey]) {
        sharedState.modeStats[modeKey] = { open: 0, closed: 0, pnl: 0 };
    }
    sharedState.modeStats[modeKey].closed = (sharedState.modeStats[modeKey].closed || 0) + 1;
    sharedState.modeStats[modeKey].pnl = (sharedState.modeStats[modeKey].pnl || 0) + finalPnL;

    if (finalPnL >= 0) {
        botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
    } else {
        botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
    }

    let isExplicitTP = reasonStr.includes("TP") || reasonStr.includes("TRAILING");
    let isExplicitSL = reasonStr.includes("SL") || reasonStr.includes("CẮT LỖ") || reasonStr.includes("ĐẢO CHIỀU");

    let logType = "tp";
    let detailTag = "CHỐT LÃI TP";

    if (isExplicitSL || (!isExplicitTP && finalPnL < 0)) {
        logType = "sl";
        detailTag = "CẮT LỖ SL";
    } else if (isExplicitTP && finalPnL < 0) {
        logType = "warn";
        detailTag = "CHỐT TP SÀN/NỘI BỘ (ÂM PNL DO PHÍ & FD)";
    }

    const formattedSymbol = formatCoinName(b.symbol);
    addBotLog(botInst, `🔒 [${detailTag} | LÝ DO: ${reasonStr}] ${formattedSymbol} ${b.side} | Chế độ: [${b.modeName || 'vol'}] | Giá chốt: ${formatPrice(markP)} | Net PnL: ${finalPnL.toFixed(2)}$`, logType);

    binancePrivate(botInst, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol })
        .then(orders => {
            const targets = (orders || []).filter(o => o.positionSide === b.side);
            for (const o of targets) {
                binancePrivate(botInst, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(() => {});
            }
        })
        .catch(() => {});

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
            const sideClose = side === 'LONG' ? 'SELL' : 'BUY';
            const key = `${p.symbol}_${side}`;
            
            checkAndAddBlacklist(p.symbol);

            try {
                const ccxtSymbol = getCcxtSymbol(botInst, p.symbol);
                await botInst.exchange.createOrder(ccxtSymbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                count++;
                
                const b = botInst.botActivePositions.get(key);
                if (b) {
                    let pnlRaw = parseFloat(p.unRealizedProfit || 0);
                    const feeAndFd = calculatePositionFeeAndFunding(botInst, b, parseFloat(p.markPrice));
                    let finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);

                    sharedState.lastClosedPnl[key] = finalPnL;

                    botInst.status.botClosedCount++;
                    botInst.status.botPnLClosed += finalPnL;

                    const modeKey = b.modeName || 'vol';
                    if (!sharedState.modeStats[modeKey]) sharedState.modeStats[modeKey] = { open: 0, closed: 0, pnl: 0 };
                    sharedState.modeStats[modeKey].closed = (sharedState.modeStats[modeKey].closed || 0) + 1;
                    sharedState.modeStats[modeKey].pnl = (sharedState.modeStats[modeKey].pnl || 0) + finalPnL;

                    if (finalPnL >= 0) {
                        botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
                    } else {
                        botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
                    }
                }
            } catch (err) { }
        }
        botInst.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(botInst, `⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] Đã giải phóng tài khoản (${reasonLog}).`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

// =========================================================================
// GIÁM SÁT GIÁ & TÍNH TOÁN SUPERTREND 1M REALTIME CHO TỪNG VỊ THẾ TREND
// =========================================================================
async function priceMonitor(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) {
        return setTimeout(() => priceMonitor(botInst), 500);
    }

    if (botInst.botActivePositions.size === 0) {
        return setTimeout(() => priceMonitor(botInst), 1000);
    }

    try {
        const now = Date.now();
        const posRisk = await getCachedPositionRisk(botInst, 1000);
        
        for (let [key, b] of Array.from(botInst.botActivePositions.entries())) {
            if (b.isClosing) continue;

            if (b.isBotOpened !== true) {
                botInst.botActivePositions.delete(key);
                continue;
            }

            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;

            if (realP) {
                const exchangeQty = Math.abs(parseFloat(realP.positionAmt));
                
                const wsLive = liveMarkPrices.get(b.symbol);
                const markP = (wsLive && (now - wsLive.time < 5000)) ? wsLive.price : parseFloat(realP.markPrice);

                b.currentQty = exchangeQty;
                b.livePrice = markP;

                const currentAvgEntry = b.avgEntry || parseFloat(realP.entryPrice) || b.firstEntry;
                b.avgEntry = currentAvgEntry;

                b.pnl = b.side === 'LONG' ? (markP - currentAvgEntry) * exchangeQty : (currentAvgEntry - markP) * exchangeQty;

                if (b.side === 'LONG') {
                    b.peakPrice = Math.max(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((markP - currentAvgEntry) / currentAvgEntry) * 100;
                } else {
                    b.peakPrice = Math.min(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((currentAvgEntry - markP) / currentAvgEntry) * 100;
                }

                const netDetails = getPairNetPnLDetails(botInst, b, markP);
                b.peakNetPnL = Math.max(b.peakNetPnL !== undefined ? b.peakNetPnL : -999999, netDetails.pairNetPnL);

                // ==============================================================
                // XỬ LÝ SUPERTREND 1M REALTIME CHO TỪNG VỊ THẾ TREND
                // ==============================================================
                if (b.modeName === 'trend' && !b.isClosing) {
                    if (b.currentSt1mVal && b.currentSt1mVal > 0) {
                        const stVal = b.currentSt1mVal;
                        
                        // Tính % khoảng cách giữa giá hiện tại và Supertrend 1m:
                        // LONG: Giá trên ST là dương (+), chạm ST là 0%, thủng xuống dưới ST là âm (-)
                        // SHORT: Giá dưới ST là dương (+), chạm ST là 0%, vượt lên trên ST là âm (-)
                        let gapPct = 0;
                        if (b.side === 'LONG') {
                            gapPct = ((markP - stVal) / stVal) * 100;
                        } else {
                            gapPct = ((stVal - markP) / stVal) * 100;
                        }
                        b.st1mGapPct = gapPct;

                        const isHedgeEnabled = !!botInst.botSettings.enableTrendHedge;

                        // Điều kiện đảo chiều chuẩn xác:
                        // Long: giá rơi xuống dưới mốc ST (gapPct <= 0) hoặc ST1m đổi hướng Giảm (st1mDir === -1)
                        // Short: giá tăng vượt lên trên mốc ST (gapPct <= 0) hoặc ST1m đổi hướng Tăng (st1mDir === 1)
                        const isSt1mReversed = (gapPct <= 0) || (b.currentSt1mDir === (b.side === 'LONG' ? -1 : 1));

                        // Nếu KHÔNG BẬT HEDGE MODE -> Supertrend 1m đảo chiều lập tức cắt lệnh ngay dù lãi hay lỗ
                        if (!isHedgeEnabled && isSt1mReversed) {
                            const lossPctStr = gapPct.toFixed(2);
                            const reasonStr = `SUPERTREND 1M ĐẢO CHIỀU (Biên độ ST: ${lossPctStr}%) - CẮT LỆNH NGAY (HEDGE TẮT)`;
                            queueClosePosition(botInst, b, markP, reasonStr);
                            continue;
                        }
                    }

                    // Nếu Hedge Mode BẬT -> khi giá đi ngược sẽ mở vị thế đối ứng
                    const isHedgeEnabled = !!botInst.botSettings.enableTrendHedge;
                    if (isHedgeEnabled && !b.hedgeTriggered && !b.isClosing) {
                        const effectiveDcaDuongPct = getEffectivePosDcaDuong(botInst, b.leverage || 50);
                        const isAdverse = b.side === 'LONG' 
                            ? ((b.firstEntry - markP) / b.firstEntry) * 100 >= effectiveDcaDuongPct
                            : ((markP - b.firstEntry) / b.firstEntry) * 100 >= effectiveDcaDuongPct;

                        if (isAdverse) {
                            const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                            const oppKey = `${b.symbol}_${oppSide}`;
                            if (!botInst.botActivePositions.has(oppKey)) {
                                b.hedgeTriggered = true;
                                const hedgeMargin = (b.firstMargin || 1) * (botInst.botSettings.heSoDcaDuong || 2.0);
                                addBotLog(botInst, `🛡️ [TREND HEDGE] Vị thế ${b.symbol} ${b.side} đi ngược >= ${effectiveDcaDuongPct.toFixed(1)}%. Mở vị thế đối ứng ${oppSide}!`, "warn");
                                openPosition(botInst, b.symbol, { margin: hedgeMargin, isHedge: true }, oppSide, null, hedgeMargin, markP, 'trend', '| HEDGE ĐỐI ỨNG');
                            }
                        }
                    }
                }

                const totalDcaCount = (b.dcaAmCount || 0) + (b.dcaDuongCount || 0);
                if (botInst.botSettings.lockDcaAmMode) {
                    if ((b.dcaDuongCount || 0) >= 1) {
                        const oppositeSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                        const oppKey = `${b.symbol}_${oppositeSide}`;
                        const oppPos = botInst.botActivePositions.get(oppKey);
                        if (oppPos) {
                            oppPos.isLockedAm = true;
                        }
                        if (b.pnl < 0) {
                            b.isLockedAm = true;
                        }
                    }
                    if (totalDcaCount > 1 && b.pnl < 0) {
                        b.isLockedAm = true;
                    }
                }

                let currentDcaMode = (b.dcaAmCount > 0 || b.isLockedAm) ? 'AM' : 'DUONG';
                b.dcaType = currentDcaMode;

                const posDcaAm = botInst.botSettings.posDcaAm || 3.0;
                const posDcaDuong = getEffectivePosDcaDuong(botInst, b.leverage || 50);
                const tpDcaAmPct = botInst.botSettings.tpDcaAm || 10.0;
                const dir = (b.side === 'LONG' ? 1 : -1);
                const firstE = b.firstEntry || currentAvgEntry;

                b.nextDcaAm = firstE * (1 - dir * ((b.dcaAmCount + 1) * posDcaAm / 100));
                b.nextDcaDuong = firstE * (1 + dir * ((b.dcaDuongCount + 1) * posDcaDuong / 100));
                b.nextDcaAmMargin = calculateDcaAmMargin(botInst, b);
                b.nextDcaDuongMargin = calculateDcaDuongMargin(botInst, b);

                const slDetails = calculateSlDetails(botInst, b);
                b.sl = slDetails.targetSlPrice;

                savePositionsToFile();

                if (botInst.botSettings.enableEarlySL && (b.dcaDuongCount || 0) >= 1) {
                    const earlySlTarget = b.side === 'LONG' 
                        ? (currentAvgEntry + (b.firstEntry * 0.007))
                        : (currentAvgEntry - (b.firstEntry * 0.007));

                    const hitEarlySl = b.side === 'LONG' ? (markP <= earlySlTarget) : (markP >= earlySlTarget);
                    if (hitEarlySl) {
                        const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                        const oppKey = `${b.symbol}_${oppSide}`;
                        const oppPos = botInst.botActivePositions.get(oppKey);

                        const reasonEarly = `CẮT LỖ SỚM DCA DƯƠNG CHẠM AVG ENTRY (${formatPrice(earlySlTarget)})`;
                        if (oppPos && !oppPos.isClosing) {
                            queueClosePairPositions(botInst, b, markP, reasonEarly, oppPos, oppPos.livePrice || markP, `CẮT LỖ SỚM THEO CẶP (${b.symbol})`);
                        } else {
                            queueClosePosition(botInst, b, markP, reasonEarly);
                        }
                        continue;
                    }
                }

                if (currentDcaMode === 'AM') {
                    const targetTpPrice = currentAvgEntry + dir * (b.firstEntry * (tpDcaAmPct / 100));
                    const hitInternalTP = b.side === 'LONG' ? (markP >= targetTpPrice) : (markP <= targetTpPrice);
                    if (hitInternalTP && netDetails.pairNetPnL >= 0) {
                        queueClosePosition(botInst, b, markP, "CHỐT TP DCA ÂM");
                        continue;
                    }

                    if (b.side === 'SHORT') {
                        const slPhongHoPrice = b.firstEntry * 2.01;
                        if (markP >= slPhongHoPrice) {
                            queueClosePosition(botInst, b, markP, `CẮT LỖ SL PHÒNG HỘ 101% ENTRY (${formatPrice(slPhongHoPrice)})`);
                            continue;
                        }
                    }
                }

                if (currentDcaMode === 'DUONG') {
                    const tpDcaDuongPct = botInst.botSettings.tpDcaDuong || 10.0;
                    const minPnlHeSo = botInst.botSettings.minPnlTpDcaDuong !== undefined ? botInst.botSettings.minPnlTpDcaDuong : 10.0;
                    const firstMargin = b.firstMargin || 1;
                    const minPnlTp = firstMargin * minPnlHeSo;

                    const baseTpPrice = calculatePriceForTargetNetPnL(botInst, b, minPnlTp, markP);
                    const peak = b.peakPrice || b.firstEntry || markP;
                    
                    const peakTpPrice = dir === 1 
                        ? (peak * (1 - tpDcaDuongPct / 100)) 
                        : (peak * (1 + tpDcaDuongPct / 100));

                    const satisfiesPnlAndOffset = dir === 1 
                        ? (peakTpPrice >= baseTpPrice) 
                        : (peakTpPrice <= baseTpPrice);

                    const predNetAtPeakTp = getPairNetPnLDetails(botInst, b, peakTpPrice).pairNetPnL;

                    if (b.lockedTpPrice !== undefined) {
                        const predNetAtLocked = getPairNetPnLDetails(botInst, b, b.lockedTpPrice).pairNetPnL;
                        if (predNetAtLocked < minPnlTp || !satisfiesPnlAndOffset) {
                            b.lockedTpPrice = undefined; 
                        }
                    }

                    if (satisfiesPnlAndOffset && predNetAtPeakTp >= minPnlTp) {
                        if (b.lockedTpPrice === undefined) {
                            b.lockedTpPrice = peakTpPrice;
                        } else {
                            if (b.side === 'LONG' && peakTpPrice > b.lockedTpPrice) {
                                b.lockedTpPrice = peakTpPrice;
                            } else if (b.side === 'SHORT' && peakTpPrice < b.lockedTpPrice) {
                                b.lockedTpPrice = peakTpPrice;
                            }
                        }
                    }

                    if (b.lockedTpPrice !== undefined) {
                        const hitLockedTp = b.side === 'LONG' ? (markP <= b.lockedTpPrice) : (markP >= b.lockedTpPrice);
                        if (hitLockedTp) {
                            const currentNetPnL = netDetails.pairNetPnL;
                            if (currentNetPnL >= minPnlTp) {
                                const reasonTp = `CHỐT TP DCA DƯƠNG (Lock TP: ${formatPrice(b.lockedTpPrice)}, Net PnL: ${currentNetPnL.toFixed(2)}$)`;
                                
                                if (botInst.botSettings.closeOppositeDcaAm && netDetails.oppPos && !netDetails.oppPos.isClosing) {
                                    queueClosePairPositions(
                                        botInst, 
                                        b, markP, reasonTp,
                                        netDetails.oppPos, netDetails.oppPos.livePrice || markP, `ĐÓNG LỆNH ÂM ĐỐI ỨNG (${b.symbol})`
                                    );
                                } else {
                                    queueClosePosition(botInst, b, markP, reasonTp);
                                }
                                continue;
                            } else {
                                b.lockedTpPrice = undefined;
                            }
                        }
                    }
                }

                // Cắt lỗ theo mức SL gần nhất
                const nearestSlVal = Math.abs(slDetails.estPnl);
                if (netDetails.pairNetPnL <= -nearestSlVal) {
                    const reasonSlPnL = `CẮT LỖ SL GẦN NHẤT (Net PnL: ${netDetails.pairNetPnL.toFixed(2)}$ <= -${nearestSlVal.toFixed(2)}$)`;
                    if (netDetails.oppPos && !netDetails.oppPos.isClosing) {
                        queueClosePairPositions(botInst, b, markP, reasonSlPnL, netDetails.oppPos, netDetails.oppPos.livePrice || markP, `CẮT LỖ SL PNL ĐỐI ỨNG (${b.symbol})`);
                    } else {
                        queueClosePosition(botInst, b, markP, reasonSlPnL);
                    }
                    continue;
                }

                const isDcaCooldown = b.lastDcaTime && (now - b.lastDcaTime < 6000);
                if (isDcaCooldown) continue;

                const allowDcaAm = b.modeName === 'trend' ? !!botInst.botSettings.enableTrendDcaAm : true;
                const allowDcaDuong = b.modeName === 'trend' ? !!botInst.botSettings.enableTrendDcaDuong : true;

                if (allowDcaAm && currentDcaMode === 'AM' && !b.isClosing) {
                    const hitDcaAm = b.side === 'LONG' ? (markP <= b.nextDcaAm) : (markP >= b.nextDcaAm);
                    if (hitDcaAm && !botInst.isProcessingDCA.has(lockKey)) {
                        botInst.isProcessingDCA.add(lockKey);
                        let marginToUse = calculateDcaAmMargin(botInst, b);
                        openPosition(botInst, b.symbol, { ...b, dcaType: 'AM', margin: marginToUse }, b.side);
                        continue;
                    }
                }

                if (allowDcaDuong && currentDcaMode === 'DUONG' && !b.isLockedAm && !b.isClosing) {
                    const hitDcaDuong = b.side === 'LONG' ? (markP >= b.nextDcaDuong) : (markP <= b.nextDcaDuong);
                    if (b.pnl > 0 && hitDcaDuong && !botInst.isProcessingDCA.has(lockKey)) {
                        botInst.isProcessingDCA.add(lockKey);
                        let marginToUse = calculateDcaDuongMargin(botInst, b);
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
    } catch (e) { }
    
    setTimeout(() => priceMonitor(botInst), 500);
}

// Mở vị thế
async function openPosition(botInst, symbol, dcaData = null, forcedSide = 'LONG', sharedQty = null, sharedMargin = null, sharedPrice = null, modeName = 'vol', extraLogInfo = '', indicatorSnapshot = null, volatilityInfo = '') {
    const isDCA = dcaData !== null && !dcaData.isHedge;
    
    if (!isDCA && !botInst.botSettings.isRunning) {
        return;
    }

    const side = forcedSide; 
    const lockKey = `${symbol}_${side}`;
    
    if (isDCA) {
        const activePos = botInst.botActivePositions.get(lockKey);
        if (!activePos || activePos.isClosing) {
            addBotLog(botInst, `⚠️ [HỦY DCA] Vị thế ${formatCoinName(symbol)} ${side} đã báo đóng, hủy lệnh DCA!`, "warn");
            botInst.isProcessingDCA.delete(lockKey);
            return;
        }
    }

    if (!isDCA && botInst.botActivePositions.has(lockKey)) {
        return;
    }

    if (botInst.isProcessingDCA.has(lockKey) && !isDCA) return;
    botInst.isProcessingDCA.add(lockKey); 

    delete sharedState.lastClosedPnl[`${symbol}_LONG`];
    delete sharedState.lastClosedPnl[`${symbol}_SHORT`];
    delete sharedState.lastClosedMargin[`${symbol}_LONG`];
    delete sharedState.lastClosedMargin[`${symbol}_SHORT`];

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) throw new Error(`Coin ${symbol} không được hỗ trợ trên sàn`);

        let qty = 0, margin = 0, currentPrice = 0;
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        if (isDCA || (dcaData && dcaData.isHedge)) {
            currentPrice = await getCachedTickerPrice(symbol, 1000);
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

        const availBal = parseFloat(walletCache.data?.availableBalance || 0);
        const reqMargin = (qty * currentPrice) / info.maxLeverage;
        if (availBal > 0 && reqMargin > availBal * 0.95) {
            const safeMargin = availBal * 0.90;
            let adjQty = (safeMargin * info.maxLeverage) / currentPrice;
            adjQty = Math.floor(adjQty / info.stepSize) * info.stepSize;
            adjQty = Number(adjQty.toFixed(info.quantityPrecision));
            if (adjQty * currentPrice >= actualMinNotional) {
                qty = adjQty;
            } else {
                addBotLog(botInst, `⚠️ [BỎ QUA LỆNH ${symbol}] Khả dụng không đủ (${availBal.toFixed(2)}$ < Margin tối thiểu ${reqMargin.toFixed(2)}$)`, "warn", `skip_bal_${symbol}`);
                return;
            }
        }

        await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
        
        let order = null;
        const clientOrderId = `LUFFY_${side}_${symbol}_${Date.now()}`.slice(0, 32);

        const ccxtSymbol = getCcxtSymbol(botInst, symbol);
        const orderQtyStr = qty.toFixed(info.quantityPrecision);
        const orderQtyNum = parseFloat(orderQtyStr);

        if (isNaN(orderQtyNum) || orderQtyNum <= 0) {
            throw new Error(`Khối lượng tính toán không hợp lệ (Qty: ${orderQtyStr})`);
        }

        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';

        try {
            order = await botInst.exchange.createOrder(
                ccxtSymbol, 
                'MARKET', 
                orderSide, 
                orderQtyNum, 
                undefined, 
                { positionSide: side, newClientOrderId: clientOrderId }
            );
        } catch (orderErr) {
            if (orderErr.name === 'RateLimitExceeded' || orderErr.name === 'DDoSProtection' || orderErr.message?.includes('429') || orderErr.message?.includes('418')) {
                handleRateLimit(orderErr.message?.includes('418') ? 418 : 429, null, null);
            }
            const errMsg = orderErr?.response?.data?.msg || orderErr?.message || String(orderErr);
            if (errMsg.includes('2019') || orderErr?.response?.data?.code === -2019) {
                qty = Math.floor((qty * 0.8) / info.stepSize) * info.stepSize;
                qty = Number(qty.toFixed(info.quantityPrecision));
                if (qty * currentPrice >= actualMinNotional) {
                    order = await botInst.exchange.createOrder(
                        ccxtSymbol, 
                        'MARKET', 
                        orderSide, 
                        parseFloat(qty.toFixed(info.quantityPrecision)), 
                        undefined, 
                        { positionSide: side, newClientOrderId: clientOrderId }
                    );
                } else {
                    throw new Error(`Khối lượng sau khi giảm không đạt minNotional: ${qty * currentPrice} < ${actualMinNotional}`);
                }
            } else {
                try {
                    const directRes = await binancePrivate(botInst, '/fapi/v1/order', 'POST', {
                        symbol: symbol,
                        side: orderSide,
                        positionSide: side,
                        type: 'MARKET',
                        quantity: orderQtyStr,
                        newClientOrderId: clientOrderId
                    });
                    if (directRes && directRes.orderId) {
                        order = {
                            id: directRes.orderId,
                            average: parseFloat(directRes.avgPrice || 0),
                            price: parseFloat(directRes.price || 0),
                            info: directRes
                        };
                    } else {
                        throw orderErr;
                    }
                } catch (directErr) {
                    throw directErr;
                }
            }
        }
        
        if (order) {
            let actualFilledPrice = 0;
            let avgP = parseFloat(order.average || order.price || order.info?.avgPrice || 0);
            if (avgP > 0) {
                actualFilledPrice = avgP;
            } else if (order.info?.cumQuote && order.info?.executedQty && parseFloat(order.info.executedQty) > 0) {
                actualFilledPrice = parseFloat(order.info.cumQuote) / parseFloat(order.info.executedQty);
            }

            if (!actualFilledPrice || actualFilledPrice <= 0) {
                actualFilledPrice = currentPrice;
            }

            let cumulativeQty = qty;
            let cumulativeCost = qty * actualFilledPrice;
            let newAvgEntry = actualFilledPrice;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage;
            let totalMargin = actualMarginUsed;
            let dcaHistory = [];
            let dcaAmCount = 0;
            let dcaDuongCount = 0;
            let lastDcaType = 'DUONG';

            if (isDCA) {
                cumulativeQty = dcaData.cumulativeQty + qty;
                cumulativeCost = dcaData.cumulativeCost + (qty * actualFilledPrice);
                newAvgEntry = cumulativeCost / cumulativeQty;
                totalMargin = (dcaData.currentMargin || dcaData.firstMargin || 0) + actualMarginUsed;
                dcaHistory = [...dcaData.dcaHistory, { price: actualFilledPrice, margin: actualMarginUsed, type: dcaData.dcaType }];
                dcaAmCount = dcaData.dcaType === 'AM' ? dcaData.dcaAmCount + 1 : dcaData.dcaAmCount;
                dcaDuongCount = dcaData.dcaType === 'DUONG' ? dcaData.dcaDuongCount + 1 : dcaData.dcaDuongCount;
                lastDcaType = dcaData.dcaType;
            } else {
                dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed, type: 'ENTRY' }];
                lastDcaType = 'DUONG';
            }

            const firstE = (dcaData && !dcaData.isHedge) ? dcaData.firstEntry : newAvgEntry;
            const posDcaAm = botInst.botSettings.posDcaAm || 3.0;
            const posDcaDuong = getEffectivePosDcaDuong(botInst, info.maxLeverage);
            const dir = (side === 'LONG' ? 1 : -1);

            let nextDcaAm = firstE * (1 - dir * ((dcaAmCount + 1) * posDcaAm / 100));
            let nextDcaDuong = firstE * (1 + dir * ((dcaDuongCount + 1) * posDcaDuong / 100));

            const nowTime = Date.now();
            const effectiveMode = isDCA ? dcaData.modeName : modeName;

            // Khởi tạo thông số Supertrend 1m trực tiếp lúc mở lệnh
            const initStVal = isDCA ? (dcaData.currentSt1mVal || 0) : (indicatorSnapshot?.st1m || 0);
            let initGap = 0;
            if (initStVal > 0) {
                initGap = side === 'LONG' 
                    ? ((actualFilledPrice - initStVal) / initStVal) * 100
                    : ((initStVal - actualFilledPrice) / initStVal) * 100;
            }

            const posData = { 
                symbol, side, entryPrice: firstE, 
                isBotOpened: true,
                botId: botInst.id,
                clientOrderId: clientOrderId,
                orderId: order.id,
                dcaAmCount, dcaDuongCount, dcaCount: dcaAmCount + dcaDuongCount, 
                dcaType: lastDcaType, lastDcaType,
                modeName: effectiveMode,
                fundingRate: liveMarkPrices.get(symbol)?.fundingRate || 0,
                isLockedAm: isDCA ? !!dcaData.isLockedAm : false,
                lockedTpPrice: undefined,
                indicatorSnapshot: indicatorSnapshot || (isDCA ? dcaData.indicatorSnapshot : null),
                volatilityInfo: volatilityInfo || (isDCA ? dcaData.volatilityInfo : ''),
                currentSt1mVal: initStVal,
                currentSt1mDir: isDCA ? (dcaData.currentSt1mDir || (side === 'LONG' ? 1 : -1)) : (side === 'LONG' ? 1 : -1),
                st1mGapPct: initGap,
                leverage: info.maxLeverage, firstEntry: firstE, firstMargin: isDCA ? dcaData.firstMargin : totalMargin, 
                currentMargin: totalMargin, currentQty: cumulativeQty, 
                cumulativeQty: cumulativeQty, cumulativeCost: cumulativeCost, dcaHistory: dcaHistory,
                pnl: 0, profitPercent: 0, peakPrice: isDCA ? Math.max(dcaData.peakPrice || firstE, actualFilledPrice) : actualFilledPrice,
                peakNetPnL: 0,
                avgEntry: newAvgEntry, nextDcaAm, nextDcaDuong, livePrice: actualFilledPrice,
                createdAt: dcaData ? (dcaData.createdAt || nowTime) : nowTime,
                lastActionTime: nowTime, 
                lastDcaTime: nowTime,
                time: dcaData ? (dcaData.time || new Date().toLocaleTimeString('vi-VN', { hour12: false })) : new Date().toLocaleTimeString('vi-VN', { hour12: false })
            };

            const slDet = calculateSlDetails(botInst, posData);
            posData.sl = slDet.targetSlPrice;

            const tpDet = calculateTpDcaDuongDetails(botInst, posData);
            posData.tp = tpDet.targetTpPrice;

            botInst.botActivePositions.set(lockKey, posData);
            savePositionsToFile();

            if (!isDCA) {
                if (!sharedState.modeStats[effectiveMode]) sharedState.modeStats[effectiveMode] = { open: 0, closed: 0, pnl: 0 };
                sharedState.modeStats[effectiveMode].open = (sharedState.modeStats[effectiveMode].open || 0) + 1;
            }

            const formattedSymbol = formatCoinName(symbol);
            if (!isDCA) {
                const volMsg = posData.volatilityInfo ? `| [${posData.volatilityInfo}]` : '';
                const logStr = `[MỞ ${side} | CHẾ ĐỘ: ${modeName.toUpperCase()}] ${formattedSymbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${formatPrice(newAvgEntry)} ${volMsg} ${extraLogInfo}`;
                addBotLog(botInst, logStr, "open"); 
            } else {
                const historyPricesStr = dcaHistory.map(h => `${formatPrice(h.price)} [${Math.abs(((h.price - firstE) / firstE) * 100).toFixed(1)}% - ${(h.margin || 0).toFixed(1)}$]`).join(' ➔ ');
                const logStr = `[DCA ${dcaData.dcaType}] ${formattedSymbol} ${side} | Margin DCA: ${actualMarginUsed.toFixed(2)}$ | Tổng: ${totalMargin.toFixed(2)}$ | [ ${historyPricesStr} ]`;
                addBotLog(botInst, logStr, "dca"); 
            }
        }
    } catch (e) { 
        checkAndAddBlacklist(symbol);
        const errMsg = e?.response?.data?.msg || e?.message || String(e);
        const errCode = e?.response?.data?.code || '';
        const throttleKey = `err_open_${symbol}`;
        addBotLog(botInst, `⚠️ [LỖI MỞ LỆNH ${symbol} ${side}] Bỏ qua coin này: [${errCode}] ${errMsg}`, "error", throttleKey);
    } finally { 
        setTimeout(() => {
            botInst.isProcessingDCA.delete(lockKey);
            openingSymbols.delete(symbol);
            sharedState.pendingOrders.delete(symbol);
        }, 3000); 
    }
}

async function openPositionPair(botInst, symbol, modeName = 'vol', extraLogInfo = '') {
    if (!botInst.botSettings.isRunning) {
        openingSymbols.delete(symbol);
        sharedState.pendingOrders.delete(symbol);
        return;
    }

    const posRisk = await getCachedPositionRisk(botInst, 1000);
    const hasManualOnExchange = (posRisk || []).some(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0 && !botInst.botActivePositions.has(`${symbol}_${p.positionSide}`));
    if (hasManualOnExchange) {
        openingSymbols.delete(symbol);
        sharedState.pendingOrders.delete(symbol);
        return;
    }

    const existingLong = botInst.botActivePositions.get(`${symbol}_LONG`);
    const existingShort = botInst.botActivePositions.get(`${symbol}_SHORT`);
    if (existingLong || existingShort) {
        openingSymbols.delete(symbol);
        return;
    }

    const info = sharedState.exchangeInfo[symbol];
    if (!info) {
        openingSymbols.delete(symbol);
        return;
    }

    delete sharedState.lastClosedPnl[`${symbol}_LONG`];
    delete sharedState.lastClosedPnl[`${symbol}_SHORT`];
    delete sharedState.lastClosedMargin[`${symbol}_LONG`];
    delete sharedState.lastClosedMargin[`${symbol}_SHORT`];

    const currentPrice = await getCachedTickerPrice(symbol, 1000).catch(() => null);
    if (!currentPrice) {
        openingSymbols.delete(symbol);
        return;
    }

    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

    const calcParams = async () => {
        const now = Date.now();
        if (!walletCache.data || walletCache.data.availableBalance === "0" || (now - walletCache.lastUpdate > 10000)) {
            const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
            if (acc) {
                walletCache.data = { 
                    totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                    totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                    availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                    totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
                };
                walletCache.lastUpdate = now;
                walletLastRestUpdate = now;
            }
        }
        if (!walletCache.data) return null;

        const snapshotAvailable = parseFloat(walletCache.data.availableBalance || 0);
        const marginSetting = botInst.botSettings.invValue || "1%";
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

    try {
        const p = await calcParams();
        if (!p) {
            openingSymbols.delete(symbol);
            sharedState.pendingOrders.delete(symbol);
            return;
        }

        await Promise.all([
            openPosition(botInst, symbol, null, 'LONG', p.finalQty, p.finalMargin, currentPrice, modeName, extraLogInfo),
            openPosition(botInst, symbol, null, 'SHORT', p.finalQty, p.finalMargin, currentPrice, modeName, extraLogInfo)
        ]);
    } catch (err) {
        checkAndAddBlacklist(symbol);
        const errMsg = err?.response?.data?.msg || err?.message || String(err);
        addBotLog(botInst, `⚠️ [BỎ QUA CẶP ${formatCoinName(symbol)}] ${errMsg}`, "error", `err_open_pair_${symbol}`);
    } finally {
        setTimeout(() => {
            openingSymbols.delete(symbol);
            sharedState.pendingOrders.delete(symbol);
        }, 3000);
    }
}

async function openPositionSingle(botInst, symbol, side = 'LONG', modeName = 'trend', extraLogInfo = '', indicatorSnapshot = null, volatilityInfo = '') {
    if (!botInst.botSettings.isRunning) {
        openingSymbols.delete(symbol);
        sharedState.pendingOrders.delete(symbol);
        return;
    }

    const posRisk = await getCachedPositionRisk(botInst, 1000);
    const hasManualOnExchange = (posRisk || []).some(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0 && !botInst.botActivePositions.has(`${symbol}_${p.positionSide}`));
    if (hasManualOnExchange) {
        openingSymbols.delete(symbol);
        sharedState.pendingOrders.delete(symbol);
        return;
    }

    const existingPos = botInst.botActivePositions.get(`${symbol}_${side}`);
    if (existingPos) {
        openingSymbols.delete(symbol);
        sharedState.pendingOrders.delete(symbol);
        return;
    }

    const info = sharedState.exchangeInfo[symbol];
    if (!info) {
        openingSymbols.delete(symbol);
        return;
    }

    delete sharedState.lastClosedPnl[`${symbol}_${side}`];
    delete sharedState.lastClosedMargin[`${symbol}_${side}`];

    const currentPrice = await getCachedTickerPrice(symbol, 1000).catch(() => null);
    if (!currentPrice) {
        openingSymbols.delete(symbol);
        return;
    }

    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

    const calcParams = async () => {
        const now = Date.now();
        if (!walletCache.data || walletCache.data.availableBalance === "0" || (now - walletCache.lastUpdate > 10000)) {
            const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
            if (acc) {
                walletCache.data = { 
                    totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                    totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                    availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                    totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
                };
                walletCache.lastUpdate = now;
                walletLastRestUpdate = now;
            }
        }
        if (!walletCache.data) return null;

        const snapshotAvailable = parseFloat(walletCache.data.availableBalance || 0);
        const marginSetting = botInst.botSettings.invValue || "1%";
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

    try {
        const p = await calcParams();
        if (!p) {
            addBotLog(botInst, `⚠️ [LỖI TÍNH TOÁN ${symbol}] Không lấy được số dư khả dụng hoặc vốn quá nhỏ!`, "error");
            openingSymbols.delete(symbol);
            sharedState.pendingOrders.delete(symbol);
            return;
        }

        await openPosition(botInst, symbol, null, side, p.finalQty, p.finalMargin, currentPrice, modeName, extraLogInfo, indicatorSnapshot, volatilityInfo);
    } catch (err) {
        checkAndAddBlacklist(symbol);
        const errMsg = err?.response?.data?.msg || err?.message || String(err);
        addBotLog(botInst, `⚠️ [BỎ QUA TREND ${formatCoinName(symbol)}] Lỗi: ${errMsg}`, "error", `err_open_single_${symbol}`);
    } finally {
        setTimeout(() => {
            openingSymbols.delete(symbol);
            sharedState.pendingOrders.delete(symbol);
        }, 3000);
    }
}

// Kiểm tra khả dụng định kỳ & tự động hồi phục
async function checkMarginLimits(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return;
    const now = Date.now();

    if (!walletCache.data || (now - walletLastRestUpdate > 5000)) {
        if (!isRateLimited()) {
            const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
            if (acc) {
                walletCache.data = { 
                    totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                    totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                    availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                    totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
                };
                walletCache.lastUpdate = now;
                walletLastRestUpdate = now;
            }
        }
    }

    if (walletCache.data && parseFloat(walletCache.data.totalMarginBalance) > 0) {
        const totalMargin = parseFloat(walletCache.data.totalMarginBalance);
        const avail = parseFloat(walletCache.data.availableBalance);
        const availPercent = (avail / totalMargin) * 100;
        
        if (availPercent <= ANTI_LIQUIDATION_LIMIT) { 
            if (!botInst.isAntiLiquidationTriggered) {
                botInst.isAntiLiquidationTriggered = true;
                botInst.antiLiquidationCooldownUntil = Date.now() + 60000;
                await panicCloseAll(botInst, `CHỐNG THANH LÝ ${ANTI_LIQUIDATION_LIMIT}%`); 
                botInst.isMarginProtected = false; 
            }
            return; 
        } else {
            if (!botInst.antiLiquidationCooldownUntil || Date.now() >= botInst.antiLiquidationCooldownUntil) {
                botInst.isAntiLiquidationTriggered = false;
            }
        }

        if (!botInst.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
            botInst.isMarginProtected = true; 
            addBotLog(botInst, `⚠️ [NGỪNG QUÉT] Khả dụng ví giảm còn ${availPercent.toFixed(1)}% (${avail.toFixed(1)}$/${totalMargin.toFixed(1)}$) dưới ngưỡng ${MARGIN_PROTECT_LIMIT}%`, "warn", "margin_drop_alert");
        } else if (botInst.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            botInst.isMarginProtected = false; 
            addBotLog(botInst, `✅ [KHÔI PHỤC QUÉT] Khả dụng ví đã hồi phục lên ${availPercent.toFixed(1)}% (${avail.toFixed(1)}$/${totalMargin.toFixed(1)}$) vượt ngưỡng ${MARGIN_RECOVER_LIMIT}%. Tiếp tục quét mở lệnh!`, "open");
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
    if (now - walletLastRestUpdate > 5000 && !isRateLimited()) {
        const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
        if (acc) {
            walletCache.data = { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
            };
            walletCache.lastUpdate = now;
            walletLastRestUpdate = now;
        }
    }

    const posRisk = await getCachedPositionRisk(botInst, 1000) || [];
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }

    let unrealizedPnL = 0;
    botInst.botActivePositions.forEach(p => { 
        if (p.isBotOpened === true) {
            unrealizedPnL += (p.pnl || 0); 
        }
    });

    const modeCounts = { vol: 0, '24h': 0, funding: 0, name: 0, trend: 0 };
    botInst.botActivePositions.forEach(p => {
        let m = p.modeName || 'vol';
        if (m === 'fd') m = 'funding';
        if (modeCounts[m] !== undefined) modeCounts[m]++;
    });
    for (let m in modeCounts) {
        if (!sharedState.modeStats[m]) sharedState.modeStats[m] = { open: 0, closed: 0, pnl: 0 };
        sharedState.modeStats[m].open = modeCounts[m];
    }

    const sortedPositions = Array.from(botInst.botActivePositions.values())
        .filter(p => p.isBotOpened === true)
        .map(p => {
            const openDurationMs = now - (p.createdAt || now);
            
            const slDet = calculateSlDetails(botInst, p);
            const slPhongHoDet = calculateSlPhongHoDetails(botInst, p);
            
            let tpDet = null;
            if ((p.dcaAmCount || 0) > 0 || p.isLockedAm) {
                tpDet = calculateTpDcaAmDetails(botInst, p);
            } else {
                tpDet = calculateTpDcaDuongDetails(botInst, p);
            }

            const nextDcaAmMargin = calculateDcaAmMargin(botInst, p);
            const nextDcaDuongMargin = calculateDcaDuongMargin(botInst, p);
            const feeAndFd = calculatePositionFeeAndFunding(botInst, p, p.livePrice || p.avgEntry);

            // Định dạng hiển thị Supertrend 1m realtime
            let st1mDisplay = '--';
            if (p.modeName === 'trend') {
                const gapVal = parseFloat(p.st1mGapPct !== undefined ? p.st1mGapPct : 0);
                const stPrice = p.currentSt1mVal ? formatPrice(p.currentSt1mVal) : '--';
                const signStr = gapVal > 0 ? '+' : '';
                st1mDisplay = `${stPrice} (${signStr}${gapVal.toFixed(2)}%)`;
            }

            return {
                ...p,
                estimatedFee: feeAndFd.estimatedFee,
                accumulatedFunding: feeAndFd.accumulatedFunding,
                nextDcaAmMargin: nextDcaAmMargin,
                nextDcaDuongMargin: nextDcaDuongMargin,
                nextDcaAmFormatted: `${formatPrice(p.nextDcaAm)} (${nextDcaAmMargin.toFixed(2)}$)`,
                nextDcaDuongFormatted: `${formatPrice(p.nextDcaDuong)} (${nextDcaDuongMargin.toFixed(2)}$)`,
                openDurationStr: formatDuration(openDurationMs),
                tpCalculatedPrice: tpDet.targetTpPrice ? formatPrice(tpDet.targetTpPrice) : '-',
                tpEstimatedPnL: tpDet.estPnl !== undefined ? (tpDet.estPnl >= 0 ? `+${tpDet.estPnl.toFixed(2)}$` : `${tpDet.estPnl.toFixed(2)}$`) : '-',
                dcaDuongBadgeIcon: tpDet.badge || '',
                slCalculatedPrice: slDet.targetSlPrice ? formatPrice(slDet.targetSlPrice) : '-',
                slEstimatedPnL: slDet.estPnl !== undefined ? `${slDet.estPnl.toFixed(2)}$` : '-',
                slPhongHoFormatted: slPhongHoDet.formattedStr,
                st1mDisplay: st1mDisplay,
                st1mGapPct: p.st1mGapPct !== undefined ? p.st1mGapPct : 0
            };
        })
        .sort((a, b) => (a.pnl || 0) - (b.pnl || 0));

    const exchangePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => {
        const amt = Math.abs(parseFloat(p.positionAmt));
        const entryPrice = parseFloat(p.entryPrice || 0);
        const leverage = parseFloat(p.leverage || 1) || 1;
        const margin = (amt * entryPrice) / leverage;
        return {
            ...p,
            margin: margin.toFixed(2)
        };
    });

    const currentMinLev = botInst.botSettings.minLev !== undefined ? botInst.botSettings.minLev : 50;
    const filtered24h = sharedState.top24hList.filter(c => c.leverage >= currentMinLev);
    const filteredFunding = sharedState.topFundingList.filter(c => c.leverage >= currentMinLev);
    
    const filteredTrend = sharedState.topTrendList
        .filter(c => c.leverage >= currentMinLev)
        .map(t => {
            const wsPrice = liveMarkPrices.get(t.symbol)?.price;
            return {
                ...t,
                price: wsPrice && wsPrice > 0 ? wsPrice : t.price
            };
        });

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
            isPnlPaused: botInst.isPnlPaused,
            candidatesList: sharedState.candidatesList,
            top24hList: filtered24h,
            topFundingList: filteredFunding,
            topTrendList: filteredTrend,
            modeStats: sharedState.modeStats,
            blackList: formattedBlacklist, 
            permanentBlacklist: sharedState.permanentBlacklist, 
            exchangeInfo: sharedState.exchangeInfo, 
            timeRun: formatUptime(botInst.startTime),
            isRateLimited: isRateLimited(),
            rateLimitUntil: rateLimitBannedUntil ? Math.ceil(Math.max(0, rateLimitBannedUntil - now) / 1000) : 0
        }, 
        wallet: {
            ...walletCache.data,
            unrealizedPnL: unrealizedPnL.toFixed(2)
        }, 
        timeRun: formatUptime(botInst.startTime)
    };
}

// Cập nhật cấu hình: Lập tức áp dụng và tính toán lại toàn bộ vị thế đang mở
appServer.post('/api/settings', (req, res) => {
    bot.botSettings = parseNormalizedSettings(req.body, bot.botSettings);
    saveSettingsToFile();
    updatePermanentBlacklist();
    recalculateAllActivePositions(bot);
    res.json({ success: true, msg: "Cập nhật cấu hình thành công & đã áp dụng ngay vào các vị thế!" });
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
            if (p) {
                const ccxtSymbol = getCcxtSymbol(bot, symbol);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
                await bot.exchange.createOrder(ccxtSymbol, 'MARKET', closeSide, Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side }); 
            }
            res.json({ success: true }); 
        } catch (e) { res.json({ success: false, msg: e.message }); } 
    } 
});

async function syncPositionsWithExchange() {
    try {
        if (bot.antiLiquidationCooldownUntil && Date.now() < bot.antiLiquidationCooldownUntil) {
            return;
        }

        const posRisk = await getCachedPositionRisk(bot, 1000);
        if (!posRisk || !Array.isArray(posRisk)) return;

        const realActivePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        const activeKeysOnExchange = new Set(realActivePositions.map(p => `${p.symbol}_${p.positionSide}`));

        for (let [key, pos] of Array.from(bot.botActivePositions.entries())) {
            if (pos.isBotOpened !== true) {
                bot.botActivePositions.delete(key);
                continue;
            }

            const ageMs = Date.now() - (pos.lastActionTime || pos.createdAt || 0);

            if (!activeKeysOnExchange.has(key)) {
                if (ageMs < 20000) {
                    continue;
                }
                bot.botActivePositions.delete(key);
                checkAndAddBlacklist(pos.symbol);
            } else {
                const realP = realActivePositions.find(p => `${p.symbol}_${p.positionSide}` === key);
                if (realP) {
                    const realEntry = parseFloat(realP.entryPrice);
                    if (realEntry > 0) {
                        pos.avgEntry = realEntry;
                        if ((pos.dcaCount || 0) === 0) {
                            pos.firstEntry = realEntry;
                            pos.entryPrice = realEntry;
                        }
                    }
                    pos.livePrice = parseFloat(realP.markPrice);
                    pos.currentQty = Math.abs(parseFloat(realP.positionAmt));
                    pos.pnl = parseFloat(realP.unRealizedProfit);
                }
            }
        }

        savePositionsToFile();
    } catch (e) {
        console.error("Lỗi đồng bộ vị thế:", e.message);
    }
}

let markPriceWs = null;
let markPriceReconnectTimer = null;

function startMarkPriceStream() {
    if (markPriceReconnectTimer) clearTimeout(markPriceReconnectTimer);
    try {
        if (markPriceWs) {
            try { markPriceWs.terminate(); } catch (e) {}
        }
        markPriceWs = new WebSocket('wss://fstream.binance.com/ws/!markPrice@arr@1s');

        markPriceWs.on('open', () => {
            console.log('✅ [WebSocket] Đã kết nối Mark Price Stream (!markPrice@arr@1s)');
        });

        markPriceWs.on('message', (raw) => {
            try {
                const list = JSON.parse(raw);
                if (Array.isArray(list)) {
                    const now = Date.now();
                    for (const item of list) {
                        liveMarkPrices.set(item.s, {
                            price: parseFloat(item.p),
                            fundingRate: parseFloat(item.r || 0),
                            time: now
                        });
                    }
                }
            } catch (err) {}
        });

        markPriceWs.on('error', (err) => {
            console.error('⚠️ [WebSocket] Mark Price Stream lỗi:', err.message);
        });

        markPriceWs.on('close', () => {
            console.log('🔄 [WebSocket] Mark Price Stream ngắt kết nối. Đang kết nối lại sau 3s...');
            markPriceReconnectTimer = setTimeout(startMarkPriceStream, 3000);
        });
    } catch (e) {
        markPriceReconnectTimer = setTimeout(startMarkPriceStream, 5000);
    }
}

let userDataWs = null;
let userDataReconnectTimer = null;
let listenKeyKeepAliveTimer = null;
let currentListenKey = null;

async function getListenKey(botInst) {
    try {
        const res = await botInst.binanceApi.post('/fapi/v1/listenKey');
        return res.data?.listenKey;
    } catch (e) {
        return null;
    }
}

async function keepAliveListenKey(botInst) {
    if (!currentListenKey) return;
    try {
        await botInst.binanceApi.put('/fapi/v1/listenKey');
    } catch (e) {}
}

async function startUserDataStream(botInst) {
    if (userDataReconnectTimer) clearTimeout(userDataReconnectTimer);
    if (listenKeyKeepAliveTimer) clearInterval(listenKeyKeepAliveTimer);

    try {
        if (userDataWs) {
            try { userDataWs.terminate(); } catch (e) {}
        }

        currentListenKey = await getListenKey(botInst);
        if (!currentListenKey) {
            userDataReconnectTimer = setTimeout(() => startUserDataStream(botInst), 10000);
            return;
        }

        userDataWs = new WebSocket(`wss://fstream.binance.com/ws/${currentListenKey}`);

        userDataWs.on('open', () => {
            console.log('✅ [WebSocket] Đã kết nối User Data Stream (Account & Trade Realtime)');
            listenKeyKeepAliveTimer = setInterval(() => keepAliveListenKey(botInst), 30 * 60 * 1000);
        });

        userDataWs.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                handleUserDataEvent(botInst, msg);
            } catch (err) {}
        });

        userDataWs.on('error', (err) => {
            console.error('⚠️ [WebSocket] User Data Stream lỗi:', err.message);
        });

        userDataWs.on('close', () => {
            console.log('🔄 [WebSocket] User Data Stream ngắt kết nối. Đang kết nối lại sau 5s...');
            if (listenKeyKeepAliveTimer) clearInterval(listenKeyKeepAliveTimer);
            userDataReconnectTimer = setTimeout(() => startUserDataStream(botInst), 5000);
        });
    } catch (e) {
        userDataReconnectTimer = setTimeout(() => startUserDataStream(botInst), 10000);
    }
}

function handleUserDataEvent(botInst, msg) {
    if (!msg) return;
    const eventType = msg.e;

    if (eventType === 'ACCOUNT_UPDATE' && msg.a) {
        const a = msg.a;
        if (Array.isArray(a.B)) {
            for (const bItem of a.B) {
                if (bItem.a === 'USDT') {
                    const wb = parseFloat(bItem.wb || 0);
                    const cw = parseFloat(bItem.cw || 0);
                    walletCache.data.totalWalletBalance = wb.toFixed(2);
                    walletCache.data.availableBalance = cw.toFixed(2);
                    
                    const unpnl = parseFloat(walletCache.data.totalUnrealizedProfit || 0);
                    walletCache.data.totalMarginBalance = (wb + unpnl).toFixed(2);
                    walletCache.lastUpdate = Date.now();
                }
            }
        }
        if (Array.isArray(a.P)) {
            for (const pItem of a.P) {
                const sym = pItem.s;
                const posSide = pItem.ps || (parseFloat(pItem.pa) > 0 ? 'LONG' : 'SHORT');
                const key = `${sym}_${posSide}`;
                const amt = Math.abs(parseFloat(pItem.pa));
                const entry = parseFloat(pItem.ep);
                const unPnl = parseFloat(pItem.up);

                const botPos = botInst.botActivePositions.get(key);
                if (botPos && botPos.isBotOpened === true && !botPos.isClosing) {
                    if (amt === 0) {
                        const ageMs = Date.now() - (botPos.lastActionTime || botPos.createdAt || 0);
                        if (ageMs > 10000) {
                            botInst.botActivePositions.delete(key);
                            savePositionsToFile();
                            checkAndAddBlacklist(sym);
                        }
                    } else {
                        botPos.currentQty = amt;
                        if (entry > 0) botPos.avgEntry = entry;
                        botPos.pnl = unPnl;
                    }
                }

                if (positionRiskCache.data && Array.isArray(positionRiskCache.data)) {
                    const cacheP = positionRiskCache.data.find(x => x.symbol === sym && x.positionSide === posSide);
                    if (cacheP) {
                        cacheP.positionAmt = pItem.pa;
                        cacheP.entryPrice = pItem.ep;
                        cacheP.unRealizedProfit = pItem.up;
                    }
                }
            }
        }
    } 
    else if (eventType === 'ORDER_TRADE_UPDATE' && msg.o) {
        const o = msg.o;
        if (o.X === 'FILLED' && o.rp !== undefined) {
            const sym = o.s;
            const posSide = o.ps || (o.S === 'BUY' ? 'SHORT' : 'LONG');
            recentTradePnL.set(`${sym}_${posSide}`, {
                realizedPnl: parseFloat(o.rp || 0),
                commission: parseFloat(o.n || 0),
                time: Date.now()
            });
        }
    }
}

// =========================================================================
// VÒNG LẶP CẬP NHẬT SUPERTREND 1M LIÊN TỤC CHO MỌI VỊ THẾ TREND ĐANG MỞ
// =========================================================================
setInterval(async () => {
    if (!bot.status.isReady) return;
    for (const [key, b] of bot.botActivePositions.entries()) {
        if (b.modeName === 'trend' && !b.isClosing) {
            try {
                const res = await binanceApi.get(`/fapi/v1/klines?symbol=${b.symbol}&interval=1m&limit=25`, { timeout: 3000 });
                if (Array.isArray(res.data) && res.data.length >= 15) {
                    const closedKlines = res.data.slice(0, -1);
                    const closes = closedKlines.map(k => parseFloat(k[4]));
                    const highs = closedKlines.map(k => parseFloat(k[2]));
                    const lows = closedKlines.map(k => parseFloat(k[3]));
                    const stRes = calcSupertrend(highs, lows, closes, TREND_INDICATOR_CONFIG.ST_ATR_PERIOD, TREND_INDICATOR_CONFIG.ST_MULTIPLIER);
                    const lastIdx = stRes.supertrend.length - 1;
                    if (lastIdx >= 0 && stRes.supertrend[lastIdx] > 0) {
                        b.currentSt1mVal = stRes.supertrend[lastIdx];
                        b.currentSt1mDir = stRes.direction[lastIdx];
                    }
                }
            } catch (err) {}
        }
    }
}, 1200);

// Tính toán chỉ báo Trend với điều kiện biến động cùng chiều >= 3%
async function evaluateTrendForSymbol(symbol) {
    try {
        const info = sharedState.exchangeInfo?.[symbol];
        if (!info) return null;

        const [k5m, k3m, k1m] = await Promise.all([
            fetchClosedKlines(symbol, '5m', 50),
            fetchClosedKlines(symbol, '3m', 50),
            fetchClosedKlines(symbol, '1m', 50)
        ]);

        if (!k5m || !k3m || !k1m || k5m.length < 30 || k3m.length < 20 || k1m.length < 30) {
            return null;
        }

        const closes5m = k5m.map(k => parseFloat(k[4]));
        const highs5m = k5m.map(k => parseFloat(k[2]));
        const lows5m = k5m.map(k => parseFloat(k[3]));
        const currentClose5m = closes5m[closes5m.length - 1];

        // 1. EMA 10 & 25 (Khung 5m)
        const ema10_5m = calcEMA(closes5m, TREND_INDICATOR_CONFIG.EMA_FAST);
        const ema25_5m = calcEMA(closes5m, TREND_INDICATOR_CONFIG.EMA_SLOW);
        const lastEma10_5m = ema10_5m[ema10_5m.length - 1];
        const lastEma25_5m = ema25_5m[ema25_5m.length - 1];

        const emaConditionLong = lastEma10_5m > lastEma25_5m && currentClose5m > lastEma25_5m;
        const emaConditionShort = lastEma10_5m < lastEma25_5m && currentClose5m < lastEma25_5m;
        const expectedDirection = lastEma10_5m >= lastEma25_5m ? 'LONG' : 'SHORT';

        // 2. Tính % Biến động có dấu trên 3 khung 1p, 5p, 15p
        const closes1m = k1m.map(k => parseFloat(k[4]));
        const highs1m = k1m.map(k => parseFloat(k[2]));
        const lows1m = k1m.map(k => parseFloat(k[3]));
        const volumes1m = k1m.map(k => parseFloat(k[5]));
        const currentClose1m = closes1m[closes1m.length - 1];

        const open1m = parseFloat(k1m[k1m.length - 1][1]);
        const pct1m = open1m > 0 ? ((currentClose1m - open1m) / open1m) * 100 : 0;

        const open5m = parseFloat(k5m[k5m.length - 1][1]);
        const pct5m = open5m > 0 ? ((currentClose5m - open5m) / open5m) * 100 : 0;

        const open15m = parseFloat(k5m[k5m.length - 3] ? k5m[k5m.length - 3][1] : open5m);
        const pct15m = open15m > 0 ? ((currentClose5m - open15m) / open15m) * 100 : 0;

        const cand = (sharedState.candidatesList || []).find(c => c.symbol === symbol);
        const cand1 = cand ? parseFloat(cand.c1 ?? cand.m1 ?? cand.v1 ?? 0) : 0;
        const cand5 = cand ? parseFloat(cand.c5 ?? cand.m5 ?? cand.v5 ?? 0) : 0;
        const cand15 = cand ? parseFloat(cand.c15 ?? cand.m15 ?? cand.v15 ?? 0) : 0;

        const change1m = Math.abs(cand1) > Math.abs(pct1m) ? cand1 : pct1m;
        const change5m = Math.abs(cand5) > Math.abs(pct5m) ? cand5 : pct5m;
        const change15m = Math.abs(cand15) > Math.abs(pct15m) ? cand15 : pct15m;

        let volatilityCondition = false;
        let volatilityText = "0.00%";
        if (expectedDirection === 'LONG') {
            const maxBullish = Math.max(change1m, change5m, change15m);
            volatilityCondition = maxBullish >= TREND_INDICATOR_CONFIG.MIN_VOLATILITY_PCT;
            volatilityText = (maxBullish > 0 ? '+' : '') + maxBullish.toFixed(2) + '%';
        } else {
            const minBearish = Math.min(change1m, change5m, change15m);
            volatilityCondition = minBearish <= -TREND_INDICATOR_CONFIG.MIN_VOLATILITY_PCT;
            volatilityText = minBearish.toFixed(2) + '%';
        }

        const volatilityDetail = `1m:${change1m > 0 ? '+' : ''}${change1m.toFixed(1)}% | 5m:${change5m > 0 ? '+' : ''}${change5m.toFixed(1)}% | 15m:${change15m > 0 ? '+' : ''}${change15m.toFixed(1)}%`;

        // 3. Supertrend 1m & 3m
        const closes3m = k3m.map(k => parseFloat(k[4]));
        const highs3m = k3m.map(k => parseFloat(k[2]));
        const lows3m = k3m.map(k => parseFloat(k[3]));
        const currentClose3m = closes3m[closes3m.length - 1];

        const st1m = calcSupertrend(highs1m, lows1m, closes1m, TREND_INDICATOR_CONFIG.ST_ATR_PERIOD, TREND_INDICATOR_CONFIG.ST_MULTIPLIER);
        const st3m = calcSupertrend(highs3m, lows3m, closes3m, TREND_INDICATOR_CONFIG.ST_ATR_PERIOD, TREND_INDICATOR_CONFIG.ST_MULTIPLIER);

        const lastSt1mVal = st1m.supertrend[st1m.supertrend.length - 1];
        const lastSt1mDir = st1m.direction[st1m.direction.length - 1];

        const lastSt3mVal = st3m.supertrend[st3m.supertrend.length - 1];
        const lastSt3mDir = st3m.direction[st3m.direction.length - 1];

        const st1mConditionLong = lastSt1mDir === 1 && currentClose1m > lastSt1mVal;
        const st1mConditionShort = lastSt1mDir === -1 && currentClose1m < lastSt1mVal;

        const st3mConditionLong = lastSt3mDir === 1 && currentClose3m > lastSt3mVal;
        const st3mConditionShort = lastSt3mDir === -1 && currentClose3m < lastSt3mVal;

        // 4. MACD 12, 26, 9 (Khung 1m)
        const macdRes = calcMACD(closes1m, TREND_INDICATOR_CONFIG.MACD_FAST, TREND_INDICATOR_CONFIG.MACD_SLOW, TREND_INDICATOR_CONFIG.MACD_SIGNAL);
        const lenM = macdRes.macdLine.length;
        const lastMacd = macdRes.macdLine[lenM - 1];
        const lastSignal = macdRes.signalLine[lenM - 1];
        const curHist = macdRes.histogram[lenM - 1];
        const prevHist = macdRes.histogram[lenM - 2];

        const macdConditionLong = lastMacd > lastSignal && curHist > prevHist;
        const macdConditionShort = lastMacd < lastSignal && curHist < prevHist;

        // 5. Volume 1m: Nến tín hiệu >= 5 lần trung bình 10 nến trước
        const curVol = volumes1m[volumes1m.length - 1];
        const prev10Vols = volumes1m.slice(-11, -1);
        const avgVol10 = prev10Vols.reduce((a, b) => a + b, 0) / (prev10Vols.length || 1);
        const volRatio = avgVol10 > 0 ? (curVol / avgVol10) : 0;
        const volCondition = volRatio >= TREND_INDICATOR_CONFIG.VOL_MULTIPLIER;

        // 6. Breakout 1m: Xét 10 nến trước đó
        const prev10Highs = highs1m.slice(-11, -1);
        const prev10Lows = lows1m.slice(-11, -1);
        const highestHigh10 = Math.max(...prev10Highs);
        const lowestLow10 = Math.min(...prev10Lows);

        const breakoutConditionLong = currentClose1m > highestHigh10;
        const breakoutConditionShort = currentClose1m < lowestLow10;

        // 7. Chống đuổi giá 5m: ATR 14, EMA 25 <= 5.0 ATR
        const atr5m = calcATR(highs5m, lows5m, closes5m, TREND_INDICATOR_CONFIG.ANTI_CHASE_ATR_PERIOD);
        const lastAtr5m = atr5m[atr5m.length - 1] || 1;
        const chaseRatioLong = (currentClose5m - lastEma25_5m) / lastAtr5m;
        const chaseRatioShort = (lastEma25_5m - currentClose5m) / lastAtr5m;

        const antiChaseConditionLong = chaseRatioLong <= TREND_INDICATOR_CONFIG.ANTI_CHASE_MAX_RATIO;
        const antiChaseConditionShort = chaseRatioShort <= TREND_INDICATOR_CONFIG.ANTI_CHASE_MAX_RATIO;

        let score = 0;
        if (expectedDirection === 'LONG') {
            if (emaConditionLong) score++;
            if (st1mConditionLong) score++;
            if (st3mConditionLong) score++;
            if (macdConditionLong) score++;
            if (volCondition) score++;
            if (breakoutConditionLong) score++;
            if (antiChaseConditionLong) score++;
            if (volatilityCondition) score++;
        } else {
            if (emaConditionShort) score++;
            if (st1mConditionShort) score++;
            if (st3mConditionShort) score++;
            if (macdConditionShort) score++;
            if (volCondition) score++;
            if (breakoutConditionShort) score++;
            if (antiChaseConditionShort) score++;
            if (volatilityCondition) score++;
        }

        const isFullLong = emaConditionLong && st1mConditionLong && st3mConditionLong && macdConditionLong && volCondition && breakoutConditionLong && antiChaseConditionLong && volatilityCondition;
        const isFullShort = emaConditionShort && st1mConditionShort && st3mConditionShort && macdConditionShort && volCondition && breakoutConditionShort && antiChaseConditionShort && volatilityCondition;

        return {
            symbol,
            leverage: info.maxLeverage,
            price: currentClose1m,
            expectedDirection,
            score,
            isFullLong,
            isFullShort,
            volatilityText,
            volatilityDetail,
            volatilityCondition,
            ema10: lastEma10_5m,
            ema25: lastEma25_5m,
            emaCondition: emaConditionLong,
            emaConditionShort: emaConditionShort,
            st1mVal: lastSt1mVal,
            st1mDir: lastSt1mDir,
            st1mCondition: st1mConditionLong,
            st1mConditionShort: st1mConditionShort,
            st3mVal: lastSt3mVal,
            st3mCondition: st3mConditionLong,
            st3mConditionShort: st3mConditionShort,
            macdVal: lastMacd,
            signalVal: lastSignal,
            curHist,
            prevHist,
            macdCondition: macdConditionLong,
            macdConditionShort: macdConditionShort,
            curVol,
            avgVol10,
            volRatio,
            volCondition,
            highestHigh10,
            lowestLow10,
            breakoutCondition: breakoutConditionLong,
            breakoutConditionShort: breakoutConditionShort,
            antiChaseRatio: expectedDirection === 'LONG' ? chaseRatioLong : chaseRatioShort,
            antiChaseCondition: expectedDirection === 'LONG' ? antiChaseConditionLong : antiChaseConditionShort
        };

    } catch (e) {
        return null;
    }
}

let isCalculatingTrend = false;
async function calcTrendIndicatorsForAll() {
    if (isCalculatingTrend || isRateLimited()) return;
    isCalculatingTrend = true;
    try {
        if (!sharedState.exchangeInfo) return;

        const minLev = bot.botSettings.minLev || 50;
        const candidateSet = new Set();

        (sharedState.candidatesList || []).slice(0, 10).forEach(c => {
            if (c.symbol && sharedState.exchangeInfo[c.symbol]?.maxLeverage >= minLev) candidateSet.add(c.symbol);
        });

        (sharedState.top24hList || []).slice(0, 10).forEach(c => {
            if (c.symbol && sharedState.exchangeInfo[c.symbol]?.maxLeverage >= minLev) candidateSet.add(c.symbol);
        });

        if (bot.botSettings.scanNamesInput) {
            bot.botSettings.scanNamesInput.split(',').forEach(n => {
                let sym = n.trim().toUpperCase();
                if (sym && !sym.endsWith('USDT') && !sym.endsWith('BUSD')) sym += 'USDT';
                if (sharedState.exchangeInfo[sym]?.maxLeverage >= minLev) candidateSet.add(sym);
            });
        }

        if (candidateSet.size < 20) {
            for (const sym in sharedState.exchangeInfo) {
                if (sharedState.exchangeInfo[sym].maxLeverage >= minLev) {
                    candidateSet.add(sym);
                    if (candidateSet.size >= 25) break;
                }
            }
        }

        const candidateSymbols = Array.from(candidateSet);
        const results = [];
        
        const batchSize = 5;
        for (let i = 0; i < candidateSymbols.length; i += batchSize) {
            const batch = candidateSymbols.slice(i, i + batchSize);
            const batchRes = await Promise.all(batch.map(sym => evaluateTrendForSymbol(sym)));
            batchRes.forEach(r => { if (r) results.push(r); });
            await new Promise(r => setTimeout(r, 60));
        }

        results.sort((a, b) => b.score - a.score);
        sharedState.topTrendList = results;
    } catch (err) {
    } finally {
        isCalculatingTrend = false;
    }
}

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
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const stepSize = lotFilter ? parseFloat(lotFilter.stepSize) : 0.001;
            const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const minNotional = notionalFilter ? parseFloat(notionalFilter.notional || notionalFilter.minNotional || 5.0) : 5.0;

            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision !== undefined ? s.quantityPrecision : 0, 
                pricePrecision: s.pricePrecision !== undefined ? s.pricePrecision : 2, 
                stepSize: stepSize > 0 ? stepSize : 0.001, 
                minNotional: minNotional > 0 ? minNotional : 5.0, 
                maxLeverage: maxLev 
            };
        });
        sharedState.exchangeInfo = temp; 
        
        loadSettingsFromFile();
        loadPositionsFromFile();

        for (let [key, pos] of Array.from(bot.botActivePositions.entries())) {
            if (pos.isBotOpened !== true) {
                bot.botActivePositions.delete(key);
            }
        }
        savePositionsToFile();

        updatePermanentBlacklist();

        startMarkPriceStream();
        await startUserDataStream(bot);

        await syncPositionsWithExchange();

        console.log("⚡ [TREND ENGINE] Khởi chạy tính toán Top Trend ngay khi start bot...");
        await calcTrendIndicatorsForAll();

        await new Promise(r => setTimeout(r, 1000));
        bot.status.isReady = true; 
        
        priceMonitor(bot); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(async () => {
    if (bot.status.isReady) {
        await calcTrendIndicatorsForAll();
    }
}, 4000);

setInterval(async () => {
    if (bot.status.isReady) {
        await syncPositionsWithExchange();
    }
}, 12000);

setInterval(async () => {
    if (isRateLimited()) return;
    try {
        const [tickerRes, premiumRes] = await Promise.all([
            binanceApi.get('/fapi/v1/ticker/24hr'),
            binanceApi.get('/fapi/v1/premiumIndex')
        ]);

        const tickers = tickerRes.data || [];
        const premiums = premiumRes.data || [];

        const premMap = {};
        premiums.forEach(p => {
            premMap[p.symbol] = parseFloat(p.lastFundingRate || 0);
        });

        const formatted24h = tickers.map(t => {
            const sym = t.symbol;
            const info = sharedState.exchangeInfo?.[sym];
            return {
                symbol: sym,
                price: parseFloat(t.lastPrice || 0),
                priceChangePercent: parseFloat(t.priceChangePercent || 0),
                leverage: info?.maxLeverage || 20
            };
        });

        const formattedFunding = tickers.map(t => {
            const sym = t.symbol;
            const info = sharedState.exchangeInfo?.[sym];
            const fr = premMap[sym] || 0;
            return {
                symbol: sym,
                price: parseFloat(t.lastPrice || 0),
                fundingRate: fr,
                absFunding: Math.abs(fr),
                leverage: info?.maxLeverage || 20
            };
        });

        formatted24h.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
        sharedState.top24hList = formatted24h;

        formattedFunding.sort((a, b) => b.absFunding - a.absFunding);
        sharedState.topFundingList = formattedFunding;

        bot.botActivePositions.forEach(p => {
            if (premMap[p.symbol] !== undefined) {
                p.fundingRate = premMap[p.symbol];
            } else if (liveMarkPrices.has(p.symbol)) {
                p.fundingRate = liveMarkPrices.get(p.symbol).fundingRate;
            }
        });

    } catch (e) {}
}, 20000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1200);

// ============================================================
// SCANNER: KIỂM TRA ĐIỀU KIỆN & KHÔNG SPAM KHI ĐÃ MAX LỆNH / BLACKLIST
// ============================================================
let isScanning = false;

setInterval(async () => {
    if (isScanning) return;
    isScanning = true;

    try {
        if (!bot.status.isReady || !bot.botSettings.isRunning || bot.isPnlPaused || isRateLimited()) {
            return;
        }

        await checkMarginLimits(bot);
        if (!bot.botSettings.isRunning) return;

        if (bot.isMarginProtected) {
            return;
        }

        if (bot.antiLiquidationCooldownUntil && Date.now() < bot.antiLiquidationCooldownUntil) return;

        const maxPosSetting = bot.botSettings.maxPositions || 3;
        const uniqueActiveSymbols = new Set(Array.from(bot.botActivePositions.values()).map(p => p.symbol));

        const exchangePositions = (positionRiskCache.data || []).filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        const exchangeSymbolsWithPosition = new Set(exchangePositions.map(p => p.symbol));

        const pairCountByMode = { vol: new Set(), '24h': new Set(), funding: new Set(), name: new Set(), trend: new Set() };
        bot.botActivePositions.forEach(p => {
            let m = p.modeName || 'vol';
            if (m === 'fd') m = 'funding';
            if (pairCountByMode[m]) {
                pairCountByMode[m].add(p.symbol);
            }
        });

        openingSymbols.forEach((m, sym) => {
            let normM = m || 'vol';
            if (normM === 'fd') normM = 'funding';
            if (pairCountByMode[normM]) {
                pairCountByMode[normM].add(sym);
            }
        });

        // ============================================================
        // 0. CHẾ ĐỘ TREND: NẾU ĐÃ ĐẠT MAX LỆNH THÌ DỪNG QUÉT LUÔN, KHÔNG SPAM
        // ============================================================
        if (bot.botSettings.enableScanTrend && pairCountByMode['trend'].size < maxPosSetting) {
            for (const item of sharedState.topTrendList) {
                const sym = item.symbol;
                let tradeSide = null;
                if (item.isFullLong) tradeSide = 'LONG';
                else if (item.isFullShort) tradeSide = 'SHORT';

                if (tradeSide) {
                    if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym]) continue;
                    if (uniqueActiveSymbols.has(sym) || openingSymbols.has(sym) || sharedState.pendingOrders.has(sym)) continue;

                    if (exchangeSymbolsWithPosition.has(sym) && !bot.botActivePositions.has(`${sym}_LONG`) && !bot.botActivePositions.has(`${sym}_SHORT`)) {
                        continue;
                    }

                    if (Date.now() - (symbolOpenCooldown.get(sym) || 0) < 15000) continue;

                    const info = sharedState.exchangeInfo[sym];
                    if (!info) continue;

                    openingSymbols.set(sym, 'trend');
                    sharedState.pendingOrders.add(sym);
                    uniqueActiveSymbols.add(sym);
                    symbolOpenCooldown.set(sym, Date.now());

                    addBotLog(bot, `🚀 [PHÁT HIỆN TÍN HIỆU TREND] ${formatCoinName(sym)} đạt FULL 8 ĐIỀU KIỆN ${tradeSide} (${item.volatilityText})! Đang tiến hành vào lệnh...`, "open");

                    const extraLog = `| EMA(5m): ${item.ema10.toFixed(4)}/${item.ema25.toFixed(4)} | ST(1m): ${item.st1mVal.toFixed(4)} | MACD(1m): ${item.macdVal.toFixed(4)} | Vol(1m): x${item.volRatio.toFixed(1)} | Biến động: ${item.volatilityText}`;
                    const snapshot = {
                        ema10: item.ema10,
                        ema25: item.ema25,
                        st1m: item.st1mVal,
                        st3m: item.st3mVal,
                        macd: item.macdVal,
                        signal: item.signalVal,
                        volRatio: item.volRatio
                    };

                    await openPositionSingle(bot, sym, tradeSide, 'trend', extraLog, snapshot, item.volatilityText);
                    return;
                }
            }
        }

        // ==========================================
        // 1. CHẾ ĐỘ CHỌN THEO TÊN
        // ==========================================
        if (bot.botSettings.enableScanName && bot.botSettings.scanNamesInput) {
            const rawNames = bot.botSettings.scanNamesInput.split(',');
            for (let rn of rawNames) {
                let sym = rn.trim().toUpperCase();
                if (!sym) continue;
                if (!sym.endsWith('USDT') && !sym.endsWith('BUSD')) {
                    sym = sym + 'USDT';
                }
                
                if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym]) continue;
                if (uniqueActiveSymbols.has(sym) || sharedState.pendingOrders.has(sym) || openingSymbols.has(sym)) continue;

                if (exchangeSymbolsWithPosition.has(sym) && !bot.botActivePositions.has(`${sym}_LONG`) && !bot.botActivePositions.has(`${sym}_SHORT`)) {
                    continue;
                }

                if (Date.now() - (symbolOpenCooldown.get(sym) || 0) < 5000) continue;

                const info = sharedState.exchangeInfo[sym];
                if (!info) continue;

                openingSymbols.set(sym, 'name');
                sharedState.pendingOrders.add(sym);
                uniqueActiveSymbols.add(sym);
                symbolOpenCooldown.set(sym, Date.now());

                await openPositionPair(bot, sym, 'name', `| CHỌN THEO TÊN`);
                return;
            }
        }

        // ============================================================
        // 2. CHẾ ĐỘ FUNDING: ĐÃ MAX LỆNH THÌ DỪNG QUÉT KHÔNG SPAM
        // ============================================================
        if (bot.botSettings.enableScanFunding && pairCountByMode['funding'].size < maxPosSetting) {
            const minFdSetting = (bot.botSettings.minFd !== undefined ? bot.botSettings.minFd : 1.0) / 100; 
            for (const item of sharedState.topFundingList) {
                const sym = item.symbol;
                
                if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym]) continue;
                if (uniqueActiveSymbols.has(sym) || sharedState.pendingOrders.has(sym) || openingSymbols.has(sym)) continue;

                if (exchangeSymbolsWithPosition.has(sym) && !bot.botActivePositions.has(`${sym}_LONG`) && !bot.botActivePositions.has(`${sym}_SHORT`)) {
                    continue;
                }

                if (Date.now() - (symbolOpenCooldown.get(sym) || 0) < 5000) continue;
                if (item.absFunding < minFdSetting) continue;

                const info = sharedState.exchangeInfo[sym];
                if (!info) continue;

                openingSymbols.set(sym, 'funding');
                sharedState.pendingOrders.add(sym);
                uniqueActiveSymbols.add(sym);
                symbolOpenCooldown.set(sym, Date.now());

                await openPositionPair(bot, sym, 'funding', `| FUNDING: ${(item.fundingRate * 100).toFixed(4)}%`);
                return;
            }
        }

        // ============================================================
        // 3. CHẾ ĐỘ QUÉT 24H: ĐÃ MAX LỆNH THÌ DỪNG QUÉT KHÔNG SPAM
        // ============================================================
        if (bot.botSettings.enableScan24h && pairCountByMode['24h'].size < maxPosSetting) {
            const min24hSetting = bot.botSettings.min24h !== undefined ? bot.botSettings.min24h : 0.0;
            for (const item of sharedState.top24hList) {
                const sym = item.symbol;
                
                if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym]) continue;
                if (uniqueActiveSymbols.has(sym) || sharedState.pendingOrders.has(sym) || openingSymbols.has(sym)) continue;

                if (exchangeSymbolsWithPosition.has(sym) && !bot.botActivePositions.has(`${sym}_LONG`) && !bot.botActivePositions.has(`${sym}_SHORT`)) {
                    continue;
                }

                if (Date.now() - (symbolOpenCooldown.get(sym) || 0) < 5000) continue;
                if (Math.abs(item.priceChangePercent) < min24hSetting) continue;

                const info = sharedState.exchangeInfo[sym];
                if (!info) continue;

                openingSymbols.set(sym, '24h');
                sharedState.pendingOrders.add(sym);
                uniqueActiveSymbols.add(sym);
                symbolOpenCooldown.set(sym, Date.now());

                await openPositionPair(bot, sym, '24h', `| 24H CHANGE: ${item.priceChangePercent.toFixed(2)}%`);
                return;
            }
        }

        // ============================================================
        // 4. CHẾ ĐỘ QUÉT VOL: ĐÃ MAX LỆNH THÌ DỪNG QUÉT KHÔNG SPAM
        // ============================================================
        if (bot.botSettings.enableScanVol !== false && pairCountByMode['vol'].size < maxPosSetting) {
            const minScanVol = bot.botSettings.minVol || 7;
            for (const c of sharedState.candidatesList) {
                const sym = c.symbol;
                
                if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym]) continue;
                if (uniqueActiveSymbols.has(sym) || sharedState.pendingOrders.has(sym) || openingSymbols.has(sym)) continue;

                if (exchangeSymbolsWithPosition.has(sym) && !bot.botActivePositions.has(`${sym}_LONG`) && !bot.botActivePositions.has(`${sym}_SHORT`)) {
                    continue;
                }

                if (Date.now() - (symbolOpenCooldown.get(sym) || 0) < 5000) continue;

                const m1 = parseFloat(c.c1 ?? c.m1 ?? c.v1 ?? 0); 
                const m5 = parseFloat(c.c5 ?? c.m5 ?? c.v5 ?? 0); 
                const m15 = parseFloat(c.c15 ?? c.m15 ?? c.v15 ?? 0);

                let isNormal = false;
                for (const tf of SCAN_CONFIG.THUONG) {
                    const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
                    if (Math.abs(val) >= minScanVol) { isNormal = true; break; }
                }

                if (isNormal) {
                    const info = sharedState.exchangeInfo[sym];
                    if (!info) continue;

                    openingSymbols.set(sym, 'vol');
                    sharedState.pendingOrders.add(sym);
                    uniqueActiveSymbols.add(sym);
                    symbolOpenCooldown.set(sym, Date.now());

                    await openPositionPair(bot, sym, 'vol', `| M1: ${m1} M5: ${m5}`);
                    return;
                }
            }
        }
    } finally {
        isScanning = false;
    }
}, 250);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT] Đã chạy trên port ${PORT}`));
