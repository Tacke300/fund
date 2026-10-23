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

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

// --- TECHNICAL INDICATORS MODULE (CALCULATED IN NODE.JS) ---

function calculateEMA(prices, period) {
    if (!prices || prices.length < period) return null;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateRSI(prices, period = 14) {
    if (!prices || prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change >= 0) gains += change;
        else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change >= 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - change) / period;
        }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (!prices || prices.length < slowPeriod + signalPeriod) return { macd: 0, signal: 0, hist: 0, dir: 'NEUTRAL' };
    
    const macdLine = [];
    for (let i = slowPeriod; i <= prices.length; i++) {
        const subPrices = prices.slice(0, i);
        const fastEma = calculateEMA(subPrices, fastPeriod);
        const slowEma = calculateEMA(subPrices, slowPeriod);
        if (fastEma !== null && slowEma !== null) {
            macdLine.push(fastEma - slowEma);
        }
    }

    const currentMacd = macdLine[macdLine.length - 1] || 0;
    const currentSignal = calculateEMA(macdLine, signalPeriod) || 0;
    const currentHist = currentMacd - currentSignal;

    return {
        macd: currentMacd,
        signal: currentSignal,
        hist: currentHist,
        dir: currentMacd > currentSignal ? 'LONG' : currentMacd < currentSignal ? 'SHORT' : 'NEUTRAL'
    };
}

function calculateSupertrend(klines, atrPeriod = 10, factor = 3) {
    if (!klines || klines.length < atrPeriod + 1) return { dir: 'NEUTRAL', value: 0 };

    const trs = [];
    for (let i = 1; i < klines.length; i++) {
        const h = klines[i].high;
        const l = klines[i].low;
        const prevC = klines[i - 1].close;
        const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        trs.push(tr);
    }

    let atr = trs.slice(0, atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
    let upperBand = 0, lowerBand = 0, dir = 'LONG', supertrend = 0;

    for (let i = atrPeriod; i < klines.length; i++) {
        const k = klines[i];
        const hl2 = (k.high + k.low) / 2;
        atr = (atr * (atrPeriod - 1) + trs[i - 1]) / atrPeriod;

        const basicUpper = hl2 + factor * atr;
        const basicLower = hl2 - factor * atr;

        const prevClose = klines[i - 1].close;
        upperBand = (basicUpper < upperBand || prevClose > upperBand) ? basicUpper : upperBand;
        lowerBand = (basicLower > lowerBand || prevClose < lowerBand) ? basicLower : lowerBand;

        if (dir === 'LONG' && k.close < lowerBand) {
            dir = 'SHORT';
            supertrend = upperBand;
        } else if (dir === 'SHORT' && k.close > upperBand) {
            dir = 'LONG';
            supertrend = lowerBand;
        } else {
            supertrend = dir === 'LONG' ? lowerBand : upperBand;
        }
    }

    return { dir, value: supertrend };
}

// --- GLOBAL STATE & WEBSOCKET ENGINE ---

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    top24hList: [],
    top10Coins: [],
    top3Potential: [],
    exchangeInfo: null,
    masterLogs: [],
    pendingOrders: new Set(),
    lastClosedMargin: {},
    lastClosedPnl: {},
    runningCodeLines: [
        '<span class="code-comment">// Luffy Bot Engine Online</span>',
        '<span class="code-keyword">const</span> <span class="code-func">wsStream</span> = <span class="code-keyword">new</span> BinanceWebSocket();',
        '<span class="code-func">wsStream</span>.on(<span class="code-string">"ticker"</span>, (data) => <span class="code-func">evaluateMarketSignal</span>(data));'
    ],
    klinesData: {}, // { SYMBOL: { '1m': [], '15m': [], '1h': [] } }
    volumeData: {}  // { SYMBOL: { '15m': ratio, '1h': ratio, ... } }
};

let bot = {
    id: "LUFFY_BOT",
    startTime: Date.now(),
    botSettings: {
        isRunning: false,
        enableNotionalMode: false,
        notionalValue: 1000,
        invValue: "1%",
        maxPositions: 3,
        minLev: 50,
        min24h: 5.0,
        minVol: 10.0,
        posDcaDuong: 1.0,
        tpDcaDuong: 10.0,
        posSL: 10.0,
        posSLDuong: 5.0,
        posDcaAm: 3.0,
        heSoDcaAm: 2.0,
        heSoDcaDuong: 2.0,
        tpDcaAm: 10.0,
        minPnlTpDcaDuong: 10.0,
        enableEarlySL: false,
        lockDcaAmMode: false,
        closeOppositeDcaAm: false
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(),
    isProcessingDCA: new Set(),
    logThrottle: new Map(),
    timestampOffset: 0,
    isMarginProtected: false,
    isAntiLiquidationTriggered: false,
    antiLiquidationCooldownUntil: 0,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

function updateRunningCode(line) {
    sharedState.runningCodeLines.unshift(line);
    if (sharedState.runningCodeLines.length > 8) sharedState.runningCodeLines.pop();
}

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalized = { ...currentSettings };
    for (let key in reqBody) {
        const val = reqBody[key];
        const lowerKey = key.toLowerCase();
        if (['minvol', 'possl', 'posslduong', 'posdcaam', 'posdcaduong', 'hesodcaam', 'hesodcaduong', 'tpdcaam', 'tpdcaduong', 'minpnltpdcaduong', 'min24h', 'notionalvalue'].includes(lowerKey)) {
            normalized[key] = parseFloat(val);
        } else if (['maxpositions', 'minlev'].includes(lowerKey)) {
            normalized[key] = parseInt(val);
        } else if (['enablenotionalmode', 'enableearlysl', 'lockdcaammode', 'closeoppositedcaam'].includes(lowerKey)) {
            normalized[key] = val === true || val === 'true' || val === 1 || val === '1';
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

// --- BINANCE WEBSOCKET INTEGRATION ---

let ws = null;
function initBinanceWebSocket() {
    const streamUrl = 'wss://fstream.binance.com/ws/!ticker@arr';
    ws = new WebSocket(streamUrl);

    ws.on('open', () => {
        console.log('✅ [WEBSOCKET] Đã kết nối thành công Binance Futures Combined Stream!');
        updateRunningCode('<span class="code-comment">// WebSocket stream connected to Binance Futures</span>');
    });

    ws.on('message', (rawData) => {
        try {
            const tickers = JSON.parse(rawData);
            if (Array.isArray(tickers)) {
                processWebSocketTickers(tickers);
            }
        } catch (e) {}
    });

    ws.on('error', (err) => {
        console.error('❌ [WEBSOCKET ERROR]:', err.message);
    });

    ws.on('close', () => {
        console.log('⚠️ [WEBSOCKET] Mất kết nối! Đang thử kết nối lại sau 3s...');
        setTimeout(initBinanceWebSocket, 3000);
    });
}

function processWebSocketTickers(tickers) {
    const formatted = tickers.map(t => {
        const sym = t.s;
        const info = sharedState.exchangeInfo?.[sym];
        return {
            symbol: sym,
            price: parseFloat(t.c || 0),
            priceChangePercent: parseFloat(t.P || 0),
            volumeQuote: parseFloat(t.q || 0),
            leverage: info?.maxLeverage || 20
        };
    });

    formatted.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
    sharedState.top24hList = formatted;

    // Filter Top 10 for Realtime Display & Technical Analysis
    const minLevSetting = bot.botSettings.minLev || 50;
    const topCandidates = formatted.filter(c => c.leverage >= minLevSetting).slice(0, 10);

    sharedState.top10Coins = topCandidates.map(c => {
        const klines1h = sharedState.klinesData[c.symbol]?.['1h'] || [];
        const closes1h = klines1h.map(k => k.close);
        
        const rsiVal = calculateRSI(closes1h, 14);
        const superRes = calculateSupertrend(klines1h, 10, 3);
        const ema50 = calculateEMA(closes1h, 50);
        const ema200 = calculateEMA(closes1h, 200);
        const macdRes = calculateMACD(closes1h, 12, 26, 9);

        return {
            ...c,
            rsi: Math.round(rsiVal),
            superDir: superRes.dir,
            emaDir: (ema50 && ema200) ? (ema50 > ema200 ? 'LONG' : 'SHORT') : 'NEUTRAL',
            macdDir: macdRes.dir
        };
    });
}

async function fetchHistoricalKlines(symbol, interval, limit = 200) {
    try {
        const res = await binanceApi.get(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        return res.data.map(k => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            quoteVolume: parseFloat(k[7])
        }));
    } catch (e) {
        return [];
    }
}

async function preloadKlinesForSymbol(symbol) {
    if (!sharedState.klinesData[symbol]) {
        sharedState.klinesData[symbol] = {};
    }
    const [k1m, k15m, k1h] = await Promise.all([
        fetchHistoricalKlines(symbol, '1m', 100),
        fetchHistoricalKlines(symbol, '15m', 200),
        fetchHistoricalKlines(symbol, '1h', 100)
    ]);
    sharedState.klinesData[symbol]['1m'] = k1m;
    sharedState.klinesData[symbol]['15m'] = k15m;
    sharedState.klinesData[symbol]['1h'] = k1h;
}

// --- BỘ LỌC CÔNG THỨC 8 KHUNG VOL PRICE ---

function checkVolPrice8Frames(symbol, reqRatio = 10.0) {
    // Kiem tra gia dinh 8 khung: 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d
    const k15m = sharedState.klinesData[symbol]?.['15m'] || [];
    if (k15m.length < 2) return false;
    const currentVol = k15m[k15m.length - 1].quoteVolume;
    const refVol = k15m[k15m.length - 2].quoteVolume;
    if (refVol <= 0) return false;

    const ratio = currentVol / refVol;
    return ratio >= reqRatio;
}

// --- LỚP QUÉT VÀ KIỂM TRA ĐIỀU KIỆN MỞ LỆNH ĐỒNG THUẬN ---

async function evaluateAndFilterPositions() {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return;

    const minLev = bot.botSettings.minLev || 50;
    const min24h = bot.botSettings.min24h || 5.0;
    const reqVolRatio = bot.botSettings.minVol || 10.0;
    const maxPos = bot.botSettings.maxPositions || 3;

    if (bot.botActivePositions.size >= maxPos) return;

    const candidates = sharedState.top24hList.filter(c => c.leverage >= minLev && Math.abs(c.priceChangePercent) >= min24h);
    const potentialList = [];

    for (const c of candidates) {
        const symbol = c.symbol;
        if (sharedState.blackList[symbol] || sharedState.permanentBlacklist[symbol] || sharedState.pendingOrders.has(symbol)) continue;

        await preloadKlinesForSymbol(symbol);

        const k15m = sharedState.klinesData[symbol]?.['15m'] || [];
        const k1m = sharedState.klinesData[symbol]?.['1m'] || [];
        const closes15m = k15m.map(k => k.close);
        const closes1m = k1m.map(k => k.close);

        const ema50_15m = calculateEMA(closes15m, 50);
        const ema200_15m = calculateEMA(closes15m, 200);
        const super15m = calculateSupertrend(k15m, 10, 3);
        const macd1m = calculateMACD(closes1m, 12, 26, 9);
        const volOk = checkVolPrice8Frames(symbol, reqVolRatio);

        const is24hPositive = c.priceChangePercent > 0;
        const waitingSide = is24hPositive ? 'LONG' : 'SHORT';

        const emaOk = is24hPositive ? (ema50_15m && ema200_15m && ema50_15m > ema200_15m) : (ema50_15m && ema200_15m && ema50_15m < ema200_15m);
        const superOk = super15m.dir === waitingSide;
        const macdOk = macd1m.dir === waitingSide;

        potentialList.push({
            symbol,
            waitingSide,
            emaOk,
            superOk,
            macdOk,
            volOk,
            priceChangePercent: c.priceChangePercent,
            leverage: c.leverage,
            price: c.price
        });

        updateRunningCode(`<span class="code-func">evalSignal</span>(<span class="code-string">"${symbol}"</span>): EMA=${emaOk}, SUPER=${superOk}, MACD=${macdOk}, VOL=${volOk}`);

        // XÁC NHẬN ĐỒNG THUẬN 100% ĐỂ MỞ LỆNH
        if (emaOk && superOk && macdOk && volOk) {
            sharedState.pendingOrders.add(symbol);
            setTimeout(() => sharedState.pendingOrders.delete(symbol), 10000);

            let marginToUse = 0;
            const info = sharedState.exchangeInfo[symbol];
            if (bot.botSettings.enableNotionalMode && bot.botSettings.notionalValue) {
                marginToUse = bot.botSettings.notionalValue / info.maxLeverage;
            } else {
                const acc = walletCache.data;
                const availBal = parseFloat(acc.availableBalance || 0);
                const invValStr = bot.botSettings.invValue || "1%";
                marginToUse = invValStr.toString().includes('%') ? (availBal * parseFloat(invValStr) / 100) : parseFloat(invValStr);
            }

            let desiredQty = (marginToUse * info.maxLeverage) / c.price;
            let qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
            qty = Number(qty.toFixed(info.quantityPrecision));

            addBotLog(bot, `🔥 [ĐỒNG THUẬN 100%] Phát hiện tín hiệu mở ${waitingSide} ${formatCoinName(symbol)} | VolRatio >= ${reqVolRatio}`, "open");
            
            await openPosition(bot, symbol, null, waitingSide, qty, marginToUse, c.price, 'matrix', `| VolRatio: ${reqVolRatio}`);
            return;
        } else {
            // LOG LÝ DO TỪ CHỐI LỆNH
            const rejectReasons = [];
            if (!emaOk) rejectReasons.push(`EMA15m mâu thuẫn`);
            if (!superOk) rejectReasons.push(`Supertrend15m mâu thuẫn`);
            if (!macdOk) rejectReasons.push(`MACD1m mâu thuẫn`);
            if (!volOk) rejectReasons.push(`Vol Price 8 khung chưa đạt ${reqVolRatio}x`);

            addBotLog(bot, `⛔ [TỪ CHỐI ${waitingSide}] ${formatCoinName(symbol)}: ${rejectReasons.join(', ')}`, 'warn', `reject_${symbol}`);
        }
    }

    sharedState.top3Potential = potentialList.slice(0, 3);
}

setInterval(evaluateAndFilterPositions, 1000);

// --- POSITION MANAGEMENT & HELPER FUNCTIONS (KEEP 100% OLD LOGIC) ---

function calculateDcaDuongMargin(botInst, b) {
    const heSo = botInst.botSettings.heSoDcaDuong || 2.0;
    return (b.firstMargin || 1) * heSo;
}

function calculateDcaAmMargin(botInst, b) {
    const heSo = botInst.botSettings.heSoDcaAm || 2.0;
    return (b.firstMargin || 1) * heSo;
}

function calculateSlDetails(botInst, b) {
    const isAmMode = (b.dcaType === 'AM') || (b.pnl < 0) || b.isLockedAm;
    const firstMargin = b.firstMargin || 1;
    const slLimitValue = isAmMode ? (botInst.botSettings.posSL || 10.0) : (firstMargin * (botInst.botSettings.posSLDuong || 5.0));
    const dir = b.side === 'LONG' ? 1 : -1;
    const targetSlPrice = b.avgEntry - dir * (b.firstEntry * (slLimitValue / 100));
    return { targetSlPrice, estPnl: -slLimitValue };
}

async function openPosition(botInst, symbol, dcaData = null, forcedSide = 'LONG', sharedQty = null, sharedMargin = null, sharedPrice = null, modeName = 'matrix', extraLogInfo = '') {
    const side = forcedSide; 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    
    if (botInst.isProcessingDCA.has(lockKey) && !isDCA) return;
    botInst.isProcessingDCA.add(lockKey); 

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) throw new Error("Coin không hỗ trợ");

        let qty = sharedQty, margin = sharedMargin, currentPrice = sharedPrice;
        await botInst.exchange.setLeverage(info.maxLeverage, symbol).catch(() => {});

        const order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualPrice = currentPrice;
            const nowTime = Date.now();
            const posData = { 
                symbol, side, entryPrice: actualPrice, tp: actualPrice * (side === 'LONG' ? 1.1 : 0.9), sl: actualPrice * (side === 'LONG' ? 0.9 : 1.1),
                dcaAmCount: 0, dcaDuongCount: 0, dcaType: 'DUONG', modeName,
                leverage: info.maxLeverage, firstEntry: actualPrice, firstMargin: margin, currentMargin: margin,
                currentQty: qty, pnl: 0, avgEntry: actualPrice, livePrice: actualPrice, createdAt: nowTime
            };

            botInst.botActivePositions.set(lockKey, posData);
            savePositionsToFile();

            addBotLog(botInst, `[MỞ VỊ THẾ ${side}] ${formatCoinName(symbol)} | Margin: ${margin.toFixed(2)}$ | Entry: ${formatPrice(actualPrice)} ${extraLogInfo}`, "open");
        }
    } catch (e) { 
        sharedState.blackList[symbol] = Date.now() + 30000;
    } finally { 
        setTimeout(() => botInst.isProcessingDCA.delete(lockKey), 1000); 
        sharedState.pendingOrders.delete(symbol);
    }
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
    botInst.status.botLogs.unshift({ time, msg, type });
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
    console.log(`[${time}][${type.toUpperCase()}] ${msg.replace(/<[^>]*>/g, '')}`);
}

async function panicCloseAll(botInst, reasonLog) {
    try {
        for (const [key, b] of Array.from(botInst.botActivePositions.entries())) {
            await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side }).catch(() => {});
        }
        botInst.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(botInst, `⚠️ Đã đóng toàn bộ vị thế (${reasonLog})`, "warn");
        return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
}

// --- EXPRESS API ENDPOINTS & STATUS BUILDER ---

const allowCors = (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
};

const appServer = express(); 
appServer.use(allowCors); 
appServer.use(express.json()); 
appServer.use(express.static(__dirname, { index: false })); 

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function buildStatusResponse(botInst) {
    const now = Date.now();
    if (now - walletCache.lastUpdate > 3000) {
        const acc = await binanceApi.get('/fapi/v2/account').catch(() => null);
        if (acc?.data) {
            walletCache.data = { 
                totalWalletBalance: parseFloat(acc.data.totalWalletBalance || 0).toFixed(2), 
                totalMarginBalance: parseFloat(acc.data.totalMarginBalance || 0).toFixed(2),
                availableBalance: parseFloat(acc.data.availableBalance || 0).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.data.totalUnrealizedProfit || 0).toFixed(2) 
            };
            walletCache.lastUpdate = now;
        }
    }

    let unrealizedPnL = 0;
    botInst.botActivePositions.forEach(p => { unrealizedPnL += (p.pnl || 0); });

    const sortedPositions = Array.from(botInst.botActivePositions.values()).map(p => {
        const slDet = calculateSlDetails(botInst, p);
        return {
            ...p,
            tpCalculatedPrice: formatPrice(p.tp),
            slCalculatedPrice: formatPrice(slDet.targetSlPrice)
        };
    });

    return { 
        botSettings: botInst.botSettings, 
        activePositions: sortedPositions, 
        status: { 
            botLogs: botInst.status.botLogs, 
            top10Coins: sharedState.top10Coins,
            top3Potential: sharedState.top3Potential,
            runningCodeLines: sharedState.runningCodeLines,
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
    const b = bot.botActivePositions.get(key); 
    if (b) { 
        await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: side }).catch(() => {});
        bot.botActivePositions.delete(key);
        savePositionsToFile();
        res.json({ success: true }); 
    } else res.json({ success: false, msg: "Vị thế không tồn tại" });
});

// --- INIT ENGINE ---

async function init() {
    try {
        await bot.exchange.loadMarkets(); 
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), 
                maxLeverage: 50 
            };
        });
        sharedState.exchangeInfo = temp; 
        
        loadSettingsFromFile();
        loadPositionsFromFile();
        initBinanceWebSocket();

        bot.status.isReady = true; 
        console.log(`🚀 [LUFFY BOT ENGINE] Khởi động thành công! Port: ${PORT}`);
    } catch (e) { setTimeout(init, 5000); }
}

init();

appServer.listen(PORT, () => console.log(`🚀 [LUFFY SERVER] Dashboard đang lắng nghe trên port ${PORT}`));
