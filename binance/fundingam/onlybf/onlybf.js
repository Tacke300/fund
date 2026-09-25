import https from 'https';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

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
    minLeverage: 20,
    maxOpenPositions: 1,
    amountMode: 'percent',
    amountValue: 25,
    tpFixedPercent: 1,
    enableTrailing: false,
    tpTrailingPercent: 1,
    slPercent: 2,
    shortOffsetMs: 0,
    fundingThreshold: 0.3,
    tradeModes: ['before'],
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
let wsPriceMap = {};
let wsClient = null;

let isBanned = false;
let banUntilTimestamp = 0;
let banAutoRestartTimer = null;

function getUtc7TimeString(timestamp) {
    const d = new Date(timestamp + (7 * 3600 * 1000));
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const year = d.getUTCFullYear();
    return `${hh}:${mm}:${ss} ${day}/${month}/${year} (UTC+7)`;
}

function stopAllSchedulers() {
    if (mainCheckInterval) { clearInterval(mainCheckInterval); mainCheckInterval = null; }
    if (schedulerTimeout) { clearTimeout(schedulerTimeout); schedulerTimeout = null; }
    if (scheduledMainTimeout) { clearTimeout(scheduledMainTimeout); scheduledMainTimeout = null; }
}

function checkBanStatus() {
    if (isBanned) {
        if (Date.now() >= banUntilTimestamp) {
            isBanned = false;
            return false;
        }
        return true;
    }
    return false;
}

function handleBanError(statusCode, headers = {}) {
    if (statusCode === 418 || statusCode === 429) {
        isBanned = true;
        let retrySecs = parseInt(headers['retry-after'] || '300');
        if (isNaN(retrySecs) || retrySecs <= 0) retrySecs = 300;
        banUntilTimestamp = Date.now() + (retrySecs * 1000);
        
        log('ERROR', 'BAN_IP', `⛔ Bị BAN IP từ Binance (HTTP ${statusCode}). Bot dừng tạm thời. Tự động chạy lại lúc: ${getUtc7TimeString(banUntilTimestamp)}`);
        
        botRunning = false;
        stopAllSchedulers();

        if (banAutoRestartTimer) clearTimeout(banAutoRestartTimer);
        banAutoRestartTimer = setTimeout(() => {
            isBanned = false;
            botRunning = true;
            armT2MinuteScheduler();
        }, retrySecs * 1000);
    }
}

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

function saveDataPositionsToFile() {
    try {
        const dataObj = { currentMainPositions };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataObj, null, 2), 'utf8');
    } catch (e) {}
}

function loadDataPositionsFromFile() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            return {
                mainPositions: Array.isArray(data.currentMainPositions) ? data.currentMainPositions : []
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
        try { return JSON.stringify(error); } catch (e) { return String(error); }
    }
    return String(error);
}

function loadConfigFromFile() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE, 'utf8');
            const savedConfig = JSON.parse(rawData);
            userConfig = { ...userConfig, ...savedConfig };
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
let currentMainPositions = [];

let mainCheckInterval = null;
let schedulerTimeout = null;
let scheduledMainTimeout = null;

let isOpeningPosition = false;
const memoryLogs = [];
const MAX_LOG_SIZE = 1000;

const WEB_SERVER_PORT = 9999;

let globalStats = {
    totalSessions: 0,
    totalPnl: 0
};

let cachedFundingRates = [];
let lastFundingFetchTime = 0;
const FUNDING_CACHE_TTL = 30000;

let lastPendingScanTime = 0;

function recalculateTotalPnlFromLogs() {
    let sum = 0;
    for (const line of memoryLogs) {
        if (line.includes('[PNL]')) {
            const match = line.match(/PnL:\s*([+-]?\d+\.?\d*)\s*USDT/);
            if (match && match[1]) {
                sum += parseFloat(match[1]);
            }
        }
    }
    return sum;
}

function initBinanceWebSocket() {
    try {
        if (wsClient) {
            try { wsClient.close(); } catch(e){}
        }
        wsClient = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');

        wsClient.on('open', () => {
            log('INFO', 'WS', 'Đã kết nối Binance Futures WebSocket Stream giá.');
        });

        wsClient.on('message', (data) => {
            try {
                const list = JSON.parse(data.toString());
                if (Array.isArray(list)) {
                    for (const item of list) {
                        if (item.s && item.c) {
                            wsPriceMap[item.s] = parseFloat(item.c);
                        }
                    }
                }
            } catch (e) {}
        });

        wsClient.on('error', (err) => {
            log('WARN', 'WS', `Lỗi WebSocket: ${err.message}`);
        });

        wsClient.on('close', () => {
            setTimeout(initBinanceWebSocket, 5000);
        });
    } catch (e) {
        log('ERROR', 'WS', `Không thể khởi tạo WebSocket: ${e.message}`);
    }
}

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
    
    if (rsiCache[key] && (now - rsiCache[key].updatedAt < 20000)) {
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
            minRsiAfterPeak: 100,
            maxRsiAfterTrough: 0
        };

        let rsiPeak = prev.rsiPeak;
        let rsiTrough = prev.rsiTrough;
        let minRsiAfterPeak = prev.minRsiAfterPeak !== undefined ? prev.minRsiAfterPeak : 100;
        let maxRsiAfterTrough = prev.maxRsiAfterTrough !== undefined ? prev.maxRsiAfterTrough : 0;

        if (currentRsi >= 70) {
            if (rsiPeak === null || currentRsi > rsiPeak) {
                rsiPeak = currentRsi;
                minRsiAfterPeak = currentRsi;
            }
        }
        if (currentRsi <= 30) {
            if (rsiTrough === null || currentRsi < rsiTrough) {
                rsiTrough = currentRsi;
                maxRsiAfterTrough = currentRsi;
            }
        }

        if (rsiPeak !== null) {
            if (currentRsi < minRsiAfterPeak) minRsiAfterPeak = currentRsi;
        }
        if (rsiTrough !== null) {
            if (currentRsi > maxRsiAfterTrough) maxRsiAfterTrough = currentRsi;
        }

        const rsiInfo = {
            currentRsi,
            rsiPeak,
            rsiTrough,
            minRsiAfterPeak,
            maxRsiAfterTrough,
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
    if (mins > 0) return `${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
    return `${String(secs).padStart(2, '0')}s`;
}

function log(level, moduleName, message) {
    const timestamp = formatTime();
    const formattedLog = `[${timestamp}] [${level}] [${moduleName}] ${message}`;
    console.log(formattedLog);
    memoryLogs.push(formattedLog);
    if (memoryLogs.length > MAX_LOG_SIZE) memoryLogs.shift();
}

function saveStateToFile() {
    try {
        const stateData = { currentMainPositions, botRunning, globalStats };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2), 'utf8');
    } catch (e) {}
}

function loadStateFromFile() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (Array.isArray(data.currentMainPositions)) currentMainPositions = data.currentMainPositions;
            if (data.botRunning !== undefined) botRunning = data.botRunning;
        }
    } catch (e) {}
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    if (checkBanStatus()) {
        throw new Error(`Đang bị BAN IP tạm thời tới ${getUtc7TimeString(banUntilTimestamp)}`);
    }

    return new Promise((resolve, reject) => {
        const options = { hostname, path, method, headers };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    handleBanError(res.statusCode, res.headers);
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
        throw new Error("Thiếu API Key hoặc Secret Key.");
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

    const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
    return JSON.parse(rawData);
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    const fullPath = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');
    const rawData = await makeHttpRequest('GET', BASE_HOST, fullPath, { 'Content-Type': 'application/json' });
    return JSON.parse(rawData);
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = data.serverTime - Date.now();
    } catch (error) {}
}

function loadLeverageFromFile() {
    try {
        if (fs.existsSync(MAXLEV_FILE)) {
            const raw = fs.readFileSync(MAXLEV_FILE, 'utf8');
            const json = JSON.parse(raw);
            if (json.data) {
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

async function fetchSymbolMaxLeverageFromExchange(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol });
        if (Array.isArray(response) && response.length > 0) {
            const item = response.find(r => r.symbol === symbol) || response[0];
            const brackets = item.brackets || [];
            brackets.sort((a, b) => b.initialLeverage - a.initialLeverage);
            const maxLev = brackets.length > 0 ? brackets[0].initialLeverage : 20;
            leverageCache[symbol] = maxLev;
            saveLeverageToFile();
            return maxLev;
        }
    } catch (e) {}
    return leverageCache[symbol] || 20;
}

function getLeverageFromCache(symbol) {
    if (leverageCache[symbol]) {
        return leverageCache[symbol];
    }
    loadLeverageFromFile();
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
        await callSignedAPI('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' });
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
                quantityPrecision: s.quantityPrecision
            };
        });
        return exchangeInfoCache;
    } catch (error) { throw error; }
}

async function getAllPricesMap() {
    if (Object.keys(wsPriceMap).length > 0) {
        return wsPriceMap;
    }
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
        return wsPriceMap;
    }
}

async function getCurrentPrice(symbol) {
    if (wsPriceMap[symbol]) return wsPriceMap[symbol];
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol });
        return parseFloat(data.price);
    } catch (error) {
        return wsPriceMap[symbol] || null;
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

function calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage) {
    let exchangeMinNotional = symbolInfo ? (symbolInfo.minNotional || 5.0) : 5.0;
    let minQty = symbolInfo ? (symbolInfo.minQty || 0) : 0;
    let minQtyNotional = minQty * currentPrice;

    let requiredNotional = Math.max(5.5, exchangeMinNotional, minQtyNotional);
    let targetNotional = initialMargin * leverage;

    if (targetNotional < requiredNotional) targetNotional = requiredNotional;

    let qtyRaw = targetNotional / currentPrice;
    let step = symbolInfo ? (symbolInfo.stepSize || 0.001) : 0.001;
    let precision = (symbolInfo && symbolInfo.quantityPrecision !== undefined) ? symbolInfo.quantityPrecision : 3;

    let quantity = Math.ceil(qtyRaw / step) * step;
    if (quantity * currentPrice < requiredNotional) quantity += step;
    if (symbolInfo && symbolInfo.minQty && quantity < symbolInfo.minQty) quantity = symbolInfo.minQty;

    return parseFloat(quantity.toFixed(precision));
}

async function executeMarketOrderWithMinVolCheck(symbol, side, positionSide, quantity, currentPrice) {
    const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
    return await callSignedAPI('/fapi/v1/order', 'POST', {
        symbol: symbol, side: orderSide, positionSide: positionSide, type: 'MARKET', quantity: quantity
    });
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
    if (!forceRefresh && loadFundingFromFile()) return cachedFundingRates;

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

    valid.sort((a, b) => (a.nextFundingTime - b.nextFundingTime) || (b.estPnl - a.estPnl));

    cachedFundingRates = valid;
    lastFundingFetchTime = now;
    saveFundingToFile();
    return cachedFundingRates;
}

function getFilteredCandidates(allFunding, reqThreshold = null, targetFundingTime = null) {
    let valid = [...allFunding];
    valid = valid.filter(item => !isBlacklisted(item.symbol));
    const minLev = userConfig.minLeverage || 20;
    valid = valid.filter(item => (item.lev || 0) >= minLev);

    if (targetFundingTime !== null) {
        valid = valid.filter(item => Math.abs(item.nextFundingTime - targetFundingTime) <= 60000);
    }
    if (reqThreshold !== null) {
        valid = valid.filter(item => {
            const frPercent = Math.abs(parseFloat(item.lastFundingRate)) * 100;
            return userConfig.sortMode === 'pnl' ? (item.estPnl || 0) >= reqThreshold : frPercent >= reqThreshold;
        });
    }
    return valid;
}

function hasActivePositionForSymbol(symbol) {
    return currentMainPositions.some(p => p.symbol === symbol);
}

async function executeOpenSequence(symbol, leverage, nextFundingTime, side, mode, estPnl, currentPrice, rsiData = null) {
    let currentLev = getLeverageFromCache(symbol) || leverage;
    await setLeverage(symbol, currentLev);
    await ensureCrossMargin(symbol);
    await aggressiveCleanup(symbol);

    const acc = await callSignedAPI('/fapi/v2/account', 'GET');
    const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

    const symbolInfo = exchangeInfoCache ? exchangeInfoCache[symbol] : null;
    let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
    let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, currentLev);

    await openMainPositionWithRetry(symbol, quantity, nextFundingTime, side, estPnl, mode, currentLev, initialMargin, rsiData);
}

async function executePendingScan() {
    if (!botRunning || isOpeningPosition) return;

    const now = Date.now();
    if (now - lastPendingScanTime < 1000) return; 
    lastPendingScanTime = now;

    const maxAllowed = userConfig.maxOpenPositions || 1;
    if (currentMainPositions.length >= maxAllowed) return;

    try {
        const modes = userConfig.tradeModes || ['before'];
        const hasAlways = modes.includes('always');
        const hasRsi = modes.includes('rsi');

        if (!hasAlways && !hasRsi) return;

        const allFunding = await fetchFundingDataFromBinance(false);
        if (!allFunding || allFunding.length === 0) return;

        const minLev = userConfig.minLeverage || 20;
        const levFiltered = allFunding.filter(item => (item.lev || 0) >= minLev);

        const pricesMap = await getAllPricesMap();
        const enableTrigger = userConfig.enablePriceTrigger;
        const triggerPct = userConfig.priceTriggerPct || 0;
        const rsiTf = userConfig.rsiTimeframe || '5m';
        const rsiPeriod = userConfig.rsiPeriod || 14;

        // BƯỚC 1: LỌC & TỰ ĐỘNG XOÁ HÀNG CHỜ KHI TỤT/HỒI 25 CHỈ SỐ RSI
        for (const sym in pendingLocks) {
            const item = pendingLocks[sym];
            if (hasActivePositionForSymbol(sym) || isBlacklisted(sym)) {
                delete pendingLocks[sym];
                continue;
            }

            if (item.mode === 'rsi' || item.mode === 'always') {
                const rsiData = await fetchRsiData(sym, rsiTf, rsiPeriod);
                if (rsiData) {
                    item.currentRsi = rsiData.currentRsi;
                    item.rsiPeak = rsiData.rsiPeak;
                    item.rsiTrough = rsiData.rsiTrough;

                    if (item.side === 'SHORT') {
                        if (item.minRsiAfterPeak === undefined || rsiData.currentRsi < item.minRsiAfterPeak) {
                            item.minRsiAfterPeak = rsiData.currentRsi;
                        }
                        // Khi RSI hồi lại 25 chỉ số từ đáy sau đỉnh => Loại khỏi hàng chờ không log
                        if (rsiData.currentRsi >= item.minRsiAfterPeak + 25) {
                            delete pendingLocks[sym];
                            continue;
                        }
                    } else if (item.side === 'LONG') {
                        if (item.maxRsiAfterTrough === undefined || rsiData.currentRsi > item.maxRsiAfterTrough) {
                            item.maxRsiAfterTrough = rsiData.currentRsi;
                        }
                        // Khi RSI tụt lại 25 chỉ số từ đỉnh sau đáy => Loại khỏi hàng chờ không log
                        if (rsiData.currentRsi <= item.maxRsiAfterTrough - 25) {
                            delete pendingLocks[sym];
                            continue;
                        }
                    }
                }
            }
        }

        // BƯỚC 2: XỬ LÝ CHẾ ĐỘ ALWAYS (BIẾN ĐỘNG GIÁ)
        if (hasAlways) {
            const candidatesAlways = getFilteredCandidates(levFiltered, userConfig.fundingThreshold, null);

            for (const candidate of candidatesAlways) {
                if (currentMainPositions.length >= maxAllowed) break;

                const symbol = candidate.symbol;
                if (hasActivePositionForSymbol(symbol) || openingSymbols.has(symbol)) {
                    delete pendingLocks[symbol];
                    continue;
                }

                const currentPrice = pricesMap[symbol];
                if (!currentPrice) continue;

                // Yêu cầu bắt buộc: Phải có quá mua (>=70) hoặc quá bán (<=30) mới được lên hàng chờ
                const rsiData = await fetchRsiData(symbol, rsiTf, rsiPeriod);
                if (!rsiData) continue;

                const leverage = candidate.lev;
                const isNegative = candidate.fdType === 'negative';
                const mainSide = isNegative ? 'SHORT' : 'LONG';

                if (mainSide === 'SHORT' && (rsiData.rsiPeak === null || rsiData.rsiPeak < 70)) continue;
                if (mainSide === 'LONG' && (rsiData.rsiTrough === null || rsiData.rsiTrough > 30)) continue;

                let lock = pendingLocks[symbol];
                if (!lock || lock.mode !== 'always' || lock.side !== mainSide) {
                    pendingLocks[symbol] = {
                        symbol: symbol, mode: 'always', fdRate: parseFloat(candidate.lastFundingRate),
                        fdType: candidate.fdType, side: mainSide, lev: leverage,
                        priceHistory: [{ price: currentPrice, time: Date.now() }],
                        extremePrice: currentPrice, lockTime: Date.now(),
                        targetFundingTime: candidate.nextFundingTime, estPnl: candidate.estPnl,
                        lastCurrentPrice: currentPrice,
                        currentRsi: rsiData.currentRsi, rsiPeak: rsiData.rsiPeak, rsiTrough: rsiData.rsiTrough,
                        minRsiAfterPeak: rsiData.currentRsi, maxRsiAfterTrough: rsiData.currentRsi
                    };
                    lock = pendingLocks[symbol];
                } else {
                    lock.lastCurrentPrice = currentPrice;
                    lock.fdRate = parseFloat(candidate.lastFundingRate);
                    lock.estPnl = candidate.estPnl;
                    lock.currentRsi = rsiData.currentRsi;
                    lock.rsiPeak = rsiData.rsiPeak;
                    lock.rsiTrough = rsiData.rsiTrough;
                    update5MinExtremePrice(lock, currentPrice, mainSide);
                }

                let rsiValid = (rsiData.currentRsi >= 21 && rsiData.currentRsi <= 69);

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
                            await executeOpenSequence(symbol, leverage, candidate.nextFundingTime, mainSide, 'always', candidate.estPnl, currentPrice, rsiData);
                        } catch (e) {
                            log('ERROR', 'ALWAYS', `✖ Lỗi mở vị thế ${symbol}: ${getErrorMessage(e)}`);
                        } finally {
                            openingSymbols.delete(symbol);
                            setTimeout(() => { isOpeningPosition = false; }, 1000);
                        }
                    })();

                    if (currentMainPositions.length + 1 >= maxAllowed) break;
                }
            }
        }

        // BƯỚC 3: XỬ LÝ CHẾ ĐỘ RSI
        if (hasRsi && currentMainPositions.length < maxAllowed) {
            for (const candidate of levFiltered) {
                if (currentMainPositions.length >= maxAllowed) break;
                const symbol = candidate.symbol;

                if (isBlacklisted(symbol) || hasActivePositionForSymbol(symbol) || openingSymbols.has(symbol)) {
                    if (pendingLocks[symbol] && pendingLocks[symbol].mode === 'rsi') delete pendingLocks[symbol];
                    continue;
                }
                if (pendingLocks[symbol] && pendingLocks[symbol].mode === 'always') continue;

                const rsiData = await fetchRsiData(symbol, rsiTf, rsiPeriod);
                if (!rsiData) continue;

                // Yêu cầu bắt buộc: Quá mua từ 70 trở lên hoặc quá bán từ 30 trở xuống mới lên hàng chờ
                const isShortRsi = (rsiData.rsiPeak !== null && rsiData.rsiPeak >= 70);
                const isLongRsi = (rsiData.rsiTrough !== null && rsiData.rsiTrough <= 30);

                if (!isShortRsi && !isLongRsi) {
                    if (pendingLocks[symbol] && pendingLocks[symbol].mode === 'rsi') delete pendingLocks[symbol];
                    continue;
                }

                const currentPrice = pricesMap[symbol];
                if (!currentPrice) continue;

                let lock = pendingLocks[symbol];

                let side = isShortRsi ? 'SHORT' : 'LONG';
                if (isShortRsi && isLongRsi) {
                    side = (rsiData.currentRsi >= 50) ? 'SHORT' : 'LONG';
                }

                const leverage = candidate.lev;

                if (!pendingLocks[symbol] || pendingLocks[symbol].mode !== 'rsi') {
                    pendingLocks[symbol] = {
                        symbol: symbol, mode: 'rsi', fdRate: parseFloat(candidate.lastFundingRate),
                        fdType: candidate.fdType, side: side, lev: leverage,
                        priceHistory: [{ price: currentPrice, time: Date.now() }],
                        extremePrice: currentPrice, lockTime: Date.now(),
                        targetFundingTime: candidate.nextFundingTime, estPnl: candidate.estPnl,
                        lastCurrentPrice: currentPrice,
                        currentRsi: rsiData.currentRsi, rsiPeak: rsiData.rsiPeak, rsiTrough: rsiData.rsiTrough,
                        minRsiAfterPeak: rsiData.currentRsi, maxRsiAfterTrough: rsiData.currentRsi
                    };
                    lock = pendingLocks[symbol];
                } else {
                    lock = pendingLocks[symbol];
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
                            await executeOpenSequence(symbol, leverage, candidate.nextFundingTime, side, 'rsi', candidate.estPnl, currentPrice, rsiData);
                        } catch (e) {
                            log('ERROR', 'RSI', `✖ Lỗi mở vị thế ${symbol}: ${getErrorMessage(e)}`);
                        } finally {
                            openingSymbols.delete(symbol);
                            setTimeout(() => { isOpeningPosition = false; }, 1000);
                        }
                    })();

                    if (currentMainPositions.length + 1 >= maxAllowed) break;
                }
            }
        }

    } catch (e) {}
}

async function armT2MinuteScheduler() {
    if (!botRunning) return;
    
    clearTimeout(schedulerTimeout);

    const modes = userConfig.tradeModes || ['before'];
    if (modes.includes('always') || modes.includes('rsi')) {
        executePendingScan().catch(e => {});
    }

    if (!modes.includes('before')) {
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 2000);
        return;
    }
    
    try {
        const allFunding = await fetchFundingDataFromBinance(false);
        if (!allFunding || allFunding.length === 0) {
            schedulerTimeout = setTimeout(armT2MinuteScheduler, 15000);
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
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 10000);
    }
}

async function executeT2MinuteSingleScan(targetFundingTime) {
    if (!botRunning) return;
    
    const maxAllowed = userConfig.maxOpenPositions || 1;
    if (currentMainPositions.length >= maxAllowed) {
        const msAfterFunding = targetFundingTime + 30000 - Date.now();
        schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(msAfterFunding, 30000));
        return;
    }

    try {
        isOpeningPosition = true;
        const allFunding = await fetchFundingDataFromBinance(true);
        const candidates = getFilteredCandidates(allFunding, userConfig.fundingThreshold, targetFundingTime);

        if (candidates.length === 0) {
            isOpeningPosition = false;
            const timeToNextFd = targetFundingTime - (Date.now() + serverTimeOffset);
            schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(timeToNextFd + 10000, 15000));
            return;
        }

        const best = candidates[0];
        const leverage = best.lev;
        const nowServer = Date.now() + serverTimeOffset;

        if (hasActivePositionForSymbol(best.symbol)) {
            isOpeningPosition = false;
            const timeToNextFd = targetFundingTime - nowServer;
            schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(timeToNextFd + 10000, 15000));
            return;
        }

        let rsiData = null;
        if (userConfig.enableRsiConfirm) {
            const rsiTf = userConfig.rsiTimeframe || '5m';
            const rsiPeriod = userConfig.rsiPeriod || 14;
            rsiData = await fetchRsiData(best.symbol, rsiTf, rsiPeriod);
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
                isOpeningPosition = false;
                const timeToNextFd = targetFundingTime - nowServer;
                schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(timeToNextFd + 10000, 15000));
                return;
            }
        }

        let currentLev = getLeverageFromCache(best.symbol) || leverage;
        await setLeverage(best.symbol, currentLev);
        await ensureCrossMargin(best.symbol);
        await aggressiveCleanup(best.symbol);

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        const symbolInfo = exchangeInfoCache[best.symbol];
        const currentPrice = await getCurrentPrice(best.symbol);
        
        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
        let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, currentLev);

        const isNegative = best.fdType === 'negative';
        const mainSide = isNegative ? 'SHORT' : 'LONG';

        const shortOffsetMs = userConfig.shortOffsetMs !== undefined ? userConfig.shortOffsetMs : 0;
        const delayShort = (targetFundingTime + shortOffsetMs) - nowServer;

        clearTimeout(scheduledMainTimeout);
        if (delayShort >= 0) {
            scheduledMainTimeout = setTimeout(() => {
                if (botRunning && currentMainPositions.length < maxAllowed) {
                    openMainPositionWithRetry(best.symbol, quantity, targetFundingTime, mainSide, best.estPnl, 'before', currentLev, initialMargin, rsiData).catch(e => {});
                }
            }, delayShort);
        } else {
            if (botRunning && currentMainPositions.length < maxAllowed) {
                openMainPositionWithRetry(best.symbol, quantity, targetFundingTime, mainSide, best.estPnl, 'before', currentLev, initialMargin, rsiData).catch(e => {});
            }
        }

        const msAfterFunding = targetFundingTime + 30000 - Date.now();
        schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(msAfterFunding, 30000));

    } catch (e) {
        log('ERROR', 'SCAN', `✖ Lỗi thực hiện chọn coin T-2m: ${getErrorMessage(e)}`);
        isOpeningPosition = false;
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 10000);
    }
}

let isClosingMain = false;

async function openMainPositionWithRetry(symbol, quantity, nextFundingTime, side, estPnl = 0, mode = 'before', leverage = 20, initialMargin = 25, rsiData = null) {
    const maxAllowed = userConfig.maxOpenPositions || 1;
    if (currentMainPositions.length >= maxAllowed) {
        isOpeningPosition = false;
        return;
    }

    try {
        await ensureCrossMargin(symbol);
        const currentPrice = await getCurrentPrice(symbol);

        await executeMarketOrderWithMinVolCheck(symbol, side, side, quantity, currentPrice || 0);
        globalStats.totalSessions++;
        
        let realEntryPrice = 0;
        let lev = leverage;

        await new Promise(r => setTimeout(r, 500));
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
            const pos = positions.find(p => p.symbol === symbol && (p.positionSide === side || p.positionSide === 'BOTH'));
            if (pos && parseFloat(pos.positionAmt) !== 0) {
                realEntryPrice = parseFloat(pos.entryPrice);
                lev = parseInt(pos.leverage);
            }
        } catch (e) {}

        if (!realEntryPrice || realEntryPrice === 0) realEntryPrice = currentPrice || 0;

        const margin = (quantity * realEntryPrice) / (lev || 1);

        // LOG MỞ LỆNH: HIỆN CẢ RSI ĐỈNH/ĐÁY VÀ RSI HIỆN TẠI
        let rsiLogStr = '';
        if (rsiData && rsiData.currentRsi !== undefined) {
            const extremeRsiLabel = side === 'SHORT' ? `Đỉnh ${rsiData.rsiPeak ? Math.round(rsiData.rsiPeak) : '--'}` : `Đáy ${rsiData.rsiTrough ? Math.round(rsiData.rsiTrough) : '--'}`;
            rsiLogStr = ` | RSI: ${extremeRsiLabel} / HT ${Math.round(rsiData.currentRsi)}`;
        }

        log('TRADE', 'MAIN', `🚀 [OPEN] Coin: ${symbol} | Mode: ${mode.toUpperCase()} | Side: ${side} | Lev: ${lev}x | Margin: ${margin.toFixed(2)} USDT | Entry: ${formatPrice(realEntryPrice)}${rsiLogStr}`);

        addToBlacklist(symbol);

        const mainPos = { 
            symbol, side, quantity, openTime: Date.now(), entryPrice: realEntryPrice, 
            extremePrice: realEntryPrice, nextFundingTime,
            margin, leverage: lev, mode
        };
        currentMainPositions.push(mainPos);
        
        saveDataPositionsToFile();
        saveStateToFile();

        if (!mainCheckInterval) mainCheckInterval = setInterval(manageMainPositions, 1000);

        setTimeout(() => { isOpeningPosition = false; }, 1000);

    } catch (error) {
        const errStr = getErrorMessage(error);
        const errCode = error.code || 0;

        if (errCode === -4028 || errStr.toLowerCase().includes('leverage') || errStr.toLowerCase().includes('max leverage')) {
            log('WARN', 'MAIN', `⚠️ Lỗi MaxLev cho ${symbol}. Đang lấy MaxLev chuẩn từ sàn...`);
            const newMaxLev = await fetchSymbolMaxLeverageFromExchange(symbol);
            log('INFO', 'MAIN', `🔄 Cập nhật MaxLev cho ${symbol}: ${newMaxLev}x. Thử mở lại lệnh...`);
            
            await setLeverage(symbol, newMaxLev);
            const newPrice = await getCurrentPrice(symbol);
            const symbolInfo = exchangeInfoCache ? exchangeInfoCache[symbol] : null;
            const newQty = calculateValidQuantity(symbolInfo, newPrice, initialMargin, newMaxLev);

            try {
                await executeMarketOrderWithMinVolCheck(symbol, side, side, newQty, newPrice || 0);
                globalStats.totalSessions++;
                const margin = (newQty * newPrice) / newMaxLev;

                let rsiLogStr = '';
                if (rsiData && rsiData.currentRsi !== undefined) {
                    const extremeRsiLabel = side === 'SHORT' ? `Đỉnh ${rsiData.rsiPeak ? Math.round(rsiData.rsiPeak) : '--'}` : `Đáy ${rsiData.rsiTrough ? Math.round(rsiData.rsiTrough) : '--'}`;
                    rsiLogStr = ` | RSI: ${extremeRsiLabel} / HT ${Math.round(rsiData.currentRsi)}`;
                }

                log('TRADE', 'MAIN', `🚀 [OPEN RETRY MAXLEV] Coin: ${symbol} | Mode: ${mode.toUpperCase()} | Side: ${side} | Lev: ${newMaxLev}x | Margin: ${margin.toFixed(2)} USDT | Entry: ${formatPrice(newPrice)}${rsiLogStr}`);
                addToBlacklist(symbol);
                const mainPos = { 
                    symbol, side, quantity: newQty, openTime: Date.now(), entryPrice: newPrice, 
                    extremePrice: newPrice, nextFundingTime, margin, leverage: newMaxLev, mode
                };
                currentMainPositions.push(mainPos);
                saveDataPositionsToFile();
                saveStateToFile();
                if (!mainCheckInterval) mainCheckInterval = setInterval(manageMainPositions, 1000);
                setTimeout(() => { isOpeningPosition = false; }, 1000);
                return;
            } catch (retryErr) {
                log('ERROR', 'MAIN', `✖ Thử lại sau khi sửa MaxLev thất bại: ${getErrorMessage(retryErr)}`);
            }
        } 
        else if (errCode === -4164 || errCode === -2019 || errStr.toLowerCase().includes('notional') || errStr.toLowerCase().includes('margin') || errStr.toLowerCase().includes('filter')) {
            log('WARN', 'MAIN', `⚠️ Lỗi Min Margin / Notional cho ${symbol}. Đang tính lại Margin tối thiểu...`);
            await getExchangeInfo();
            const symbolInfo = exchangeInfoCache ? exchangeInfoCache[symbol] : null;
            const newPrice = await getCurrentPrice(symbol);
            
            let minNotional = symbolInfo ? (symbolInfo.minNotional || 5.0) : 5.0;
            let minMarginRequired = (minNotional / leverage) * 1.1; 
            let adjustedMargin = Math.max(initialMargin, minMarginRequired);
            let newQty = calculateValidQuantity(symbolInfo, newPrice, adjustedMargin, leverage);

            log('INFO', 'MAIN', `🔄 Thử lại với Margin tối thiểu: ${adjustedMargin.toFixed(2)} USDT (Qty: ${newQty})...`);
            try {
                await executeMarketOrderWithMinVolCheck(symbol, side, side, newQty, newPrice || 0);
                globalStats.totalSessions++;
                const margin = (newQty * newPrice) / leverage;

                let rsiLogStr = '';
                if (rsiData && rsiData.currentRsi !== undefined) {
                    const extremeRsiLabel = side === 'SHORT' ? `Đỉnh ${rsiData.rsiPeak ? Math.round(rsiData.rsiPeak) : '--'}` : `Đáy ${rsiData.rsiTrough ? Math.round(rsiData.rsiTrough) : '--'}`;
                    rsiLogStr = ` | RSI: ${extremeRsiLabel} / HT ${Math.round(rsiData.currentRsi)}`;
                }

                log('TRADE', 'MAIN', `🚀 [OPEN RETRY MIN MARGIN] Coin: ${symbol} | Mode: ${mode.toUpperCase()} | Side: ${side} | Lev: ${leverage}x | Margin: ${margin.toFixed(2)} USDT | Entry: ${formatPrice(newPrice)}${rsiLogStr}`);
                addToBlacklist(symbol);
                const mainPos = { 
                    symbol, side, quantity: newQty, openTime: Date.now(), entryPrice: newPrice, 
                    extremePrice: newPrice, nextFundingTime, margin, leverage, mode
                };
                currentMainPositions.push(mainPos);
                saveDataPositionsToFile();
                saveStateToFile();
                if (!mainCheckInterval) mainCheckInterval = setInterval(manageMainPositions, 1000);
                setTimeout(() => { isOpeningPosition = false; }, 1000);
                return;
            } catch (retryErr) {
                log('ERROR', 'MAIN', `✖ Thử lại sau khi sửa Min Margin thất bại: ${getErrorMessage(retryErr)}`);
            }
        } else {
            log('ERROR', 'MAIN', `✖ Lỗi mở lệnh MAIN ${side} ${symbol}: ${errStr}`);
        }

        isOpeningPosition = false;
        armT2MinuteScheduler();
    }
}

async function manageMainPositions() {
    if (currentMainPositions.length === 0 || isClosingMain) return;
    isClosingMain = true;
    try {
        const currentServerTime = Date.now() + serverTimeOffset;

        for (let i = currentMainPositions.length - 1; i >= 0; i--) {
            const pos = currentMainPositions[i];
            if (!pos) continue;
            const { symbol, side, entryPrice, nextFundingTime, openTime, mode } = pos;
            const isLong = side === 'LONG';

            if (mode === 'always' || mode === 'rsi') {
                const elapsedMins = (Date.now() - openTime) / 60000;
                const maxHoldMins = userConfig.holdMinutes || 15;
                if (elapsedMins >= maxHoldMins) {
                    await closeMainInternal(pos, `Hết thời gian (${maxHoldMins}m)`);
                    continue;
                }
            } else if (nextFundingTime && currentServerTime >= nextFundingTime) {
                await closeMainInternal(pos, 'Hết giờ Funding');
                continue;
            }
            
            const currentPrice = wsPriceMap[symbol] || await getCurrentPrice(symbol);
            if (!currentPrice) continue;

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
                await closeMainInternal(pos, closeReason);
            }
        }
    } catch (error) { 
        log('ERROR', 'MAIN_CHECK', `Lỗi kiểm tra vị thế Main: ${getErrorMessage(error)}`);
    } finally {
        isClosingMain = false;
    }
}

async function closeMainInternal(mainPos, reason = 'Thủ công') {
    if (!mainPos) return;
    const { symbol, side, openTime, entryPrice, quantity, leverage, margin, mode } = mainPos;
    const duration = formatDuration(openTime);

    try {
        await aggressiveCleanup(symbol);
        
        const currentPrice = wsPriceMap[symbol] || await getCurrentPrice(symbol) || entryPrice;
        
        let rawPnl = 0;
        if (side === 'LONG') {
            rawPnl = (currentPrice - entryPrice) * quantity;
        } else {
            rawPnl = (entryPrice - currentPrice) * quantity;
        }
        
        const roi = margin > 0 ? (rawPnl / margin) * 100 : 0;
        
        let logType = 'CLOSE-MANUAL';
        if (reason.includes('TP') || reason.includes('Lãi')) logType = 'CLOSE-TP';
        else if (reason.includes('SL') || reason.includes('Lỗ')) logType = 'CLOSE-SL';
        else if (reason.includes('Hết giờ')) logType = 'CLOSE-EXPIRE';

        log('PNL', 'MAIN', `💰 [${logType}] Coin: ${symbol} | Mode: ${(mode || 'before').toUpperCase()} | Side: ${side} | Lev: ${leverage || 20}x | Margin: ${(margin || 0).toFixed(2)} USDT | Entry: ${formatPrice(entryPrice)} | Giá Chốt: ${formatPrice(currentPrice)} | PnL: ${rawPnl >= 0 ? '+' : ''}${rawPnl.toFixed(2)} USDT | ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}% | Time: ${duration}`);

        globalStats.totalPnl += rawPnl;
        saveStateToFile();

        currentMainPositions = currentMainPositions.filter(p => p.symbol !== symbol);
        saveDataPositionsToFile();
        saveStateToFile();

    } catch (error) {
        log('ERROR', 'MAIN', `✖ Lỗi đóng vị thế ${symbol}: ${getErrorMessage(error)}`);
    }
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/config', (req, res) => {
    res.json(userConfig);
});

app.get('/api/status', (req, res) => {
    let statusText = botRunning ? "RUNNING" : "STOPPED";
    if (isBanned) {
        statusText += ` | BAN IP (Tự start lại lúc: ${getUtc7TimeString(banUntilTimestamp)})`;
    }
    res.send(`Status: ${statusText}`);
});

app.get('/api/logs', (req, res) => {
    res.json(memoryLogs);
});

app.get('/api/funding_rates', async (req, res) => {
    try {
        const data = await fetchFundingDataFromBinance(false);
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

function applyConfigUpdates(query) {
    if (query.apiKey !== undefined) userConfig.apiKey = query.apiKey;
    if (query.secretKey !== undefined) userConfig.secretKey = query.secretKey;
    if (query.minLeverage !== undefined) userConfig.minLeverage = parseInt(query.minLeverage) || 20;
    if (query.maxOpenPositions !== undefined) userConfig.maxOpenPositions = parseInt(query.maxOpenPositions) || 1;
    if (query.amountMode !== undefined) userConfig.amountMode = query.amountMode;
    if (query.amountValue !== undefined) userConfig.amountValue = parseFloat(query.amountValue) || 25;
    if (query.tpFixed !== undefined) userConfig.tpFixedPercent = parseFloat(query.tpFixed) || 1;
    if (query.enableTrailing !== undefined) userConfig.enableTrailing = query.enableTrailing === 'true';
    if (query.tpTrailing !== undefined) userConfig.tpTrailingPercent = parseFloat(query.tpTrailing) || 1;
    if (query.sl !== undefined) userConfig.slPercent = parseFloat(query.sl) || 2;
    if (query.shortMs !== undefined) userConfig.shortOffsetMs = parseInt(query.shortMs) || 0;
    if (query.threshold !== undefined) userConfig.fundingThreshold = parseFloat(query.threshold) || 0.3;
    if (query.tradeModes !== undefined) userConfig.tradeModes = query.tradeModes.split(',').filter(Boolean);
    if (query.sortMode !== undefined) userConfig.sortMode = query.sortMode;
    if (query.holdMinutes !== undefined) userConfig.holdMinutes = parseInt(query.holdMinutes) || 15;
    if (query.enablePriceTrigger !== undefined) userConfig.enablePriceTrigger = query.enablePriceTrigger === 'true';
    if (query.priceTriggerPct !== undefined) userConfig.priceTriggerPct = parseFloat(query.priceTriggerPct) || 5;
    if (query.enableRsiConfirm !== undefined) userConfig.enableRsiConfirm = query.enableRsiConfirm === 'true';
    if (query.rsiTimeframe !== undefined) userConfig.rsiTimeframe = query.rsiTimeframe;
    if (query.rsiPeriod !== undefined) userConfig.rsiPeriod = parseInt(query.rsiPeriod) || 14;

    saveConfigToFile();
}

app.get('/api/start', async (req, res) => {
    applyConfigUpdates(req.query);
    botRunning = true;
    saveStateToFile();
    log('INFO', 'SYS', '▶ Bot đã khởi chạy và áp dụng ngay lập tức cấu hình.');
    armT2MinuteScheduler();
    executePendingScan().catch(e => {});
    res.send('Bot started');
});

app.get('/api/save_config', (req, res) => {
    applyConfigUpdates(req.query);
    log('INFO', 'SYS', '💾 Đã lưu & áp dụng cấu hình mới ngay lập tức!');
    if (botRunning) {
        armT2MinuteScheduler();
        executePendingScan().catch(e => {});
    }
    res.send('Lưu cấu hình thành công và đã áp dụng ngay lập tức!');
});

app.get('/api/stop', (req, res) => {
    botRunning = false;
    stopAllSchedulers();
    saveStateToFile();
    log('INFO', 'SYS', '⏹ Bot đã tạm dừng.');
    res.send('Bot stopped');
});

app.get('/api/dashboard', async (req, res) => {
    try {
        let balance = 0;
        let totalWalletBalance = 0;

        try {
            if (userConfig.apiKey && userConfig.secretKey) {
                const acc = await callSignedAPI('/fapi/v2/account', 'GET');
                if (acc) {
                    balance = parseFloat(acc.availableBalance || 0);
                    // TÍNH TOÀN BỘ TÀI SẢN TRONG FUTU BINANCE (GỒM PNL CHƯA GHI NHẬN)
                    totalWalletBalance = parseFloat(acc.totalMarginBalance || acc.totalWalletBalance || 0);
                    if (!totalWalletBalance && acc.assets) {
                        const usdtAsset = acc.assets.find(a => a.asset === 'USDT');
                        if (usdtAsset) {
                            balance = parseFloat(usdtAsset.availableBalance || 0);
                            totalWalletBalance = parseFloat(usdtAsset.walletBalance || 0) + parseFloat(usdtAsset.unrealizedProfit || 0);
                        }
                    }
                }
            }
        } catch (e) {}

        let totalUnrealizedPnl = 0;

        const mappedPositions = await Promise.all(currentMainPositions.map(async (pos) => {
            let currentPrice = wsPriceMap[pos.symbol];
            if (!currentPrice) {
                try { currentPrice = await getCurrentPrice(pos.symbol); } catch(e){}
            }
            if (!currentPrice) currentPrice = pos.entryPrice;

            const isLong = pos.side === 'LONG';
            
            let pnl = 0;
            if (isLong) {
                pnl = (currentPrice - pos.entryPrice) * pos.quantity;
            } else {
                pnl = (pos.entryPrice - currentPrice) * pos.quantity;
            }

            totalUnrealizedPnl += pnl;

            const margin = pos.margin || ((pos.quantity * pos.entryPrice) / pos.leverage);
            const pctFromEntry = margin > 0 ? (pnl / margin) * 100 : 0;

            const tpFixedPct = userConfig.tpFixedPercent || 1;
            const slPct = userConfig.slPercent || 2;
            const tpTrailingPct = userConfig.tpTrailingPercent || 1;

            const tpFixedPrice = isLong ?
                pos.entryPrice + (pos.entryPrice * (tpFixedPct / 100)) :
                pos.entryPrice - (pos.entryPrice * (tpFixedPct / 100));

            const slPrice = isLong ?
                pos.entryPrice - (pos.entryPrice * (slPct / 100)) :
                pos.entryPrice + (pos.entryPrice * (slPct / 100));

            let tpTrailingPrice = 0;
            if (pos.extremePrice) {
                tpTrailingPrice = isLong ?
                    pos.extremePrice - (pos.entryPrice * (tpTrailingPct / 100)) :
                    pos.extremePrice + (pos.entryPrice * (tpTrailingPct / 100));
            }

            let remainingMs = 0;
            if (pos.mode === 'always' || pos.mode === 'rsi') {
                const maxHoldMs = (userConfig.holdMinutes || 15) * 60000;
                remainingMs = Math.max(0, (pos.openTime + maxHoldMs) - Date.now());
            } else if (pos.nextFundingTime) {
                remainingMs = Math.max(0, pos.nextFundingTime - (Date.now() + serverTimeOffset));
            }

            return {
                coin: pos.symbol,
                side: pos.side,
                leverage: pos.leverage,
                margin: margin,
                entryPrice: pos.entryPrice,
                markPrice: currentPrice,
                extremePrice: pos.extremePrice || pos.entryPrice,
                pnl: pnl,
                pctFromEntry: pctFromEntry,
                slPrice: slPrice,
                slPnlRoi: -slPct,
                tpFixedPrice: tpFixedPrice,
                tpFixedPnlRoi: tpFixedPct,
                enableTrailing: userConfig.enableTrailing || false,
                tpTrailingPrice: tpTrailingPrice,
                mode: pos.mode || 'before',
                remainingMs: remainingMs
            };
        }));

        const pendingList = Object.values(pendingLocks).map(item => {
            const currentPrice = wsPriceMap[item.symbol] || item.lastCurrentPrice || 0;
            const extremePrice = item.extremePrice || currentPrice;
            let currentDiffPct = 0;
            if (extremePrice && currentPrice) {
                currentDiffPct = Math.abs((currentPrice - extremePrice) / extremePrice) * 100;
            }

            return {
                symbol: item.symbol,
                mode: item.mode,
                side: item.side,
                lev: item.lev,
                fdRate: item.fdRate,
                currentRsi: item.currentRsi,
                rsiPeak: item.rsiPeak,
                rsiTrough: item.rsiTrough,
                extremePrice: extremePrice,
                currentPrice: currentPrice,
                currentDiffPct: currentDiffPct,
                targetTriggerPct: userConfig.enablePriceTrigger ? (userConfig.priceTriggerPct || 5) : 0,
                targetFundingTime: item.targetFundingTime,
                expectedMargin: userConfig.amountValue || 25
            };
        });

        const closedPnlSum = recalculateTotalPnlFromLogs();
        const displayClosedPnl = globalStats.totalPnl !== 0 ? globalStats.totalPnl : closedPnlSum;

        // HIỆN PNL CHƯA GHI NHẬN BÊN TRÁI PNL ĐÃ CHỐT (TẠI THẺ SỐ PHIÊN / UPNL)
        const uPnlFormatted = totalUnrealizedPnl >= 0 ? `+${totalUnrealizedPnl.toFixed(2)}` : totalUnrealizedPnl.toFixed(2);
        const sessionsWithUpnl = `${globalStats.totalSessions} | uPnL: ${uPnlFormatted} USDT`;

        res.json({
            totalWalletBalance: totalWalletBalance,
            balance: balance,
            botOpenPositionsCount: mappedPositions.length,
            totalSessions: sessionsWithUpnl,
            totalPnl: displayClosedPnl,
            positions: mappedPositions,
            pendingQueue: pendingList
        });

    } catch (e) {
        res.status(500).json({ error: getErrorMessage(e) });
    }
});

app.get('/api/force_close', async (req, res) => {
    const { symbol, side } = req.query;
    const pos = currentMainPositions.find(p => p.symbol === symbol && p.side === side);
    if (pos) {
        await closeMainInternal(pos, 'Đóng thủ công từ Web UI');
        res.send(`Đã đóng vị thế ${symbol}`);
    } else {
        res.status(404).send('Không tìm thấy vị thế');
    }
});

app.get('/api/cancel_pending', (req, res) => {
    const { symbol } = req.query;
    if (pendingLocks[symbol]) {
        delete pendingLocks[symbol];
        res.send(`Đã hủy coin ${symbol} khỏi hàng chờ`);
    } else {
        res.status(404).send('Coin không trong hàng chờ');
    }
});

app.listen(WEB_SERVER_PORT, async () => {
    console.log(`==================================================`);
    console.log(` Web Dashboard Server running on http://localhost:${WEB_SERVER_PORT}`);
    console.log(`==================================================`);
    
    const loadedData = loadDataPositionsFromFile();
    currentMainPositions = loadedData.mainPositions;
    loadStateFromFile();
    
    await syncServerTime();
    await getExchangeInfo();
    initBinanceWebSocket();

    if (botRunning) {
        log('INFO', 'SYS', '▶ Tự động tiếp tục bot theo trạng thái đã lưu...');
        armT2MinuteScheduler();
    }
    
    if (currentMainPositions.length > 0 && !mainCheckInterval) {
        mainCheckInterval = setInterval(manageMainPositions, 1000);
    }
});
