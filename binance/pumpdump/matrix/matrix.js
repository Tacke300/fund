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

// ============================================================================
// 1. CẤU HÌNH HỆ THỐNG & CHỈ BÁO TREND (ĐẶT Ở ĐẦU CODE)
// ============================================================================
const PORT = 6777;
const MIN_NOTIONAL_FORCE = 5.1;
const MAX_DCA_LEVEL = 999999;

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5']
};

const ANTI_LIQUIDATION_LIMIT = 15;
const MARGIN_PROTECT_LIMIT = 65;
const MARGIN_RECOVER_LIMIT = 75;

// --- CẤU HÌNH THAM SỐ CHỈ BÁO TREND ---
const TREND_CONFIG = {
    EMA_FAST: 50,
    EMA_SLOW: 200,
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,
    SUPERTREND_ATR_PERIOD: 10,
    SUPERTREND_MULTIPLIER: 3,
    ATR_PERIOD: 14,
    CHASE_LIMIT_ATR: 1.5,
    VOL_MULTIPLIER: 5,
    VOL_AVG_PERIOD: 20, // Số nến quá khứ để tính Volume trung bình
    
    // Nến nạp ban đầu cho mỗi timeframe
    HISTORICAL_KLINE_LIMIT: 250,

    // Cảnh báo Pump/Dump bất thường
    PUMP_DUMP_WINDOW_CANDLES: 3,
    PUMP_DUMP_THRESHOLD_PCT: 5.0,

    // Cấp độ Trend & Timeframes
    LEVELS: {
        Small: {
            ema: '5m',
            volBreakout: '1m',
            breakoutLookback: 10,
            macd: '1m',
            supertrend: '3m'
        },
        Mid: {
            ema: '1h',
            volBreakout: '3m',
            breakoutLookback: 15,
            macd: '1m',
            supertrend: '15m'
        },
        High: {
            ema: '4h',
            volBreakout: '15m',
            breakoutLookback: 20,
            macd: '3m',
            supertrend: '30m'
        }
    }
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
    exchangeInfo: null,
    masterLogs: [],
    errorSpamGuard: {},
    pendingOrders: new Set(),
    lastClosedMargin: {},
    lastClosedPnl: {}
};

// ============================================================================
// 2. TÍNH TOÁN CHỈ BÁO THUẦN NODE.JS (EMA, MACD, SUPERTREND, ATR, BREAKOUT, VOLUME)
// ============================================================================
function calculateEMAValues(prices, period) {
    if (!prices || prices.length < period) return [];
    const k = 2 / (period + 1);
    let emaArray = new Array(prices.length);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    emaArray[period - 1] = sum / period;
    for (let i = period; i < prices.length; i++) {
        emaArray[i] = (prices[i] * k) + (emaArray[i - 1] * (1 - k));
    }
    return emaArray;
}

function calculateTR(high, low, prevClose) {
    return Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
    );
}

function calculateATRValues(candles, period) {
    if (!candles || candles.length < period + 1) return [];
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        trs.push(calculateTR(candles[i].high, candles[i].low, candles[i - 1].close));
    }
    let atr = new Array(candles.length);
    let sumTR = 0;
    for (let i = 0; i < period; i++) sumTR += trs[i];
    atr[period] = sumTR / period;
    for (let i = period + 1; i < candles.length; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + trs[i - 1]) / period;
    }
    return atr;
}

function calculateSupertrendValues(candles, period = 10, multiplier = 3) {
    if (!candles || candles.length < period + 1) return [];
    const atr = calculateATRValues(candles, period);
    let supertrend = new Array(candles.length);
    let direction = new Array(candles.length); // 1: LONG, -1: SHORT

    let upperBand = new Array(candles.length);
    let lowerBand = new Array(candles.length);

    for (let i = period; i < candles.length; i++) {
        const hl2 = (candles[i].high + candles[i].low) / 2;
        let basicUpper = hl2 + multiplier * atr[i];
        let basicLower = hl2 - multiplier * atr[i];

        if (i === period) {
            upperBand[i] = basicUpper;
            lowerBand[i] = basicLower;
            direction[i] = candles[i].close > upperBand[i] ? 1 : -1;
            supertrend[i] = direction[i] === 1 ? lowerBand[i] : upperBand[i];
            continue;
        }

        lowerBand[i] = (basicLower > lowerBand[i - 1] || candles[i - 1].close < lowerBand[i - 1]) ? basicLower : lowerBand[i - 1];
        upperBand[i] = (basicUpper < upperBand[i - 1] || candles[i - 1].close > upperBand[i - 1]) ? basicUpper : upperBand[i - 1];

        if (direction[i - 1] === 1) {
            direction[i] = candles[i].close < lowerBand[i] ? -1 : 1;
        } else {
            direction[i] = candles[i].close > upperBand[i] ? 1 : -1;
        }

        supertrend[i] = direction[i] === 1 ? lowerBand[i] : upperBand[i];
    }
    return { supertrend, direction };
}

function calculateMACDValues(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (!prices || prices.length < slowPeriod + signalPeriod) return null;
    const fastEMA = calculateEMAValues(prices, fastPeriod);
    const slowEMA = calculateEMAValues(prices, slowPeriod);

    let macdLine = new Array(prices.length);
    let validMACDs = [];
    let validIndices = [];

    for (let i = slowPeriod - 1; i < prices.length; i++) {
        macdLine[i] = fastEMA[i] - slowEMA[i];
        validMACDs.push(macdLine[i]);
        validIndices.push(i);
    }

    const signalEMA = calculateEMAValues(validMACDs, signalPeriod);
    let signalLine = new Array(prices.length);
    let histogram = new Array(prices.length);

    for (let k = 0; k < validIndices.length; k++) {
        const idx = validIndices[k];
        if (signalEMA[k] !== undefined) {
            signalLine[idx] = signalEMA[k];
            histogram[idx] = macdLine[idx] - signalLine[idx];
        }
    }

    return { macdLine, signalLine, histogram };
}

// ============================================================================
// 3. QUẢN LÝ DỮ LIỆU KLINE WEBSOCKET VÀ ĐỒNG BỘ REALTIME
// ============================================================================
const candleStore = new Map(); // Key: `${symbol}_${interval}` -> Array of closed candles
const candleWSConnections = new Map();

function getKlineStreamName(symbols, intervals) {
    let streams = [];
    for (let s of symbols) {
        for (let tf of intervals) {
            streams.push(`${s.toLowerCase()}@kline_${tf}`);
        }
    }
    return streams;
}

class TrendDataManager {
    constructor() {
        this.ws = null;
        this.isInitializing = false;
        this.isReady = false;
        this.lastWsActivity = Date.now();
        this.staleTimeout = 30000;
        this.symbols = [];
        this.allTimeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
    }

    async initHistoricalData(symbols) {
        this.symbols = symbols;
        this.isInitializing = true;
        this.isReady = false;

        const totalTasks = symbols.length * this.allTimeframes.length;
        let completed = 0;

        // Tải lịch sử song song từng đợt
        const batchSize = 10;
        for (let i = 0; i < symbols.length; i += batchSize) {
            const symbolBatch = symbols.slice(i, i + batchSize);
            await Promise.all(symbolBatch.map(async (sym) => {
                for (let tf of this.allTimeframes) {
                    try {
                        const res = await binanceApi.get(`/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${TREND_CONFIG.HISTORICAL_KLINE_LIMIT}`);
                        if (Array.isArray(res.data)) {
                            const candles = res.data.map(k => ({
                                openTime: k[0],
                                open: parseFloat(k[1]),
                                high: parseFloat(k[2]),
                                low: parseFloat(k[3]),
                                close: parseFloat(k[4]),
                                volume: parseFloat(k[5]),
                                closeTime: k[6],
                                isClosed: true
                            }));
                            // Nến cuối cùng có thể chưa đóng
                            if (candles.length > 0) candles.pop();
                            candleStore.set(`${sym}_${tf}`, candles);
                        }
                    } catch (e) {}
                    completed++;
                }
            }));
        }

        this.isInitializing = false;
        this.isReady = true;
        this.startWebSocketStreams();
    }

    startWebSocketStreams() {
        if (this.ws) {
            try { this.ws.close(); } catch(e){}
        }

        // Tạo Combined Streams cho tất cả Top Symbols
        const topSymbols = this.symbols.slice(0, 50); // Giới hạn stream cho 50 coin đầu
        const streams = getKlineStreamName(topSymbols, ['1m', '3m', '5m', '15m', '30m', '1h', '4h']);
        const wsUrl = `wss://fstream.binance.com/stream?streams=${streams.join('/')}`;

        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
            this.lastWsActivity = Date.now();
        });

        this.ws.on('message', (data) => {
            this.lastWsActivity = Date.now();
            try {
                const parsed = JSON.parse(data);
                if (!parsed.data || !parsed.data.k) return;
                const k = parsed.data.k;
                const sym = k.s;
                const tf = k.i;
                const isClosed = k.x;

                const storeKey = `${sym}_${tf}`;
                let store = candleStore.get(storeKey) || [];

                const candleObj = {
                    openTime: k.t,
                    open: parseFloat(k.o),
                    high: parseFloat(k.h),
                    low: parseFloat(k.l),
                    close: parseFloat(k.c),
                    volume: parseFloat(k.v),
                    closeTime: k.T,
                    isClosed: isClosed
                };

                if (isClosed) {
                    const lastIdx = store.length - 1;
                    if (lastIdx >= 0 && store[lastIdx].openTime === k.t) {
                        store[lastIdx] = candleObj;
                    } else {
                        store.push(candleObj);
                        if (store.length > TREND_CONFIG.HISTORICAL_KLINE_LIMIT) store.shift();
                    }
                    candleStore.set(storeKey, store);
                }
            } catch (e) {}
        });

        this.ws.on('error', () => {
            setTimeout(() => this.startWebSocketStreams(), 5000);
        });

        this.ws.on('close', () => {
            setTimeout(() => this.startWebSocketStreams(), 5000);
        });
    }

    checkWsHealth() {
        if (Date.now() - this.lastWsActivity > this.staleTimeout && this.isReady) {
            this.startWebSocketStreams();
        }
    }
}

const trendDataManager = new TrendDataManager();

// ============================================================================
// 4. BỘ TÍNH TOÁN VÀ ĐÁNH GIÁ TÍN HIỆU TREND TỔNG HỢP
// ============================================================================
function evaluateTrendConditions(symbol, levelName) {
    const levelCfg = TREND_CONFIG.LEVELS[levelName] || TREND_CONFIG.LEVELS.Small;
    
    const emaStore = candleStore.get(`${symbol}_${levelCfg.ema}`);
    const volBreakoutStore = candleStore.get(`${symbol}_${levelCfg.volBreakout}`);
    const macdStore = candleStore.get(`${symbol}_${levelCfg.macd}`);
    const supertrendStore = candleStore.get(`${symbol}_${levelCfg.supertrend}`);

    if (!emaStore || emaStore.length < TREND_CONFIG.EMA_SLOW ||
        !volBreakoutStore || volBreakoutStore.length < levelCfg.breakoutLookback + 1 ||
        !macdStore || macdStore.length < TREND_CONFIG.MACD_SLOW + TREND_CONFIG.MACD_SIGNAL ||
        !supertrendStore || supertrendStore.length < TREND_CONFIG.SUPERTREND_ATR_PERIOD + 1) {
        return { isReady: false, reason: "Đang tải dữ liệu nến chỉ báo" };
    }

    // 1. EMA (Timeframe EMA)
    const emaCloses = emaStore.map(c => c.close);
    const ema50Arr = calculateEMAValues(emaCloses, TREND_CONFIG.EMA_FAST);
    const ema200Arr = calculateEMAValues(emaCloses, TREND_CONFIG.EMA_SLOW);

    const lastEmaIdx = emaStore.length - 1;
    const ema50 = ema50Arr[lastEmaIdx];
    const ema200 = ema200Arr[lastEmaIdx];
    const emaClosePrice = emaCloses[lastEmaIdx];

    const emaLong = (ema50 > ema200) && (emaClosePrice > ema200);
    const emaShort = (ema50 < ema200) && (emaClosePrice < ema200);

    // 2. Supertrend (Timeframe Supertrend)
    const stResult = calculateSupertrendValues(supertrendStore, TREND_CONFIG.SUPERTREND_ATR_PERIOD, TREND_CONFIG.SUPERTREND_MULTIPLIER);
    const lastStIdx = supertrendStore.length - 1;
    const stValue = stResult.supertrend[lastStIdx];
    const stDir = stResult.direction[lastStIdx]; // 1: Up, -1: Down
    const stClosePrice = supertrendStore[lastStIdx].close;

    const stLong = (stDir === 1) && (stClosePrice > stValue);
    const stShort = (stDir === -1) && (stClosePrice < stValue);

    // 3. MACD (Timeframe MACD)
    const macdCloses = macdStore.map(c => c.close);
    const macdRes = calculateMACDValues(macdCloses, TREND_CONFIG.MACD_FAST, TREND_CONFIG.MACD_SLOW, TREND_CONFIG.MACD_SIGNAL);
    const lastMacdIdx = macdStore.length - 1;

    const macdLine = macdRes ? macdRes.macdLine[lastMacdIdx] : 0;
    const signalLine = macdRes ? macdRes.signalLine[lastMacdIdx] : 0;
    const histCurr = macdRes ? macdRes.histogram[lastMacdIdx] : 0;
    const histPrev = macdRes ? macdRes.histogram[lastMacdIdx - 1] : 0;

    const macdLong = (macdLine > signalLine) && (histCurr > histPrev);
    const macdShort = (macdLine < signalLine) && (histCurr < histPrev);

    // 4. Volume (Timeframe Vol/Breakout)
    const lastVolIdx = volBreakoutStore.length - 1;
    const currVol = volBreakoutStore[lastVolIdx].volume;
    
    let sumPastVol = 0;
    const volAvgPeriod = Math.min(TREND_CONFIG.VOL_AVG_PERIOD, lastVolIdx);
    for (let i = lastVolIdx - volAvgPeriod; i < lastVolIdx; i++) {
        sumPastVol += volBreakoutStore[i].volume;
    }
    const avgVol = sumPastVol / volAvgPeriod;
    const volRatio = avgVol > 0 ? (currVol / avgVol) : 0;
    const volPass = volRatio >= TREND_CONFIG.VOL_MULTIPLIER;

    // 5. Breakout (Timeframe Vol/Breakout)
    const N = levelCfg.breakoutLookback;
    let highestPast = -Infinity;
    let lowestPast = Infinity;

    for (let i = lastVolIdx - N; i < lastVolIdx; i++) {
        if (volBreakoutStore[i].high > highestPast) highestPast = volBreakoutStore[i].high;
        if (volBreakoutStore[i].low < lowestPast) lowestPast = volBreakoutStore[i].low;
    }

    const currClose = volBreakoutStore[lastVolIdx].close;
    const breakoutLong = currClose > highestPast;
    const breakoutShort = currClose < lowestPast;

    // 6. Chống đuổi giá (ATR14 & EMA50)
    const atr14Arr = calculateATRValues(volBreakoutStore, TREND_CONFIG.ATR_PERIOD);
    const atr14Val = atr14Arr[lastVolIdx] || 1;
    const chaseDistanceAtr = Math.abs(currClose - ema50) / atr14Val;
    const antiChasePass = chaseDistanceAtr <= TREND_CONFIG.CHASE_LIMIT_ATR;

    // 7. Cảnh báo Pump/Dump bất thường
    let isPumpDumpWarning = false;
    const pdWindow = TREND_CONFIG.PUMP_DUMP_WINDOW_CANDLES;
    if (volBreakoutStore.length > pdWindow) {
        const startPrice = volBreakoutStore[volBreakoutStore.length - 1 - pdWindow].open;
        const endPrice = volBreakoutStore[volBreakoutStore.length - 1].close;
        const changePct = Math.abs((endPrice - startPrice) / startPrice) * 100;
        if (changePct >= TREND_CONFIG.PUMP_DUMP_THRESHOLD_PCT) {
            isPumpDumpWarning = true;
        }
    }

    // ĐIỀU KIỆN CUỐI CÙNG
    const finalLong = emaLong && stLong && macdLong && volPass && breakoutLong && antiChasePass && !isPumpDumpWarning;
    const finalShort = emaShort && stShort && macdShort && volPass && breakoutShort && antiChasePass && !isPumpDumpWarning;

    // Đánh giá điểm tổng hợp (số điều kiện đạt)
    let longScore = 0;
    if (emaLong) longScore++;
    if (stLong) longScore++;
    if (macdLong) longScore++;
    if (volPass) longScore++;
    if (breakoutLong) longScore++;
    if (antiChasePass) longScore++;

    let shortScore = 0;
    if (emaShort) shortScore++;
    if (stShort) shortScore++;
    if (macdShort) shortScore++;
    if (volPass) shortScore++;
    if (breakoutShort) shortScore++;
    if (antiChasePass) shortScore++;

    const side = emaLong ? 'LONG' : (emaShort ? 'SHORT' : (longScore >= shortScore ? 'LONG' : 'SHORT'));
    const totalScore = side === 'LONG' ? longScore : shortScore;

    return {
        isReady: true,
        side,
        totalScore,
        finalSignal: side === 'LONG' ? finalLong : finalShort,
        currentPrice: currClose,
        ema50,
        ema200,
        emaClosePrice,
        emaTimeframe: levelCfg.ema,
        emaPass: side === 'LONG' ? emaLong : emaShort,
        stDirection: stDir === 1 ? 'UP' : 'DOWN',
        stValue,
        stPass: side === 'LONG' ? stLong : stShort,
        stTimeframe: levelCfg.supertrend,
        macdLine,
        signalLine,
        histCurr,
        histPrev,
        macdPass: side === 'LONG' ? macdLong : macdShort,
        macdTimeframe: levelCfg.macd,
        currVol,
        avgVol,
        volRatio,
        volPass,
        breakoutHigh: highestPast,
        breakoutLow: lowestPast,
        breakoutLookback: N,
        breakoutPass: side === 'LONG' ? breakoutLong : breakoutShort,
        breakoutTimeframe: levelCfg.volBreakout,
        atr14: atr14Val,
        chaseDistanceAtr,
        antiChasePass,
        isPumpDumpWarning
    };
}

function computeTop10TrendList(levelName, minLev = 20) {
    if (!trendDataManager.isReady) return { isReady: false, list: [] };

    const results = [];
    const symbols = Object.keys(sharedState.exchangeInfo || {});

    for (let sym of symbols) {
        const info = sharedState.exchangeInfo[sym];
        if (!info || info.maxLeverage < minLev) continue;

        const evalRes = evaluateTrendConditions(sym, levelName);
        if (!evalRes.isReady) continue;

        results.push({
            symbol: sym,
            leverage: info.maxLeverage,
            ...evalRes
        });
    }

    // Sắp xếp ưu tiên: Điểm tổng hợp cao nhất -> Tỷ lệ Volume lớn nhất -> Tỷ lệ khoảng cách ATR nhỏ nhất
    results.sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        if (b.volRatio !== a.volRatio) return b.volRatio - a.volRatio;
        return a.chaseDistanceAtr - b.chaseDistanceAtr;
    });

    return { isReady: true, list: results.slice(0, 10) };
}

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalized = { ...currentSettings };
    for (let key in reqBody) {
        const val = reqBody[key];
        const lowerKey = key.toLowerCase();
        if (['minvol', 'possl', 'posslduong', 'posdcaam', 'posdcaduong', 'hesodcaam', 'hesodcaduong', 'tpdcaam', 'tpdcaduong', 'minpnltpdcaduong', 'minfd', 'min24h', 'tptrendpct'].includes(lowerKey)) {
            normalized[key] = parseFloat(val);
        } else if (['maxpositions', 'minlev'].includes(lowerKey)) {
            normalized[key] = parseInt(val);
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam', 'enabletrendmode', 'tptrendpctenabled', 'hedgetrendenabled', 'voltrendenabled'].includes(lowerKey)) {
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
        tpDcaDuong: 10.0,
        minPnlTpDcaDuong: 10.0,

        // Cấu hình chế độ Trend mới
        enableTrendMode: false,
        trendLevel: "Small", // Small, Mid, High
        tpTrendPctEnabled: false,
        tpTrendPct: 2.0,
        hedgeTrendEnabled: false,
        volTrendEnabled: false
    },
    status: {
        botLogs: [],
        botClosedCount: 0,
        botPnLClosed: 0,
        pnlGain: 0,
        pnlLoss: 0,
        trendClosedCount: 0,
        trendPnLClosed: 0,
        trendPnlGain: 0,
        trendPnlLoss: 0,
        isReady: false
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
                    addBotLog(botInst, `⚠️ [QUÉT VỊ THẾ SÓT] Phát hiện vị thế sót ${formatCoinName(b.symbol)} ${b.side} (Qty: ${leftoverQty}). Đang đóng quét sạch...`, "warn");
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

        const isTrendPos = b.modeName === 'trend';
        if (isTrendPos) {
            botInst.status.trendClosedCount = (botInst.status.trendClosedCount || 0) + 1;
            botInst.status.trendPnLClosed = (botInst.status.trendPnLClosed || 0) + finalPnL;
            if (finalPnL >= 0) {
                botInst.status.trendPnlGain = (botInst.status.trendPnlGain || 0) + finalPnL;
            } else {
                botInst.status.trendPnlLoss = (botInst.status.trendPnlLoss || 0) + finalPnL;
            }
        } else {
            botInst.status.botClosedCount++;
            botInst.status.botPnLClosed += finalPnL;
            if (finalPnL >= 0) {
                botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
            } else {
                botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
            }
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
            detailTag = "CHỐT TP SÀN/NỘI BỘ (ÂM PNL DO PHÍ & FD)";
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

                    if (b.modeName === 'trend') {
                        botInst.status.trendClosedCount = (botInst.status.trendClosedCount || 0) + 1;
                        botInst.status.trendPnLClosed = (botInst.status.trendPnLClosed || 0) + finalPnL;
                    } else {
                        botInst.status.botClosedCount++;
                        botInst.status.botPnLClosed += finalPnL;
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

// ============================================================================
// 5. GIÁM SÁT VỊ THẾ & XỬ LÝ LỆNH TREND (EMA REVERSAL, TP TREND %, HEDGE TREND)
// ============================================================================
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

                // --- QUẢN LÝ RIÊNG CHO VỊ THẾ CHẾ ĐỘ TREND ---
                if (b.modeName === 'trend') {
                    const currentLevel = botInst.botSettings.trendLevel || 'Small';
                    const trendEval = evaluateTrendConditions(b.symbol, currentLevel);

                    // 1. Kiểm tra EMA đảo chiều
                    if (trendEval.isReady) {
                        const emaReversed = (b.side === 'LONG' && trendEval.ema50 < trendEval.ema200) ||
                                            (b.side === 'SHORT' && trendEval.ema50 > trendEval.ema200);
                        
                        if (emaReversed) {
                            if (b.pnl > 0) {
                                queueClosePosition(botInst, b, markP, `EMA ĐẢO CHIỀU (${currentLevel}) - PnL DƯƠNG (+${b.pnl.toFixed(2)}$)`);
                                continue;
                            }
                            // Nếu PnL âm: giữ nguyên không đóng
                        }
                    }

                    // 2. Chốt lời theo TP Trend % Price (nếu bật)
                    if (botInst.botSettings.tpTrendPctEnabled) {
                        const tpPct = botInst.botSettings.tpTrendPct || 2.0;
                        const firstE = b.firstEntry || currentAvgEntry;
                        const priceDiffPct = b.side === 'LONG' 
                            ? ((markP - firstE) / firstE) * 100 
                            : ((firstE - markP) / firstE) * 100;

                        if (priceDiffPct >= tpPct) {
                            queueClosePosition(botInst, b, markP, `TP TREND % PRICE DẠT (${priceDiffPct.toFixed(2)}% >= ${tpPct}%)`);
                            continue;
                        }
                    }

                    // 3. Mở Hedge Trend (nếu bật)
                    if (botInst.botSettings.hedgeTrendEnabled && !b.isHedged) {
                        const hedgeThresholdPct = getEffectivePosDcaDuong(botInst, b.leverage || 50);
                        const priceAgainstPct = b.side === 'LONG'
                            ? ((currentAvgEntry - markP) / currentAvgEntry) * 100
                            : ((markP - currentAvgEntry) / currentAvgEntry) * 100;

                        if (priceAgainstPct >= hedgeThresholdPct) {
                            const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                            const oppKey = `${b.symbol}_${oppSide}`;
                            
                            if (!botInst.botActivePositions.has(oppKey)) {
                                b.isHedged = true;
                                const heSoDuong = botInst.botSettings.heSoDcaDuong || 2.0;
                                const hedgeMargin = (b.firstMargin || 1) * heSoDuong;
                                addBotLog(botInst, `🛡️ [HEDGE TREND] Mở lệnh đối ứng ${b.symbol} ${oppSide} với Margin: ${hedgeMargin.toFixed(2)}$`, "warn");
                                openPosition(botInst, b.symbol, null, oppSide, null, hedgeMargin, markP, 'trend', '| HEDGE TREND');
                            }
                        }
                    }

                    // Nếu TP Trend % Price bật -> Không dùng DCA Âm/Dương
                    if (botInst.botSettings.tpTrendPctEnabled) {
                        savePositionsToFile();
                        continue;
                    }
                }

                // --- QUẢN LÝ CHO CÁC CHẾ ĐỘ CŨ (DCA ÂM / DƯƠNG & SL / TP THƯỜNG) ---
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

                const isAmMode = currentDcaMode === 'AM';
                const slLimit = isAmMode 
                    ? (botInst.botSettings.posSL || 10.0) 
                    : ((b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0));

                if (netDetails.pairNetPnL <= -slLimit) {
                    const reasonSlPnL = `CẮT LỖ SL PNL CẶP (Net PnL: ${netDetails.pairNetPnL.toFixed(2)}$ <= -${slLimit.toFixed(2)}$)`;
                    if (netDetails.oppPos && !netDetails.oppPos.isClosing) {
                        queueClosePairPositions(botInst, b, markP, reasonSlPnL, netDetails.oppPos, netDetails.oppPos.livePrice || markP, `CẮT LỖ SL PNL ĐỐI ỨNG (${b.symbol})`);
                    } else {
                        queueClosePosition(botInst, b, markP, reasonSlPnL);
                    }
                    continue;
                }

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

// ============================================================================
// 6. TÍNH TOÁN CỠ LỆNH VÀ MỞ VỊ THẾ BỎ QUA HOẶC DÙNG VOL TREND
// ============================================================================
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
        } else if (sharedQty && sharedMargin && sharedPrice) {
            qty = sharedQty;
            margin = sharedMargin;
            currentPrice = sharedPrice;
        } else {
            // Mở vị thế mới thủ công/đơn lẻ
            currentPrice = await getCachedTickerPrice(symbol, 300);
            
            // Xử lý nút Vol Trend (nếu bật, trường vốn hiểu là danh nghĩa)
            if (modeName === 'trend' && botInst.botSettings.volTrendEnabled) {
                const notionalValue = parseFloat(botInst.botSettings.invValue) || 100;
                let desiredQty = notionalValue / currentPrice;
                qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
                if (qty * currentPrice < actualMinNotional) {
                    qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
                }
                qty = Number(qty.toFixed(info.quantityPrecision));
                margin = (qty * currentPrice) / info.maxLeverage;
            } else {
                const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
                const availBal = parseFloat(acc?.availableBalance || 0);
                const marginSetting = botInst.botSettings.invValue || "1%";
                margin = marginSetting.toString().includes('%') ? (availBal * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);
                let desiredQty = (margin * info.maxLeverage) / currentPrice;
                qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
                if (qty * currentPrice < actualMinNotional) {
                    qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
                }
                qty = Number(qty.toFixed(info.quantityPrecision));
                margin = (qty * currentPrice) / info.maxLeverage;
            }
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
                    addBotLog(botInst, `⚠️ [BỎ QUA LỆNH] Khả dụng không đủ (${availBal.toFixed(2)}$ < Margin ${reqMargin.toFixed(2)}$)`, "warn");
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
            const slPhongHoDet = calculateSlPhongHoDetails(botInst, p);
            
            let tpDet = null;
            if (p.pnl < 0 || p.isLockedAm) {
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
        return {
            ...p,
            margin: margin.toFixed(2)
        };
    });

    const currentMinLev = botInst.botSettings.minLev !== undefined ? botInst.botSettings.minLev : 50;
    const filtered24h = sharedState.top24hList.filter(c => c.leverage >= currentMinLev);
    const filteredFunding = sharedState.topFundingList.filter(c => c.leverage >= currentMinLev);

    // Tính toán Bảng Top 10 Trend
    const trendLevel = botInst.botSettings.trendLevel || 'Small';
    const top10TrendData = computeTop10TrendList(trendLevel, currentMinLev);

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
            trendClosedCount: botInst.status.trendClosedCount || 0,
            trendPnLClosed: botInst.status.trendPnLClosed || 0,
            trendPnlGain: botInst.status.trendPnlGain || 0,
            trendPnlLoss: botInst.status.trendPnlLoss || 0,
            isReady: botInst.status.isReady, 
            isPnlPaused: botInst.isPnlPaused,
            candidatesList: sharedState.candidatesList,
            top24hList: filtered24h,
            topFundingList: filteredFunding,
            top10TrendList: top10TrendData.list,
            top10TrendReady: top10TrendData.isReady,
            blackList: formattedBlacklist, 
            permanentBlacklist: sharedState.permanentBlacklist, 
            exchangeInfo: sharedState.exchangeInfo, 
            timeRun: formatUptime(botInst.startTime) 
        }, 
        wallet: {
            ...walletCache.data,
            unrealizedPnL: unrealizedPnL.toFixed(2)
        }, 
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

function adoptOrphanPosition(targetBot, realP) {
    const symbol = realP.symbol;
    const side = realP.positionSide || (parseFloat(realP.positionAmt) > 0 ? 'LONG' : 'SHORT');
    const key = `${symbol}_${side}`;
    const qty = Math.abs(parseFloat(realP.positionAmt));
    const entryPrice = parseFloat(realP.entryPrice);
    const leverage = parseInt(realP.leverage) || 20;
    const pnl = parseFloat(realP.unRealizedProfit || 0);

    const initialDcaType = pnl < 0 ? 'AM' : 'DUONG';

    const posDcaAm = targetBot.botSettings.posDcaAm || 3.0;
    const posDcaDuong = getEffectivePosDcaDuong(targetBot, leverage);
    const slPercent = initialDcaType === 'AM' ? (targetBot.botSettings.posSL || 10.0) : (targetBot.botSettings.posSLDuong || 5.0);
    const tpDcaAmPercent = targetBot.botSettings.tpDcaAm || 10.0;
    const tpDcaDuongPercent = targetBot.botSettings.tpDcaDuong || 10.0;

    const dir = (side === 'LONG' ? 1 : -1);
    
    let nextDcaAm = entryPrice * (1 - dir * (1 * posDcaAm / 100));
    let nextDcaDuong = entryPrice * (1 + dir * (1 * posDcaDuong / 100));
    
    let activeTpPercent = initialDcaType === 'AM' ? tpDcaAmPercent : tpDcaDuongPercent;
    let finalTP = entryPrice + dir * (entryPrice * (activeTpPercent / 100));
    let finalSL = entryPrice * (1 - dir * (slPercent / 100));

    const nowTime = Date.now();
    const totalMargin = (qty * entryPrice) / leverage;

    targetBot.botActivePositions.set(key, {
        symbol,
        side,
        entryPrice: entryPrice,
        tp: finalTP,
        sl: finalSL,
        dcaAmCount: 0,
        dcaDuongCount: 0,
        dcaCount: 0,
        dcaType: initialDcaType,
        lastDcaType: initialDcaType,
        modeName: 'vol',
        fundingRate: 0,
        isLockedAm: false,
        lockedTpPrice: undefined,
        leverage: leverage,
        firstEntry: entryPrice,
        firstMargin: totalMargin,
        currentMargin: totalMargin,
        currentQty: qty,
        cumulativeQty: qty,
        cumulativeCost: qty * entryPrice,
        dcaHistory: [{ price: entryPrice, margin: totalMargin, type: 'ENTRY' }],
        pnl: pnl,
        profitPercent: 0,
        peakPrice: entryPrice,
        peakNetPnL: 0,
        avgEntry: entryPrice,
        nextDcaAm,
        nextDcaDuong,
        livePrice: parseFloat(realP.markPrice || entryPrice),
        createdAt: nowTime,
        lastActionTime: nowTime,
        lastDcaTime: nowTime,
        time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
    });

    savePositionsToFile();
    addBotLog(targetBot, `📥 [TIẾP QUẢN] ${formatCoinName(symbol)} ${side} | Qty: ${qty} | Entry: ${formatPrice(entryPrice)}`, "warn");
}

async function syncPositionsWithExchange() {
    try {
        if (bot.antiLiquidationCooldownUntil && Date.now() < bot.antiLiquidationCooldownUntil) {
            return;
        }

        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return;

        const realActivePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        const activeKeysOnExchange = new Set(realActivePositions.map(p => `${p.symbol}_${p.positionSide}`));

        for (let [key, pos] of Array.from(bot.botActivePositions.entries())) {
            if (!activeKeysOnExchange.has(key)) {
                bot.botActivePositions.delete(key);
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

        for (const p of realActivePositions) {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!bot.botActivePositions.has(key) && !bot.isProcessingDCA.has(key)) {
                adoptOrphanPosition(bot, p);
            }
        }

        savePositionsToFile();
    } catch (e) {
        console.error("Lỗi đồng bộ vị thế:", e.message);
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
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        loadSettingsFromFile();
        loadPositionsFromFile();

        updatePermanentBlacklist();

        await syncPositionsWithExchange();

        // Khởi tạo dữ liệu nến cho Trend Mode ngay khi start
        const allSymbols = Object.keys(temp);
        await trendDataManager.initHistoricalData(allSymbols);

        await new Promise(r => setTimeout(r, 1500));
        bot.status.isReady = true; 
        
        priceMonitor(bot); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(async () => {
    if (bot.status.isReady) {
        await syncPositionsWithExchange();
        trendDataManager.checkWsHealth();
    }
}, 5000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1000);

setInterval(async () => {
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
            }
        });

    } catch (e) {}
}, 5000);

// ============================================================================
// 7. VÒNG LẶP QUÉT VÀ VÀO LỆNH TỰ ĐỘNG
// ============================================================================
let isScanning = false;

setInterval(async () => {
    if (isScanning) return;
    isScanning = true;

    try {
        await checkMarginLimits(bot);
        if (!bot.status.isReady || !bot.botSettings.isRunning || bot.isMarginProtected || bot.isPnlPaused) return;
        if (bot.antiLiquidationCooldownUntil && Date.now() < bot.antiLiquidationCooldownUntil) return;

        const maxPosSetting = bot.botSettings.maxPositions || 3;
        const uniqueActiveSymbols = new Set(Array.from(bot.botActivePositions.values()).map(p => p.symbol));

        const pairCountByMode = { vol: new Set(), '24h': new Set(), funding: new Set(), name: new Set(), trend: new Set() };
        bot.botActivePositions.forEach(p => {
            const m = p.modeName || 'vol';
            if (pairCountByMode[m]) {
                pairCountByMode[m].add(p.symbol);
            }
        });

        // 1. Quét Chế Độ Trend (Nếu Bật)
        if (bot.botSettings.enableTrendMode) {
            if (pairCountByMode['trend'].size < maxPosSetting) {
                const trendLevel = bot.botSettings.trendLevel || 'Small';
                const currentMinLev = bot.botSettings.minLev || 20;
                const top10Data = computeTop10TrendList(trendLevel, currentMinLev);

                if (top10Data.isReady && top10Data.list.length > 0) {
                    for (const candidate of top10Data.list) {
                        const sym = candidate.symbol;
                        if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
                        if (uniqueActiveSymbols.has(sym)) continue;

                        if (candidate.finalSignal) {
                            sharedState.pendingOrders.add(sym);
                            pairCountByMode['trend'].add(sym);
                            setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);

                            const side = candidate.side;
                            const logInfo = `| TREND [${trendLevel}] - ${side} (Score: ${candidate.totalScore}/6)`;
                            await openPosition(bot, sym, null, side, null, null, candidate.currentPrice, 'trend', logInfo);
                            return;
                        }
                    }
                }
            }
        }

        // 2. Chế độ Chọn Theo Tên
        if (bot.botSettings.enableScanName && bot.botSettings.scanNamesInput) {
            const rawNames = bot.botSettings.scanNamesInput.split(',');
            for (let rn of rawNames) {
                let sym = rn.trim().toUpperCase();
                if (!sym) continue;
                if (!sym.endsWith('USDT') && !sym.endsWith('BUSD')) {
                    sym = sym + 'USDT';
                }
                if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
                if (uniqueActiveSymbols.has(sym)) continue;

                const info = sharedState.exchangeInfo[sym];
                if (!info) continue;

                sharedState.pendingOrders.add(sym);
                setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);

                await openPositionPair(bot, sym, 'name', `| CHỌN THEO TÊN`);
                return;
            }
        }

        // 3. Chế độ Funding
        if (bot.botSettings.enableScanFunding) {
            if (pairCountByMode['funding'].size < maxPosSetting) {
                const minFdSetting = (bot.botSettings.minFd !== undefined ? bot.botSettings.minFd : 1.0) / 100; 
                for (const item of sharedState.topFundingList) {
                    const sym = item.symbol;
                    if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
                    if (uniqueActiveSymbols.has(sym)) continue;
                    if (item.absFunding < minFdSetting) continue;

                    if (pairCountByMode['funding'].size >= maxPosSetting) break;

                    const info = sharedState.exchangeInfo[sym];
                    if (!info) continue;

                    sharedState.pendingOrders.add(sym);
                    pairCountByMode['funding'].add(sym);
                    setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);

                    await openPositionPair(bot, sym, 'fd', `| FUNDING: ${(item.fundingRate * 100).toFixed(4)}%`);
                    return;
                }
            }
        }

        // 4. Chế độ Biến Động 24H
        if (bot.botSettings.enableScan24h) {
            if (pairCountByMode['24h'].size < maxPosSetting) {
                const min24hSetting = bot.botSettings.min24h !== undefined ? bot.botSettings.min24h : 0.0;
                for (const item of sharedState.top24hList) {
                    const sym = item.symbol;
                    if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
                    if (uniqueActiveSymbols.has(sym)) continue;
                    if (Math.abs(item.priceChangePercent) < min24hSetting) continue;

                    if (pairCountByMode['24h'].size >= maxPosSetting) break;

                    const info = sharedState.exchangeInfo[sym];
                    if (!info) continue;

                    sharedState.pendingOrders.add(sym);
                    pairCountByMode['24h'].add(sym);
                    setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);

                    await openPositionPair(bot, sym, '24h', `| 24H CHANGE: ${item.priceChangePercent.toFixed(2)}%`);
                    return;
                }
            }
        }

        // 5. Chế độ Vol Biến Động
        if (bot.botSettings.enableScanVol !== false) {
            if (pairCountByMode['vol'].size < maxPosSetting) {
                const minScanVol = bot.botSettings.minVol || 7;
                for (const c of sharedState.candidatesList) {
                    const sym = c.symbol;
                    if (sharedState.blackList[sym] || sharedState.permanentBlacklist[sym] || sharedState.pendingOrders.has(sym)) continue;
                    if (uniqueActiveSymbols.has(sym)) continue;

                    const m1 = parseFloat(c.c1 ?? c.m1 ?? c.v1 ?? 0); 
                    const m5 = parseFloat(c.c5 ?? c.m5 ?? c.v5 ?? 0); 
                    const m15 = parseFloat(c.c15 ?? c.m15 ?? c.v15 ?? 0);

                    let isNormal = false;
                    for (const tf of SCAN_CONFIG.THUONG) {
                        const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
                        if (Math.abs(val) >= minScanVol) { isNormal = true; break; }
                    }

                    if (isNormal) {
                        if (pairCountByMode['vol'].size >= maxPosSetting) break;

                        const info = sharedState.exchangeInfo[sym];
                        if (!info) continue;

                        sharedState.pendingOrders.add(sym);
                        pairCountByMode['vol'].add(sym);
                        setTimeout(() => sharedState.pendingOrders.delete(sym), 8000);

                        await openPositionPair(bot, sym, 'vol', `| M1: ${m1} M5: ${m5}`);
                        return;
                    }
                }
            }
        }
    } finally {
        isScanning = false;
    }
}, 100);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT] Đã chạy trên port ${PORT}`));
