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

const REAL_PORT = 6789;
const DEMO_PORT = 6790;
const MIN_NOTIONAL_FORCE = 5.1;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const POSITIONS_FILE = path.join(__dirname, 'positions.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DEMO_STATE_FILE = path.join(__dirname, 'demo_state.json');

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
    history: { vol: [], '24h': [], fd: [], trend: [] },
    modeStats: {
        vol: { count: 0, pnl: 0 },
        '24h': { count: 0, pnl: 0 },
        fd: { count: 0, pnl: 0 },
        trend: { count: 0, pnl: 0 }
    }
};

let demoState = {
    walletBalance: 10000.0,
    openPositions: new Map(),
    history: [],
    logs: [],
    closedCount: 0,
    closedPnl: 0
};

function loadDemoState() {
    try {
        if (fs.existsSync(DEMO_STATE_FILE)) {
            const raw = fs.readFileSync(DEMO_STATE_FILE, 'utf-8');
            const data = JSON.parse(raw);
            demoState.walletBalance = data.walletBalance || 10000.0;
            demoState.closedCount = data.closedCount || 0;
            demoState.closedPnl = data.closedPnl || 0;
            demoState.history = data.history || [];
            if (Array.isArray(data.openPositions)) {
                demoState.openPositions = new Map(data.openPositions);
            }
        }
    } catch (e) {}
}

function saveDemoState() {
    try {
        const data = {
            walletBalance: demoState.walletBalance,
            closedCount: demoState.closedCount,
            closedPnl: demoState.closedPnl,
            history: demoState.history,
            openPositions: Array.from(demoState.openPositions.entries())
        };
        fs.writeFileSync(DEMO_STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
}

loadDemoState();

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
        scanNamesInput: "",
        minFd: 1.0,
        min24h: 0.0,
        enableEarlySL: false,
        lockDcaAmMode: false,
        closeOppositeDcaAm: false,
        tpTrendPrice: false,
        volTrend: false,
        enableDemo: false,
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
    timestampOffset: 0,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

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
    if (match) return num.toFixed(match[1].length + 4);
    return num.toFixed(defaultPrec);
}

function formatCoinName(symbol) {
    return `<span style="color: #f97316; font-weight: bold;">${symbol}</span>`;
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
        } else if (['enablescanvol', 'enablescan24h', 'enablescanfunding', 'enablescanname', 'enablescantrend', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam', 'tptrendprice', 'voltrend', 'enabledemo'].includes(lowerKey)) {
            normalized[key] = val === true || val === 'true' || val === 1 || val === '1';
        } else {
            normalized[key] = val; 
        }
    }
    return normalized;
}

function addBotLog(botInst, msg, type = 'open') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    botInst.status.botLogs.unshift({ time, msg, type });
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
}

function addDemoLog(msg) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    demoState.logs.unshift({ time, msg });
    if (demoState.logs.length > 200) demoState.logs.pop();
}

// Indicator calculations (EMA, Supertrend, MACD, Volume, ATR, Breakout)
function calculateEMA(prices, period) {
    if (!prices || prices.length === 0) return [];
    const k = 2 / (period + 1);
    let emaArray = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
        emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
    }
    return emaArray;
}

function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 1;
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    const recentTrs = trs.slice(-period);
    return recentTrs.reduce((a, b) => a + b, 0) / period;
}

function calculateSupertrend(candles, period = 10, multiplier = 3) {
    if (candles.length < period) return { direction: 'UP', value: 0 };
    let atr = calculateATR(candles, period);
    const last = candles[candles.length - 1];
    const hl2 = (last.high + last.low) / 2;
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;
    const isUp = last.close > basicLower;
    return { direction: isUp ? 'UP' : 'DOWN', value: isUp ? basicLower : basicUpper };
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return { macd: 0, signal: 0, hist: 0, prevHist: 0 };
    const emaFast = calculateEMA(closes, fast);
    const emaSlow = calculateEMA(closes, slow);
    let macdLine = [];
    for (let i = 0; i < closes.length; i++) {
        macdLine.push(emaFast[i] - emaSlow[i]);
    }
    const signalLine = calculateEMA(macdLine, signal);
    const hist = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
    const prevHist = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2];
    return { macd: macdLine[macdLine.length - 1], signal: signalLine[signalLine.length - 1], hist, prevHist };
}

// WebSocket connection for real-time klines to avoid rate limits
let klineStore = {};
function startKlineWebSocket() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('open', () => {});
    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            // We can subscribe to klines dynamically if needed or use REST for historical klines + WS for live ticks
        } catch (e) {}
    });
}
startKlineWebSocket();

// Analyze Trend Conditions for symbols
async function evaluateTrendForSymbol(symbol, exchangeInfoItem) {
    try {
        const [res1h, res15m, res5m] = await Promise.all([
            binanceApi.get(`/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=210`),
            binanceApi.get(`/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=30`),
            binanceApi.get(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=30`)
        ]);

        const parseKlines = (data) => data.map(k => ({
            time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
        }));

        const k1h = parseKlines(res1h.data);
        const k15m = parseKlines(res15m.data);
        const k5m = parseKlines(res5m.data);

        if (k1h.length < 200 || k15m.length < 15 || k5m.length < 25) return null;

        const closes1h = k1h.map(k => k.close);
        const ema50_1h = calculateEMA(closes1h, 50);
        const ema200_1h = calculateEMA(closes1h, 200);
        const last1h = k1h[k1h.length - 1];
        const lastEma50_1h = ema50_1h[ema50_1h.length - 1];
        const lastEma200_1h = ema200_1h[ema200_1h.length - 1];

        // 1. EMA
        const isLongEma = lastEma50_1h > lastEma200_1h && last1h.close > lastEma200_1h;
        const isShortEma = lastEma50_1h < lastEma200_1h && last1h.close < lastEma200_1h;
        if (!isLongEma && !isShortEma) return null;
        const direction = isLongEma ? 'LONG' : 'SHORT';

        // 2. Supertrend (15m)
        const st = calculateSupertrend(k15m, 10, 3);
        const stOk = direction === 'LONG' ? (st.direction === 'UP' && k15m[k15m.length - 1].close > st.value) : (st.direction === 'DOWN' && k15m[k15m.length - 1].close < st.value);

        // 3. MACD (5m)
        const closes5m = k5m.map(k => k.close);
        const macd = calculateMACD(closes5m, 12, 26, 9);
        const macdOk = direction === 'LONG' ? (macd.macd > macd.signal && macd.hist > macd.prevHist) : (macd.macd < macd.signal && macd.hist < macd.prevHist);

        // 4. Volume (5m)
        const recent20Vols = k5m.slice(-21, -1).map(k => k.volume);
        const avgVol = recent20Vols.reduce((a, b) => a + b, 0) / recent20Vols.length;
        const sigVol = k5m[k5m.length - 1].volume;
        const volOk = sigVol >= 1.5 * avgVol;

        // 5. Breakout (5m, 20 closed candles)
        const prev20 = k5m.slice(-21, -1);
        const highestHigh = Math.max(...prev20.map(k => k.high));
        const lowestLow = Math.min(...prev20.map(k => k.low));
        const breakoutOk = direction === 'LONG' ? (last1h.close > highestHigh || k5m[k5m.length - 1].close > highestHigh) : (last1h.close < lowestLow || k5m[k5m.length - 1].close < lowestLow);

        // 6. Anti-late entry (ATR(14) on 5m, EMA50 on 5m)
        const atr5m = calculateATR(k5m, 14);
        const ema50_5m = calculateEMA(closes5m, 50);
        const lastEma50_5m = ema50_5m[ema50_5m.length - 1];
        const currentPrice = last1h.close;
        const distanceCheck = direction === 'LONG' ? ((currentPrice - lastEma50_5m) / atr5m <= 1.5) : ((lastEma50_5m - currentPrice) / atr5m <= 1.5);

        const score = (stOk ? 1 : 0) + (macdOk ? 1 : 0) + (volOk ? 1 : 0) + (breakoutOk ? 1 : 0);

        return {
            symbol: symbol,
            direction,
            price: currentPrice,
            leverage: exchangeInfoItem.maxLeverage,
            emaOk: true,
            superOk: stOk,
            macdOk,
            volOk,
            breakoutOk,
            distanceCheck,
            score
        };
    } catch (e) {
        return null;
    }
}

// Positions file handling
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
        if (Array.isArray(data)) bot.botActivePositions = new Map(data);
    } catch (e) {}
}

function loadSettingsFromFile() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return;
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data) bot.botSettings = parseNormalizedSettings(data, bot.botSettings);
    } catch (e) {}
}

function saveSettingsToFile() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(bot.botSettings, null, 2), 'utf-8');
    } catch (e) {}
}

async function binancePrivate(botInst, endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + botInst.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await botInst.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        throw e;
    }
}

// Open Real Position
async function openRealPosition(symbol, side, modeName, margin, qty, price) {
    const lockKey = `${symbol}_${side}`;
    try {
        const info = sharedState.exchangeInfo[symbol];
        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        const posData = {
            symbol, side, modeName,
            leverage: info.maxLeverage,
            firstEntry: price,
            avgEntry: price,
            currentMargin: margin,
            firstMargin: margin,
            currentQty: qty,
            pnl: 0,
            livePrice: price,
            createdAt: Date.now(),
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
        };
        bot.botActivePositions.set(lockKey, posData);
        savePositionsToFile();
        addBotLog(bot, `[MỞ ${side} | ${modeName.toUpperCase()}] ${symbol} | Margin: ${margin.toFixed(2)}$ | Entry: ${formatPrice(price)}`, 'open');
    } catch (e) {}
}

// Open Demo Position
async function openDemoPosition(symbol, side, modeName, margin, qty, price) {
    const lockKey = `${symbol}_${side}`;
    if (demoState.walletBalance < margin) {
        addDemoLog(`⚠️ Không đủ số dư demo mở ${symbol} ${side}`);
        return;
    }
    demoState.walletBalance -= margin;
    const posData = {
        symbol, side, modeName,
        leverage: 20,
        firstEntry: price,
        avgEntry: price,
        currentMargin: margin,
        currentQty: qty,
        pnl: 0,
        livePrice: price,
        createdAt: Date.now(),
        time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
    };
    demoState.openPositions.set(lockKey, posData);
    saveDemoState();
    addDemoLog(`[DEMO MỞ ${side} | ${modeName.toUpperCase()}] ${symbol} | Margin: ${margin.toFixed(2)}$ | Entry: ${formatPrice(price)}`);
}

// Background Price & Indicator Scanner & Monitoring Loop
async function backgroundScanner() {
    try {
        if (!bot.status.isReady || !bot.botSettings.isRunning) return;

        // Update top trend list
        if (sharedState.exchangeInfo) {
            let trendCandidates = [];
            for (const sym of Object.keys(sharedState.exchangeInfo)) {
                if (sharedState.blackList[sym]) continue;
                const evalRes = await evaluateTrendForSymbol(sym, sharedState.exchangeInfo[sym]);
                if (evalRes && evalRes.distanceCheck && evalRes.score >= 3) {
                    trendCandidates.push(evalRes);
                }
            }
            trendCandidates.sort((a, b) => b.score - a.score);
            const minLev = bot.botSettings.minLev || 20;
            sharedState.topTrendList = trendCandidates.filter(c => c.leverage >= minLev).slice(0, 10);

            // If Trend mode is enabled, execute trend entries
            if (bot.botSettings.enableScanTrend && sharedState.topTrendList.length > 0) {
                const maxPos = bot.botSettings.maxPositions || 3;
                const activeTrendCount = Array.from(bot.botActivePositions.values()).filter(p => p.modeName === 'trend').length;
                if (activeTrendCount < maxPos) {
                    const best = sharedState.topTrendList[0];
                    const lockKey = `${best.symbol}_${best.direction}`;
                    if (!bot.botActivePositions.has(lockKey) && !demoState.openPositions.has(lockKey)) {
                        const info = sharedState.exchangeInfo[best.symbol];
                        let margin = 10;
                        if (bot.botSettings.volTrend) {
                            const rawInput = parseFloat(bot.botSettings.invValue || 10);
                            margin = rawInput / info.maxLeverage;
                        } else {
                            margin = parseFloat(bot.botSettings.invValue || 10);
                        }
                        const qty = Number(((margin * info.maxLeverage) / best.price).toFixed(info.quantityPrecision));

                        // Real bot open
                        await openRealPosition(best.symbol, best.direction, 'trend', margin, qty, best.price);
                        sharedState.modeStats.trend.count++;

                        // Demo bot open if enabled
                        if (bot.botSettings.enableDemo) {
                            await openDemoPosition(best.symbol, best.direction, 'trend', margin, qty, best.price);
                        }
                    }
                }
            }
        }

        // Monitor Real Positions & Trend EMA inversion check
        for (const [key, p] of Array.from(bot.botActivePositions.entries())) {
            try {
                const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${p.symbol}`);
                const markP = parseFloat(ticker.data.price);
                p.livePrice = markP;
                const dir = p.side === 'LONG' ? 1 : -1;
                p.pnl = dir * (markP - p.avgEntry) * p.currentQty;

                // Trend mode EMA inversion check
                if (p.modeName === 'trend') {
                    // Check if 1h candle EMA closed inverted
                    const res1h = await binanceApi.get(`/fapi/v1/klines?symbol=${p.symbol}&interval=1h&limit=50`);
                    const closes1h = res1h.data.map(k => parseFloat(k[4]));
                    const ema50 = calculateEMA(closes1h, 50);
                    const ema200 = calculateEMA(closes1h, 200);
                    const inverted = p.side === 'LONG' ? (ema50[ema50.length - 1] < ema200[ema200.length - 1]) : (ema50[ema50.length - 1] > ema200[ema200.length - 1]);
                    
                    if (inverted) {
                        if (p.pnl >= 0) {
                            // Cut order if profit >= 0
                            await bot.exchange.createOrder(p.symbol, 'MARKET', p.side === 'SHORT' ? 'BUY' : 'SELL', p.currentQty, undefined, { positionSide: p.side });
                            bot.botActivePositions.delete(key);
                            sharedState.modeStats.trend.pnl += p.pnl;
                            bot.status.botPnLClosed += p.pnl;
                            sharedState.history.trend.unshift({ ...p, closePrice: markP, time: new Date().toLocaleTimeString('vi-VN', { hour12: false }) });
                            addBotLog(bot, `🌊 [TREND CẮT LỆNH EMA ĐẢO CHIỀU & CÓ LÃI] ${p.symbol} ${p.side} | PnL: ${p.pnl.toFixed(2)}$`, 'tp');
                            savePositionsToFile();
                        }
                    }
                }
            } catch (e) {}
        }

        // Monitor Demo Positions
        if (bot.botSettings.enableDemo) {
            for (const [key, p] of Array.from(demoState.openPositions.entries())) {
                try {
                    const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${p.symbol}`);
                    const markP = parseFloat(ticker.data.price);
                    p.livePrice = markP;
                    const dir = p.side === 'LONG' ? 1 : -1;
                    p.pnl = dir * (markP - p.avgEntry) * p.currentQty;

                    // TP / SL check for Demo
                    const tpPct = 5.0;
                    const slPct = 3.0;
                    const hitTp = dir === 1 ? (markP >= p.avgEntry * (1 + tpPct/100)) : (markP <= p.avgEntry * (1 - tpPct/100));
                    const hitSl = dir === 1 ? (markP <= p.avgEntry * (1 - slPct/100)) : (markP >= p.avgEntry * (1 + slPct/100));

                    if (hitTp || hitSl) {
                        demoState.walletBalance += p.currentMargin + p.pnl;
                        demoState.closedCount++;
                        demoState.closedPnl += p.pnl;
                        demoState.history.unshift({ ...p, closePrice: markP, time: new Date().toLocaleTimeString('vi-VN', { hour12: false }) });
                        demoState.openPositions.delete(key);
                        saveDemoState();
                        addDemoLog(`🔒 [DEMO CHỐT ${hitTp ? 'TP' : 'SL'}] ${p.symbol} ${p.side} | PnL: ${p.pnl.toFixed(2)}$`);
                    }
                } catch (e) {}
            }
        }

    } catch (e) {}
    setTimeout(backgroundScanner, 2000);
}

// Express Apps for Port 6789 (Real Bot) and Port 6790 (Demo Bot)
const realApp = express();
realApp.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
realApp.use(express.json());
realApp.use(express.static(__dirname, { index: false }));

realApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

realApp.get('/api/status', async (req, res) => {
    let walletData = { totalWalletBalance: "1000", totalMarginBalance: "1000", availableBalance: "1000", unrealizedPnL: "0" };
    try {
        const acc = await binancePrivate(bot, '/fapi/v2/account');
        walletData = {
            totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2),
            totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2),
            unrealizedPnL: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2)
        };
    } catch (e) {}

    const activePositions = Array.from(bot.botActivePositions.values()).map(p => ({
        ...p,
        openDurationStr: formatDuration(Date.now() - p.createdAt)
    }));

    res.json({
        botSettings: bot.botSettings,
        activePositions,
        exchangePositions: activePositions,
        status: {
            botLogs: bot.status.botLogs,
            botClosedCount: bot.status.botClosedCount,
            botPnLClosed: bot.status.botPnLClosed,
            pnlGain: bot.status.pnlGain || 0,
            pnlLoss: bot.status.pnlLoss || 0,
            isReady: bot.status.isReady,
            modeStats: sharedState.modeStats,
            topTrendList: sharedState.topTrendList,
            top24hList: sharedState.top24hList,
            topFundingList: sharedState.topFundingList,
            candidatesList: sharedState.candidatesList,
            history: sharedState.history,
            timeRun: formatUptime(bot.startTime)
        },
        wallet: walletData,
        demo: {
            walletBalance: demoState.walletBalance,
            openCount: demoState.openPositions.size,
            closedPnl: demoState.closedPnl,
            logs: demoState.logs,
            history: demoState.history
        }
    });
});

realApp.post('/api/settings', (req, res) => {
    bot.botSettings = parseNormalizedSettings(req.body, bot.botSettings);
    saveSettingsToFile();
    res.json({ success: true, msg: "Đã lưu cài đặt thành công!" });
});

realApp.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body;
    const key = `${symbol}_${side}`;
    const p = bot.botActivePositions.get(key);
    if (p) {
        try {
            await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', p.currentQty, undefined, { positionSide: side });
            bot.botActivePositions.delete(key);
            savePositionsToFile();
            res.json({ success: true });
        } catch (e) { res.json({ success: false, msg: e.message }); }
    } else {
        res.json({ success: false, msg: "Không tìm thấy vị thế" });
    }
});

realApp.post('/api/close_all', async (req, res) => {
    bot.botActivePositions.clear();
    savePositionsToFile();
    res.json({ success: true });
});

realApp.post('/api/demo/reset', (req, res) => {
    demoState.walletBalance = 10000.0;
    demoState.openPositions.clear();
    demoState.history = [];
    demoState.logs = [];
    demoState.closedCount = 0;
    demoState.closedPnl = 0;
    saveDemoState();
    res.json({ success: true });
});

// Demo App on Port 6790 (Shows demo exclusively and independently)
const demoApp = express();
demoApp.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
demoApp.use(express.json());
demoApp.use(express.static(__dirname, { index: false }));

demoApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

demoApp.get('/api/status', (req, res) => {
    res.json({
        botSettings: { ...bot.botSettings, enableDemo: true },
        activePositions: Array.from(demoState.openPositions.values()),
        exchangePositions: [],
        status: {
            botLogs: demoState.logs.map(l => ({ time: l.time, msg: `[DEMO] ${l.msg}` })),
            botClosedCount: demoState.closedCount,
            botPnLClosed: demoState.closedPnl,
            pnlGain: 0, pnlLoss: 0, isReady: true,
            modeStats: sharedState.modeStats,
            topTrendList: sharedState.topTrendList,
            top24hList: sharedState.top24hList,
            topFundingList: sharedState.topFundingList,
            candidatesList: sharedState.candidatesList,
            history: sharedState.history,
            timeRun: formatUptime(bot.startTime)
        },
        wallet: {
            totalWalletBalance: demoState.walletBalance.toFixed(2),
            totalMarginBalance: demoState.walletBalance.toFixed(2),
            availableBalance: demoState.walletBalance.toFixed(2),
            unrealizedPnL: "0.00"
        },
        demo: {
            walletBalance: demoState.walletBalance,
            openCount: demoState.openPositions.size,
            closedPnl: demoState.closedPnl,
            logs: demoState.logs,
            history: demoState.history
        }
    });
});

demoApp.post('/api/settings', (req, res) => {
    bot.botSettings = parseNormalizedSettings(req.body, bot.botSettings);
    bot.botSettings.enableDemo = true;
    saveSettingsToFile();
    res.json({ success: true, msg: "Đã lưu cấu hình Demo!" });
});

demoApp.post('/api/demo/reset', (req, res) => {
    demoState.walletBalance = 10000.0;
    demoState.openPositions.clear();
    demoState.history = [];
    demoState.logs = [];
    demoState.closedCount = 0;
    demoState.closedPnl = 0;
    saveDemoState();
    res.json({ success: true });
});

// Initialize and Start Servers
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
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0),
                maxLeverage: maxLev
            };
        });
        sharedState.exchangeInfo = temp;
        loadSettingsFromFile();
        loadPositionsFromFile();

        bot.status.isReady = true;
        backgroundScanner();

        realApp.listen(REAL_PORT, () => console.log(`🚀 [LUFFY REAL BOT] Chạy tại http://localhost:${REAL_PORT}`));
        demoApp.listen(DEMO_PORT, () => console.log(`🧪 [LUFFY DEMO BOT] Chạy tại http://localhost:${DEMO_PORT}`));
    } catch (e) {
        setTimeout(init, 5000);
    }
}

init();
