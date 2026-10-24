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

// --- HỆ THỐNG TÍNH TOÁN CHỈ BÁO KỸ THUẬT & WEBSOCKET KKL ---
const klineCache = {}; // { SYMBOL: { '1h': [], '15m': [], '5m': [] } }
let wsConn = null;

function calculateEMA(data, period) {
    if (!data || data.length === 0) return [];
    const k = 2 / (period + 1);
    const emaArray = [];
    let sum = 0;
    for (let i = 0; i < Math.min(period, data.length); i++) {
        sum += data[i];
    }
    let prevEMA = sum / Math.min(period, data.length);
    emaArray[Math.min(period, data.length) - 1] = prevEMA;
    for (let i = 0; i < data.length; i++) {
        if (i === 0) { emaArray[i] = prevEMA; continue; }
        prevEMA = (data[i] * k) + (prevEMA * (1 - k));
        emaArray[i] = prevEMA;
    }
    return emaArray;
}

function calculateATR(highs, lows, closes, period = 14) {
    if (highs.length < period + 1) return 0;
    let trs = [];
    for (let i = 1; i < highs.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        trs.push(Math.max(hl, hc, lc));
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

function calculateSupertrend(highs, lows, closes, atrPeriod = 10, multiplier = 3) {
    if (highs.length < atrPeriod + 1) return { direction: 'UP', value: closes[closes.length - 1] };
    const atr = calculateATR(highs, lows, closes, atrPeriod);
    const hl2 = (highs[highs.length - 1] + lows[lows.length - 1]) / 2;
    const upperBasic = hl2 + (multiplier * atr);
    const lowerBasic = hl2 - (multiplier * atr);
    const close = closes[closes.length - 1];
    const isUp = close >= lowerBasic;
    return { direction: isUp ? 'UP' : 'DOWN', value: isUp ? lowerBasic : upperBasic };
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = calculateEMA(closes, fast);
    const emaSlow = calculateEMA(closes, slow);
    const macdLine = [];
    for (let i = 0; i < closes.length; i++) {
        macdLine.push((emaFast[i] || 0) - (emaSlow[i] || 0));
    }
    const signalLine = calculateEMA(macdLine, signal);
    const histogram = [];
    for (let i = 0; i < closes.length; i++) {
        histogram.push((macdLine[i] || 0) - (signalLine[i] || 0));
    }
    return {
        macd: macdLine[macdLine.length - 1] || 0,
        signal: signalLine[signalLine.length - 1] || 0,
        histogram: histogram[histogram.length - 1] || 0,
        prevHistogram: histogram[histogram.length - 2] || 0
    };
}

async function initKlineWebsocket() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const symbols = res.data.symbols.filter(s => s.status === 'TRADING').map(s => s.symbol.toLowerCase());
        
        // Fetch historical klines ban đầu qua REST (tránh rate limit, thực hiện tuần tự hoặc chia batch)
        for (const sym of symbols.slice(0, 150)) { // Giới hạn top 150 coin chính để khởi tạo nhanh
            try {
                const [r1h, r15m, r5m] = await Promise.all([
                    axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym.toUpperCase()}&interval=1h&limit=250`),
                    axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym.toUpperCase()}&interval=15m&limit=100`),
                    axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym.toUpperCase()}&interval=5m&limit=50`)
                ]);
                klineCache[sym.toUpperCase()] = {
                    '1h': r1h.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]), closed: true })),
                    '15m': r15m.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]), closed: true })),
                    '5m': r5m.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]), closed: true }))
                };
            } catch (e) {}
        }

        // Kết nối WebSocket stream đa kênh kline 1h, 15m, 5m
        const streams = symbols.slice(0, 100).flatMap(s => [`${s}@kline_1h`, `${s}@kline_15m`, `${s}@kline_5m`]);
        const wsUrl = `wss://fstream.binance.com/stream?streams=${streams.slice(0, 200).join('/')}`;
        
        wsConn = new WebSocket(wsUrl);
        wsConn.on('message', (data) => {
            try {
                const parsed = JSON.parse(data);
                if (parsed && parsed.data && parsed.data.k) {
                    const k = parsed.data.k;
                    const sym = parsed.data.s;
                    const tf = k.i;
                    if (!klineCache[sym]) klineCache[sym] = { '1h': [], '15m': [], '5m': [] };
                    if (!klineCache[sym][tf]) klineCache[sym][tf] = [];

                    const candle = {
                        time: k.t,
                        open: parseFloat(k.o),
                        high: parseFloat(k.h),
                        low: parseFloat(k.l),
                        close: parseFloat(k.c),
                        volume: parseFloat(k.v),
                        closed: k.x
                    };

                    const arr = klineCache[sym][tf];
                    if (arr.length > 0 && arr[arr.length - 1].time === candle.time) {
                        arr[arr.length - 1] = candle;
                    } else {
                        arr.push(candle);
                        if (arr.length > 300) arr.shift();
                    }
                }
            } catch (err) {}
        });
        wsConn.on('error', () => {});
        wsConn.on('close', () => { setTimeout(initKlineWebsocket, 10000); });
    } catch (e) {}
}

// --- LOGIC XÁC ĐỊNH & QUÉT CHẾ ĐỘ TREND ---
async function evaluateTrendScanner(botInst) {
    if (!botInst.botSettings.enableScanTrend) {
        sharedState.topTrendList = [];
        return;
    }

    const currentMinLev = botInst.botSettings.minLev || 50;
    const candidates = [];

    for (const symbol in sharedState.exchangeInfo) {
        const info = sharedState.exchangeInfo[symbol];
        if (!info || info.maxLeverage < currentMinLev) continue;

        const klines = klineCache[symbol];
        if (!klines || !klines['1h'] || !klines['15m'] || !klines['5m']) continue;

        const c1h = klines['1h'].filter(k => k.closed);
        const c15m = klines['15m'].filter(k => k.closed);
        const c5m = klines['5m'].filter(k => k.closed);

        if (c1h.length < 200 || c15m.length < 20 || c5m.length < 25) continue;

        // 1. EMA 1H
        const closes1h = c1h.map(k => k.close);
        const ema50_1h = calculateEMA(closes1h, 50);
        const ema200_1h = calculateEMA(closes1h, 200);
        const curEma50_1h = ema50_1h[ema50_1h.length - 1];
        const curEma200_1h = ema200_1h[ema200_1h.length - 1];
        const lastClose1h = closes1h[closes1h.length - 1];

        const isLongEma = curEma50_1h > curEma200_1h && lastClose1h > curEma200_1h;
        const isShortEma = curEma50_1h < curEma200_1h && lastClose1h < curEma200_1h;
        if (!isLongEma && !isShortEma) continue;
        const suggestedSide = isLongEma ? 'LONG' : 'SHORT';

        // 2. Supertrend 15m
        const highs15m = c15m.map(k => k.high);
        const lows15m = c15m.map(k => k.low);
        const closes15m = c15m.map(k => k.close);
        const st = calculateSupertrend(highs15m, lows15m, closes15m, 10, 3);
        const stPass = (suggestedSide === 'LONG' && st.direction === 'UP' && closes15m[closes15m.length - 1] > st.value) ||
                       (suggestedSide === 'SHORT' && st.direction === 'DOWN' && closes15m[closes15m.length - 1] < st.value);

        // 3. MACD 5m
        const closes5m = c5m.map(k => k.close);
        const macd = calculateMACD(closes5m, 12, 26, 9);
        const macdPass = (suggestedSide === 'LONG' && macd.macd > macd.signal && macd.histogram > macd.prevHistogram) ||
                         (suggestedSide === 'SHORT' && macd.macd < macd.signal && macd.histogram < macd.prevHistogram);

        // 4. Volume 5m
        const vols5m = c5m.map(k => k.volume);
        const avgVol20 = vols5m.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
        const signalVol = vols5m[vols5m.length - 1];
        const volPass = signalVol >= (1.5 * avgVol20);

        // 5. Phá vỡ giá 5m (20 nến trước)
        const past20Highs = c5m.slice(-21, -1).map(k => k.high);
        const past20Lows = c5m.slice(-21, -1).map(k => k.low);
        const highest20 = Math.max(...past20Highs);
        const lowest20 = Math.min(...past20Lows);
        const currentClose5m = closes5m[closes5m.length - 1];
        const breakoutPass = (suggestedSide === 'LONG' && currentClose5m > highest20) ||
                             (suggestedSide === 'SHORT' && currentClose5m < lowest20);

        // 6. Chống đuổi giá (ATR 14, EMA 50 khung 5m)
        const highs5m = c5m.map(k => k.high);
        const lows5m = c5m.map(k => k.low);
        const atr5m = calculateATR(highs5m, lows5m, closes5m, 14);
        const ema50_5m = calculateEMA(closes5m, 50);
        const curEma50_5m = ema50_5m[ema50_5m.length - 1];
        const chaseRatio = atr5m > 0 ? Math.abs(currentClose5m - curEma50_5m) / atr5m : 0;
        const chasePass = chaseRatio <= 1.5;

        // Đếm tổng số điều kiện đạt
        let score = 2; // EMA + Side
        if (stPass) score++;
        if (macdPass) score++;
        if (volPass) score++;
        if (breakoutPass) score++;
        if (chasePass) score++;

        candidates.push({
            symbol,
            leverage: info.maxLeverage,
            price: currentClose5m,
            suggestedSide,
            score,
            emaPass: true,
            ema50Val: formatPrice(curEma50_1h),
            ema200Val: formatPrice(curEma200_1h),
            stPass,
            macdPass,
            volPass,
            breakoutPass,
            chasePass,
            isAllValid: stPass && macdPass && volPass && breakoutPass && chasePass
        });
    }

    candidates.sort((a, b) => b.score - a.score);
    sharedState.topTrendList = candidates.slice(0, 10);

    // Nếu bot đang chạy và bật chế độ trend, tự động vào lệnh nếu đạt tất cả điều kiện
    if (botInst.botSettings.isRunning && botInst.botSettings.enableScanTrend) {
        const maxPos = botInst.botSettings.maxPositions || 3;
        const currentActiveCount = botInst.botActivePositions.size;
        if (currentActiveCount < maxPos) {
            for (const c of sharedState.topTrendList) {
                if (c.isAllValid) {
                    if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol] || sharedState.pendingOrders.has(c.symbol)) continue;
                    const activeSyms = new Set(Array.from(botInst.botActivePositions.values()).map(p => p.symbol));
                    if (activeSyms.has(c.symbol)) continue;

                    sharedState.pendingOrders.add(c.symbol);
                    setTimeout(() => sharedState.pendingOrders.delete(c.symbol), 8000);

                    const indicatorInfo = `EMA50:${c.ema50Val} EMA200:${c.ema200Val} ST:${c.stPass?'OK':'X'} MACD:${c.macdPass?'OK':'X'} Vol:${c.volPass?'OK':'X'}`;
                    await openTrendPosition(botInst, c.symbol, c.suggestedSide, indicatorInfo);
                    break;
                }
            }
        }
    }
}

async function openTrendPosition(botInst, symbol, side, indicatorLogInfo) {
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;

    delete sharedState.lastClosedPnl[`${symbol}_LONG`];
    delete sharedState.lastClosedPnl[`${symbol}_SHORT`];

    const currentPrice = await getCachedTickerPrice(symbol, 300).catch(() => null);
    if (!currentPrice) return;

    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);
    const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
    const availBal = parseFloat(acc?.availableBalance || 0);

    const marginSetting = botInst.botSettings.invValue || "1%";
    let rawInputVal = marginSetting.toString().includes('%') ? (availBal * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

    let finalMargin = rawInputVal;
    let finalQty = 0;

    if (botInst.botSettings.volTrendMode) {
        // Nếu bật nút Vol Trend: Vốn nhập vào tính là khối lượng => Chia max lev để ra margin chuẩn
        finalQty = Math.floor(rawInputVal / info.stepSize) * info.stepSize;
        if (finalQty * currentPrice < actualMinNotional) {
            finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
        finalQty = Number(finalQty.toFixed(info.quantityPrecision));
        finalMargin = (finalQty * currentPrice) / info.maxLeverage;
    } else {
        finalMargin = rawInputVal;
        let desiredQty = (finalMargin * info.maxLeverage) / currentPrice;
        finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
        if (finalQty * currentPrice < actualMinNotional) {
            finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
        finalQty = Number(finalQty.toFixed(info.quantityPrecision));
    }

    await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);

    try {
        const order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', finalQty, undefined, { positionSide: side });
        let actualFilledPrice = parseFloat(order.average || order.price || currentPrice);

        const lockKey = `${symbol}_${side}`;
        const nowTime = Date.now();

        const posData = {
            symbol,
            side,
            entryPrice: actualFilledPrice,
            firstEntry: actualFilledPrice,
            avgEntry: actualFilledPrice,
            currentQty: finalQty,
            cumulativeQty: finalQty,
            cumulativeCost: finalQty * actualFilledPrice,
            firstMargin: finalMargin,
            currentMargin: finalMargin,
            leverage: info.maxLeverage,
            modeName: 'trend',
            dcaAmCount: 0,
            dcaDuongCount: 0,
            dcaCount: 0,
            dcaType: 'DUONG',
            isLockedAm: false,
            pnl: 0,
            profitPercent: 0,
            peakPrice: actualFilledPrice,
            livePrice: actualFilledPrice,
            indicatorLogInfo,
            createdAt: nowTime,
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
        };

        botInst.botActivePositions.set(lockKey, posData);
        savePositionsToFile();
        addBotLog(botInst, `🚀 [MỞ LỆNH TREND ${side}] ${formatCoinName(symbol)} | Khối lượng: ${finalQty} | Margin: ${finalMargin.toFixed(2)}$ | Entry: ${formatPrice(actualFilledPrice)} | Chỉ báo: [${indicatorLogInfo}]`, "open");

    } catch (e) {
        checkAndAddBlacklist(symbol);
    }
}
// -------------------------------------------------------------

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalized = { ...currentSettings };
    for (let key in reqBody) {
        const val = reqBody[key];
        const lowerKey = key.toLowerCase();
        if (['minvol', 'possl', 'posslduong', 'posdcaam', 'posdcaduong', 'hesodcaam', 'hesodcaduong', 'tpdcaam', 'tpdcaduong', 'minpnltpdcaduong', 'minfd', 'min24h'].includes(lowerKey)) {
            normalized[key] = parseFloat(val);
        } else if (['maxpositions', 'minlev'].includes(lowerKey)) {
            normalized[key] = parseInt(val);
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enablescantrend', 'tptrendbyprice', 'voltrendmode', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
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
        tpTrendByPrice: false,
        volTrendMode: false,
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
    if (b.modeName === 'trend' && botInst.botSettings.tpTrendByPrice) {
        const tpPct = botInst.botSettings.tpDcaDuong || 10.0;
        const dir = b.side === 'LONG' ? 1 : -1;
        const targetTpPrice = b.firstEntry * (1 + dir * (tpPct / 100));
        const estPnl = dir * (targetTpPrice - b.avgEntry) * b.currentQty;
        return { targetTpPrice, estPnl, badge: '🎯 [TP % Price]' };
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
        } catch (err) {}
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
        }

        const formattedSymbol = formatCoinName(b.symbol);
        addBotLog(botInst, `🔒 [${detailTag} | LÝ DO: ${reasonStr}] ${formattedSymbol} ${b.side} | Chế độ: [${b.modeName || 'vol'}] | Giá chốt: ${formatPrice(markP)} | Net PnL: ${finalPnL.toFixed(2)}$`, logType);
        
    } catch (e) {}

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
                    b.peakPrice = Math.max(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((markP - currentAvgEntry) / currentAvgEntry) * 100;
                } else {
                    b.peakPrice = Math.min(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((currentAvgEntry - markP) / currentAvgEntry) * 100;
                }

                // CẬP NHẬT RIÊNG CHO CHẾ ĐỘ TREND: Nếu chưa đạt TP mà EMA nến 1h đóng bị đảo chiều => Cắt lệnh nếu pnl đã lãi & giữ lệnh nếu pnl đang âm
                if (b.modeName === 'trend') {
                    const klines = klineCache[b.symbol];
                    if (klines && klines['1h']) {
                        const c1h = klines['1h'].filter(k => k.closed);
                        if (c1h.length >= 200) {
                            const closes1h = c1h.map(k => k.close);
                            const ema50 = calculateEMA(closes1h, 50);
                            const ema200 = calculateEMA(closes1h, 200);
                            const cur50 = ema50[ema50.length - 1];
                            const cur200 = ema200[ema200.length - 1];
                            const lastC = closes1h[closes1h.length - 1];

                            const isStillLong = cur50 > cur200 && lastC > cur200;
                            const isStillShort = cur50 < cur200 && lastC < cur200;
                            const isTrendReversed = (b.side === 'LONG' && !isStillLong) || (b.side === 'SHORT' && !isStillShort);

                            if (isTrendReversed) {
                                if (b.pnl > 0) {
                                    queueClosePosition(botInst, b, markP, `CẮT LỆNH TREND DO EMA 1H ĐẢO CHIỀU (Đã lãi PnL: ${b.pnl.toFixed(2)}$)`);
                                    continue;
                                } else {
                                    // PnL đang âm => giữ nguyên lệnh, không cắt
                                }
                            }
                        }
                    }
                }

                const netDetails = getPairNetPnLDetails(botInst, b, markP);
                b.peakNetPnL = Math.max(b.peakNetPnL !== undefined ? b.peakNetPnL : -999999, netDetails.pairNetPnL);

                const totalDcaCount = (b.dcaAmCount || 0) + (b.dcaDuongCount || 0);
                if (botInst.botSettings.lockDcaAmMode) {
                    if ((b.dcaDuongCount || 0) >= 1) {
                        const oppositeSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                        const oppKey = `${b.symbol}_${oppositeSide}`;
                        const oppPos = botInst.botActivePositions.get(oppKey);
                        if (oppPos) { oppPos.isLockedAm = true; }
                        if (b.pnl < 0) { b.isLockedAm = true; }
                    }
                    if (totalDcaCount > 1 && b.pnl < 0) { b.isLockedAm = true; }
                }

                let currentDcaMode = b.pnl < 0 ? 'AM' : 'DUONG';
                if (b.isLockedAm) { currentDcaMode = 'AM'; }
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

                // Kiểm tra TP cho Chế độ Trend hoặc chế độ thường
                if (b.modeName === 'trend') {
                    const tpDet = calculateTpDcaDuongDetails(botInst, b);
                    const hitTp = b.side === 'LONG' ? (markP >= tpDet.targetTpPrice) : (markP <= tpDet.targetTpPrice);
                    if (hitTp) {
                        queueClosePosition(botInst, b, markP, `CHỐT TP TREND (${formatPrice(tpDet.targetTpPrice)})`);
                        continue;
                    }
                } else {
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

                        const satisfiesPnlAndOffset = dir === 1 ? (peakTpPrice >= baseTpPrice) : (peakTpPrice <= baseTpPrice);
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
                                    queueClosePosition(botInst, b, markP, reasonTp);
                                    continue;
                                } else {
                                    b.lockedTpPrice = undefined;
                                }
                            }
                        }
                    }
                }

                const isAmMode = currentDcaMode === 'AM';
                const slLimit = isAmMode ? (botInst.botSettings.posSL || 10.0) : ((b.firstMargin || 1) * (botInst.botSettings.posSLDuong || 5.0));

                if (netDetails.pairNetPnL <= -slLimit) {
                    queueClosePosition(botInst, b, markP, `CẮT LỖ SL PNL (Net PnL: ${netDetails.pairNetPnL.toFixed(2)}$)`);
                    continue;
                }
            }
        }
    } catch (e) {}
    
    setTimeout(() => priceMonitor(botInst), 300);
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
            const slPhongHoDet = calculateSlPhongHoDetails(botInst, p);
            
            let tpDet = null;
            if (p.pnl < 0 || p.isLockedAm) {
                tpDet = calculateTpDcaAmDetails(botInst, p);
            } else {
                tpDet = calculateTpDcaDuongDetails(botInst, p);
            }

            const feeAndFd = calculatePositionFeeAndFunding(botInst, p, p.livePrice || p.avgEntry);

            return {
                ...p,
                estimatedFee: feeAndFd.estimatedFee,
                accumulatedFunding: feeAndFd.accumulatedFunding,
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

async function syncPositionsWithExchange() {
    try {
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
                    }
                    pos.livePrice = parseFloat(realP.markPrice);
                    pos.currentQty = Math.abs(parseFloat(realP.positionAmt));
                    pos.pnl = parseFloat(realP.unRealizedProfit);
                }
            }
        }
        savePositionsToFile();
    } catch (e) {}
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

        // Khởi động WebSocket kline để tính toán chỉ báo tự động tránh rate limit
        initKlineWebsocket();

        await new Promise(r => setTimeout(r, 1500));
        bot.status.isReady = true; 
        priceMonitor(bot); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(async () => {
    if (bot.status.isReady) {
        await syncPositionsWithExchange();
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

// Chạy định kỳ quét Trend Scanner mỗi 3 giây
setInterval(async () => {
    if (bot.status.isReady && bot.botSettings.isRunning) {
        await evaluateTrendScanner(bot);
    }
}, 3000);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT] Đã chạy trên port ${PORT}`));
