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

// ==========================================
// TOÀN BỘ CẤU HÌNH HỆ THỐNG VÀ CHỈ BÁO TREND
// ==========================================
const PORT = 6777;
const MIN_NOTIONAL_FORCE = 5.1;
const MAX_DCA_LEVEL = 999999; 

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5']
};

const ANTI_LIQUIDATION_LIMIT = 15;
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  

export const TREND_CONFIG = {
    // Chỉ báo EMA
    EMA_FAST: 50,
    EMA_SLOW: 200,

    // Chỉ báo Supertrend
    SUPERTREND_ATR_PERIOD: 10,
    SUPERTREND_MULTIPLIER: 3.0,

    // Chỉ báo MACD
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,

    // Chỉ báo Volume & Breakout
    VOLUME_LOOKBACK: 20,
    VOLUME_MULTIPLIER: 5.0,

    // Bộ lọc chống đuổi giá
    CHASE_ATR_PERIOD: 14,
    CHASE_MAX_RATIO: 1.5,

    // Bộ lọc phát hiện Pump / Dump bất thường
    ANOMALY_MAX_CANDLE_BODY_ATR: 3.5, 
    ANOMALY_MAX_PERCENT_CHANGE: 6.0,   

    // Cấu hình các cấp độ khung thời gian
    LEVELS: {
        Small: {
            emaTf: '5m',
            volBreakoutTf: '1m',
            breakoutLookback: 10,
            macdTf: '1m',
            supertrendTf: '3m'
        },
        Mid: {
            emaTf: '1h',
            volBreakoutTf: '3m',
            breakoutLookback: 15,
            macdTf: '1m',
            supertrendTf: '15m'
        },
        High: {
            emaTf: '4h',
            volBreakoutTf: '15m',
            breakoutLookback: 20,
            macdTf: '3m',
            supertrendTf: '30m'
        }
    },

    // Quản lý dữ liệu nến và WebSocket
    KLINE_HISTORY_LIMIT: 250,
    WS_RECONNECT_INTERVAL_MS: 5000,
    DATA_STALE_TIMEOUT_MS: 30000,
    TOP_TREND_MAX_ITEMS: 10
};

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
    trendLoadingProgress: "Đang khởi tạo hệ thống...",
    trendErrorStatus: "",
    trendAnalysisLoading: true,
    wsConnected: false,
    lastWsMessageTime: 0,
    exchangeInfo: null,
    masterLogs: [],
    errorSpamGuard: {}, 
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
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam', 'enablescantrend', 'enabletptrendprice', 'enablehedgetrend', 'enablevoltrend'].includes(lowerKey)) {
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
        tpDcaDuong: 10.0, // Dùng chung cho TP DCA Dương và TP Trend % Giá
        minPnlTpDcaDuong: 10.0,

        // Cấu hình bổ sung chế độ TREND
        enableScanTrend: false,
        trendLevel: "Small", // Small, Mid, High
        enableTpTrendPrice: false,
        enableHedgeTrend: false,
        enableVolTrend: false
    },
    status: { 
        botLogs: [], 
        botClosedCount: 0, 
        botPnLClosed: 0, 
        pnlGain: 0, 
        pnlLoss: 0, 
        isReady: false,
        statsByMode: {
            vol: { open: 0, closed: 0, pnl: 0 },
            '24h': { open: 0, closed: 0, pnl: 0 },
            funding: { open: 0, closed: 0, pnl: 0 },
            name: { open: 0, closed: 0, pnl: 0 },
            trend: { open: 0, closed: 0, pnl: 0 }
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
    // DÙNG CHUNG % TP DCA DƯƠNG CHO TP TREND % GIÁ KHI BẬT
    if (b.modeName === 'trend' && botInst.botSettings.enableTpTrendPrice) {
        const tpPct = botInst.botSettings.tpDcaDuong || 10.0;
        const dir = b.side === 'LONG' ? 1 : -1;
        const targetTpPrice = b.firstEntry * (1 + dir * (tpPct / 100));
        const netDetails = getPairNetPnLDetails(botInst, b, targetTpPrice);
        return { targetTpPrice, estPnl: netDetails.pairNetPnL, badge: "✅ [TP Trend % Giá]" };
    }

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
        const errMsg = e?.response?.data?.msg || e?.message || String(e);
        addBotLog(botInst, `❌ Thất bại khi đóng vị thế sàn ${formatCoinName(b.symbol)}: ${errMsg}`, "error");
        return false;
    }
    
    if (!orderClosedSuccessfully) return false;

    try {
        await new Promise(r => setTimeout(r, 800));
        const doubleCheckRisk = await binancePrivate(botInst, '/fapi/v2/positionRisk', 'GET', { symbol: b.symbol }).catch(() => null);
        if (Array.isArray(doubleCheckRisk)) {
            const leftoverP = doubleCheckRisk.find(p => p.symbol === b.symbol && p.positionSide === b.side && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (leftoverP) {
                const leftoverQty = Math.abs(parseFloat(leftoverP.positionAmt));
                if (leftoverQty > 0) {
                    addBotLog(botInst, `⚠️ Quét phát hiện vị thế sót ${formatCoinName(b.symbol)} ${b.side} Qty: ${leftoverQty}. Đang đóng quét sạch...`, "warn");
                    await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', leftoverQty, undefined, { positionSide: b.side }).catch(() => {});
                }
            }
        }
    } catch (sweepErr) {}

    await new Promise(resolve => setTimeout(resolve, 2000));
    if (botInst.antiLiquidationCooldownUntil && Date.now() < botInst.antiLiquidationCooldownUntil) {
        return true;
    }

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

        const mode = b.modeName || 'vol';
        if (!botInst.status.statsByMode[mode]) {
            botInst.status.statsByMode[mode] = { open: 0, closed: 0, pnl: 0 };
        }
        botInst.status.statsByMode[mode].closed++;
        botInst.status.statsByMode[mode].pnl += finalPnL;

        if (finalPnL >= 0) {
            botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
        } else {
            botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
        }

        let isExplicitTP = reasonStr.includes("TP") || reasonStr.includes("TRAILING");
        let isExplicitSL = reasonStr.includes("SL") || reasonStr.includes("CẮT LỖ");

        let logType = "tp";
        let detailTag = "CHỐT LÃI TP";

        if (isExplicitSL || (!isExplicitTP && finalPnL < 0)) {
            logType = "sl";
            detailTag = "CẮT LỖ SL";
        } else if (isExplicitTP && finalPnL < 0) {
            logType = "warn";
            detailTag = "CHỐT TP SÀN/NỘI BỘ";
        }

        const formattedSymbol = formatCoinName(b.symbol);
        addBotLog(botInst, `🔒 [${detailTag} | LÝ DO: ${reasonStr}] ${formattedSymbol} ${b.side} | Chế độ: [${b.modeName || 'vol'}] | Giá chốt: ${formatPrice(markP)} | Net PnL: ${finalPnL.toFixed(2)}$`, logType);
        
    } catch (e) {
        const errMsg = e?.response?.data?.msg || e?.message || String(e);
        addBotLog(botInst, `❌ Lỗi xử lý/ghi log PnL cho ${formatCoinName(b.symbol)}: ${errMsg}`, "error");
    }

    try {
        const openOrders = await binancePrivate(botInst, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol }).catch(() => []);
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(botInst, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
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
                
                const b = botInst.botActivePositions.get(key);
                if (b) {
                    let pnlRaw = parseFloat(p.unRealizedProfit || 0);
                    const feeAndFd = calculatePositionFeeAndFunding(botInst, b, parseFloat(p.markPrice));
                    let finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);

                    sharedState.lastClosedPnl[key] = finalPnL;

                    botInst.status.botClosedCount++;
                    botInst.status.botPnLClosed += finalPnL;
                    const mode = b.modeName || 'vol';
                    if (!botInst.status.statsByMode[mode]) botInst.status.statsByMode[mode] = { open: 0, closed: 0, pnl: 0 };
                    botInst.status.statsByMode[mode].closed++;
                    botInst.status.statsByMode[mode].pnl += finalPnL;

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
        addBotLog(botInst, `⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] Đã giải phóng tài khoản ${reasonLog}.`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

// ==========================================
// THƯ VIỆN TÍNH CHỈ BÁO KỸ THUẬT NỘI BỘ
// ==========================================
class TechnicalIndicators {
    static calculateEMA(values, period) {
        if (!values || values.length < period) return null;
        const k = 2 / (period + 1);
        let ema = 0;
        for (let i = 0; i < period; i++) ema += values[i];
        ema /= period;
        for (let i = period; i < values.length; i++) {
            ema = (values[i] * k) + (ema * (1 - k));
        }
        return ema;
    }

    static calculateEMAArray(values, period) {
        if (!values || values.length < period) return [];
        const k = 2 / (period + 1);
        const emaArr = [];
        let ema = 0;
        for (let i = 0; i < period; i++) ema += values[i];
        ema /= period;
        emaArr.push({ index: period - 1, value: ema });
        for (let i = period; i < values.length; i++) {
            ema = (values[i] * k) + (ema * (1 - k));
            emaArr.push({ index: i, value: ema });
        }
        return emaArr;
    }

    static calculateATR(candles, period = 14) {
        if (!candles || candles.length <= period) return null;
        const trs = [];
        for (let i = 1; i < candles.length; i++) {
            const h = candles[i].high;
            const l = candles[i].low;
            const prevC = candles[i - 1].close;
            const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
            trs.push(tr);
        }
        if (trs.length < period) return null;
        let atr = 0;
        for (let i = 0; i < period; i++) atr += trs[i];
        atr /= period;
        for (let i = period; i < trs.length; i++) {
            atr = (atr * (period - 1) + trs[i]) / period;
        }
        return atr;
    }

    static calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (!closes || closes.length < slowPeriod + signalPeriod) return null;
        const fastEMA = this.calculateEMAArray(closes, fastPeriod);
        const slowEMA = this.calculateEMAArray(closes, slowPeriod);
        if (fastEMA.length === 0 || slowEMA.length === 0) return null;

        const slowStartIndex = slowEMA[0].index;
        const macdLines = [];
        for (let i = 0; i < slowEMA.length; i++) {
            const currIndex = slowEMA[i].index;
            const fItem = fastEMA.find(f => f.index === currIndex);
            if (fItem) {
                macdLines.push(fItem.value - slowEMA[i].value);
            }
        }
        if (macdLines.length < signalPeriod + 1) return null;

        const signalEMA = this.calculateEMAArray(macdLines, signalPeriod);
        if (signalEMA.length < 2) return null;

        const currentSignal = signalEMA[signalEMA.length - 1].value;
        const prevSignal = signalEMA[signalEMA.length - 2].value;

        const currentMacd = macdLines[macdLines.length - 1];
        const prevMacd = macdLines[macdLines.length - 2];

        const currentHist = currentMacd - currentSignal;
        const prevHist = prevMacd - prevSignal;

        return {
            macd: currentMacd,
            signal: currentSignal,
            histogram: currentHist,
            prevHistogram: prevHist
        };
    }

    static calculateSupertrend(candles, period = 10, multiplier = 3.0) {
        if (!candles || candles.length <= period) return null;
        const trs = [];
        for (let i = 1; i < candles.length; i++) {
            const h = candles[i].high;
            const l = candles[i].low;
            const prevC = candles[i - 1].close;
            trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
        }

        let atrs = [];
        let atr = 0;
        for (let i = 0; i < period; i++) atr += trs[i];
        atr /= period;
        atrs.push({ index: period, val: atr });
        for (let i = period; i < trs.length; i++) {
            atr = (atr * (period - 1) + trs[i]) / period;
            atrs.push({ index: i + 1, val: atr });
        }

        let direction = 1; 
        let supertrendVal = 0;
        let prevUpperBand = 0;
        let prevLowerBand = 0;

        for (let i = 0; i < atrs.length; i++) {
            const candleIdx = atrs[i].index;
            const c = candles[candleIdx];
            const prevCandle = candles[candleIdx - 1];
            const currentAtr = atrs[i].val;

            const hl2 = (c.high + c.low) / 2;
            let basicUpper = hl2 + (multiplier * currentAtr);
            let basicLower = hl2 - (multiplier * currentAtr);

            let upperBand = (basicUpper < prevUpperBand || prevCandle.close > prevUpperBand) ? basicUpper : prevUpperBand;
            let lowerBand = (basicLower > prevLowerBand || prevCandle.close < prevLowerBand) ? basicLower : prevLowerBand;

            if (i === 0) {
                upperBand = basicUpper;
                lowerBand = basicLower;
            }

            if (direction === 1) {
                if (c.close < lowerBand) {
                    direction = -1;
                    supertrendVal = upperBand;
                } else {
                    supertrendVal = lowerBand;
                }
            } else {
                if (c.close > upperBand) {
                    direction = 1;
                    supertrendVal = lowerBand;
                } else {
                    supertrendVal = upperBand;
                }
            }

            prevUpperBand = upperBand;
            prevLowerBand = lowerBand;
        }

        return {
            direction: direction === 1 ? 'UP' : 'DOWN',
            value: supertrendVal
        };
    }
}

// ==========================================
// QUẢN LÝ DỮ LIỆU NẾN & WEBSOCKET TREND ENGINE
// ==========================================
class TrendDataManager {
    constructor() {
        this.klineStore = new Map();
        this.ws = null;
        this.isConnecting = false;
        this.lastPing = Date.now();
    }

    getKlineKey(symbol, tf) {
        return `${symbol.toUpperCase()}_${tf}`;
    }

    getClosedCandles(symbol, tf) {
        const key = this.getKlineKey(symbol, tf);
        const data = this.klineStore.get(key) || [];
        return data.filter(c => c.isClosed);
    }

    async seedInitialCandles(symbol, tf) {
        try {
            const res = await binanceApi.get('/fapi/v1/klines', {
                params: {
                    symbol: symbol.toUpperCase(),
                    interval: tf,
                    limit: TREND_CONFIG.KLINE_HISTORY_LIMIT
                }
            });
            if (Array.isArray(res.data)) {
                const parsed = res.data.map(k => ({
                    openTime: k[0],
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[5]),
                    closeTime: k[6],
                    isClosed: true 
                }));
                if (parsed.length > 0) {
                    parsed[parsed.length - 1].isClosed = false;
                }
                const key = this.getKlineKey(symbol, tf);
                this.klineStore.set(key, parsed);
                return true;
            }
        } catch (e) {
            sharedState.trendErrorStatus = `Lỗi tải nến ${symbol} ${tf}: ${e.message}`;
            return false;
        }
        return false;
    }

    updateCandle(symbol, tf, candleData) {
        const key = this.getKlineKey(symbol, tf);
        let list = this.klineStore.get(key);
        if (!list) {
            list = [];
            this.klineStore.set(key, list);
        }

        const existingIdx = list.findIndex(c => c.openTime === candleData.openTime);
        if (existingIdx >= 0) {
            list[existingIdx] = candleData;
        } else {
            list.push(candleData);
            if (list.length > TREND_CONFIG.KLINE_HISTORY_LIMIT + 50) {
                list.shift();
            }
        }
    }

    initWebSocket(symbols, intervals) {
        if (this.isConnecting) return;
        this.isConnecting = true;

        if (this.ws) {
            try { this.ws.terminate(); } catch (e) {}
        }

        const streams = [];
        symbols.forEach(sym => {
            const sLower = sym.toLowerCase();
            intervals.forEach(tf => {
                streams.push(`${sLower}@kline_${tf}`);
            });
        });

        const chunk = streams.slice(0, 800);
        const wsUrl = `wss://fstream.binance.com/stream?streams=${chunk.join('/')}`;

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', () => {
                this.isConnecting = false;
                sharedState.wsConnected = true;
                this.lastPing = Date.now();
                sharedState.trendErrorStatus = "";
            });

            this.ws.on('message', (raw) => {
                try {
                    sharedState.lastWsMessageTime = Date.now();
                    const msg = JSON.parse(raw);
                    if (!msg.data || msg.data.e !== 'kline') return;
                    const k = msg.data.k;
                    const sym = msg.data.s;
                    const tf = k.i;
                    const candleObj = {
                        openTime: k.t,
                        open: parseFloat(k.o),
                        high: parseFloat(k.h),
                        low: parseFloat(k.l),
                        close: parseFloat(k.c),
                        volume: parseFloat(k.v),
                        closeTime: k.T,
                        isClosed: k.x
                    };
                    this.updateCandle(sym, tf, candleObj);
                } catch (err) {}
            });

            this.ws.on('error', (err) => {
                sharedState.wsConnected = false;
                sharedState.trendErrorStatus = `Lỗi WebSocket: ${err.message || 'Mất kết nối'}`;
            });

            this.ws.on('close', () => {
                sharedState.wsConnected = false;
                this.isConnecting = false;
                setTimeout(() => {
                    this.initWebSocket(symbols, intervals);
                }, TREND_CONFIG.WS_RECONNECT_INTERVAL_MS);
            });
        } catch (e) {
            this.isConnecting = false;
            sharedState.trendErrorStatus = `Lỗi khởi tạo WS: ${e.message}`;
        }
    }
}

const trendDataManager = new TrendDataManager();

// ==========================================
// TÍNH TOÁN BỘ ĐIỀU KIỆN VÀ PHÂN TÍCH TREND
// ==========================================
function evaluateTrendForSymbol(symbol, levelName) {
    const config = TREND_CONFIG.LEVELS[levelName] || TREND_CONFIG.LEVELS.Small;
    const { emaTf, volBreakoutTf, breakoutLookback, macdTf, supertrendTf } = config;

    const emaCandles = trendDataManager.getClosedCandles(symbol, emaTf);
    const volBreakoutCandles = trendDataManager.getClosedCandles(symbol, volBreakoutTf);
    const macdCandles = trendDataManager.getClosedCandles(symbol, macdTf);
    const supertrendCandles = trendDataManager.getClosedCandles(symbol, supertrendTf);

    if (emaCandles.length < TREND_CONFIG.EMA_SLOW ||
        volBreakoutCandles.length < (breakoutLookback + TREND_CONFIG.VOLUME_LOOKBACK) ||
        macdCandles.length < (TREND_CONFIG.MACD_SLOW + TREND_CONFIG.MACD_SIGNAL) ||
        supertrendCandles.length < TREND_CONFIG.SUPERTREND_ATR_PERIOD + 2) {
        return null;
    }

    const lastEmaCandle = emaCandles[emaCandles.length - 1];
    const lastSignalCandle = volBreakoutCandles[volBreakoutCandles.length - 1];
    const lastMacdCandle = macdCandles[macdCandles.length - 1];
    const lastStCandle = supertrendCandles[supertrendCandles.length - 1];

    const currentPrice = lastSignalCandle.close;

    // A. EMA 50 & 200
    const emaCloses = emaCandles.map(c => c.close);
    const ema50 = TechnicalIndicators.calculateEMA(emaCloses, TREND_CONFIG.EMA_FAST);
    const ema200 = TechnicalIndicators.calculateEMA(emaCloses, TREND_CONFIG.EMA_SLOW);

    const isEmaLong = ema50 && ema200 && (ema50 > ema200) && (lastEmaCandle.close > ema200);
    const isEmaShort = ema50 && ema200 && (ema50 < ema200) && (lastEmaCandle.close < ema200);

    const determinedSide = isEmaLong ? 'LONG' : (isEmaShort ? 'SHORT' : 'NEUTRAL');

    // B. SUPERTREND
    const stResult = TechnicalIndicators.calculateSupertrend(supertrendCandles, TREND_CONFIG.SUPERTREND_ATR_PERIOD, TREND_CONFIG.SUPERTREND_MULTIPLIER);
    let stAchieved = false;
    if (stResult) {
        if (determinedSide === 'LONG' && stResult.direction === 'UP' && lastStCandle.close > stResult.value) {
            stAchieved = true;
        } else if (determinedSide === 'SHORT' && stResult.direction === 'DOWN' && lastStCandle.close < stResult.value) {
            stAchieved = true;
        }
    }

    // C. MACD
    const macdCloses = macdCandles.map(c => c.close);
    const macdResult = TechnicalIndicators.calculateMACD(macdCloses, TREND_CONFIG.MACD_FAST, TREND_CONFIG.MACD_SLOW, TREND_CONFIG.MACD_SIGNAL);
    let macdAchieved = false;
    if (macdResult) {
        if (determinedSide === 'LONG' && macdResult.macd > macdResult.signal && macdResult.histogram > macdResult.prevHistogram) {
            macdAchieved = true;
        } else if (determinedSide === 'SHORT' && macdResult.macd < macdResult.signal && macdResult.histogram < macdResult.prevHistogram) {
            macdAchieved = true;
        }
    }

    // D. VOLUME
    const priorVols = volBreakoutCandles.slice(volBreakoutCandles.length - 1 - TREND_CONFIG.VOLUME_LOOKBACK, volBreakoutCandles.length - 1).map(c => c.volume);
    const avgVol = priorVols.length > 0 ? (priorVols.reduce((a, b) => a + b, 0) / priorVols.length) : 0;
    const currentVol = lastSignalCandle.volume;
    const volRatio = avgVol > 0 ? (currentVol / avgVol) : 0;
    const volAchieved = volRatio >= TREND_CONFIG.VOLUME_MULTIPLIER;

    // E. BREAKOUT
    const priorCandlesForBreakout = volBreakoutCandles.slice(volBreakoutCandles.length - 1 - breakoutLookback, volBreakoutCandles.length - 1);
    const highestHigh = Math.max(...priorCandlesForBreakout.map(c => c.high));
    const lowestLow = Math.min(...priorCandlesForBreakout.map(c => c.low));
    let breakoutAchieved = false;
    if (determinedSide === 'LONG' && lastSignalCandle.close > highestHigh) {
        breakoutAchieved = true;
    } else if (determinedSide === 'SHORT' && lastSignalCandle.close < lowestLow) {
        breakoutAchieved = true;
    }

    // F. CHỐNG ĐUỔI GIÁ
    const atrVal = TechnicalIndicators.calculateATR(volBreakoutCandles, TREND_CONFIG.CHASE_ATR_PERIOD);
    let chaseSafe = false;
    let chaseRatio = 0;
    if (atrVal && atrVal > 0 && ema50) {
        if (determinedSide === 'LONG') {
            chaseRatio = (currentPrice - ema50) / atrVal;
            chaseSafe = chaseRatio <= TREND_CONFIG.CHASE_MAX_RATIO;
        } else if (determinedSide === 'SHORT') {
            chaseRatio = (ema50 - currentPrice) / atrVal;
            chaseSafe = chaseRatio <= TREND_CONFIG.CHASE_MAX_RATIO;
        }
    }

    // G. PHÁT HIỆN BẤT THƯỜNG PUMP / DUMP
    const candleBody = Math.abs(lastSignalCandle.close - lastSignalCandle.open);
    const candlePct = (candleBody / lastSignalCandle.open) * 100;
    const isAnomaly = (atrVal && (candleBody / atrVal) > TREND_CONFIG.ANOMALY_MAX_CANDLE_BODY_ATR) || (candlePct > TREND_CONFIG.ANOMALY_MAX_PERCENT_CHANGE);
    const anomalyPassed = !isAnomaly;

    let score = 0;
    if (determinedSide !== 'NEUTRAL') score += 1;
    if (stAchieved) score += 1;
    if (macdAchieved) score += 1;
    if (volAchieved) score += 1;
    if (breakoutAchieved) score += 1;
    if (chaseSafe) score += 1;
    if (anomalyPassed) score += 1;

    const allConditionsPassed = (determinedSide !== 'NEUTRAL') && stAchieved && macdAchieved && volAchieved && breakoutAchieved && chaseSafe && anomalyPassed;
    const lev = sharedState.exchangeInfo?.[symbol]?.maxLeverage || 20;

    return {
        symbol,
        side: determinedSide,
        price: currentPrice,
        leverage: lev,
        levelName,
        score,
        isQualified: allConditionsPassed,
        ema: {
            fast: ema50,
            slow: ema200,
            close: lastEmaCandle.close,
            tf: emaTf,
            achieved: determinedSide !== 'NEUTRAL'
        },
        supertrend: {
            direction: stResult?.direction || '--',
            value: stResult?.value || 0,
            achieved: stAchieved,
            tf: supertrendTf
        },
        macd: {
            macd: macdResult?.macd || 0,
            signal: macdResult?.signal || 0,
            hist: macdResult?.histogram || 0,
            prevHist: macdResult?.prevHistogram || 0,
            achieved: macdAchieved,
            tf: macdTf
        },
        volume: {
            current: currentVol,
            avg: avgVol,
            ratio: volRatio,
            achieved: volAchieved,
            tf: volBreakoutTf
        },
        breakout: {
            high: highestHigh,
            low: lowestLow,
            candlesChecked: breakoutLookback,
            achieved: breakoutAchieved,
            tf: volBreakoutTf
        },
        chase: {
            atr: atrVal || 0,
            ratio: chaseRatio,
            safe: chaseSafe
        },
        anomaly: {
            passed: anomalyPassed
        }
    };
}

async function refreshAllTrendData() {
    if (!sharedState.exchangeInfo) return;
    try {
        const symbols = Object.keys(sharedState.exchangeInfo);
        const minLev = bot.botSettings.minLev !== undefined ? bot.botSettings.minLev : 50;
        const targetSymbols = symbols.filter(s => sharedState.exchangeInfo[s].maxLeverage >= minLev);

        const currentLevel = bot.botSettings.trendLevel || "Small";
        const evaluated = [];

        for (const sym of targetSymbols) {
            const ev = evaluateTrendForSymbol(sym, currentLevel);
            if (ev) evaluated.push(ev);
        }

        evaluated.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.volume.ratio !== a.volume.ratio) return b.volume.ratio - a.volume.ratio;
            return Math.abs(b.price - (b.ema.slow || 0)) - Math.abs(a.price - (a.ema.slow || 0));
        });

        sharedState.topTrendList = evaluated.slice(0, TREND_CONFIG.TOP_TREND_MAX_ITEMS);
        if (evaluated.length > 0) {
            sharedState.trendAnalysisLoading = false;
        }
    } catch (e) {
        sharedState.trendErrorStatus = `Lỗi tính Top Trend: ${e.message}`;
    }
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
                    b.peakPrice = Math.max(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((markP - currentAvgEntry) / currentAvgEntry) * 100;
                } else {
                    b.peakPrice = Math.min(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((currentAvgEntry - markP) / currentAvgEntry) * 100;
                }

                const netDetails = getPairNetPnLDetails(botInst, b, markP);
                b.peakNetPnL = Math.max(b.peakNetPnL !== undefined ? b.peakNetPnL : -999999, netDetails.pairNetPnL);

                // KIỂM TRA ĐẢO CHIỀU EMA CHO LỆNH TREND
                if (b.modeName === 'trend') {
                    const currentLevel = botInst.botSettings.trendLevel || "Small";
                    const emaTf = TREND_CONFIG.LEVELS[currentLevel]?.emaTf || '5m';
                    const closedCandles = trendDataManager.getClosedCandles(b.symbol, emaTf);
                    if (closedCandles.length >= TREND_CONFIG.EMA_SLOW) {
                        const closes = closedCandles.map(c => c.close);
                        const ema50 = TechnicalIndicators.calculateEMA(closes, TREND_CONFIG.EMA_FAST);
                        const ema200 = TechnicalIndicators.calculateEMA(closes, TREND_CONFIG.EMA_SLOW);
                        if (ema50 && ema200) {
                            const isEmaReversed = b.side === 'LONG' ? (ema50 < ema200) : (ema50 > ema200);
                            if (isEmaReversed && b.pnl > 0) {
                                queueClosePosition(botInst, b, markP, `EMA ĐẢO CHIỀU KHUNG ${emaTf.toUpperCase()} KHI PNL DƯƠNG`);
                                continue;
                            }
                        }
                    }

                    // XỬ LÝ HEDGE TREND NẾU BẬT
                    if (botInst.botSettings.enableHedgeTrend && !b.hedgeOpened) {
                        const effectiveDcaDuongPct = getEffectivePosDcaDuong(botInst, b.leverage || 50);
                        const dir = b.side === 'LONG' ? 1 : -1;
                        const distPercent = dir === 1 ? ((b.firstEntry - markP) / b.firstEntry) * 100 : ((markP - b.firstEntry) / b.firstEntry) * 100;
                        if (distPercent >= effectiveDcaDuongPct) {
                            const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                            const oppKey = `${b.symbol}_${oppSide}`;
                            if (!botInst.botActivePositions.has(oppKey) && !botInst.isProcessingDCA.has(oppKey)) {
                                b.hedgeOpened = true;
                                const hedgeMargin = (b.firstMargin || 1) * (botInst.botSettings.heSoDcaDuong || 2.0);
                                addBotLog(botInst, `🛡️ KÍCH HOẠT HEDGE TREND ${formatCoinName(b.symbol)}: Mở ${oppSide} ngược vị thế`, "warn");
                                openPosition(botInst, b.symbol, null, oppSide, null, hedgeMargin, markP, 'trend', '| HEDGE ĐỐI ỨNG');
                            }
                        }
                    }

                    // TP THEO % GIÁ TREND DÙNG CHUNG % TP DCA DƯƠNG
                    if (botInst.botSettings.enableTpTrendPrice) {
                        const tpPriceTargetPct = botInst.botSettings.tpDcaDuong || 10.0;
                        const dir = b.side === 'LONG' ? 1 : -1;
                        const targetPrice = b.firstEntry * (1 + dir * (tpPriceTargetPct / 100));
                        const hitTpPrice = dir === 1 ? (markP >= targetPrice) : (markP <= targetPrice);
                        if (hitTpPrice) {
                            queueClosePosition(botInst, b, markP, `TP TREND % GIÁ ĐẠT ${tpPriceTargetPct}%`);
                            continue;
                        }
                    }
                }

                const isTpTrendPriceActive = (b.modeName === 'trend' && botInst.botSettings.enableTpTrendPrice);

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

                let currentDcaMode = b.pnl < 0 ? 'AM' : 'DUONG';
                if (b.isLockedAm) {
                    currentDcaMode = 'AM';
                }
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

                        const reasonEarly = `CẮT LỖ SỚM DCA DƯƠNG CHẠM AVG ENTRY ${formatPrice(earlySlTarget)}`;
                        if (oppPos && !oppPos.isClosing) {
                            queueClosePairPositions(botInst, b, markP, reasonEarly, oppPos, oppPos.livePrice || markP, `CẮT LỖ SỚM THEO CẶP ${b.symbol}`);
                        } else {
                            queueClosePosition(botInst, b, markP, reasonEarly);
                        }
                        continue;
                    }
                }

                if (!isTpTrendPriceActive && currentDcaMode === 'AM') {
                    const targetTpPrice = currentAvgEntry + dir * (b.firstEntry * (tpDcaAmPct / 100));
                    const hitInternalTP = b.side === 'LONG' ? (markP >= targetTpPrice) : (markP <= targetTpPrice);
                    if (hitInternalTP && netDetails.pairNetPnL >= 0) {
                        queueClosePosition(botInst, b, markP, "CHỐT TP DCA ÂM");
                        continue;
                    }

                    if (b.side === 'SHORT') {
                        const slPhongHoPrice = b.firstEntry * 2.01;
                        if (markP >= slPhongHoPrice) {
                            queueClosePosition(botInst, b, markP, `CẮT LỖ SL PHÒNG HỘ 101% ENTRY ${formatPrice(slPhongHoPrice)}`);
                            continue;
                        }
                    }
                }

                if (!isTpTrendPriceActive && currentDcaMode === 'DUONG') {
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
                                const reasonTp = `CHỐT TP DCA DƯƠNG Lock TP: ${formatPrice(b.lockedTpPrice)} Net PnL: ${currentNetPnL.toFixed(2)}$`;
                                
                                if (botInst.botSettings.closeOppositeDcaAm && netDetails.oppPos && !netDetails.oppPos.isClosing) {
                                    queueClosePairPositions(
                                        botInst, 
                                        b, markP, reasonTp,
                                        netDetails.oppPos, netDetails.oppPos.livePrice || markP, `ĐÓNG LỆNH ÂM ĐỐI ỨNG ${b.symbol}`
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

                const isAmMode = currentDcaMode === 'AM';
                const slLimit = isAmMode 
                    ? (botInst.botSettings.posSL || 10.0) 
                    : ((b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0));

                if (netDetails.pairNetPnL <= -slLimit) {
                    const reasonSlPnL = `CẮT LỖ SL PNL CẶP Net PnL: ${netDetails.pairNetPnL.toFixed(2)}$`;
                    if (netDetails.oppPos && !netDetails.oppPos.isClosing) {
                        queueClosePairPositions(botInst, b, markP, reasonSlPnL, netDetails.oppPos, netDetails.oppPos.livePrice || markP, `CẮT LỖ SL PNL ĐỐI ỨNG ${b.symbol}`);
                    } else {
                        queueClosePosition(botInst, b, markP, reasonSlPnL);
                    }
                    continue;
                }

                if (!isTpTrendPriceActive) {
                    const isDcaCooldown = b.lastDcaTime && (now - b.lastDcaTime < 8000);
                    if (isDcaCooldown) continue;

                    if (currentDcaMode === 'AM' && !b.isClosing) {
                        const hitDcaAm = b.side === 'LONG' ? (markP <= b.nextDcaAm) : (markP >= b.nextDcaAm);
                        if (hitDcaAm && !botInst.isProcessingDCA.has(lockKey)) {
                            botInst.isProcessingDCA.add(lockKey);
                            let marginToUse = calculateDcaAmMargin(botInst, b);
                            openPosition(botInst, b.symbol, { ...b, dcaType: 'AM', margin: marginToUse }, b.side);
                            continue;
                        }
                    }

                    if (currentDcaMode === 'DUONG' && !b.isLockedAm && !b.isClosing) {
                        const hitDcaDuong = b.side === 'LONG' ? (markP >= b.nextDcaDuong) : (markP <= b.nextDcaDuong);
                        if (b.pnl > 0 && hitDcaDuong && !botInst.isProcessingDCA.has(lockKey)) {
                            botInst.isProcessingDCA.add(lockKey);
                            let marginToUse = calculateDcaDuongMargin(botInst, b);
                            openPosition(botInst, b.symbol, { ...b, dcaType: 'DUONG', margin: marginToUse }, b.side);
                            continue;
                        }
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
    
    setTimeout(() => priceMonitor(botInst), 300);
}

async function openPosition(botInst, symbol, dcaData = null, forcedSide = 'LONG', sharedQty = null, sharedMargin = null, sharedPrice = null, modeName = 'vol', extraLogInfo = '') {
    const side = forcedSide; 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    
    if (isDCA) {
        const activePos = botInst.botActivePositions.get(lockKey);
        if (!activePos || activePos.isClosing) {
            addBotLog(botInst, `⚠️ [HỦY DCA] Vị thế ${formatCoinName(symbol)} ${side} đã báo đóng, hủy lệnh DCA!`, "warn");
            botInst.isProcessingDCA.delete(lockKey);
            return;
        }
    }

    if (botInst.isProcessingDCA.has(lockKey) && !isDCA) return;
    botInst.isProcessingDCA.add(lockKey); 

    delete sharedState.lastClosedPnl[`${symbol}_LONG`];
    delete sharedState.lastClosedPnl[`${symbol}_SHORT`];
    delete sharedState.lastClosedMargin[`${symbol}_LONG`];
    delete sharedState.lastClosedMargin[`${symbol}_SHORT`];

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

        try {
            const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
            const availBal = parseFloat(acc?.availableBalance || 0);
            const reqMargin = (qty * currentPrice) / info.maxLeverage;
            if (availBal > 0 && reqMargin > availBal * 0.95) {
                const safeMargin = availBal * 0.90;
                let adjQty = (safeMargin * info.maxLeverage) / currentPrice;
                adjQty = Math.floor(adjQty / info.stepSize) * info.stepSize;
                adjQty = Number(adjQty.toFixed(info.quantityPrecision));
                if (adjQty * currentPrice >= actualMinNotional) {
                    qty = adjQty;
                } else {
                    addBotLog(botInst, `⚠️ [BỎ QUA LỆNH] Khả dụng không đủ ${availBal.toFixed(2)}$ < Margin ${reqMargin.toFixed(2)}$`, "warn");
                    return;
                }
            }
        } catch (chkErr) {}

        await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
        
        let order = null;
        try {
            order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        } catch (orderErr) {
            const errMsg = orderErr?.response?.data?.msg || orderErr?.message || String(orderErr);
            if (errMsg.includes('2019') || orderErr?.response?.data?.code === -2019) {
                qty = Math.floor((qty * 0.8) / info.stepSize) * info.stepSize;
                qty = Number(qty.toFixed(info.quantityPrecision));
                if (qty * currentPrice >= actualMinNotional) {
                    order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
                } else {
                    return;
                }
            } else {
                throw orderErr;
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

            try {
                await new Promise(r => setTimeout(r, 400));
                const posRisk = await binancePrivate(botInst, '/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => null);
                if (Array.isArray(posRisk)) {
                    const pRisk = posRisk.find(p => p.symbol === symbol && p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
                    if (pRisk && parseFloat(pRisk.entryPrice) > 0) {
                        actualFilledPrice = parseFloat(pRisk.entryPrice);
                    }
                }
            } catch (pErr) {}

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

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const posDcaAm = botInst.botSettings.posDcaAm || 3.0;
            const posDcaDuong = getEffectivePosDcaDuong(botInst, info.maxLeverage);
            const slPercent = (dcaData && dcaData.dcaType === 'AM') ? (botInst.botSettings.posSL || 10.0) : (botInst.botSettings.posSLDuong || 5.0);
            const tpDcaAmPercent = botInst.botSettings.tpDcaAm || 10.0;

            const dir = (side === 'LONG' ? 1 : -1);

            let nextDcaAm = firstE * (1 - dir * ((dcaAmCount + 1) * posDcaAm / 100));
            let nextDcaDuong = firstE * (1 + dir * ((dcaDuongCount + 1) * posDcaDuong / 100));

            let finalTP = newAvgEntry + dir * (firstE * (tpDcaAmPercent / 100));
            let finalSL = firstE * (1 - dir * (slPercent / 100));

            const nowTime = Date.now();
            
            const posData = { 
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, 
                dcaAmCount, dcaDuongCount, dcaCount: dcaAmCount + dcaDuongCount, 
                dcaType: lastDcaType, lastDcaType,
                modeName: isDCA ? dcaData.modeName : modeName,
                fundingRate: 0,
                isLockedAm: isDCA ? !!dcaData.isLockedAm : false,
                lockedTpPrice: undefined,
                hedgeOpened: false,
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

            botInst.botActivePositions.set(lockKey, posData);
            savePositionsToFile();

            const currentMode = isDCA ? dcaData.modeName : modeName;
            if (!botInst.status.statsByMode[currentMode]) {
                botInst.status.statsByMode[currentMode] = { open: 0, closed: 0, pnl: 0 };
            }
            if (!isDCA) botInst.status.statsByMode[currentMode].open++;

            const formattedSymbol = formatCoinName(symbol);
            if (!isDCA) {
                const logStr = `[MỞ ${side} | CHẾ ĐỘ: ${modeName.toUpperCase()}] ${formattedSymbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${formatPrice(newAvgEntry)} ${extraLogInfo}`;
                addBotLog(botInst, logStr, "open"); 
            } else {
                const historyPricesStr = dcaHistory.map(h => `${formatPrice(h.price)} [${Math.abs(((h.price - firstE) / firstE) * 100).toFixed(1)}% - ${(h.margin || 0).toFixed(1)}$]`).join(' ➔ ');
                const logStr = `[DCA ${dcaData.dcaType}] ${formattedSymbol} ${side} | Margin DCA: ${actualMarginUsed.toFixed(2)}$ | Tổng: ${totalMargin.toFixed(2)}$ | [ ${historyPricesStr} ]`;
                addBotLog(botInst, logStr, "dca"); 
            }
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

async function openPositionPair(botInst, symbol, modeName = 'vol', extraLogInfo = '') {
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;

    delete sharedState.lastClosedPnl[`${symbol}_LONG`];
    delete sharedState.lastClosedPnl[`${symbol}_SHORT`];
    delete sharedState.lastClosedMargin[`${symbol}_LONG`];
    delete sharedState.lastClosedMargin[`${symbol}_SHORT`];

    const currentPrice = await getCachedTickerPrice(symbol, 300).catch(() => null);
    if (!currentPrice) return;

    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

    const calcParams = async () => {
        const now = Date.now();
        if (!walletCache.data || walletCache.data.availableBalance === "0" || (now - walletCache.lastUpdate > 5000)) {
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
        if (!walletCache.data) return null;

        const snapshotAvailable = parseFloat(walletCache.data.availableBalance || 0);
        const marginSetting = botInst.botSettings.invValue || "1%";
        let calculatedMargin = 0;

        if (botInst.botSettings.enableVolTrend && modeName === 'trend') {
            let notionalVal = parseFloat(marginSetting) || 100;
            calculatedMargin = notionalVal / info.maxLeverage;
        } else {
            calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);
        }

        let desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
        let finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
        if (finalQty * currentPrice < actualMinNotional) {
            finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
        finalQty = Number(finalQty.toFixed(info.quantityPrecision));
        const finalMargin = (finalQty * currentPrice) / info.maxLeverage;
        return { finalQty, finalMargin };
    };

    const p = await calcParams();
    if (!p) return;

    await Promise.all([
        openPosition(botInst, symbol, null, 'LONG', p.finalQty, p.finalMargin, currentPrice, modeName, extraLogInfo),
        openPosition(botInst, symbol, null, 'SHORT', p.finalQty, p.finalMargin, currentPrice, modeName, extraLogInfo)
    ]);
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

    if (walletCache.data && parseFloat(walletCache.data.totalMarginBalance) > 0) {
        const availPercent = (parseFloat(walletCache.data.availableBalance) / parseFloat(walletCache.data.totalMarginBalance)) * 100;
        
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
            botInst.isMarginProtected = true; addBotLog(botInst, `⚠️ CẢNH BÁO: Khả dụng giảm dưới ${MARGIN_PROTECT_LIMIT}%. Dừng quét!`, "warn");
        } else if (botInst.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            botInst.isMarginProtected = false; addBotLog(botInst, `✅ Khả dụng phục hồi trên ${MARGIN_RECOVER_LIMIT}%. Mở lại quét.`, "open");
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
            const slPhongHoDet = calculateSlPhongHoDetails(
