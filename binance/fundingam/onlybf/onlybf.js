import https from 'https';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(__dirname, 'position_state.json');
const MAXLEV_FILE = path.join(__dirname, 'maxlev.json');
const FUNDING_FILE = path.join(__dirname, 'funding_cache.json');
const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim();
const DEFAULT_SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim();

let userConfig = {
    apiKey: DEFAULT_API_KEY,
    secretKey: DEFAULT_SECRET_KEY,
    maxOpenPositions: 1,
    amountMode: 'percent',
    amountValue: 25,
    tpFixedPercent: 1,
    enableTrailing: false,
    tpTrailingPercent: 1,
    slPercent: 2,
    shortOffsetMs: 0,
    fundingThreshold: 0.3,
    tradeModes: ['before'], // Hỗ trợ đa chế độ: 'before', 'always', 'rsi'
    sortMode: 'pnl',
    holdMinutes: 15,
    enablePriceTrigger: false,
    priceTriggerPct: 5,
    enableRsiConfirm: false,
    rsiTimeframe: '5m',
    rsiPeriod: 14
};

let blacklistMap = {};
let pendingLocks = {}; 
let openingSymbols = new Set();
let rsiCache = {};

function isBlacklisted(symbol) {
    const unlockTime = blacklistMap[symbol];
    if (!unlockTime) return false;
    if (Date.now() < unlockTime) return true;
    delete blacklistMap[symbol];
    return false;
}

function addToBlacklist(symbol) {
    blacklistMap[symbol] = Date.now() + 999999999999;
}

function unlockBlacklistWith15MinDelay(symbol) {
    blacklistMap[symbol] = Date.now() + 15 * 60 * 1000;
}

function saveDataPositionsToFile() {
    try {
        const dataObj = {
            currentMainPositions
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataObj, null, 2), 'utf8');
    } catch (e) {}
}

function loadDataPositionsFromFile() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            return {
                mainPositions: Array.isArray(data.currentMainPositions) ? data.currentMainPositions : (Array.isArray(data.mainPositions) ? data.mainPositions : [])
            };
        }
    } catch (e) {}
    return { mainPositions: [] };
}

function getErrorMessage(error) {
    if (!error) return 'Không xác định';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    if (error.msg) return error.msg;
    if (typeof error === 'object') {
        try {
            return JSON.stringify(error);
        } catch (e) {
            return String(error);
        }
    }
    return String(error);
}

function loadConfigFromFile() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE, 'utf8');
            const savedConfig = JSON.parse(rawData);
            userConfig = { ...userConfig, ...savedConfig };
            if (savedConfig.tradeMode && !savedConfig.tradeModes) {
                userConfig.tradeModes = [savedConfig.tradeMode];
            }
            if (savedConfig.enableAlwaysPriceTrigger !== undefined && savedConfig.enablePriceTrigger === undefined) {
                userConfig.enablePriceTrigger = savedConfig.enableAlwaysPriceTrigger;
            }
            if (savedConfig.alwaysPriceTriggerPct !== undefined && savedConfig.priceTriggerPct === undefined) {
                userConfig.priceTriggerPct = savedConfig.alwaysPriceTriggerPct;
            }
        }
    } catch (error) {}
}

function saveConfigToFile() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(userConfig, null, 2), 'utf8');
    } catch (error) {}
}

loadConfigFromFile();

const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0;
let exchangeInfoCache = null;
let leverageCache = {};
let botRunning = false;
let botStartTime = null;

let currentMainPositions = [];

let mainCheckInterval = null;
let schedulerTimeout = null;
let scheduledMainTimeout = null;
let antiLiquidationInterval = null;

let isOpeningPosition = false;
let lastOrderOpenTime = 0;

let consecutiveApiErrors = 0;
const MAX_CONSECUTIVE_API_ERRORS = 10;
const memoryLogs = [];
const MAX_LOG_SIZE = 1000;
const logCounts = {};
const LOG_COOLDOWN_MS = 60000;

const WEB_SERVER_PORT = 9999;

let globalStats = {
    totalSessions: 0,
    totalPnl: 0
};

let cachedFundingRates = [];
let lastFundingFetchTime = 0;
const FUNDING_CACHE_TTL = 30000;

let cachedDashboardData = null;
let lastDashboardFetchTime = 0;
const DASHBOARD_CACHE_TTL = 1000;

// CẬP NHẬT ĐỈNH/ĐÁY HÀNG CHỜ TRONG 5 PHÚT
function update5MinExtremePrice(item, currentPrice, side) {
    const now = Date.now();
    if (!item.priceHistory) item.priceHistory = [];
    
    item.priceHistory.push({ price: currentPrice, time: now });
    item.priceHistory = item.priceHistory.filter(p => (now - p.time) <= 300000);
    
    if (side === 'SHORT') {
        item.extremePrice = Math.max(...item.priceHistory.map(p => p.price));
    } else {
        item.extremePrice = Math.min(...item.priceHistory.map(p => p.price));
    }
}

// CẬP NHẬT ĐỈNH/ĐÁY CHO VỊ THẾ ĐANG MỞ TỪ LÚC VÀO LỆNH (SỬA LỖI TRAILING TP)
function updatePositionExtremePrice(pos, currentPrice, side) {
    if (pos.extremePrice === undefined || pos.extremePrice === null) {
        pos.extremePrice = pos.entryPrice || currentPrice;
    }
    if (side === 'LONG') {
        pos.extremePrice = Math.max(pos.extremePrice, currentPrice);
    } else {
        pos.extremePrice = Math.min(pos.extremePrice, currentPrice);
    }
}

function calculateRSIFromPrices(closes, period = 14) {
    if (!closes || closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }
    if (avgLoss === 0) return 100;
    let rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

async function fetchRsiData(symbol, timeframe = '5m', period = 14) {
    const key = `${symbol}_${timeframe}`;
    const now = Date.now();
    if (rsiCache[key] && (now - rsiCache[key].updatedAt < 10000)) {
        return rsiCache[key];
    }
    try {
        const klines = await callPublicAPI('/fapi/v1/klines', { symbol, interval: timeframe, limit: 60 });
        if (!Array.isArray(klines) || klines.length < period + 1) return null;
        const closes = klines.map(k => parseFloat(k[4]));
        const currentRsi = calculateRSIFromPrices(closes, period);

        let prev = rsiCache[key] || {
            rsiPeak: null,
            rsiTrough: null,
            minRsiSincePeak: 100,
            maxRsiSinceTrough: 0
        };

        let rsiPeak = prev.rsiPeak;
        let rsiTrough = prev.rsiTrough;
        let minRsiSincePeak = prev.minRsiSincePeak;
        let maxRsiSinceTrough = prev.maxRsiSinceTrough;

        // Xử lý Quá Mua (> 70) cho Short
        if (currentRsi >= 70) {
            if (rsiPeak === null || currentRsi > rsiPeak) {
                rsiPeak = currentRsi;
            }
            minRsiSincePeak = currentRsi;
        } else if (rsiPeak !== null) {
            if (currentRsi < minRsiSincePeak) {
                minRsiSincePeak = currentRsi;
            }
            // Nếu bị hồi 20 RSI từ min hoặc đã xuống <= 20 quá bán => Hủy đỉnh
            if ((currentRsi - minRsiSincePeak) >= 20 || currentRsi <= 20) {
                rsiPeak = null;
                minRsiSincePeak = 100;
            }
        }

        // Xử lý Quá Bán (< 30) cho Long
        if (currentRsi <= 30) {
            if (rsiTrough === null || currentRsi < rsiTrough) {
                rsiTrough = currentRsi;
            }
            maxRsiSinceTrough = currentRsi;
        } else if (rsiTrough !== null) {
            if (currentRsi > maxRsiSinceTrough) {
                maxRsiSinceTrough = currentRsi;
            }
            // Nếu bị giảm 20 RSI từ max hoặc đã vượt >= 70 quá mua => Hủy đáy
            if ((maxRsiSinceTrough - currentRsi) >= 20 || currentRsi >= 70) {
                rsiTrough = null;
                maxRsiSinceTrough = 0;
            }
        }

        const rsiInfo = {
            currentRsi,
            rsiPeak,
            rsiTrough,
            minRsiSincePeak,
            maxRsiSinceTrough,
            updatedAt: now
        };
        rsiCache[key] = rsiInfo;
        return rsiInfo;
    } catch (e) {
        return rsiCache[key] || null;
    }
}

function formatTime(date = new Date()) {
    const utc7 = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    const hours = String(utc7.getUTCHours()).padStart(2, '0');
    const minutes = String(utc7.getUTCMinutes()).padStart(2, '0');
    const seconds = String(utc7.getUTCSeconds()).padStart(2, '0');
    const ms = String(utc7.getUTCMilliseconds()).padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
}

function formatPrice(val) {
    if (val === null || val === undefined || isNaN(val)) return '0.00';
    const num = parseFloat(val);
    return parseFloat(num.toFixed(6)).toString();
}

function formatNumber(val) {
    if (val === null || val === undefined || isNaN(val)) return '0';
    return parseFloat(parseFloat(val).toFixed(6)).toString();
}

function formatQty(symbol, amount) {
    if (exchangeInfoCache && exchangeInfoCache[symbol] && exchangeInfoCache[symbol].quantityPrecision !== undefined) {
        return parseFloat(Math.abs(amount)).toFixed(exchangeInfoCache[symbol].quantityPrecision);
    }
    return Math.abs(amount).toString();
}

function formatDuration(startTimeMs) {
    if (!startTimeMs) return '00s';
    const elapsedSec = Math.floor((Date.now() - startTimeMs) / 1000);
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    if (mins > 0) {
        return `${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
    }
    return `${String(secs).padStart(2, '0')}s`;
}

function log(level, moduleName, message) {
    const timestamp = formatTime();
    const formattedLog = `[${timestamp}] [${level}] [${moduleName}] ${message}`;

    const plainTextMsg = formattedLog.replace(/<[^>]*>?/gm, '');
    const messageHash = crypto.createHash('md5').update(plainTextMsg).digest('hex');
    const now = Date.now();

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        if ((now - logCounts[messageHash].lastLoggedTime) < LOG_COOLDOWN_MS) {
            return;
        } else {
            logCounts[messageHash] = { count: 1, lastLoggedTime: new Date(now) };
        }
    } else {
        logCounts[messageHash] = { count: 1, lastLoggedTime: new Date(now) };
    }

    console.log(plainTextMsg);
    memoryLogs.push(formattedLog);
    if (memoryLogs.length > MAX_LOG_SIZE) memoryLogs.shift();
}

function saveStateToFile() {
    try {
        const stateData = {
            currentMainPositions,
            botRunning,
            globalStats
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2), 'utf8');
    } catch (e) {}
}

function loadStateFromFile() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (Array.isArray(data.currentMainPositions)) {
                currentMainPositions = data.currentMainPositions;
            } else if (data.currentMainPosition) {
                currentMainPositions = [data.currentMainPosition];
            } else {
                currentMainPositions = [];
            }

            if (data.botRunning !== undefined) botRunning = data.botRunning;
            if (data.globalStats) globalStats = data.globalStats;
        }
    } catch (e) {}
}

class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = { hostname, path, method, headers };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    let errorDetails = { code: res.statusCode, msg: res.statusMessage };
                    try { errorDetails = { ...errorDetails, ...JSON.parse(data) }; } catch (e) {}
                    reject(errorDetails);
                }
            });
        });
        req.on('error', e => reject({ code: 'NETWORK_ERROR', msg: e.message }));
        if (method === 'POST' && postData) req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!userConfig.apiKey || !userConfig.secretKey) {
        throw new CriticalApiError("Thiếu API Key hoặc Secret Key.");
    }
    const timestamp = Date.now() + serverTimeOffset;
    let queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
    const signature = createSignature(queryString, userConfig.secretKey);

    let requestPath, requestBody = '', headers = { 'X-MBX-APIKEY': userConfig.apiKey };

    if (method === 'GET' || method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else if (method === 'POST') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        throw error;
    }
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    const fullPath = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');
    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPath, { 'Content-Type': 'application/json' });
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        throw error;
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = data.serverTime - Date.now();
    } catch (error) {
        throw error;
    }
}

function loadLeverageFromFile() {
    try {
        if (fs.existsSync(MAXLEV_FILE)) {
            const raw = fs.readFileSync(MAXLEV_FILE, 'utf8');
            const json = JSON.parse(raw);
            if (json.data && (Date.now() - (json.lastUpdated || 0)) < 8 * 3600 * 1000) {
                leverageCache = json.data;
                return true;
            }
        }
    } catch (e) {}
    return false;
}

function saveLeverageToFile() {
    try {
        const json = { lastUpdated: Date.now(), data: leverageCache };
        fs.writeFileSync(MAXLEV_FILE, JSON.stringify(json, null, 2), 'utf8');
    } catch (e) {}
}

async function updateAllLeverageCache(force = false) {
    try {
        if (!force && loadLeverageFromFile()) {
            return;
        }
        if (!userConfig.apiKey || !userConfig.secretKey) return;
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET');
        if (Array.isArray(response)) {
            response.forEach(item => {
                const brackets = item.brackets || [];
                brackets.sort((a, b) => b.initialLeverage - a.initialLeverage);
                leverageCache[item.symbol] = brackets.length > 0 ? brackets[0].initialLeverage : 20;
            });
            saveLeverageToFile();
        }
    } catch (error) {}
}

function getLeverageFromCache(symbol) {
    return leverageCache[symbol] || 20;
}

async function setLeverage(symbol, leverage) {
    try {
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });
        return true;
    } catch (error) { return false; }
}

async function ensureCrossMargin(symbol) {
    try {
        await callSignedAPI('/fapi/v1/marginType', 'POST', {
            symbol: symbol,
            marginType: 'CROSSED'
        });
    } catch (e) {}
}

async function getExchangeInfo() {
    if (exchangeInfoCache) return exchangeInfoCache;
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            exchangeInfoCache[s.symbol] = {
                minQty: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE')?.minQty || 0),
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize || 0.001),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0),
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: parseFloat(s.filters.find(f => f.filterType === 'PRICE_FILTER')?.tickSize || 0.001)
            };
        });
        return exchangeInfoCache;
    } catch (error) { throw error; }
}

async function getAllPricesMap() {
    try {
        const list = await callPublicAPI('/fapi/v1/ticker/price');
        const map = {};
        if (Array.isArray(list)) {
            for (let i = 0; i < list.length; i++) {
                map[list[i].symbol] = parseFloat(list[i].price);
            }
        }
        return map;
    } catch (e) {
        return {};
    }
}

async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol });
        return parseFloat(data.price);
    } catch (error) {
        return null;
    }
}

async function aggressiveCleanup(symbol) {
    try {
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        for (const pos of positions) {
            const amt = parseFloat(pos.positionAmt);
            if (Math.abs(amt) > 0) {
                const side = amt > 0 ? 'SELL' : 'BUY';
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol, side: side, positionSide: pos.positionSide, type: 'MARKET', quantity: formatQty(symbol, amt)
                });
            }
        }
    } catch (e) {}
}

function fetchAndLogRealizedPnL(symbol, positionSide, isTest = false) {
    const closeTime = Date.now();
    setTimeout(async () => {
        try {
            const trades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol, limit: 25 });
            const closeTrades = trades.filter(t => 
                t.time >= closeTime - 10000 && 
                t.realizedPnl !== "0" && 
                (t.positionSide === positionSide || t.positionSide === 'BOTH')
            );
            
            const totalPnl = closeTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            
            if (!isTest) {
                globalStats.totalPnl += totalPnl;
                saveStateToFile();
            }
            
            log('PNL', 'PNL', `💰 Kết quả giao dịch chuẩn xác từ sàn | Coin: ${symbol} | Position: ${positionSide} | PnL chốt thực tế: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT ${isTest ? '(TEST)' : ''}`);
        } catch (e) {
            log('ERROR', 'PNL', `✖ Lỗi tổng hợp PnL cho ${symbol}: ${getErrorMessage(e)}`);
        }
    }, 3000);
}

function calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage) {
    let exchangeMinNotional = symbolInfo ? (symbolInfo.minNotional || 5.0) : 5.0;
    let minQty = symbolInfo ? (symbolInfo.minQty || 0) : 0;
    let minQtyNotional = minQty * currentPrice;

    let requiredNotional = Math.max(5.5, exchangeMinNotional, minQtyNotional);
    let targetNotional = initialMargin * leverage;

    if (targetNotional < requiredNotional) {
        targetNotional = requiredNotional;
    }

    let qtyRaw = targetNotional / currentPrice;
    let step = symbolInfo ? (symbolInfo.stepSize || 0.001) : 0.001;
    let precision = (symbolInfo && symbolInfo.quantityPrecision !== undefined) ? symbolInfo.quantityPrecision : 3;

    let quantity = Math.ceil(qtyRaw / step) * step;

    if (quantity * currentPrice < requiredNotional) {
        quantity += step;
    }

    if (symbolInfo && symbolInfo.minQty && quantity < symbolInfo.minQty) {
        quantity = symbolInfo.minQty;
    }

    return parseFloat(quantity.toFixed(precision));
}

async function executeMarketOrderWithMinVolCheck(symbol, side, positionSide, quantity, currentPrice) {
    const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
    try {
        return await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: orderSide, positionSide: positionSide, type: 'MARKET', quantity: quantity
        });
    } catch (error) {
        try {
            const exInfo = await callPublicAPI('/fapi/v1/exchangeInfo');
            const sInfo = exInfo.symbols.find(s => s.symbol === symbol);
            if (sInfo) {
                const minNotionalFilter = sInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
                const lotSizeFilter = sInfo.filters.find(f => f.filterType === 'LOT_SIZE');
                const minNotional = parseFloat(minNotionalFilter?.notional || 5.0);
                const minQty = parseFloat(lotSizeFilter?.minQty || 0);
                const stepSize = parseFloat(lotSizeFilter?.stepSize || 0.001);
                
                let reqNotional = Math.max(5.5, minNotional, minQty * currentPrice);
                let newQtyRaw = reqNotional / currentPrice;
                let newQty = Math.ceil(newQtyRaw / stepSize) * stepSize;
                if (newQty < minQty) newQty = minQty;
                let formattedQty = parseFloat(newQty.toFixed(sInfo.quantityPrecision));

                return await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol, side: orderSide, positionSide: positionSide, type: 'MARKET', quantity: formattedQty
                });
            }
        } catch (retryErr) {}
        throw error;
    }
}

function loadFundingFromFile() {
    try {
        if (fs.existsSync(FUNDING_FILE)) {
            const raw = fs.readFileSync(FUNDING_FILE, 'utf8');
            const json = JSON.parse(raw);
            if (Array.isArray(json.data) && (Date.now() - (json.lastUpdated || 0)) < FUNDING_CACHE_TTL) {
                cachedFundingRates = json.data;
                lastFundingFetchTime = json.lastUpdated;
                return true;
            }
        }
    } catch (e) {}
    return false;
}

function saveFundingToFile() {
    try {
        const json = { lastUpdated: lastFundingFetchTime, data: cachedFundingRates };
        fs.writeFileSync(FUNDING_FILE, JSON.stringify(json, null, 2), 'utf8');
    } catch (e) {}
}

async function fetchFundingDataFromBinance(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedFundingRates.length > 0 && (now - lastFundingFetchTime < FUNDING_CACHE_TTL)) {
        return cachedFundingRates;
    }
    if (!forceRefresh && loadFundingFromFile()) {
        return cachedFundingRates;
    }

    if (!exchangeInfoCache) await getExchangeInfo();
    const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
    
    let valid = allFunding.filter(item => 
        item.symbol.endsWith('USDT') && 
        exchangeInfoCache && exchangeInfoCache[item.symbol] && 
        item.nextFundingTime > now 
    );

    valid.forEach(item => {
        const lev = getLeverageFromCache(item.symbol);
        const fdValue = parseFloat(item.lastFundingRate);
        item.estPnl = lev * (Math.abs(fdValue) * 100); 
        item.fdType = fdValue >= 0 ? 'positive' : 'negative';
        item.lev = lev;
        item.timeToFunding = item.nextFundingTime - now;
    });

    valid.sort((a, b) => {
        const timeDiff = a.nextFundingTime - b.nextFundingTime;
        if (Math.abs(timeDiff) > 60000) { 
            return timeDiff; 
        }
        return b.estPnl - a.estPnl; 
    });

    cachedFundingRates = valid;
    lastFundingFetchTime = now;
    saveFundingToFile();
    return cachedFundingRates;
}

function getFilteredCandidates(allFunding, reqThreshold = null, targetFundingTime = null) {
    let valid = [...allFunding];
    valid = valid.filter(item => !isBlacklisted(item.symbol));

    if (targetFundingTime !== null) {
        valid = valid.filter(item => Math.abs(item.nextFundingTime - targetFundingTime) <= 60000);
    }
    if (reqThreshold !== null) {
        valid = valid.filter(item => {
            const frPercent = Math.abs(parseFloat(item.lastFundingRate)) * 100;
            if (userConfig.sortMode === 'pnl') {
                return (item.estPnl || 0) >= reqThreshold;
            } else {
                return frPercent >= reqThreshold;
            }
        });
    }
    return valid;
}

function hasActivePositionForSymbol(symbol) {
    return currentMainPositions.some(p => p.symbol === symbol);
}

// MỞ LỆNH CHUNG DÀNH CHO CÁC MỐI MỞ LỆNH AUTO
async function executeOpenSequence(symbol, leverage, nextFundingTime, side, mode, estPnl, currentPrice) {
    await setLeverage(symbol, leverage);
    await ensureCrossMargin(symbol);
    await aggressiveCleanup(symbol);

    const acc = await callSignedAPI('/fapi/v2/account', 'GET');
    const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

    const symbolInfo = exchangeInfoCache[symbol];
    let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
    let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);

    await openMainPosition(symbol, quantity, nextFundingTime, side, false, estPnl, mode);
}

// XỬ LÝ QUÉT VÀ MỞ LỆNH HÀNG CHỜ (CẢ CHẾ ĐỘ ALWAYS VÀ CHẾ ĐỘ RSI)
async function executePendingScan() {
    if (!botRunning || isOpeningPosition) return;

    const maxAllowed = userConfig.maxOpenPositions || 1;
    if (currentMainPositions.length >= maxAllowed) return;

    try {
        const modes = userConfig.tradeModes || ['before'];
        const hasAlways = modes.includes('always');
        const hasRsi = modes.includes('rsi');

        if (!hasAlways && !hasRsi) return;

        const allFunding = await fetchFundingDataFromBinance(false);
        if (!allFunding || allFunding.length === 0) return;

        const pricesMap = await getAllPricesMap();
        const enableTrigger = userConfig.enablePriceTrigger;
        const triggerPct = userConfig.priceTriggerPct || 0;
        const rsiTf = userConfig.rsiTimeframe || '5m';
        const rsiPeriod = userConfig.rsiPeriod || 14;

        // 1. QUÉT DÀNH CHO CHẾ ĐỘ ALWAYS (ĐẠT NGƯỠNG FUNDING RATE)
        if (hasAlways) {
            const candidatesAlways = getFilteredCandidates(allFunding, userConfig.fundingThreshold, null);

            for (const sym in pendingLocks) {
                if (pendingLocks[sym].mode === 'always' && (!candidatesAlways.some(c => c.symbol === sym) || hasActivePositionForSymbol(sym))) {
                    delete pendingLocks[sym];
                }
            }

            for (const candidate of candidatesAlways) {
                if (currentMainPositions.length >= maxAllowed) break;

                const symbol = candidate.symbol;
                if (hasActivePositionForSymbol(symbol) || openingSymbols.has(symbol)) {
                    delete pendingLocks[symbol];
                    continue;
                }

                const currentPrice = pricesMap[symbol];
                if (!currentPrice) continue;

                const leverage = candidate.lev;
                const isNegative = candidate.fdType === 'negative';
                const mainSide = isNegative ? 'SHORT' : 'LONG';

                let lock = pendingLocks[symbol];
                if (!lock || lock.mode !== 'always' || lock.side !== mainSide) {
                    pendingLocks[symbol] = {
                        symbol: symbol, mode: 'always', fdRate: parseFloat(candidate.lastFundingRate),
                        fdType: candidate.fdType, side: mainSide, lev: leverage,
                        priceHistory: [{ price: currentPrice, time: Date.now() }],
                        extremePrice: currentPrice, lockTime: Date.now(),
                        targetFundingTime: candidate.nextFundingTime, estPnl: candidate.estPnl,
                        lastCurrentPrice: currentPrice
                    };
                    lock = pendingLocks[symbol];
                    log('INFO', 'ALWAYS', `🔒 [HÀNG CHỜ ALWAYS] ${symbol} đạt FD ${(parseFloat(candidate.lastFundingRate) * 100).toFixed(4)}% | Hướng: ${mainSide}`);
                } else {
                    lock.lastCurrentPrice = currentPrice;
                    lock.fdRate = parseFloat(candidate.lastFundingRate);
                    lock.estPnl = candidate.estPnl;
                    update5MinExtremePrice(lock, currentPrice, mainSide);
                }

                // Kiểm tra điều kiện RSI nếu bật xác nhận RSI
                let rsiValid = true;
                if (userConfig.enableRsiConfirm) {
                    const rsiData = await fetchRsiData(symbol, rsiTf, rsiPeriod);
                    if (rsiData) {
                        lock.currentRsi = rsiData.currentRsi;
                        lock.rsiPeak = rsiData.rsiPeak;
                        lock.rsiTrough = rsiData.rsiTrough;

                        if (mainSide === 'SHORT') {
                            rsiValid = (rsiData.rsiPeak !== null && rsiData.rsiPeak >= 70 && rsiData.currentRsi >= 21 && rsiData.currentRsi <= 69);
                        } else {
                            rsiValid = (rsiData.rsiTrough !== null && rsiData.rsiTrough <= 30 && rsiData.currentRsi >= 21 && rsiData.currentRsi <= 69);
                        }
                    } else {
                        rsiValid = false;
                    }
                }

                let isTriggered = false;
                if (!enableTrigger) {
                    isTriggered = rsiValid;
                } else {
                    const extremePrice = lock.extremePrice;
                    if (mainSide === 'LONG') {
                        const targetPrice = extremePrice * (1 + triggerPct / 100);
                        if (currentPrice >= targetPrice && rsiValid) isTriggered = true;
                    } else {
                        const targetPrice = extremePrice * (1 - triggerPct / 100);
                        if (currentPrice <= targetPrice && rsiValid) isTriggered = true;
                    }
                }

                if (isTriggered) {
                    if (currentMainPositions.length >= maxAllowed) {
                        delete pendingLocks[symbol];
                        break;
                    }
                    delete pendingLocks[symbol];
                    openingSymbols.add(symbol);

                    (async () => {
                        try {
                            isOpeningPosition = true;
                            log('SUCCESS', 'ALWAYS', `🎯 [ALWAYS MODE] Mở ngay vị thế ${mainSide} cho ${symbol}`);
                            await executeOpenSequence(symbol, leverage, candidate.nextFundingTime, mainSide, 'always', candidate.estPnl, currentPrice);
                        } catch (e) {
                            log('ERROR', 'ALWAYS', `✖ Lỗi mở vị thế ${symbol}: ${getErrorMessage(e)}`);
                        } finally {
                            openingSymbols.delete(symbol);
                            setTimeout(() => { isOpeningPosition = false; }, 3000);
                        }
                    })();

                    if (currentMainPositions.length + 1 >= maxAllowed) break;
                }
            }
        }

        // 2. QUÉT DÀNH CHO CHẾ ĐỘ RSI (BỎ QUA NGƯỠNG FUNDING RATE)
        if (hasRsi && currentMainPositions.length < maxAllowed) {
            for (const candidate of allFunding) {
                if (currentMainPositions.length >= maxAllowed) break;
                const symbol = candidate.symbol;

                if (isBlacklisted(symbol) || hasActivePositionForSymbol(symbol) || openingSymbols.has(symbol)) {
                    if (pendingLocks[symbol] && pendingLocks[symbol].mode === 'rsi') delete pendingLocks[symbol];
                    continue;
                }
                if (pendingLocks[symbol] && pendingLocks[symbol].mode === 'always') continue;

                const rsiData = await fetchRsiData(symbol, rsiTf, rsiPeriod);
                if (!rsiData) continue;

                const currentPrice = pricesMap[symbol];
                if (!currentPrice) continue;

                const isShortRsi = (rsiData.rsiPeak !== null && rsiData.rsiPeak >= 70);
                const isLongRsi = (rsiData.rsiTrough !== null && rsiData.rsiTrough <= 30);

                if (!isShortRsi && !isLongRsi) {
                    if (pendingLocks[symbol] && pendingLocks[symbol].mode === 'rsi') {
                        delete pendingLocks[symbol];
                    }
                    continue;
                }

                const side = isShortRsi ? 'SHORT' : 'LONG';
                const leverage = candidate.lev;

                let lock = pendingLocks[symbol];
                if (!lock || lock.mode !== 'rsi' || lock.side !== side) {
                    pendingLocks[symbol] = {
                        symbol: symbol, mode: 'rsi', fdRate: parseFloat(candidate.lastFundingRate),
                        fdType: candidate.fdType, side: side, lev: leverage,
                        priceHistory: [{ price: currentPrice, time: Date.now() }],
                        extremePrice: currentPrice, lockTime: Date.now(),
                        targetFundingTime: candidate.nextFundingTime, estPnl: candidate.estPnl,
                        lastCurrentPrice: currentPrice,
                        currentRsi: rsiData.currentRsi, rsiPeak: rsiData.rsiPeak, rsiTrough: rsiData.rsiTrough
                    };
                    log('INFO', 'RSI', `🔒 [HÀNG CHỜ RSI] ${symbol} đạt vùng Quá Mua/Bán (RSI: ${rsiData.currentRsi.toFixed(1)}) | Hướng: ${side}`);
                    lock = pendingLocks[symbol];
                } else {
                    lock.lastCurrentPrice = currentPrice;
                    lock.currentRsi = rsiData.currentRsi;
                    lock.rsiPeak = rsiData.rsiPeak;
                    lock.rsiTrough = rsiData.rsiTrough;
                    update5MinExtremePrice(lock, currentPrice, side);
                }

                let rsiConditionMet = false;
                if (side === 'SHORT') {
                    rsiConditionMet = (rsiData.rsiPeak !== null && rsiData.rsiPeak >= 70 && rsiData.currentRsi >= 21 && rsiData.currentRsi <= 69);
                } else {
                    rsiConditionMet = (rsiData.rsiTrough !== null && rsiData.rsiTrough <= 30 && rsiData.currentRsi >= 21 && rsiData.currentRsi <= 69);
                }

                let isTriggered = false;
                if (!enableTrigger) {
                    isTriggered = rsiConditionMet;
                } else {
                    const extremePrice = lock.extremePrice;
                    if (side === 'LONG') {
                        const targetPrice = extremePrice * (1 + triggerPct / 100);
                        if (currentPrice >= targetPrice && rsiConditionMet) isTriggered = true;
                    } else {
                        const targetPrice = extremePrice * (1 - triggerPct / 100);
                        if (currentPrice <= targetPrice && rsiConditionMet) isTriggered = true;
                    }
                }

                if (isTriggered) {
                    if (currentMainPositions.length >= maxAllowed) {
                        delete pendingLocks[symbol];
                        break;
                    }
                    delete pendingLocks[symbol];
                    openingSymbols.add(symbol);

                    (async () => {
                        try {
                            isOpeningPosition = true;
                            log('SUCCESS', 'RSI', `🎯 [RSI MODE] Kích hoạt mở vị thế ${side} cho ${symbol}`);
                            await executeOpenSequence(symbol, leverage, candidate.nextFundingTime, side, 'rsi', candidate.estPnl, currentPrice);
                        } catch (e) {
                            log('ERROR', 'RSI', `✖ Lỗi mở vị thế ${symbol}: ${getErrorMessage(e)}`);
                        } finally {
                            openingSymbols.delete(symbol);
                            setTimeout(() => { isOpeningPosition = false; }, 3000);
                        }
                    })();

                    if (currentMainPositions.length + 1 >= maxAllowed) break;
                }
            }
        }

    } catch (e) {
        log('ERROR', 'SCAN', `✖ Lỗi quét hàng chờ pending scan: ${getErrorMessage(e)}`);
    }
}

async function armT2MinuteScheduler() {
    if (!botRunning) return;
    
    clearTimeout(schedulerTimeout);

    const modes = userConfig.tradeModes || ['before'];
    if (modes.includes('always') || modes.includes('rsi')) {
        executePendingScan().catch(e => {});
    }

    if (!modes.includes('before')) {
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 3000);
        return;
    }
    
    try {
        const allFunding = await fetchFundingDataFromBinance(false);
        if (!allFunding || allFunding.length === 0) {
            schedulerTimeout = setTimeout(armT2MinuteScheduler, 30000);
            return;
        }

        const nearestFdTime = Math.min(...allFunding.map(item => item.nextFundingTime));
        const nowServer = Date.now() + serverTimeOffset;
        
        const t2TargetTime = nearestFdTime - 120000;
        const msToWait = t2TargetTime - nowServer;

        if (msToWait > 0) {
            schedulerTimeout = setTimeout(() => {
                executeT2MinuteSingleScan(nearestFdTime);
            }, msToWait);
        } else {
            executeT2MinuteSingleScan(nearestFdTime);
        }
    } catch (e) {
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 15000);
    }
}

async function executeT2MinuteSingleScan(targetFundingTime) {
    if (!botRunning) return;
    
    const maxAllowed = userConfig.maxOpenPositions || 1;
    if (currentMainPositions.length >= maxAllowed) {
        log('INFO', 'SCAN', `ℹ Đã đạt tối đa số lệnh cho phép mở (${currentMainPositions.length}/${maxAllowed}). Bỏ qua lượt quét Before Funding.`);
        const msAfterFunding = targetFundingTime + 30000 - Date.now();
        schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(msAfterFunding, 60000));
        return;
    }

    try {
        isOpeningPosition = true;
        const allFunding = await fetchFundingDataFromBinance(true);
        const candidates = getFilteredCandidates(allFunding, userConfig.fundingThreshold, targetFundingTime);

        if (candidates.length === 0) {
            const timeStr = new Date(targetFundingTime + 7*3600000).toISOString().substr(11, 8);
            log('WARN', 'SCAN', `⚠️ Không có coin nào tới giờ Funding (${timeStr} UTC+7) đủ điều kiện threshold (>=${userConfig.fundingThreshold}%). Bỏ qua lượt này.`);
            isOpeningPosition = false;
            const timeToNextFd = targetFundingTime - (Date.now() + serverTimeOffset);
            schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(timeToNextFd + 10000, 30000));
            return;
        }

        const best = candidates[0];
        const leverage = best.lev;
        const nowServer = Date.now() + serverTimeOffset;
        const timeStr = new Date(targetFundingTime + 7*3600000).toISOString().substr(11, 8);

        if (hasActivePositionForSymbol(best.symbol)) {
            log('INFO', 'BEFORE', `ℹ Coin ${best.symbol} đã có vị thế mở. Bỏ qua lượt này để tránh mở trùng.`);
            isOpeningPosition = false;
            const timeToNextFd = targetFundingTime - nowServer;
            schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(timeToNextFd + 10000, 30000));
            return;
        }

        // Kiểm tra điều kiện RSI nếu bật xác nhận
        if (userConfig.enableRsiConfirm) {
            const rsiTf = userConfig.rsiTimeframe || '5m';
            const rsiPeriod = userConfig.rsiPeriod || 14;
            const rsiData = await fetchRsiData(best.symbol, rsiTf, rsiPeriod);
            const isNegative = best.fdType === 'negative';
            const side = isNegative ? 'SHORT' : 'LONG';

            let rsiValid = false;
            if (rsiData) {
                if (side === 'SHORT') {
                    rsiValid = (rsiData.rsiPeak !== null && rsiData.rsiPeak >= 70 && rsiData.currentRsi >= 21 && rsiData.currentRsi <= 69);
                } else {
                    rsiValid = (rsiData.rsiTrough !== null && rsiData.rsiTrough <= 30 && rsiData.currentRsi >= 21 && rsiData.currentRsi <= 69);
                }
            }

            if (!rsiValid) {
                log('WARN', 'BEFORE', `⚠️ Coin ${best.symbol} đủ điều kiện FD nhưng KHÔNG đạt xác nhận RSI. Bỏ qua mở lệnh.`);
                isOpeningPosition = false;
                const timeToNextFd = targetFundingTime - nowServer;
                schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(timeToNextFd + 10000, 30000));
                return;
            }
        }

        log('SUCCESS', 'SCAN', `🎯 [CHỌN COIN BEFORE] Symbol: ${best.symbol} | Funding Rate: ${(parseFloat(best.lastFundingRate) * 100).toFixed(4)}% | Đòn bẩy: ${leverage}x | Est PnL: ${best.estPnl.toFixed(2)}% | Funding Time: ${timeStr} UTC+7`);

        await setLeverage(best.symbol, leverage);
        await ensureCrossMargin(best.symbol);
        await aggressiveCleanup(best.symbol);

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        const symbolInfo = exchangeInfoCache[best.symbol];
        const currentPrice = await getCurrentPrice(best.symbol);
        
        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
        let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);

        const isNegative = best.fdType === 'negative';
        const mainSide = isNegative ? 'SHORT' : 'LONG';

        const shortOffsetMs = userConfig.shortOffsetMs !== undefined ? userConfig.shortOffsetMs : 0;
        const delayShort = (targetFundingTime + shortOffsetMs) - nowServer;

        clearTimeout(scheduledMainTimeout);
        if (delayShort >= 0) {
            scheduledMainTimeout = setTimeout(() => {
                if (botRunning && currentMainPositions.length < maxAllowed) {
                    openMainPosition(best.symbol, quantity, targetFundingTime, mainSide, false, best.estPnl, 'before').catch(e => {});
                }
            }, delayShort);
        } else {
            if (botRunning && currentMainPositions.length < maxAllowed) {
                openMainPosition(best.symbol, quantity, targetFundingTime, mainSide, false, best.estPnl, 'before').catch(e => {});
            }
        }

        const msAfterFunding = targetFundingTime + 30000 - Date.now();
        schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(msAfterFunding, 60000));

    } catch (e) {
        log('ERROR', 'SCAN', `✖ Lỗi thực hiện chọn coin T-2m: ${getErrorMessage(e)}`);
        isOpeningPosition = false;
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 15000);
    }
}

let isClosingMain = false;
async function openMainPosition(symbol, quantity, nextFundingTime, side, isTest = false, estPnl = 0, mode = 'before') {
    const maxAllowed = userConfig.maxOpenPositions || 1;
    if (currentMainPositions.length >= maxAllowed) {
        log('WARN', 'MAIN', `⚠️ Không thể mở ${symbol}. Số lượng vị thế do bot mở đã đạt giới hạn tối đa (${currentMainPositions.length}/${maxAllowed}).`);
        isOpeningPosition = false;
        return;
    }

    try {
        await ensureCrossMargin(symbol);
        const currentPrice = await getCurrentPrice(symbol);

        await executeMarketOrderWithMinVolCheck(symbol, side, side, quantity, currentPrice || 0);
        
        if (!isTest) {
            globalStats.totalSessions++;
        }
        
        let realEntryPrice = 0;
        let lev = getLeverageFromCache(symbol);

        await new Promise(r => setTimeout(r, 500));
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
            const pos = positions.find(p => p.symbol === symbol && (p.positionSide === side || p.positionSide === 'BOTH'));
            if (pos && parseFloat(pos.positionAmt) !== 0) {
                realEntryPrice = parseFloat(pos.entryPrice);
                lev = parseInt(pos.leverage);
            }
        } catch (e) {}

        if (!realEntryPrice || realEntryPrice === 0) {
            realEntryPrice = currentPrice || 0;
        }

        const margin = (quantity * realEntryPrice) / (lev || 1);
        log('TRADE', 'MAIN', `🚀 Mở vị thế Main [${mode.toUpperCase()}] | Coin: ${symbol} | Hướng: ${side} | Qty: ${formatNumber(quantity)} | Đòn bẩy: ${lev}x | Margin: ${margin.toFixed(2)} USDT | Entry: ${formatPrice(realEntryPrice)}`);

        addToBlacklist(symbol);

        const mainPos = { 
            symbol, side, quantity, openTime: Date.now(), entryPrice: realEntryPrice, 
            extremePrice: realEntryPrice, nextFundingTime, isTest,
            margin, leverage: lev, mode
        };
        currentMainPositions.push(mainPos);
        
        saveDataPositionsToFile();
        saveStateToFile();

        if (!mainCheckInterval) mainCheckInterval = setInterval(manageMainPositions, 1500);

        lastOrderOpenTime = Date.now();
        setTimeout(() => { isOpeningPosition = false; }, 5000);

    } catch (error) {
        log('ERROR', 'MAIN', `✖ Lỗi mở lệnh MAIN ${side} ${symbol}: ${getErrorMessage(error)}`);
        isOpeningPosition = false;
        armT2MinuteScheduler();
    }
}

async function manageMainPositions() {
    if (currentMainPositions.length === 0 || isClosingMain) return;
    isClosingMain = true;
    try {
        const currentServerTime = Date.now() + serverTimeOffset;
        const pricesMap = await getAllPricesMap();

        for (let i = currentMainPositions.length - 1; i >= 0; i--) {
            const pos = currentMainPositions[i];
            if (!pos) continue;
            const { symbol, side, entryPrice, nextFundingTime, openTime, isTest, mode } = pos;
            const isLong = side === 'LONG';

            if (mode === 'always' || mode === 'rsi') {
                const elapsedMins = (Date.now() - openTime) / 60000;
                const maxHoldMins = userConfig.holdMinutes || 15;
                if (elapsedMins >= maxHoldMins) {
                    log('INFO', 'MAIN', `⏳ [${mode.toUpperCase()} MODE] Đã giữ lệnh ${elapsedMins.toFixed(1)}m >= ${maxHoldMins}m. Tự động đóng vị thế!`);
                    await closeMainInternal(pos, `Hết thời gian (${maxHoldMins}m)`, isTest);
                    continue;
                }
            } else if (nextFundingTime && currentServerTime >= nextFundingTime) {
                log('INFO', 'MAIN', `⏳ Hết giờ Funding cho ${symbol}. Tự động đóng vị thế ngay lập tức!`);
                await closeMainInternal(pos, 'Hết giờ Funding', isTest);
                continue;
            }

            if (nextFundingTime && isTest) {
                const timeRemaining = nextFundingTime - currentServerTime;
                if (timeRemaining <= 1500 && timeRemaining > 0) {
                    log('INFO', 'MAIN', `⏳ [TEST] Còn <= 1500ms tới giờ Funding. Tự động đóng lệnh TEST!`);
                    await closeMainInternal(pos, 'Test Auto Close', true);
                    continue;
                }
            }
            
            const currentPrice = pricesMap[symbol] || await getCurrentPrice(symbol);
            if (!currentPrice) continue;

            // TÍNH TOÁN VÀ CẬP NHẬT GIÁ ĐỈNH/ĐÁY CHO TRAILING TP TỪ THỜI ĐIỂM MỞ LỆNH
            updatePositionExtremePrice(pos, currentPrice, side);
            saveDataPositionsToFile();
            saveStateToFile();

            const extremePrice = pos.extremePrice || entryPrice;
            const tpFixedPct = userConfig.tpFixedPercent || 1;
            const enableTrailing = userConfig.enableTrailing || false;
            const tpTrailingPct = userConfig.tpTrailingPercent || 1;
            const slPct = userConfig.slPercent || 2;

            const maxGainPct = isLong ? 
                ((extremePrice - entryPrice) / entryPrice) * 100 : 
                ((entryPrice - extremePrice) / entryPrice) * 100;

            const fixedSL = isLong ? 
                entryPrice - (entryPrice * (slPct / 100)) : 
                entryPrice + (entryPrice * (slPct / 100));

            const tpFixedPrice = isLong ?
                entryPrice + (entryPrice * (tpFixedPct / 100)) :
                entryPrice - (entryPrice * (tpFixedPct / 100));

            let activeSL = fixedSL;
            let isSlPositive = false;
            let closeReason = 'Chạm Stop Loss';

            if (maxGainPct >= tpFixedPct) {
                isSlPositive = true;
                if (enableTrailing) {
                    if (isLong) {
                        const trailedSL = extremePrice - (entryPrice * (tpTrailingPct / 100));
                        activeSL = Math.max(tpFixedPrice, trailedSL);
                    } else {
                        const trailedSL = extremePrice + (entryPrice * (tpTrailingPct / 100));
                        activeSL = Math.min(tpFixedPrice, trailedSL);
                    }
                    closeReason = 'Chốt Lãi TP Trailing';
                } else {
                    activeSL = tpFixedPrice;
                    closeReason = 'Chốt Lãi TP Cứng';
                }
            }

            pos.dynamicSL = activeSL; 
            pos.isSlPositive = isSlPositive;

            let triggerClose = false;
            if (isLong && currentPrice <= activeSL) triggerClose = true;
            if (!isLong && currentPrice >= activeSL) triggerClose = true;

            if (triggerClose) {
                if (isSlPositive) {
                    log('SUCCESS', 'TP', `🎯 Kích hoạt ${closeReason} | Coin: ${symbol} | Entry: ${formatPrice(entryPrice)} | Giá chốt: ${formatPrice(activeSL)} | Giá hiện tại: ${formatPrice(currentPrice)}`);
                } else {
                    log('WARN', 'SL', `⚠ Kích hoạt Stop Loss | Coin: ${symbol} | Entry: ${formatPrice(entryPrice)} | Giá SL: ${formatPrice(activeSL)} | Giá hiện tại: ${formatPrice(currentPrice)}`);
                }
                await closeMainInternal(pos, closeReason, isTest);
            }
        }
    } catch (error) { 
        log('ERROR', 'MAIN_CHECK', `Lỗi kiểm tra vị thế Main: ${getErrorMessage(error)}`);
    } finally {
        isClosingMain = false;
    }
}

async function closeMainInternal(mainPos, reason = 'Thủ công', isTest = false) {
    if (!mainPos) return;
    const { symbol, side, openTime, entryPrice } = mainPos;
    const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
    const duration = formatDuration(openTime);

    currentMainPositions = currentMainPositions.filter(p => p !== mainPos);
    
    saveDataPositionsToFile();
    saveStateToFile();

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && (p.positionSide === side || p.positionSide === 'BOTH'));
        const actualAmt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
        const markPrice = pos ? parseFloat(pos.markPrice) : entryPrice;

        if (actualAmt > 0) {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: orderSide, positionSide: pos ? pos.positionSide : side, type: 'MARKET', quantity: formatQty(symbol, actualAmt)
            });
            log('SUCCESS', 'MAIN', `🛑 Đóng vị thế Main | Coin: ${symbol} | Hướng: ${side} | Giá vào: ${formatPrice(entryPrice)} | Giá thoát: ${formatPrice(markPrice)} | Lý do: ${reason} | Thời gian giữ: ${duration}`);
            fetchAndLogRealizedPnL(symbol, side, isTest);
        }
    } catch (error) {
        log('ERROR', 'MAIN', `✖ Lỗi khi đóng MAIN ${symbol}: ${getErrorMessage(error)}.`);
        await aggressiveCleanup(symbol);
    } finally {
        cleanupAfterClose(symbol);
    }
}

function cleanupAfterClose(symbol) {
    saveDataPositionsToFile();
    saveStateToFile();

    const remainingForSymbol = currentMainPositions.some(p => p.symbol === symbol);
    if (!remainingForSymbol) {
        unlockBlacklistWith15MinDelay(symbol);
    }

    if (currentMainPositions.length === 0 && mainCheckInterval) { 
        clearInterval(mainCheckInterval); 
        mainCheckInterval = null; 
    }
    setTimeout(async () => {
        const stillRemaining = currentMainPositions.some(p => p.symbol === symbol);
        if (!stillRemaining) {
            await aggressiveCleanup(symbol);
        }
        if (botRunning) armT2MinuteScheduler();
    }, 10000);
}

function startAntiLiquidationMonitor() {
    if (antiLiquidationInterval) clearInterval(antiLiquidationInterval);
    antiLiquidationInterval = setInterval(async () => {
        if (!botRunning || isOpeningPosition) return;
        try {
            const acc = await callSignedAPI('/fapi/v2/account', 'GET');
            const totalWalletBalance = parseFloat(acc.totalWalletBalance || 0);
            const availableBalance = parseFloat(acc.availableBalance || 0);

            if (totalWalletBalance > 0 && availableBalance <= (totalWalletBalance * 0.15)) {
                log('WARN', 'POSITION', `🚨 BÁO ĐỘNG: Margin/Khả dụng còn lại <= 15% số dư tài khoản. KÍCH HOẠT CHỐNG THANH LÝ TOÀN BỘ SÀN!`);
                botRunning = false; 
                
                await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE'); 
                const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
                
                for (const p of positions) {
                    const amt = parseFloat(p.positionAmt);
                    if (Math.abs(amt) > 0) {
                        const side = amt > 0 ? 'SELL' : 'BUY';
                        await callSignedAPI('/fapi/v1/order', 'POST', {
                            symbol: p.symbol, side: side, positionSide: p.positionSide, type: 'MARKET', quantity: formatQty(p.symbol, Math.abs(amt))
                        });
                    }
                }
                currentMainPositions = [];
                saveDataPositionsToFile();
                saveStateToFile();
                log('SUCCESS', 'POSITION', `🛑 Đã ĐÓNG TOÀN BỘ vị thế trên tài khoản. Bot tự động TẮT để bảo toàn vốn.`);
            }
        } catch(e) {}
    }, 20000);
}

async function restoreActivePositionsOnStartup() {
    loadStateFromFile();
    const dataSaved = loadDataPositionsFromFile();
    
    let candidateMains = dataSaved.mainPositions.length > 0 ? dataSaved.mainPositions : currentMainPositions;

    if (!userConfig.apiKey || !userConfig.secretKey) return;
    try {
        await syncServerTime();
        await updateAllLeverageCache(); 
        await getExchangeInfo();
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        
        const validMains = [];
        for (const mainPos of candidateMains) {
            const pos = positions.find(p => p.symbol === mainPos.symbol && (p.positionSide === mainPos.side || p.positionSide === 'BOTH'));
            if (pos) {
                const actualAmt = Math.abs(parseFloat(pos.positionAmt));
                if (actualAmt > 0 && (Math.abs(actualAmt - parseFloat(mainPos.quantity)) < 0.001 || Math.abs(actualAmt - parseFloat(mainPos.quantity)) / actualAmt < 0.02)) {
                    log('SUCCESS', 'SYNC', `✓ Khôi phục quản lý MAIN ${mainPos.side} ${mainPos.symbol} (Entry: ${mainPos.entryPrice})`);
                    validMains.push(mainPos);
                    addToBlacklist(mainPos.symbol);
                }
            }
        }
        currentMainPositions = validMains;

        saveDataPositionsToFile();
        saveStateToFile();

        if (currentMainPositions.length > 0) {
            botRunning = true;
            if (mainCheckInterval) clearInterval(mainCheckInterval);
            mainCheckInterval = setInterval(manageMainPositions, 1500);
        }

        if (botRunning) {
            startAntiLiquidationMonitor();
            armT2MinuteScheduler();
        }
    } catch (e) {
        log('ERROR', 'SYNC', `✖ Lỗi khôi phục vị thế: ${getErrorMessage(e)}`);
    }
}

async function getDashboardDataCached() {
    const now = Date.now();

    if (cachedDashboardData && (now - lastDashboardFetchTime < DASHBOARD_CACHE_TTL)) {
        return cachedDashboardData;
    }

    let balance = 0;
    let totalWalletBalance = 0;
    let positionsRes = [];
    let pendingQueueRes = [];

    if (userConfig.apiKey && userConfig.secretKey) {
        try {
            const acc = await callSignedAPI('/fapi/v2/account', 'GET');
            balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
            const walletBalance = parseFloat(acc.totalWalletBalance || 0);
            const totalUnrealizedProfit = parseFloat(acc.totalUnrealizedProfit || 0);
            totalWalletBalance = walletBalance + totalUnrealizedProfit;

            const allPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const openPositions = allPositions.filter(p => parseFloat(p.positionAmt) !== 0);

            for (const p of openPositions) {
                const posAmt = parseFloat(p.positionAmt);
                const posAmtAbs = Math.abs(posAmt);
                const entryPrice = parseFloat(p.entryPrice);
                const markPrice = parseFloat(p.markPrice);
                const lev = parseInt(p.leverage);
                const margin = (posAmtAbs * entryPrice) / lev;
                const pnl = parseFloat(p.unRealizedProfit);
                
                const isLong = p.positionSide === 'LONG' || (p.positionSide === 'BOTH' && posAmt > 0);
                const sideStr = isLong ? 'LONG' : 'SHORT';
                
                const pctFromEntry = entryPrice > 0 ? (isLong ? ((markPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - markPrice) / entryPrice) * 100) : 0;

                const isMatchMain = currentMainPositions.find(m => 
                    m.symbol === p.symbol && 
                    (m.side === p.positionSide || p.positionSide === 'BOTH')
                );

                if (!isMatchMain) {
                    continue; 
                }

                let deepest = isMatchMain.extremePrice || markPrice;
                let openTime = isMatchMain.openTime || Date.now();
                let posType = isMatchMain.isTest ? 'TEST MAIN' : 'MAIN';
                let nextFundingTime = isMatchMain.nextFundingTime || null;
                let mode = isMatchMain.mode || 'before';

                const slPct = userConfig.slPercent || 2;
                const tpFixedPct = userConfig.tpFixedPercent || 1;
                const tpTrailingPct = userConfig.tpTrailingPercent || 1;
                const enableTrailing = userConfig.enableTrailing || false;

                const slPrice = isLong ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100);
                const tpFixedPrice = isLong ? entryPrice * (1 + tpFixedPct / 100) : entryPrice * (1 - tpFixedPct / 100);
                
                let tpTrailingPrice = 0;
                let isReached = false;
                if (enableTrailing && deepest) {
                    tpTrailingPrice = isLong ? deepest - (entryPrice * (tpTrailingPct / 100)) : deepest + (entryPrice * (tpTrailingPct / 100));
                    const maxGainPct = isLong ? ((deepest - entryPrice) / entryPrice) * 100 : ((entryPrice - deepest) / entryPrice) * 100;
                    if (maxGainPct >= tpFixedPct) isReached = true;
                }

                const slPnlAmount = isLong ? (slPrice - entryPrice) * posAmtAbs : (entryPrice - slPrice) * posAmtAbs;
                const slPnlRoi = (slPnlAmount / margin) * 100;

                const tpFixedPnlAmount = isLong ? (tpFixedPrice - entryPrice) * posAmtAbs : (entryPrice - tpFixedPrice) * posAmtAbs;
                const tpFixedPnlRoi = (tpFixedPnlAmount / margin) * 100;

                const tpTrailingPnlAmount = tpTrailingPrice > 0 ? (isLong ? (tpTrailingPrice - entryPrice) * posAmtAbs : (entryPrice - tpTrailingPrice) * posAmtAbs) : 0;
                const tpTrailingPnlRoi = margin > 0 ? (tpTrailingPnlAmount / margin) * 100 : 0;

                let remainingMs = 0;
                if (mode === 'always' || mode === 'rsi') {
                    const maxHoldMs = (userConfig.holdMinutes || 15) * 60 * 1000;
                    remainingMs = Math.max(0, (openTime + maxHoldMs) - Date.now());
                } else if (nextFundingTime) {
                    remainingMs = Math.max(0, nextFundingTime - (Date.now() + serverTimeOffset));
                }

                positionsRes.push({
                    coin: p.symbol, side: sideStr, mode, size: posAmtAbs, leverage: lev, margin, entryPrice, markPrice, pnl,
                    pctFromEntry, slPrice, slPnlAmount, slPnlRoi, tpFixedPrice, tpFixedPnlAmount, tpFixedPnlRoi,
                    enableTrailing, tpTrailingPrice, tpTrailingPnlAmount, tpTrailingPnlRoi, isReached, extremePrice: deepest,
                    openTime, posType, remainingMs, tpTrailingPct
                });
            }
        } catch (e) {}
    }

    const expectedMargin = userConfig.amountMode === 'percent' 
        ? balance * (userConfig.amountValue / 100) 
        : userConfig.amountValue;

    const triggerPct = userConfig.priceTriggerPct || 0;
    for (const sym in pendingLocks) {
        const lock = pendingLocks[sym];
        if (!lock) continue;
        
        const cPrice = lock.lastCurrentPrice || lock.extremePrice;
        const extPrice = lock.extremePrice;
        const isLong = lock.side === 'LONG';

        let expectedEntry = 0;
        let currentDiffPct = 0;

        if (isLong) {
            expectedEntry = extPrice * (1 + triggerPct / 100);
            currentDiffPct = extPrice > 0 ? ((cPrice - extPrice) / extPrice) * 100 : 0;
        } else {
            expectedEntry = extPrice * (1 - triggerPct / 100);
            currentDiffPct = extPrice > 0 ? ((extPrice - cPrice) / extPrice) * 100 : 0;
        }

        pendingQueueRes.push({
            symbol: lock.symbol,
            mode: lock.mode || 'always',
            side: lock.side,
            lev: lock.lev,
            expectedMargin: expectedMargin,
            fdRate: lock.fdRate,
            extremePrice: extPrice,
            currentPrice: cPrice,
            expectedEntryPrice: expectedEntry,
            currentDiffPct: Math.max(0, currentDiffPct),
            targetTriggerPct: triggerPct,
            targetFundingTime: lock.targetFundingTime,
            estPnl: lock.estPnl,
            rsiPeak: lock.rsiPeak || null,
            rsiTrough: lock.rsiTrough || null,
            currentRsi: lock.currentRsi || null
        });
    }

    const modePriority = { 'before': 1, 'always': 2, 'rsi': 3 };
    pendingQueueRes.sort((a, b) => (modePriority[a.mode] || 99) - (modePriority[b.mode] || 99));
    positionsRes.sort((a, b) => (modePriority[a.mode] || 99) - (modePriority[b.mode] || 99));

    cachedDashboardData = {
        running: botRunning,
        balance,
        totalWalletBalance,
        botOpenPositionsCount: currentMainPositions.length,
        positions: positionsRes,
        pendingQueue: pendingQueueRes,
        totalSessions: globalStats.totalSessions,
        totalPnl: globalStats.totalPnl
    };
    lastDashboardFetchTime = now;
    return cachedDashboardData;
}

const app = express();
app.use(express.static(__dirname));

app.get('/api/config', (req, res) => {
    res.json(userConfig);
});

app.get('/api/save_config', (req, res) => {
    const { 
        apiKey, secretKey, maxOpenPositions, amountMode, amountValue, 
        tpFixed, enableTrailing, tpTrailing, sl, shortMs, threshold, 
        tradeModes, sortMode, holdMinutes, enablePriceTrigger, priceTriggerPct,
        enableRsiConfirm, rsiTimeframe, rsiPeriod
    } = req.query;

    if (apiKey) userConfig.apiKey = apiKey;
    if (secretKey) userConfig.secretKey = secretKey;
    if (maxOpenPositions) userConfig.maxOpenPositions = parseInt(maxOpenPositions);
    if (amountMode) userConfig.amountMode = amountMode;
    if (amountValue) userConfig.amountValue = parseFloat(amountValue);
    if (tpFixed) userConfig.tpFixedPercent = parseFloat(tpFixed);
    userConfig.enableTrailing = enableTrailing === 'true';
    if (tpTrailing) userConfig.tpTrailingPercent = parseFloat(tpTrailing);
    if (sl) userConfig.slPercent = parseFloat(sl);
    if (shortMs !== undefined) userConfig.shortOffsetMs = parseInt(shortMs);
    if (threshold) userConfig.fundingThreshold = parseFloat(threshold);
    if (tradeModes) userConfig.tradeModes = tradeModes.split(',').filter(Boolean);
    if (sortMode) userConfig.sortMode = sortMode;
    if (holdMinutes) userConfig.holdMinutes = parseInt(holdMinutes);
    userConfig.enablePriceTrigger = enablePriceTrigger === 'true';
    if (priceTriggerPct) userConfig.priceTriggerPct = parseFloat(priceTriggerPct);
    userConfig.enableRsiConfirm = enableRsiConfirm === 'true';
    if (rsiTimeframe) userConfig.rsiTimeframe = rsiTimeframe;
    if (rsiPeriod) userConfig.rsiPeriod = parseInt(rsiPeriod);

    saveConfigToFile();
    log('SUCCESS', 'CONFIG', '💾 Đã lưu cấu hình vào tệp config.json!');
    res.send("Saved");
});

app.get('/api/start', async (req, res) => {
    const { 
        apiKey, secretKey, maxOpenPositions, amountMode, amountValue, 
        tpFixed, enableTrailing, tpTrailing, sl, shortMs, threshold, 
        tradeModes, sortMode, holdMinutes, enablePriceTrigger, priceTriggerPct,
        enableRsiConfirm, rsiTimeframe, rsiPeriod
    } = req.query;

    if (apiKey) userConfig.apiKey = apiKey;
    if (secretKey) userConfig.secretKey = secretKey;
    if (maxOpenPositions) userConfig.maxOpenPositions = parseInt(maxOpenPositions);
    if (amountMode) userConfig.amountMode = amountMode;
    if (amountValue) userConfig.amountValue = parseFloat(amountValue);
    if (tpFixed) userConfig.tpFixedPercent = parseFloat(tpFixed);
    userConfig.enableTrailing = enableTrailing === 'true';
    if (tpTrailing) userConfig.tpTrailingPercent = parseFloat(tpTrailing);
    if (sl) userConfig.slPercent = parseFloat(sl);
    if (shortMs !== undefined) userConfig.shortOffsetMs = parseInt(shortMs);
    if (threshold) userConfig.fundingThreshold = parseFloat(threshold);
    if (tradeModes) userConfig.tradeModes = tradeModes.split(',').filter(Boolean);
    if (sortMode) userConfig.sortMode = sortMode;
    if (holdMinutes) userConfig.holdMinutes = parseInt(holdMinutes);
    userConfig.enablePriceTrigger = enablePriceTrigger === 'true';
    if (priceTriggerPct) userConfig.priceTriggerPct = parseFloat(priceTriggerPct);
    userConfig.enableRsiConfirm = enableRsiConfirm === 'true';
    if (rsiTimeframe) userConfig.rsiTimeframe = rsiTimeframe;
    if (rsiPeriod) userConfig.rsiPeriod = parseInt(rsiPeriod);

    saveConfigToFile();

    if (!botRunning) {
        botRunning = true;
        botStartTime = Date.now();
        pendingLocks = {};
        log('SUCCESS', 'BOT', `▶ BOT KHỞI ĐỘNG CHẾ ĐỘ: ${userConfig.tradeModes.join(', ').toUpperCase()} | Max: ${userConfig.maxOpenPositions} vị thế`);
        startAntiLiquidationMonitor();
        armT2MinuteScheduler();
    }
    res.send("OK");
});

app.get('/api/stop', (req, res) => {
    botRunning = false;
    clearTimeout(schedulerTimeout);
    clearTimeout(scheduledMainTimeout);
    if (antiLiquidationInterval) clearInterval(antiLiquidationInterval);
    pendingLocks = {};
    log('WARN', 'BOT', '⏹ BOT ĐÃ DỪNG HOẠT ĐỘNG!');
    saveStateToFile();
    res.send("OK");
});

app.get('/api/status', (req, res) => {
    res.send(botRunning ? "Status: RUNNING" : "Status: STOPPED");
});

app.get('/api/logs', (req, res) => {
    res.json(memoryLogs);
});

app.get('/api/funding_rates', async (req, res) => {
    try {
        const data = await fetchFundingDataFromBinance();
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/dashboard', async (req, res) => {
    const data = await getDashboardDataCached();
    res.json(data);
});

app.get('/api/cancel_pending', (req, res) => {
    const { symbol } = req.query;
    if (symbol && pendingLocks[symbol]) {
        delete pendingLocks[symbol];
        log('INFO', 'PENDING', `🗑 Đã xóa ${symbol} khỏi hàng chờ theo yêu cầu người dùng.`);
        res.send("OK");
    } else {
        res.send("Not found");
    }
});

app.get('/api/force_close', async (req, res) => {
    const { symbol, side } = req.query;
    if (!symbol || !side) return res.status(400).send("Thiếu tham số");

    const matchMain = currentMainPositions.find(p => p.symbol === symbol && p.side === side);

    if (matchMain) {
        await closeMainInternal(matchMain, 'Đóng thủ công Web', matchMain.isTest);
        return res.send(`Đã đóng vị thế Main ${side} ${symbol}`);
    }

    try {
        await aggressiveCleanup(symbol);
        res.send(`Đã giải phóng thủ công vị thế ${side} ${symbol}`);
    } catch (e) {
        res.status(500).send("Lỗi: " + e.message);
    }
});

app.get('/api/test_fast', async (req, res) => {
    if (!botRunning) return res.send("Bot đang tắt");
    try {
        const allFunding = await fetchFundingDataFromBinance(true);
        const candidates = getFilteredCandidates(allFunding, userConfig.fundingThreshold);
        if (candidates.length === 0) return res.send("Không có coin thỏa mãn threshold");

        const best = candidates[0];
        const leverage = best.lev;
        await setLeverage(best.symbol, leverage);
        await ensureCrossMargin(best.symbol);
        await aggressiveCleanup(best.symbol);

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        const symbolInfo = exchangeInfoCache[best.symbol];
        const currentPrice = await getCurrentPrice(best.symbol);
        
        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
        let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);

        const isNegative = best.fdType === 'negative';
        const mainSide = isNegative ? 'SHORT' : 'LONG';

        await openMainPosition(best.symbol, quantity, Date.now() + 60000, mainSide, true, best.estPnl, 'before');
        res.send(`Đã chạy Test Nhanh thành công cho ${best.symbol}`);
    } catch (e) {
        res.status(500).send("Lỗi Test: " + getErrorMessage(e));
    }
});

app.listen(WEB_SERVER_PORT, () => {
    log('INFO', 'SERVER', `🌐 Web Dashboard running at http://localhost:${WEB_SERVER_PORT}`);
    restoreActivePositionsOnStartup();
});
