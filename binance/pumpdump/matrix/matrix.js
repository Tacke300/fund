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
    klinesCache: {} // Klines cache từ WebSocket
};

// WebSocket kết nối klines Binance Futures
function initWebSocketKlines() {
    // Kết nối streams klines thông dụng cho các TF 1m, 3m, 5m, 15m, 30m, 1h, 4h
    // Để đơn giản và bao quát, ta lắng nghe ticker/kline chung hoặc kết nối động theo top coin
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        try {
            const arr = JSON.parse(data);
            if (Array.isArray(arr)) {
                arr.forEach(t => {
                    if (t.s && sharedState.exchangeInfo && sharedState.exchangeInfo[t.s]) {
                        if (!sharedState.klinesCache[t.s]) sharedState.klinesCache[t.s] = {};
                        sharedState.klinesCache[t.s].lastPrice = parseFloat(t.c);
                    }
                });
            }
        } catch (e) {}
    });
    ws.on('close', () => {
        setTimeout(initWebSocketKlines, 5000);
    });
}
initWebSocketKlines();

// Thuật toán tính toán chỉ báo kỹ thuật
function calculateEMA(closes, period) {
    if (closes.length < period) return null;
    let k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateATR(highs, lows, closes, period = 10) {
    if (closes.length < period + 1) return 0;
    let trs = [];
    for (let i = 1; i < closes.length; i++) {
        let hl = highs[i] - lows[i];
        let hc = Math.abs(highs[i] - closes[i - 1]);
        let lc = Math.abs(lows[i] - closes[i - 1]);
        trs.push(Math.max(hl, hc, lc));
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

function calculateSupertrend(highs, lows, closes, period = 10, multiplier = 3) {
    if (closes.length < period + 1) return { supertrend: closes[closes.length - 1], isUp: true };
    let atr = calculateATR(highs, lows, closes, period);
    let hl2 = (highs[highs.length - 1] + lows[lows.length - 1]) / 2;
    let upperBasic = hl2 + (multiplier * atr);
    let lowerBasic = hl2 - (multiplier * atr);
    let close = closes[closes.length - 1];
    let isUp = close > lowerBasic;
    return { supertrend: isUp ? lowerBasic : upperBasic, isUp };
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return { macdLine: 0, signalLine: 0, histogram: 0, prevHistogram: 0 };
    // Tính EMA fast và slow cho toàn bộ mảng
    let emaFast = [];
    let emaSlow = [];
    let kFast = 2 / (fast + 1);
    let kSlow = 2 / (slow + 1);
    
    let f = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
    let s = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
    
    emaFast.push(f);
    emaSlow.push(s);

    let macdArr = [];
    for (let i = 0; i < closes.length; i++) {
        if (i >= fast) {
            f = (closes[i] * kFast) + (f * (1 - kFast));
        }
        if (i >= slow) {
            s = (closes[i] * kSlow) + (s * (1 - kSlow));
            macdArr.push(f - s);
        }
    }

    if (macdArr.length < signal) return { macdLine: 0, signalLine: 0, histogram: 0, prevHistogram: 0 };
    let kSig = 2 / (signal + 1);
    let sig = macdArr.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
    for (let i = signal; i < macdArr.length; i++) {
        sig = (macdArr[i] * kSig) + (sig * (1 - kSig));
    }

    let macdLine = macdArr[macdArr.length - 1];
    let hist = macdLine - sig;
    let prevHist = (macdArr[macdArr.length - 2] || 0) - sig;

    return { macdLine, signalLine: sig, histogram: hist, prevHistogram: prevHist };
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
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam', 'enabletrendmode', 'enabletptrendprice', 'enablevoltrend'].includes(lowerKey)) {
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
        botSettings: {
            isRunning: false,
            enableTrendMode: false,
            trendSize: 'mid', // small, mid, high
            enableTpTrendPrice: false,
            enableVolTrend: false,
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
            minLev: 20,
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
            modeStats: { vol: {opened:0, pnl:0}, '24h': {opened:0, pnl:0}, funding: {opened:0, pnl:0}, name: {opened:0, pnl:0}, trend: {opened:0, pnl:0} }
        },
        botActivePositions: new Map(),
        isProcessingDCA: new Set(),
        logThrottle: new Map(),
        timestampOffset: 0,
        isMarginProtected: false,
        isAntiLiquidationTriggered: false,
        antiLiquidationCooldownUntil: 0,
        isPnlPaused: false,
        demoWallet: { totalWalletBalance: 10000, availableBalance: 10000, totalMarginBalance: 10000 },
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
    const totalFee = feeAndFd.estimatedFee;
    const negativeFdLoss = feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0;
    const bPnL = dirB * (currentPrice - bAvgEntry) * bQty;
    const pairNetPnL = bPnL + oppPnL - totalFee - negativeFdLoss;

    return { oppPos, oppPnL, oppQty, oppAvgEntry, oppIsOpen, fee: totalFee, fd: feeAndFd.accumulatedFunding, pairNetPnL, bQty, bAvgEntry, dirB, dirOpp };
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

function calculateSlDetails(botInst, b) {
    if (b.modeName === 'trend') {
        // Trend mode SL theo SL PnL ($) hoặc hệ số SL first margin
        const slLimit = (b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0);
        return { targetSlPrice: b.side === 'LONG' ? b.avgEntry * 0.95 : b.avgEntry * 1.05, estPnl: -slLimit, isEarlySL: false };
    }
    const isAmMode = (b.dcaType === 'AM') || (b.pnl < 0) || b.isLockedAm;
    const firstMargin = b.firstMargin || 1;
    const slLimitValue = isAmMode ? (botInst.botSettings.posSL || 10.0) : (firstMargin * (botInst.botSettings.posSLDuong || 5.0));
    const currentPrice = b.livePrice || b.avgEntry;
    const targetSlPrice = calculatePriceForTargetNetPnL(botInst, b, -slLimitValue, currentPrice);
    return { targetSlPrice, estPnl: -slLimitValue, isEarlySL: false };
}

function calculateSlPhongHoDetails(botInst, b) {
    if (b.side === 'LONG') return { formattedStr: '--' };
    const slPrice = b.firstEntry * 2.01;
    const estPnl = -1 * (slPrice - b.avgEntry) * b.currentQty;
    return { slPrice, estPnl, formattedStr: `${formatPrice(slPrice)} (${estPnl.toFixed(2)}$)` };
}

async function getCachedPositionRisk(botInst, maxAgeMs = 300) {
    if (botInst.isDemo) {
        // Trả về vị thế từ demo botActivePositions
        const arr = [];
        botInst.botActivePositions.forEach(p => {
            arr.push({
                symbol: p.symbol,
                positionSide: p.side,
                positionAmt: p.side === 'LONG' ? p.currentQty : -p.currentQty,
                entryPrice: p.avgEntry,
                markPrice: p.livePrice || p.avgEntry,
                unRealizedProfit: p.pnl || 0,
                leverage: p.leverage
            });
        });
        return arr;
    }
    try {
        const data = await binancePrivate(botInst, '/fapi/v2/positionRisk');
        if (Array.isArray(data)) return data;
    } catch (e) {}
    return [];
}

function savePositionsToFile(botInst) {
    const file = botInst.isDemo ? POSITIONS_FILE_DEMO : POSITIONS_FILE_REAL;
    try {
        const data = Array.from(botInst.botActivePositions.entries());
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
}

function loadPositionsFromFile(botInst) {
    const file = botInst.isDemo ? POSITIONS_FILE_DEMO : POSITIONS_FILE_REAL;
    try {
        if (!fs.existsSync(file)) return;
        const raw = fs.readFileSync(file, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            botInst.botActivePositions = new Map(data);
        }
    } catch (e) {}
}

function saveSettingsToFile(botInst) {
    const file = botInst.isDemo ? SETTINGS_FILE_DEMO : SETTINGS_FILE_REAL;
    try {
        fs.writeFileSync(file, JSON.stringify(botInst.botSettings, null, 2), 'utf-8');
    } catch (e) {}
}

function loadSettingsFromFile(botInst) {
    const file = botInst.isDemo ? SETTINGS_FILE_DEMO : SETTINGS_FILE_REAL;
    try {
        if (!fs.existsSync(file)) return;
        const raw = fs.readFileSync(file, 'utf-8');
        const data = JSON.parse(raw);
        if (data) {
            botInst.botSettings = parseNormalizedSettings(data, botInst.botSettings);
            updatePermanentBlacklist(botInst);
        }
    } catch (e) {}
}

function addBotLog(botInst, msg, type = 'open') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type, botId: botInst.id };
    botInst.status.botLogs.unshift(logItem);
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
}

async function binancePrivate(botInst, endpoint, method = 'GET', data = {}) {
    if (botInst.isDemo) return null;
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

// Lấy dữ liệu klines qua REST hoặc WS cache
async function getHistoricalKlines(symbol, interval, limit = 100) {
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        if (Array.isArray(res.data)) {
            return res.data.map(k => ({
                openTime: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
        }
    } catch (e) {}
    return [];
}

// Phân tích và quét tín hiệu Trend cho 1 coin dựa trên cấp độ (small, mid, high)
async function analyzeTrendForCoin(symbol, trendSize) {
    let emaTf = '1h', volTf = '3m', macd_tf = '1m', superTf = '15m', candleLimit = 15;
    if (trendSize === 'small') {
        emaTf = '5m'; volTf = '1m'; macd_tf = '1m'; superTf = '3m'; candleLimit = 10;
    } else if (trendSize === 'mid') {
        emaTf = '1h'; volTf = '3m'; macd_tf = '1m'; superTf = '15m'; candleLimit = 15;
    } else if (trendSize === 'high') {
        emaTf = '4h'; volTf = '15m'; macd_tf = '3m'; superTf = '30m'; candleLimit = 20;
    }

    const [klinesEma, klinesVol, klinesMacd, klinesSuper] = await Promise.all([
        getHistoricalKlines(symbol, emaTf, 220),
        getHistoricalKlines(symbol, volTf, 30),
        getHistoricalKlines(symbol, macd_tf, 60),
        getHistoricalKlines(symbol, superTf, 30)
    ]);

    if (klinesEma.length < 200 || klinesVol.length < 22 || klinesMacd.length < 40 || klinesSuper.length < 15) return null;

    const closesEma = klinesEma.map(k => k.close);
    const ema50 = calculateEMA(closesEma, 50);
    const ema200 = calculateEMA(closesEma, 200);
    const currentClose = closesEma[closesEma.length - 1];

    // 1. EMA Check
    let emaLong = ema50 > ema200 && currentClose > ema200;
    let emaShort = ema50 < ema200 && currentClose < ema200;
    if (!emaLong && !emaShort) return null;
    let direction = emaLong ? 'LONG' : 'SHORT';

    // 2. Supertrend Check
    const highsSup = klinesSuper.map(k => k.high);
    const lowsSup = klinesSuper.map(k => k.low);
    const closesSup = klinesSuper.map(k => k.close);
    const superRes = calculateSupertrend(highsSup, lowsSup, closesSup, 10, 3);
    let superOk = direction === 'LONG' ? superRes.isUp && currentClose > superRes.supertrend : !superRes.isUp && currentClose < superRes.supertrend;

    // 3. MACD Check
    const closesMacd = klinesMacd.map(k => k.close);
    const macdRes = calculateMACD(closesMacd, 12, 26, 9);
    let macdOk = direction === 'LONG' ? (macdRes.macdLine > macdRes.signalLine && macdRes.histogram > macdRes.prevHistogram) : (macdRes.macdLine < macdRes.signalLine && macdRes.histogram < macdRes.prevHistogram);

    // 4. Volume Check
    const vols = klinesVol.map(k => k.volume);
    const signalVol = vols[vols.length - 1];
    const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    let volOk = signalVol >= 2 * avgVol20;

    // 5. Price Breakout Check (20 closed candles before)
    const recentKlines = klinesVol.slice(-candleLimit - 1, -1);
    const highs = recentKlines.map(k => k.high);
    const lows = recentKlines.map(k => k.low);
    const highestPeak = Math.max(...highs);
    const lowestBottom = Math.min(...lows);
    let breakOk = direction === 'LONG' ? currentClose > highestPeak : currentClose < lowestBottom;

    // 6. Chống vào lệnh quá muộn (ATR 14, EMA50)
    const atrVal = calculateATR(highsSup, lowsSup, closesSup, 14);
    let chaseCheck = true;
    if (atrVal > 0) {
        let diff = direction === 'LONG' ? (currentClose - ema50) / atrVal : (ema50 - currentClose) / atrVal;
        if (diff > 1.5) chaseCheck = false;
    }

    let isValid = ema50 && ema200 && superOk && macdOk && volOk && breakOk && chaseCheck;

    return {
        symbol,
        direction,
        price: currentClose,
        ema50,
        ema200,
        superOk,
        macdOk,
        volOk,
        breakOk,
        chaseCheck,
        isValid,
        emaTf,
        superTf,
        macdTf: macd_tf,
        volTf
    };
}

// Quét toàn bộ top trend
async function scanTopTrend(botInst) {
    if (!sharedState.exchangeInfo) return [];
    const symbols = Object.keys(sharedState.exchangeInfo);
    const minLev = botInst.botSettings.minLev || 20;
    const trendSize = botInst.botSettings.trendSize || 'mid';

    let results = [];
    for (const sym of symbols) {
        if (sharedState.exchangeInfo[sym].maxLeverage < minLev) continue;
        if (sharedState.blackList[sym]) continue;
        try {
            const res = await analyzeTrendForCoin(sym, trendSize);
            if (res) {
                results.push(res);
            }
        } catch (e) {}
    }

    // Sắp xếp ưu tiên: EMA, Super, MACD, Vol
    results.sort((a, b) => {
        let scoreA = (a.ema50 ? 1 : 0) + (a.superOk ? 1 : 0) + (a.macdOk ? 1 : 0) + (a.volOk ? 1 : 0);
        let scoreB = (b.ema50 ? 1 : 0) + (b.superOk ? 1 : 0) + (b.macdOk ? 1 : 0) + (b.volOk ? 1 : 0);
        return scoreB - scoreA;
    });

    sharedState.topTrendList = results.slice(0, 10);
    return sharedState.topTrendList;
}

// Price monitor và quản lý Trend Mode
async function trendPriceMonitor(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return setTimeout(() => trendPriceMonitor(botInst), 500);

    try {
        const posRisk = await getCachedPositionRisk(botInst, 300);
        if (!posRisk) return setTimeout(() => trendPriceMonitor(botInst), 500);

        for (let [key, b] of Array.from(botInst.botActivePositions.entries())) {
            if (b.isClosing) continue;
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const markP = parseFloat(realP.markPrice);
                b.livePrice = markP;
                b.currentQty = Math.abs(parseFloat(realP.positionAmt));
                b.pnl = parseFloat(realP.unRealizedProfit);
                const currentAvg = b.avgEntry || parseFloat(realP.entryPrice);

                if (b.side === 'LONG') {
                    b.profitPercent = ((markP - currentAvg) / currentAvg) * 100;
                } else {
                    b.profitPercent = ((currentAvg - markP) / currentAvg) * 100;
                }

                // Kiểm tra điều kiện đảo chiều EMA 1h trong chế độ Trend
                if (b.modeName === 'trend') {
                    try {
                        const klines1h = await getHistoricalKlines(b.symbol, '1h', 210);
                        if (klines1h.length >= 200) {
                            const closes = klines1h.map(k => k.close);
                            const e50 = calculateEMA(closes, 50);
                            const e200 = calculateEMA(closes, 200);
                            const close1h = closes[closes.length - 1];
                            let isReversed = (b.side === 'LONG' && e50 < e200) || (b.side === 'SHORT' && e50 > e200);
                            if (isReversed) {
                                if (b.pnl > 0) {
                                    queueClosePosition(botInst, b, markP, "TREND 1H EMA ĐẢO CHIỀU & PNL DƯƠNG");
                                    continue;
                                } else {
                                    // PnL âm -> giữ lệnh
                                }
                            }
                        }
                    } catch (e) {}

                    // Kiểm tra TP theo % giá nếu bật
                    if (botInst.botSettings.enableTpTrendPrice) {
                        const tpPct = botInst.botSettings.tpDcaDuong || 10.0;
                        const hitTp = b.side === 'LONG' ? (markP >= currentAvg * (1 + tpPct/100)) : (markP <= currentAvg * (1 - tpPct/100));
                        if (hitTp && b.pnl > 0) {
                            queueClosePosition(botInst, b, markP, `TP TREND % PRICE (${tpPct}%)`);
                            continue;
                        }
                    }
                }

                // SL kiểm tra
                const slLimit = (b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0);
                if (b.pnl <= -slLimit) {
                    queueClosePosition(botInst, b, markP, `CẮT LỖ SL PNL (${b.pnl.toFixed(2)}$)`);
                    continue;
                }
            } else {
                botInst.botActivePositions.delete(key);
                savePositionsToFile(botInst);
            }
        }
    } catch (e) {}

    setTimeout(() => trendPriceMonitor(botInst), 500);
}

async function queueClosePosition(botInst, b, markP, reasonStr) {
    const key = `${b.symbol}_${b.side}`;
    if (b.isClosing) return;
    b.isClosing = true;

    try {
        if (!botInst.isDemo) {
            await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        } else {
            botInst.demoWallet.availableBalance += (b.currentMargin || 100) + b.pnl;
            botInst.demoWallet.totalWalletBalance = botInst.demoWallet.availableBalance;
        }

        botInst.botActivePositions.delete(key);
        savePositionsToFile(botInst);

        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += b.pnl;
        if (b.pnl >= 0) botInst.status.pnlGain += b.pnl;
        else botInst.status.pnlLoss += b.pnl;

        if (botInst.status.modeStats[b.modeName]) {
            botInst.status.modeStats[b.modeName].pnl += b.pnl;
        }

        addBotLog(botInst, `🔒 [ĐÓNG LỆNH | ${reasonStr}] ${formatCoinName(b.symbol)} ${b.side} | PnL: ${b.pnl.toFixed(2)}$`, b.pnl >= 0 ? 'tp' : 'sl');
    } catch (e) {
        b.isClosing = false;
    }
}

async function executeOpenPosition(botInst, symbol, side, modeName, indicatorStr, customMargin = null) {
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;
    const lockKey = `${symbol}_${side}`;
    if (botInst.isProcessingDCA.has(lockKey)) return;
    botInst.isProcessingDCA.add(lockKey);

    try {
        const currentPrice = sharedState.klinesCache[symbol]?.lastPrice || await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`).then(r => parseFloat(r.data.price));
        let margin = 100;
        let qty = 0;

        if (!botInst.isDemo) {
            const acc = await binancePrivate(botInst, '/fapi/v2/account');
            const avail = parseFloat(acc?.availableBalance || 1000);
            const marginSetting = botInst.botSettings.invValue || "1%";
            margin = marginSetting.toString().includes('%') ? (avail * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);
        } else {
            const marginSetting = botInst.botSettings.invValue || "1%";
            margin = marginSetting.toString().includes('%') ? (botInst.demoWallet.availableBalance * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);
        }

        if (botInst.botSettings.enableVolTrend && modeName === 'trend') {
            // Vol trend: lấy vốn tính là khối lượng => margin = khối lượng / max lev
            qty = margin;
            margin = (qty * currentPrice) / info.maxLeverage;
        } else {
            let desiredQty = (margin * info.maxLeverage) / currentPrice;
            qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
        }

        if (qty * currentPrice < MIN_NOTIONAL_FORCE) {
            qty = Math.ceil((MIN_NOTIONAL_FORCE / currentPrice) / info.stepSize) * info.stepSize;
        }
        qty = Number(qty.toFixed(info.quantityPrecision));

        if (!botInst.isDemo) {
            await botInst.exchange.setLeverage(info.maxLeverage, symbol);
            await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty, undefined, { positionSide: side });
        } else {
            botInst.demoWallet.availableBalance -= margin;
        }

        const now = Date.now();
        const posData = {
            symbol,
            side,
            modeName,
            leverage: info.maxLeverage,
            firstEntry: currentPrice,
            avgEntry: currentPrice,
            currentQty: qty,
            firstMargin: margin,
            currentMargin: margin,
            pnl: 0,
            livePrice: currentPrice,
            createdAt: now,
            indicatorSnapshot: indicatorStr,
            trendDirection: side
        };

        botInst.botActivePositions.set(lockKey, posData);
        savePositionsToFile(botInst);

        botInst.status.modeStats[modeName].opened++;
        addBotLog(botInst, `[MỞ ${side} | CHẾ ĐỘ: ${modeName.toUpperCase()}] ${formatCoinName(symbol)} | Margin: ${margin.toFixed(2)}$ | ${indicatorStr}`, 'open');
    } catch (e) {
    } finally {
        setTimeout(() => botInst.isProcessingDCA.delete(lockKey), 2000);
    }
}

// Main scanning loop cho Bot
async function botScanLoop(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return setTimeout(() => botScanLoop(botInst), 1000);

    try {
        const maxPos = botInst.botSettings.maxPositions || 3;
        if (botInst.botActivePositions.size >= maxPos) return setTimeout(() => botScanLoop(botInst), 2000);

        // Quét chế độ Trend nếu được bật
        if (botInst.botSettings.enableTrendMode) {
            const topTrend = await scanTopTrend(botInst);
            for (const item of topTrend) {
                if (botInst.botActivePositions.size >= maxPos) break;
                const key = `${item.symbol}_${item.direction}`;
                if (!botInst.botActivePositions.has(key) && item.isValid) {
                    const indStr = `EMA(${item.emaTf}): 50=${formatPrice(item.ema50)} 200=${formatPrice(item.ema200)}, Super: ${item.superOk}, MACD: ${item.macdOk}, Vol: ${item.volOk}`;
                    await executeOpenPosition(botInst, item.symbol, item.direction, 'trend', indStr);
                    break;
                }
            }
        }

        // Quét các chế độ cũ (Vol, 24h, Funding, Name)
        if (botInst.botSettings.enableScanVol && botInst.botActivePositions.size < maxPos) {
            for (const c of sharedState.candidatesList) {
                const sym = c.symbol;
                if (botInst.botActivePositions.has(`${sym}_LONG`) || botInst.botActivePositions.has(`${sym}_SHORT`)) continue;
                const m1 = parseFloat(c.c1 ?? c.m1 ?? c.v1 ?? 0);
                if (Math.abs(m1) >= (botInst.botSettings.minVol || 7)) {
                    await executeOpenPosition(botInst, sym, m1 > 0 ? 'LONG' : 'SHORT', 'vol', `Vol M1: ${m1}%`);
                    break;
                }
            }
        }
    } catch (e) {}

    setTimeout(() => botScanLoop(botInst), 2000);
}

// Khởi chạy server cho cả 2 Port 6789 (Real) và 6790 (Demo)
function setupAppServer(botInst, port) {
    loadSettingsFromFile(botInst);
    loadPositionsFromFile(botInst);
    updatePermanentBlacklist(botInst);
    botInst.status.isReady = true;

    trendPriceMonitor(botInst);
    botScanLoop(botInst);

    const app = express();
    app.use(express.json());
    app.use(express.static(__dirname, { index: false }));

    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

    app.get('/api/status', async (req, res) => {
        let unrealizedPnL = 0;
        botInst.botActivePositions.forEach(p => unrealizedPnL += (p.pnl || 0));

        let walletData = botInst.isDemo ? {
            totalWalletBalance: (botInst.demoWallet.totalWalletBalance + unrealizedPnL).toFixed(2),
            totalMarginBalance: botInst.demoWallet.totalMarginBalance.toFixed(2),
            availableBalance: botInst.demoWallet.availableBalance.toFixed(2)
        } : {
            totalWalletBalance: "1000.00",
            totalMarginBalance: "1000.00",
            availableBalance: "1000.00"
        };

        const sortedPositions = Array.from(botInst.botActivePositions.values()).map(p => {
            const openDurationMs = Date.now() - (p.createdAt || Date.now());
            const feeAndFd = calculatePositionFeeAndFunding(botInst, p, p.livePrice || p.avgEntry);
            const slDet = calculateSlDetails(botInst, p);
            return {
                ...p,
                estimatedFee: feeAndFd.estimatedFee,
                accumulatedFunding: feeAndFd.accumulatedFunding,
                openDurationStr: formatDuration(openDurationMs),
                tpCalculatedPrice: formatPrice(p.avgEntry * 1.05),
                tpEstimatedPnL: "+10.00$",
                slCalculatedPrice: slDet.targetSlPrice ? formatPrice(slDet.targetSlPrice) : '-',
                slEstimatedPnL: `${slDet.estPnl.toFixed(2)}$`
            };
        });

        res.json({
            botSettings: botInst.botSettings,
            activePositions: sortedPositions,
            exchangePositions: sortedPositions.map(p => ({ symbol: p.symbol, positionSide: p.side, positionAmt: p.side === 'LONG' ? p.currentQty : -p.currentQty, entryPrice: p.avgEntry, markPrice: p.livePrice, unRealizedProfit: p.pnl, leverage: p.leverage })),
            status: {
                botLogs: botInst.status.botLogs,
                botClosedCount: botInst.status.botClosedCount,
                botPnLClosed: botInst.status.botPnLClosed,
                pnlGain: botInst.status.pnlGain,
                pnlLoss: botInst.status.pnlLoss,
                isReady: botInst.status.isReady,
                modeStats: botInst.status.modeStats,
                topTrendList: sharedState.topTrendList,
                top24hList: sharedState.top24hList,
                topFundingList: sharedState.topFundingList,
                candidatesList: sharedState.candidatesList,
                blackList: sharedState.blackList,
                timeRun: formatUptime(botInst.startTime)
            },
            wallet: {
                ...walletData,
                unrealizedPnL: unrealizedPnL.toFixed(2)
            }
        });
    });

    app.post('/api/settings', (req, res) => {
        botInst.botSettings = parseNormalizedSettings(req.body, botInst.botSettings);
        saveSettingsToFile(botInst);
        updatePermanentBlacklist(botInst);
        res.json({ success: true, msg: "Cập nhật cấu hình thành công!" });
    });

    app.post('/api/close_all', async (req, res) => {
        botInst.botActivePositions.clear();
        savePositionsToFile(botInst);
        addBotLog(botInst, "⚠️ Đóng toàn bộ vị thế thủ công.", "warn");
        res.json({ success: true, count: 0 });
    });

    app.post('/api/close_position', async (req, res) => {
        const { symbol, side } = req.body;
        const key = `${symbol}_${side}`;
        const b = botInst.botActivePositions.get(key);
        if (b) {
            await queueClosePosition(botInst, b, b.livePrice, "ĐÓNG THỦ CÔNG");
        }
        res.json({ success: true });
    });

    if (botInst.isDemo) {
        app.post('/api/reset_demo', (req, res) => {
            botInst.demoWallet = { totalWalletBalance: 10000, availableBalance: 10000, totalMarginBalance: 10000 };
            botInst.botActivePositions.clear();
            botInst.status.botClosedCount = 0;
            botInst.status.botPnLClosed = 0;
            botInst.status.pnlGain = 0;
            botInst.status.pnlLoss = 0;
            savePositionsToFile(botInst);
            res.json({ success: true, msg: "Đã reset ví demo về 10,000$ thành công!" });
        });
    }

    app.listen(port, () => {
        console.log(`🚀 [LUFFY BOT ${botInst.id}] Đang chạy trên port ${port}`);
    });
}

// Khởi tạo exchange info và chạy cả 2 bot đồng thời
async function initGlobal() {
    try {
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binanceApi.get('/fapi/v1/leverageBracket').catch(() => ({ data: [] }));
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            const b = brk.data.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize || 0.001),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0),
                maxLeverage: maxLev
            };
        });
        sharedState.exchangeInfo = temp;

        // Lấy top 24h và funding định kỳ
        setInterval(async () => {
            try {
                const tRes = await binanceApi.get('/fapi/v1/ticker/24hr');
                sharedState.top24hList = tRes.data.map(t => ({
                    symbol: t.symbol,
                    price: parseFloat(t.lastPrice || 0),
                    priceChangePercent: parseFloat(t.priceChangePercent || 0),
                    leverage: sharedState.exchangeInfo[t.symbol]?.maxLeverage || 20
                })).sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
            } catch (e) {}
        }, 5000);

    } catch (e) {
        setTimeout(initGlobal, 5000);
    }
}

initGlobal();

// Khởi chạy port 6789 (Bản Thật) và port 6790 (Bản Demo $10,000)
setupAppServer(botReal, 6789);
setupAppServer(botDemo, 6790);
