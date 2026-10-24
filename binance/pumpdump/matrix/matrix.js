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
const globalStartTime = Date.now();

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5']
};

const ANTI_LIQUIDATION_LIMIT = 15;
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  

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
    exchangeInfo: null,
    masterLogs: [],
    pendingOrders: new Set(),
    lastClosedMargin: {},
    lastClosedPnl: {},
    klinesCache: {}, // Lưu trữ nến realtime qua WebSocket cho các khung 1m, 3m, 5m, 15m, 30m, 1h, 4h
    topTrendList: []
};

// Khởi tạo WebSocket kết nối kline Binance Futures để lấy dữ liệu nến realtime không qua REST API tránh rate limit
function initBinanceKlinesWebSocket() {
    const symbolsToSub = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'PEPEUSDT', 'NEARUSDT', 'RENDERUSDT', 'APTUSDT', 'ARBUSDT', 'INJUSDT', 'OPUSDT', 'TIAUSDT', 'FETUSDT', 'AGIXUSDT', 'NEIROUSDT'];
    const timeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
    
    let streams = [];
    symbolsToSub.forEach(sym => {
        timeframes.forEach(tf => {
            streams.push(`${sym.toLowerCase()}@kline_${tf}`);
        });
    });

    // Kết nối websocket theo lô (chia nhỏ nếu quá dài hoặc dùng kết nối chung)
    const wsUrl = `wss://fstream.binance.com/stream?streams=` + streams.slice(0, 100).join('/');
    const ws = new WebSocket(wsUrl);

    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.data && parsed.data.k) {
                const k = parsed.data.k;
                const sym = k.s;
                const tf = k.i;
                const key = `${sym}_${tf}`;
                
                if (!sharedState.klinesCache[key]) {
                    sharedState.klinesCache[key] = [];
                }
                
                const candleObj = {
                    time: k.t,
                    open: parseFloat(k.o),
                    high: parseFloat(k.h),
                    low: parseFloat(k.l),
                    close: parseFloat(k.c),
                    volume: parseFloat(k.v),
                    isClosed: k.x
                };

                const arr = sharedState.klinesCache[key];
                if (arr.length > 0 && arr[arr.length - 1].time === candleObj.time) {
                    arr[arr.length - 1] = candleObj;
                } else {
                    arr.push(candleObj);
                    if (arr.length > 100) arr.shift();
                }
            }
        } catch (e) {}
    });

    ws.on('error', () => {});
    ws.on('close', () => {
        setTimeout(initBinanceKlinesWebSocket, 5000);
    });
}
initBinanceKlinesWebSocket();

// Các hàm tính toán chỉ báo kỹ thuật (EMA, Supertrend, MACD, Volume, Breakout, ATR)
function calculateEMA(closes, period) {
    if (closes.length === 0) return 0;
    let k = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 1;
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        let high = candles[i].high;
        let low = candles[i].low;
        let prevClose = candles[i - 1].close;
        let tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    let atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
    return atr || 1;
}

function calculateSupertrend(candles, period = 10, multiplier = 3) {
    if (candles.length < period + 1) return { trend: 'UP', value: candles[candles.length - 1]?.close || 0 };
    let atr = calculateATR(candles, period);
    let h = candles[candles.length - 1].high;
    let l = candles[candles.length - 1].low;
    let c = candles[candles.length - 1].close;
    let basicUpper = (h + l) / 2 + multiplier * atr;
    let basicLower = (h + l) / 2 - multiplier * atr;
    let trend = c > basicLower ? 'UP' : 'DOWN';
    return { trend, value: trend === 'UP' ? basicLower : basicUpper };
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return { macd: 0, signal: 0, hist: 0, prevHist: 0 };
    let fastEma = calculateEMA(closes, fast);
    let slowEma = calculateEMA(closes, slow);
    let macdLine = fastEma - slowEma;
    let macdHistory = [];
    for (let i = slow; i < closes.length; i++) {
        let f = calculateEMA(closes.slice(0, i + 1), fast);
        let s = calculateEMA(closes.slice(0, i + 1), slow);
        macdHistory.push(f - s);
    }
    let signalLine = calculateEMA(macdHistory, signal);
    let hist = macdLine - signalLine;
    let prevHist = macdHistory.length >= 2 ? macdHistory[macdHistory.length - 2] - signalLine : hist;
    return { macd: macdLine, signal: signalLine, hist, prevHist };
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
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enablescantrend', 'tptrendprice', 'voltrend', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
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

// Factory tạo bot instance (Hỗ trợ 2 bot độc lập cho Port 6789 (Thật) và Port 6790 (Demo $10,000))
function createBotInstance(id, isDemo = false) {
    return {
        id,
        isDemo,
        startTime: Date.now(),
        botSettings: {
            isRunning: false,
            enableScanVol: true,
            enableScan24h: false,
            enableScanFunding: false,
            enableScanName: false,
            enableScanTrend: false,
            trendProfile: 'mid',
            tpTrendPrice: false,
            volTrend: false,
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
            modeStats: { trend: {opened:0, closed:0, pnl:0}, vol: {opened:0, closed:0, pnl:0}, '24h': {opened:0, closed:0, pnl:0}, fd: {opened:0, closed:0, pnl:0}, name: {opened:0, closed:0, pnl:0} }
        },
        demoWallet: {
            totalWalletBalance: 10000,
            totalMarginBalance: 10000,
            availableBalance: 10000,
            totalUnrealizedProfit: 0
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

const realBot = createBotInstance("REAL_BOT", false);
const demoBot = createBotInstance("DEMO_BOT", true);

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
    if (b.modeName === 'trend' && botInst.botSettings.tpTrendPrice) {
        // Chế độ trend với tp trend % price bật
        const firstE = b.firstEntry || b.avgEntry;
        const dir = b.side === 'LONG' ? 1 : -1;
        const tpPct = botInst.botSettings.tpDcaDuong || 10.0;
        const targetTpPrice = firstE * (1 + dir * (tpPct / 100));
        const estPnl = dir * (targetTpPrice - firstE) * b.currentQty;
        return { targetTpPrice, estPnl, badge: '🚀' };
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
let demoPositionRiskCache = { data: null, lastUpdate: 0 };

async function getCachedPositionRisk(botInst, maxAgeMs = 300) {
    if (botInst.isDemo) {
        const arr = [];
        botInst.botActivePositions.forEach(p => {
            arr.push({
                symbol: p.symbol,
                positionSide: p.side,
                positionAmt: (p.side === 'LONG' ? 1 : -1) * p.currentQty,
                entryPrice: p.avgEntry || p.firstEntry,
                markPrice: p.livePrice,
                unRealizedProfit: p.pnl,
                leverage: p.leverage
            });
        });
        return arr;
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
    
    sharedState.masterLogs.unshift({ time, msg: `[${botInst.id}] ${msg}`, type });
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    
    const consoleMsg = msg.replace(/<[^>]*>/g, '');
    console.log(`[${time}][${botInst.id}][${type.toUpperCase()}] ${consoleMsg}`);
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
                        savePositionsToFile(botInst);
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
                        savePositionsToFile(botInst);
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

    if (botInst.isDemo) {
        let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
        const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
        finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);
        
        botInst.demoWallet.availableBalance += (b.currentMargin || 0) + finalPnL;
        botInst.demoWallet.totalWalletBalance += finalPnL;
        orderClosedSuccessfully = true;
    } else {
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
    }
    
    if (!orderClosedSuccessfully) return false;

    if (!botInst.isDemo) {
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
        } catch (e) {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            const feeAndFd = calculatePositionFeeAndFunding(botInst, b, markP);
            finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);
        }
    }

    sharedState.lastClosedPnl[`${b.symbol}_${b.side}`] = finalPnL;

    botInst.status.botClosedCount++;
    botInst.status.botPnLClosed += finalPnL;

    if (finalPnL >= 0) {
        botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
    } else {
        botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
    }

    const mName = b.modeName || 'vol';
    if (botInst.status.modeStats[mName]) {
        botInst.status.modeStats[mName].closed++;
        botInst.status.modeStats[mName].pnl += finalPnL;
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
        detailTag = "CHỐT TP SÀN/NỘI BỘ (ÂM PNL)";
    }

    const formattedSymbol = formatCoinName(b.symbol);
    addBotLog(botInst, `🔒 [${detailTag} | LÝ DO: ${reasonStr}] ${formattedSymbol} ${b.side} | Chế độ: [${b.modeName || 'vol'}] | Giá chốt: ${formatPrice(markP)} | Net PnL: ${finalPnL.toFixed(2)}$`, logType);
    
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
                if (!botInst.isDemo) {
                    await botInst.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                }
                count++;
                
                const b = botInst.botActivePositions.get(key);
                if (b) {
                    let pnlRaw = parseFloat(p.unRealizedProfit || 0);
                    const feeAndFd = calculatePositionFeeAndFunding(botInst, b, parseFloat(p.markPrice));
                    let finalPnL = pnlRaw - feeAndFd.estimatedFee - (feeAndFd.accumulatedFunding < 0 ? Math.abs(feeAndFd.accumulatedFunding) : 0);

                    sharedState.lastClosedPnl[key] = finalPnL;
                    botInst.status.botClosedCount++;
                    botInst.status.botPnLClosed += finalPnL;
                    if (finalPnL >= 0) {
                        botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
                    } else {
                        botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
                    }
                }
            } catch (err) { }
        }
        botInst.botActivePositions.clear();
        savePositionsToFile(botInst);
        addBotLog(botInst, `⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] (${reasonLog}).`, "warn");
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
                    b.peakPrice = Math.max(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((markP - currentAvgEntry) / currentAvgEntry) * 100;
                } else {
                    b.peakPrice = Math.min(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((currentAvgEntry - markP) / currentAvgEntry) * 100;
                }

                const netDetails = getPairNetPnLDetails(botInst, b, markP);
                b.peakNetPnL = Math.max(b.peakNetPnL !== undefined ? b.peakNetPnL : -999999, netDetails.pairNetPnL);

                const isTrendMode = b.modeName === 'trend';

                // KIỂM TRA ĐIỀU KIỆN ĐẢO CHIỀU EMA 1H CHO CHẾ ĐỘ TREND
                if (isTrendMode) {
                    const trendProfile = botInst.botSettings.trendProfile || 'mid';
                    const emaTf = trendProfile === 'small' ? '5m' : (trendProfile === 'high' ? '4h' : '1h');
                    const klines = sharedState.klinesCache[`${b.symbol}_${emaTf}`] || [];
                    if (klines.length >= 50) {
                        const closes = klines.map(k => k.close);
                        const ema50 = calculateEMA(closes, 50);
                        const ema200 = calculateEMA(closes, 200);
                        const lastClose = closes[closes.length - 1];

                        // Nếu chưa đạt TP mà EMA nến đóng bị đảo chiều => cắt lệnh nếu PnL đã lãi & vẫn giữ lệnh nếu PnL đang âm
                        const isReversedLong = (b.side === 'LONG' && (ema50 < ema200 || lastClose < ema200));
                        const isReversedShort = (b.side === 'SHORT' && (ema50 > ema200 || lastClose > ema200));

                        if (isReversedLong || isReversedShort) {
                            if (b.pnl > 0) {
                                queueClosePosition(botInst, b, markP, `TREND REVERSAL EMA (${emaTf}) - PNL LÃI -> CẮT LỆNH`);
                                continue;
                            }
                        }
                    }
                }

                if (!isTrendMode) {
                    const totalDcaCount = (b.dcaAmCount || 0) + (b.dcaDuongCount || 0);
                    if (botInst.botSettings.lockDcaAmMode) {
                        if ((b.dcaDuongCount || 0) >= 1) {
                            const oppositeSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                            const oppKey = `${b.symbol}_${oppositeSide}`;
                            const oppPos = botInst.botActivePositions.get(oppKey);
                            if (oppPos) oppPos.isLockedAm = true;
                            if (b.pnl < 0) b.isLockedAm = true;
                        }
                        if (totalDcaCount > 1 && b.pnl < 0) b.isLockedAm = true;
                    }

                    let currentDcaMode = b.pnl < 0 ? 'AM' : 'DUONG';
                    if (b.isLockedAm) currentDcaMode = 'AM';
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
                    savePositionsToFile(botInst);

                    if (botInst.botSettings.enableEarlySL && (b.dcaDuongCount || 0) >= 1) {
                        const earlySlTarget = b.side === 'LONG' ? (currentAvgEntry + (b.firstEntry * 0.007)) : (currentAvgEntry - (b.firstEntry * 0.007));
                        const hitEarlySl = b.side === 'LONG' ? (markP <= earlySlTarget) : (markP >= earlySlTarget);
                        if (hitEarlySl) {
                            const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                            const oppKey = `${b.symbol}_${oppSide}`;
                            const oppPos = botInst.botActivePositions.get(oppKey);
                            const reasonEarly = `CẮT LỖ SỚM DCA DƯƠNG CHẠM AVG ENTRY`;
                            if (oppPos && !oppPos.isClosing) {
                                queueClosePairPositions(botInst, b, markP, reasonEarly, oppPos, oppPos.livePrice || markP, `CẮT LỖ SỚM THEO CẶP`);
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
                    }

                    if (currentDcaMode === 'DUONG') {
                        const tpDcaDuongPct = botInst.botSettings.tpDcaDuong || 10.0;
                        const minPnlHeSo = botInst.botSettings.minPnlTpDcaDuong !== undefined ? botInst.botSettings.minPnlTpDcaDuong : 10.0;
                        const firstMargin = b.firstMargin || 1;
                        const minPnlTp = firstMargin * minPnlHeSo;

                        const baseTpPrice = calculatePriceForTargetNetPnL(botInst, b, minPnlTp, markP);
                        const peak = b.peakPrice || b.firstEntry || markP;
                        const peakTpPrice = dir === 1 ? (peak * (1 - tpDcaDuongPct / 100)) : (peak * (1 + tpDcaDuongPct / 100));
                        const satisfiesPnlAndOffset = dir === 1 ? (peakTpPrice >= baseTpPrice) : (peakTpPrice <= baseTpPrice);
                        const predNetAtPeakTp = getPairNetPnLDetails(botInst, b, peakTpPrice).pairNetPnL;

                        if (b.lockedTpPrice !== undefined) {
                            const predNetAtLocked = getPairNetPnLDetails(botInst, b, b.lockedTpPrice).pairNetPnL;
                            if (predNetAtLocked < minPnlTp || !satisfiesPnlAndOffset) b.lockedTpPrice = undefined;
                        }

                        if (satisfiesPnlAndOffset && predNetAtPeakTp >= minPnlTp) {
                            if (b.lockedTpPrice === undefined) b.lockedTpPrice = peakTpPrice;
                            else {
                                if (b.side === 'LONG' && peakTpPrice > b.lockedTpPrice) b.lockedTpPrice = peakTpPrice;
                                else if (b.side === 'SHORT' && peakTpPrice < b.lockedTpPrice) b.lockedTpPrice = peakTpPrice;
                            }
                        }

                        if (b.lockedTpPrice !== undefined) {
                            const hitLockedTp = b.side === 'LONG' ? (markP <= b.lockedTpPrice) : (markP >= b.lockedTpPrice);
                            if (hitLockedTp) {
                                const currentNetPnL = netDetails.pairNetPnL;
                                if (currentNetPnL >= minPnlTp) {
                                    const reasonTp = `CHỐT TP DCA DƯƠNG (Lock TP: ${formatPrice(b.lockedTpPrice)})`;
                                    if (botInst.botSettings.closeOppositeDcaAm && netDetails.oppPos && !netDetails.oppPos.isClosing) {
                                        queueClosePairPositions(botInst, b, markP, reasonTp, netDetails.oppPos, netDetails.oppPos.livePrice || markP, `ĐÓNG LỆNH ÂM ĐỐI ỨNG`);
                                    } else {
                                        queueClosePosition(botInst, b, markP, reasonTp);
                                    }
                                    continue;
                                } else b.lockedTpPrice = undefined;
                            }
                        }
                    }

                    const slLimit = currentDcaMode === 'AM' ? (botInst.botSettings.posSL || 10.0) : ((b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0));
                    if (netDetails.pairNetPnL <= -slLimit) {
                        const reasonSlPnL = `CẮT LỖ SL PNL CẶP (${netDetails.pairNetPnL.toFixed(2)}$)`;
                        if (netDetails.oppPos && !netDetails.oppPos.isClosing) {
                            queueClosePairPositions(botInst, b, markP, reasonSlPnL, netDetails.oppPos, netDetails.oppPos.livePrice || markP, `CẮT LỖ SL PNL ĐỐI ỨNG`);
                        } else {
                            queueClosePosition(botInst, b, markP, reasonSlPnL);
                        }
                        continue;
                    }

                    const isDcaCooldown = b.lastDcaTime && (now - b.lastDcaTime < 8000);
                    if (!isDcaCooldown) {
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
                    // Logic Kiểm tra TP / SL cho chế độ Trend (không dùng DCA âm/dương)
                    const firstE = b.firstEntry || currentAvgEntry;
                    const dir = b.side === 'LONG' ? 1 : -1;
                    const tpPct = botInst.botSettings.tpDcaDuong || 10.0;
                    const slPct = botInst.botSettings.posSL || 10.0;

                    let hitTP = false;
                    let hitSL = false;

                    if (botInst.botSettings.tpTrendPrice) {
                        const targetTpPrice = firstE * (1 + dir * (tpPct / 100));
                        hitTP = b.side === 'LONG' ? (markP >= targetTpPrice) : (markP <= targetTpPrice);
                    } else {
                        // Mặc định TP theo PnL
                        hitTP = b.pnl >= (b.firstMargin * (botInst.botSettings.minPnlTpDcaDuong || 10.0));
                    }

                    const targetSlPrice = firstE * (1 - dir * (slPct / 100));
                    hitSL = b.side === 'LONG' ? (markP <= targetSlPrice) : (markP <= targetSlPrice);

                    if (hitTP) {
                        queueClosePosition(botInst, b, markP, "CHỐT TP CHẾ ĐỘ TREND");
                        continue;
                    }
                    if (hitSL || b.pnl <= -(botInst.botSettings.posSL || 10.0)) {
                        queueClosePosition(botInst, b, markP, "CẮT LỖ SL CHẾ ĐỘ TREND");
                        continue;
                    }
                }

            } else {
                if (!botInst.isProcessingDCA.has(lockKey)) {
                    botInst.botActivePositions.delete(key); 
                    savePositionsToFile(botInst);
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
            if (qty * currentPrice < actualMinNotional) {
                qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
            qty = Number(qty.toFixed(info.quantityPrecision)); 
        } else {
            currentPrice = sharedPrice;
            if (modeName === 'trend' && botInst.botSettings.volTrend) {
                // Vol trend bật: invValue là khối lượng => margin = khối lượng / max lev
                const inputVol = parseFloat(botInst.botSettings.invValue) || 1;
                qty = Math.floor(inputVol / info.stepSize) * info.stepSize;
                margin = (qty * currentPrice) / info.maxLeverage;
            } else {
                qty = sharedQty;
                margin = sharedMargin;
            }
        }

        if (botInst.isDemo) {
            if (botInst.demoWallet.availableBalance < margin) {
                botInst.isProcessingDCA.delete(lockKey);
                return;
            }
            botInst.demoWallet.availableBalance -= margin;
            botInst.demoWallet.totalMarginBalance = botInst.demoWallet.availableBalance + margin;
        } else {
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
                        botInst.isProcessingDCA.delete(lockKey);
                        return;
                    }
                }
            } catch (chkErr) {}
        }

        await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
        
        if (!botInst.isDemo) {
            await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        }
        
        let actualFilledPrice = currentPrice;
        let cumulativeQty = qty;
        let cumulativeCost = qty * actualFilledPrice;
        let newAvgEntry = actualFilledPrice;
        let actualMarginUsed = margin;
        let totalMargin = margin;
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
        }

        const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
        const nowTime = Date.now();
        
        const posData = { 
            symbol, side, entryPrice: firstE, 
            dcaAmCount, dcaDuongCount, dcaCount: dcaAmCount + dcaDuongCount, 
            dcaType: lastDcaType, lastDcaType,
            modeName: isDCA ? dcaData.modeName : modeName,
            fundingRate: 0,
            isLockedAm: isDCA ? !!dcaData.isLockedAm : false,
            lockedTpPrice: undefined,
            leverage: info.maxLeverage, firstEntry: firstE, firstMargin: isDCA ? dcaData.firstMargin : totalMargin, 
            currentMargin: totalMargin, currentQty: cumulativeQty, 
            cumulativeQty: cumulativeQty, cumulativeCost: cumulativeCost, dcaHistory: dcaHistory,
            pnl: 0, profitPercent: 0, peakPrice: actualFilledPrice,
            peakNetPnL: 0,
            avgEntry: newAvgEntry, livePrice: actualFilledPrice,
            indicatorLog: extraLogInfo,
            createdAt: dcaData ? (dcaData.createdAt || nowTime) : nowTime,
            lastActionTime: nowTime, 
            lastDcaTime: nowTime,
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
        };

        botInst.botActivePositions.set(lockKey, posData);
        savePositionsToFile(botInst);

        if (botInst.status.modeStats[modeName]) {
            botInst.status.modeStats[modeName].opened++;
        }

        const formattedSymbol = formatCoinName(symbol);
        if (!isDCA) {
            const logStr = `[MỞ ${side} | CHẾ ĐỘ: ${modeName.toUpperCase()}] ${formattedSymbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${formatPrice(newAvgEntry)} ${extraLogInfo}`;
            addBotLog(botInst, logStr, "open"); 
        } else {
            const logStr = `[DCA ${dcaData.dcaType}] ${formattedSymbol} ${side} | Tổng Margin: ${totalMargin.toFixed(2)}$`;
            addBotLog(botInst, logStr, "dca"); 
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

async function openPositionPair(botInst, symbol, modeName = 'vol', extraLogInfo = '', forcedSide = null) {
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
        let availBal = botInst.isDemo ? botInst.demoWallet.availableBalance : 0;
        if (!botInst.isDemo) {
            const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
            availBal = parseFloat(acc?.availableBalance || 0);
        }

        const marginSetting = botInst.botSettings.invValue || "1%";
        let calculatedMargin = marginSetting.toString().includes('%') ? (availBal * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

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

    if (modeName === 'trend' && forcedSide) {
        // Chế độ Trend chỉ mở 1 chiều Long hoặc Short theo tín hiệu
        await openPosition(botInst, symbol, null, forcedSide, p.finalQty, p.finalMargin, currentPrice, 'trend', extraLogInfo);
    } else {
        await Promise.all([
            openPosition(botInst, symbol, null, 'LONG', p.finalQty, p.finalMargin, currentPrice, modeName, extraLogInfo),
            openPosition(botInst, symbol, null, 'SHORT', p.finalQty, p.finalMargin, currentPrice, modeName, extraLogInfo)
        ]);
    }
}

async function checkMarginLimits(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return;
    if (botInst.isDemo) return;

    const now = Date.now();
    const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalMarginBalance = parseFloat(acc.totalMarginBalance || 0);
        const availableBalance = parseFloat(acc.availableBalance || 0);
        if (totalMarginBalance > 0) {
            const availPercent = (availableBalance / totalMarginBalance) * 100;
            if (availPercent <= ANTI_LIQUIDATION_LIMIT) { 
                if (!botInst.isAntiLiquidationTriggered) {
                    botInst.isAntiLiquidationTriggered = true;
                    botInst.antiLiquidationCooldownUntil = Date.now() + 60000;
                    await panicCloseAll(botInst, `CHỐNG THANH LÝ ${ANTI_LIQUIDATION_LIMIT}%`); 
                    botInst.isMarginProtected = false; 
                }
                return; 
            }
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

// Xây dựng response status cho từng bot instance
async function buildStatusResponse(botInst) {
    const now = Date.now();
    let walletData = {};

    if (botInst.isDemo) {
        let unrealized = 0;
        botInst.botActivePositions.forEach(p => unrealized += (p.pnl || 0));
        botInst.demoWallet.totalUnrealizedProfit = unrealized;
        botInst.demoWallet.totalMarginBalance = botInst.demoWallet.availableBalance + unrealized;
        walletData = {
            totalWalletBalance: (botInst.demoWallet.availableBalance + unrealized).toFixed(2),
            totalMarginBalance: botInst.demoWallet.totalMarginBalance.toFixed(2),
            availableBalance: botInst.demoWallet.availableBalance.toFixed(2),
            unrealizedPnL: unrealized.toFixed(2)
        };
    } else {
        const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
        walletData = {
            totalWalletBalance: parseFloat(acc?.totalWalletBalance || 0).toFixed(2),
            totalMarginBalance: parseFloat(acc?.totalMarginBalance || 0).toFixed(2),
            availableBalance: parseFloat(acc?.availableBalance || 0).toFixed(2),
            unrealizedPnL: "0.00"
        };
    }

    const posRisk = await getCachedPositionRisk(botInst, 300) || [];
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }

    let unrealizedPnL = 0;
    botInst.botActivePositions.forEach(p => { unrealizedPnL += (p.pnl || 0); });
    walletData.unrealizedPnL = unrealizedPnL.toFixed(2);

    const sortedPositions = Array.from(botInst.botActivePositions.values())
        .map(p => {
            const openDurationMs = now - (p.createdAt || now);
            const slDet = calculateSlDetails(botInst, p);
            const slPhongHoDet = calculateSlPhongHoDetails(botInst, p);
            
            let tpDet = null;
            if (p.modeName === 'trend') {
                tpDet = calculateTpDcaDuongDetails(botInst, p);
            } else if (p.pnl < 0 || p.isLockedAm) {
                tpDet = calculateTpDcaAmDetails(botInst, p);
            } else {
                tpDet = calculateTpDcaDuongDetails(botInst, p);
            }

            const nextDcaAmMargin = calculateDcaAmMargin(botInst, p);
            const nextDcaDuongMargin = calculateDcaDuongMargin(botInst, p);
            const feeAndFd = calculatePositionFeeAndFunding(botInst, p, p.livePrice || p.avgEntry);

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
                slPhongHoFormatted: slPhongHoDet.formattedStr
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
            modeStats: botInst.status.modeStats,
            candidatesList: sharedState.candidatesList,
            top24hList: filtered24h,
            topFundingList: filteredFunding,
            topTrendList: filteredTrend,
            blackList: formattedBlacklist, 
            permanentBlacklist: sharedState.permanentBlacklist, 
            exchangeInfo: sharedState.exchangeInfo, 
            timeRun: formatUptime(botInst.startTime) 
        }, 
        wallet: walletData, 
        timeRun: formatUptime(botInst.startTime)
    };
}

// Khởi tạo các ứng dụng Express cho Port 6789 và Port 6790
function setupServerApp(botInstance) {
    const app = express();
    app.use(allowCors);
    app.use(express.json());
    app.use(express.static(__dirname, { index: false }));

    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

    app.post('/api/settings', (req, res) => {
        botInstance.botSettings = parseNormalizedSettings(req.body, botInstance.botSettings);
        saveSettingsToFile(botInstance);
        updatePermanentBlacklist(botInstance);
        res.json({ success: true, msg: "Cập nhật cấu hình thành công!" });
    });

    app.get('/api/status', async (req, res) => {
        const data = await buildStatusResponse(botInstance);
        res.json(data);
    });

    app.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(botInstance, "ĐÓNG TOÀN BỘ TỪ DASHBOARD")));

    app.post('/api/close_position', async (req, res) => { 
        const { symbol, side } = req.body; 
        const key = `${symbol}_${side}`; 
        checkAndAddBlacklist(symbol);

        const b = botInstance.botActivePositions.get(key); 
        if (b) { 
            queueClosePosition(botInstance, b, b.livePrice, "ĐÓNG THỦ CÔNG");
            return res.json({ success: true }); 
        } else { 
            try { 
                const posRisk = await getCachedPositionRisk(botInstance, 0) || []; 
                const p = posRisk.find(x => x.symbol === symbol && x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0); 
                if (p && !botInstance.isDemo) await botInstance.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side }); 
                res.json({ success: true }); 
            } catch (e) { res.json({ success: false, msg: e.message }); } 
        } 
    });

    if (botInstance.isDemo) {
        app.post('/api/demo/reset_wallet', (req, res) => {
            botInstance.demoWallet.availableBalance = 10000;
            botInstance.demoWallet.totalMarginBalance = 10000;
            botInstance.demoWallet.totalUnrealizedProfit = 0;
            botInstance.botActivePositions.clear();
            savePositionsToFile(botInstance);
            res.json({ success: true, msg: "Đã reset ví giả lập về $10,000!" });
        });

        app.post('/api/demo/reset_history', (req, res) => {
            botInstance.status.botClosedCount = 0;
            botInstance.status.botPnLClosed = 0;
            botInstance.status.pnlGain = 0;
            botInstance.status.pnlLoss = 0;
            res.json({ success: true, msg: "Đã xóa lịch sử giao dịch!" });
        });
    }

    return app;
}

const app6789 = setupServerApp(realBot);
const app6790 = setupServerApp(demoBot);

app6789.listen(6789, () => console.log(`🚀 [LUFFY BOT - REAL] Đang chạy trên port 6789`));
app6790.listen(6790, () => console.log(`🚀 [LUFFY BOT - DEMO] Đang chạy trên port 6790`));

// QUÉT VÀ TÍNH TOÁN CHẾ ĐỘ TREND REALTIME CHO CẢ 2 BOT
async function scanTrendForBot(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning || !botInst.botSettings.enableScanTrend) return;
    if (botInst.isMarginProtected || botInst.isPnlPaused) return;

    const trendProfile = botInst.botSettings.trendProfile || 'mid';
    // Khung thời gian theo profile
    let emaTf = '1h', volTf = '3m', macdTimeframe = '1m', superTf = '15m', candleCount = 15;
    if (trendProfile === 'small') {
        emaTf = '5m'; volTf = '1m'; macdTimeframe = '1m'; superTf = '3m'; candleCount = 10;
    } else if (trendProfile === 'high') {
        emaTf = '4h'; volTf = '15m'; macdTimeframe = '3m'; superTf = '30m'; candleCount = 20;
    }

    if (!sharedState.exchangeInfo) return;

    const scoredSymbols = [];

    for (const symbol in sharedState.exchangeInfo) {
        if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol] || sharedState.pendingOrders.has(symbol)) continue;

        const klinesEma = sharedState.klinesCache[`${symbol}_${emaTf}`] || [];
        const klinesVol = sharedState.klinesCache[`${symbol}_${volTf}`] || [];
        const klinesSuper = sharedState.klinesCache[`${symbol}_${superTf}`] || [];
        const klinesMacd = sharedState.klinesCache[`${symbol}_${macdTimeframe}`] || [];

        if (klinesEma.length < 200 || klinesVol.length < candleCount + 5 || klinesSuper.length < 15 || klinesMacd.length < 35) continue;

        const closesEma = klinesEma.map(k => k.close);
        const ema50 = calculateEMA(closesEma, 50);
        const ema200 = calculateEMA(closesEma, 200);
        const lastCloseEma = closesEma[closesEma.length - 1];
        const currentPrice = lastCloseEma;

        // 1. EMA xác định xu hướng chính
        let isLongEma = ema50 > ema200 && lastCloseEma > ema200;
        let isShortEma = ema50 < ema200 && lastCloseEma < ema200;
        if (!isLongEma && !isShortEma) continue;
        const trendDir = isLongEma ? 'LONG' : 'SHORT';

        // 2. Supertrend xác nhận xu hướng
        const st = calculateSupertrend(klinesSuper, 10, 3);
        const isSuperValid = trendDir === 'LONG' ? (st.trend === 'UP' && currentPrice > st.value) : (st.trend === 'DOWN' && currentPrice < st.value);

        // 3. MACD xác nhận động lượng
        const closesMacd = klinesMacd.map(k => k.close);
        const macdRes = calculateMACD(closesMacd, 12, 26, 9);
        const isMacdValid = trendDir === 'LONG' ? (macdRes.macd > macdRes.signal && macdRes.hist > macdRes.prevHist) : (macdRes.macd < macdRes.signal && macdRes.hist < macdRes.prevHist);

        // 4. Volume xác nhận lực giao dịch (Volume nến tín hiệu >= 5 lần trung bình Volume các nến trước)
        const recentVolCandles = klinesVol.slice(-candleCount - 1, -1);
        const avgVol = recentVolCandles.reduce((a, b) => a + b.volume, 0) / recentVolCandles.length;
        const sigVol = klinesVol[klinesVol.length - 1].volume;
        const isVolValid = sigVol >= 5 * avgVol;

        // 5. Phá vỡ giá (Breakout) xét trên N nến đã đóng trước đó
        const pastCandles = klinesVol.slice(-candleCount - 1, -1);
        const highestHigh = Math.max(...pastCandles.map(k => k.high));
        const lowestLow = Math.min(...pastCandles.map(k => k.low));
        const isBreakoutValid = trendDir === 'LONG' ? (currentPrice > highestHigh) : (currentPrice < lowestLow);

        // 6. Chống vào lệnh quá muộn (ATR 14)
        const atr = calculateATR(klinesEma, 14);
        const distanceEma = Math.abs(currentPrice - ema50) / atr;
        const isNotLate = distanceEma <= 1.5;

        // Tính điểm số điều kiện đạt được để đưa vào bảng Top 10 Trend
        let score = 0;
        if (isLongEma || isShortEma) score++;
        if (isSuperValid) score++;
        if (isMacdValid) score++;
        if (isVolValid) score++;
        if (isBreakoutValid) score++;
        if (isNotLate) score++;

        const info = sharedState.exchangeInfo[symbol];
        const indicatorDetails = `ema50: ${formatPrice(ema50)} | ema200: ${formatPrice(ema200)} | Super: ${isSuperValid ? '✅' : '❌'} | MACD: ${isMacdValid ? '✅' : '❌'} | Vol: ${isVolValid ? '✅' : '❌'} | Break: ${isBreakoutValid ? '✅' : '❌'}`;

        scoredSymbols.push({
            symbol,
            direction: trendDir,
            score,
            leverage: info?.maxLeverage || 20,
            price: currentPrice,
            indicatorDetails,
            isAllValid: isSuperValid && isMacdValid && isVolValid && isBreakoutValid && isNotLate
        });
    }

    scoredSymbols.sort((a, b) => b.score - a.score);
    sharedState.topTrendList = scoredSymbols;

    // Tiến hành mở lệnh nếu bot đang chạy và đạt đủ điều kiện cuối cùng
    const maxPosSetting = botInst.botSettings.maxPositions || 3;
    const uniqueActiveSymbols = new Set(Array.from(botInst.botActivePositions.values()).map(p => p.symbol));

    for (const item of scoredSymbols) {
        if (!item.isAllValid) continue;
        if (uniqueActiveSymbols.has(item.symbol)) continue;
        if (botInst.botActivePositions.size >= maxPosSetting) break;

        sharedState.pendingOrders.add(item.symbol);
        setTimeout(() => sharedState.pendingOrders.delete(item.symbol), 8000);

        const extraInfo = `[TREND ${item.direction} | Profile: ${trendProfile.toUpperCase()}]`;
        await openPositionPair(botInst, item.symbol, 'trend', extraInfo, item.direction);
        break;
    }
}

// Quét các chế độ thường (Vol, 24h, Funding, Name)
async function scanNormalModesForBot(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return;
    if (botInst.isMarginProtected || botInst.isPnlPaused) return;

    const maxPosSetting = botInst.botSettings.maxPositions || 3;
    const uniqueActiveSymbols = new Set(Array.from(botInst.botActivePositions.values()).map(p => p.symbol));

    if (botInst.botSettings.enableScanName && botInst.botSettings.scanNamesInput) {
        const rawNames = botInst.botSettings.scanNamesInput.split(',');
        for (let rn of rawNames) {
            let sym = rn.trim().toUpperCase();
            if (!sym) continue;
            if (!sym.endsWith('USDT') && !sym.endsWith('BUSD')) sym = sym + 'USDT';
            if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
            if (uniqueActiveSymbols.has(sym)) continue;

            const info = sharedState.exchangeInfo[sym];
            if (!info) continue;

            sharedState.pendingOrders.add(sym);
            setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);
            await openPositionPair(botInst, sym, 'name', `| CHỌN THEO TÊN`);
            return;
        }
    }

    if (botInst.botSettings.enableScanFunding) {
        const minFdSetting = (botInst.botSettings.minFd !== undefined ? botInst.botSettings.minFd : 1.0) / 100; 
        for (const item of sharedState.topFundingList) {
            const sym = item.symbol;
            if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
            if (uniqueActiveSymbols.has(sym)) continue;
            if (item.absFunding < minFdSetting) continue;
            if (botInst.botActivePositions.size >= maxPosSetting) break;

            const info = sharedState.exchangeInfo[sym];
            if (!info) continue;

            sharedState.pendingOrders.add(sym);
            setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);
            await openPositionPair(botInst, sym, 'fd', `| FUNDING: ${(item.fundingRate * 100).toFixed(4)}%`);
            return;
        }
    }

    if (botInst.botSettings.enableScan24h) {
        const min24hSetting = botInst.botSettings.min24h !== undefined ? botInst.botSettings.min24h : 0.0;
        for (const item of sharedState.top24hList) {
            const sym = item.symbol;
            if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
            if (uniqueActiveSymbols.has(sym)) continue;
            if (Math.abs(item.priceChangePercent) < min24hSetting) continue;
            if (botInst.botActivePositions.size >= maxPosSetting) break;

            const info = sharedState.exchangeInfo[sym];
            if (!info) continue;

            sharedState.pendingOrders.add(sym);
            setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);
            await openPositionPair(botInst, sym, '24h', `| 24H CHANGE: ${item.priceChangePercent.toFixed(2)}%`);
            return;
        }
    }

    if (botInst.botSettings.enableScanVol !== false) {
        const minScanVol = botInst.botSettings.minVol || 7;
        for (const c of sharedState.candidatesList) {
            const sym = c.symbol;
            if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
            if (uniqueActiveSymbols.has(sym)) continue;
            if (botInst.botActivePositions.size >= maxPosSetting) break;

            const m1 = parseFloat(c.c1 ?? c.m1 ?? c.v1 ?? 0); 
            const m5 = parseFloat(c.c5 ?? c.m5 ?? c.v5 ?? 0); 

            let isNormal = false;
            for (const tf of SCAN_CONFIG.THUONG) {
                const val = tf === 'M1' ? m1 : m5;
                if (Math.abs(val) >= minScanVol) { isNormal = true; break; }
            }

            if (isNormal) {
                const info = sharedState.exchangeInfo[sym];
                if (!info) continue;

                sharedState.pendingOrders.add(sym);
                setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);
                await openPositionPair(botInst, sym, 'vol', `| M1: ${m1} M5: ${m5}`);
                return;
            }
        }
    }
}

// Vòng lặp quét chung cho Bot Real và Bot Demo
setInterval(async () => {
    try {
        await checkMarginLimits(realBot);
        await scanTrendForBot(realBot);
        await scanNormalModesForBot(realBot);

        await scanTrendForBot(demoBot);
        await scanNormalModesForBot(demoBot);
    } catch (e) {}
}, 200);

// Đồng bộ 24h & funding tickers toàn hệ thống
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

        const formatted24h = tickers.map(t => {
            const sym = t.symbol;
            const info = sharedState.exchangeInfo?.[sym];
            return { symbol: sym, price: parseFloat(t.lastPrice || 0), priceChangePercent: parseFloat(t.priceChangePercent || 0), leverage: info?.maxLeverage || 20 };
        });

        const formattedFunding = tickers.map(t => {
            const sym = t.symbol;
            const info = sharedState.exchangeInfo?.[sym];
            const fr = premMap[sym] || 0;
            return { symbol: sym, price: parseFloat(t.lastPrice || 0), fundingRate: fr, absFunding: Math.abs(fr), leverage: info?.maxLeverage || 20 };
        });

        formatted24h.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
        sharedState.top24hList = formatted24h;

        formattedFunding.sort((a, b) => b.absFunding - a.absFunding);
        sharedState.topFundingList = formattedFunding;
    } catch (e) {}
}, 5000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1000);

// Khởi tạo hệ thống
async function initSystem() {
    try {
        await realBot.exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(realBot, '/fapi/v1/leverageBracket');
        const temp = {};

        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol); 
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        loadSettingsFromFile(realBot);
        loadPositionsFromFile(realBot);
        loadSettingsFromFile(demoBot);
        loadPositionsFromFile(demoBot);

        updatePermanentBlacklist(realBot);
        updatePermanentBlacklist(demoBot);

        realBot.status.isReady = true;
        demoBot.status.isReady = true;

        priceMonitor(realBot);
        priceMonitor(demoBot);
    } catch (e) {
        setTimeout(initSystem, 5000);
    }
}

initSystem();
