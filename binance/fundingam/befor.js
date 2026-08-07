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

const DEFAULT_API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim();
const DEFAULT_SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim();

let userConfig = {
    apiKey: DEFAULT_API_KEY,
    secretKey: DEFAULT_SECRET_KEY,
    amountMode: 'percent', 
    amountValue: 25,       
    tpPercent: 1,        
    slPercent: 2,
    longOffsetMs: 1500, 
    shortOffsetMs: 0,
    fundingThreshold: 0.3,
    tradeMode: 'both',
    sortMode: 'pnl'
};

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
        }
    } catch (error) {
        log('WARN', 'SYSTEM', `⚠️ Không thể đọc file cấu hình: ${getErrorMessage(error)}`);
    }
}

function saveConfigToFile() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(userConfig, null, 2), 'utf8');
    } catch (error) {
        log('ERROR', 'SYSTEM', `✖ Lỗi lưu file cấu hình: ${getErrorMessage(error)}`);
    }
}

const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; 
let exchangeInfoCache = null;
let leverageCache = {};
let botRunning = false;
let botStartTime = null; 

let currentMainPosition = null; 
let currentBufferPosition = null; 

let mainCheckInterval = null; 
let bufferCheckInterval = null;
let schedulerTimeout = null; 
let scheduledBufferTimeout = null; 
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
const DASHBOARD_CACHE_TTL = 3000; 

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
            currentMainPosition,
            currentBufferPosition,
            botRunning,
            globalStats
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2), 'utf8');
    } catch (e) {
        log('ERROR', 'SYSTEM', `✖ Lỗi lưu vị thế state: ${getErrorMessage(e)}`);
    }
}

function loadStateFromFile() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (data.currentMainPosition) currentMainPosition = data.currentMainPosition;
            if (data.currentBufferPosition) currentBufferPosition = data.currentBufferPosition;
            if (data.botRunning !== undefined) botRunning = data.botRunning;
            if (data.globalStats) globalStats = data.globalStats;
        }
    } catch (e) {
        log('ERROR', 'SYSTEM', `✖ Lỗi đọc vị thế state: ${getErrorMessage(e)}`);
    }
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
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            log('ERROR', 'API', `⚠ Đã xảy ra ${consecutiveApiErrors} lỗi API liên tiếp.`);
        }
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
        log('ERROR', 'SYNC', `✖ Lỗi đồng bộ thời gian Binance: ${getErrorMessage(error)}`);
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
    } catch (error) { }
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

async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol });
        return parseFloat(data.price);
    } catch (error) { 
        return null; 
    }
}

async function checkExchangePositionExists(symbol) {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        for (const pos of positions) {
            if (Math.abs(parseFloat(pos.positionAmt)) > 0) {
                return true;
            }
        }
        return false;
    } catch (e) {
        return false;
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
    } catch (e) { }
}

function fetchAndLogRealizedPnL(symbol, positionSide, isTest = false) {
    const closeTime = Date.now();
    setTimeout(async () => {
        try {
            const trades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol, limit: 15 });
            const closeTrades = trades.filter(t => 
                t.time >= closeTime - 15000 && 
                t.realizedPnl !== "0" && 
                (t.positionSide === positionSide || t.positionSide === 'BOTH')
            );
            const totalPnl = closeTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            
            if (!isTest) {
                globalStats.totalPnl += totalPnl;
                saveStateToFile();
            }
            
            log('PNL', 'PNL', `💰 Kết quả giao dịch | Coin: ${symbol} | Position: ${positionSide} | PnL thực tế: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT ${isTest ? '(TEST)' : ''}`);
        } catch (e) { }
    }, 5000); 
}

function calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage) {
    let minNotional = symbolInfo.minNotional || 5.0;
    let targetNotional = initialMargin * leverage;

    if (targetNotional < minNotional) {
        targetNotional = minNotional;
    }

    let qtyRaw = targetNotional / currentPrice;
    let step = symbolInfo.stepSize || 0.001;
    let precision = symbolInfo.quantityPrecision;

    let quantity = Math.ceil(qtyRaw / step) * step;

    if (quantity * currentPrice < minNotional) {
        quantity += step;
    }

    return parseFloat(quantity.toFixed(precision));
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

function getFilteredCandidates(allFunding, reqThreshold = null) {
    let valid = [...allFunding];
    if (reqThreshold !== null) {
        valid = valid.filter(item => (Math.abs(parseFloat(item.lastFundingRate)) * 100) >= reqThreshold);
    }
    return valid;
}

async function armT2MinuteScheduler() {
    if (!botRunning || currentMainPosition) return;
    
    clearTimeout(schedulerTimeout);
    
    try {
        const allFunding = await fetchFundingDataFromBinance(true);
        if (!allFunding || allFunding.length === 0) {
            schedulerTimeout = setTimeout(armT2MinuteScheduler, 30000);
            return;
        }

        const nextFdTime = allFunding[0].nextFundingTime;
        const nowServer = Date.now() + serverTimeOffset;
        
        const t2TargetTime = nextFdTime - 120000;
        const msToWait = t2TargetTime - nowServer;

        if (msToWait > 0) {
            schedulerTimeout = setTimeout(() => {
                executeT2MinuteSingleScan(nextFdTime);
            }, msToWait);
        } else {
            executeT2MinuteSingleScan(nextFdTime);
        }
    } catch (e) {
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 15000);
    }
}

async function executeT2MinuteSingleScan(targetFundingTime) {
    if (!botRunning || currentMainPosition) return;
    
    try {
        isOpeningPosition = true;
        const allFunding = await fetchFundingDataFromBinance(true);
        const candidates = getFilteredCandidates(allFunding, userConfig.fundingThreshold);

        if (candidates.length === 0) {
            log('WARN', 'SCAN', `⚠️ Không có coin nào đủ điều kiện threshold (>=${userConfig.fundingThreshold}%). Hủy phiên này.`);
            isOpeningPosition = false;
            const timeToNextFd = targetFundingTime - (Date.now() + serverTimeOffset);
            schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(timeToNextFd + 10000, 30000));
            return;
        }

        const best = candidates[0];
        const leverage = best.lev;
        const nowServer = Date.now() + serverTimeOffset;
        const timeStr = new Date(targetFundingTime + 7*3600000).toISOString().substr(11, 8);

        log('SUCCESS', 'SCAN', `🎯 [CHỌN COIN] Symbol: ${best.symbol} | Funding Rate: ${(parseFloat(best.lastFundingRate) * 100).toFixed(4)}% | Đòn bẩy: ${leverage}x | Est PnL: ${best.estPnl.toFixed(2)}% | Funding Time: ${timeStr} UTC+7`);

        await setLeverage(best.symbol, leverage);
        await aggressiveCleanup(best.symbol);

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        const symbolInfo = exchangeInfoCache[best.symbol];
        const currentPrice = await getCurrentPrice(best.symbol);
        
        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
        let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);

        const isNegative = best.fdType === 'negative';
        const bufferSide = isNegative ? 'LONG' : 'SHORT';
        const mainSide = isNegative ? 'SHORT' : 'LONG';

        const longOffsetMs = userConfig.longOffsetMs || 1500;
        const shortOffsetMs = userConfig.shortOffsetMs || 0;

        const delayLong = targetFundingTime - longOffsetMs - nowServer;
        const delayShort = targetFundingTime - shortOffsetMs - nowServer;

        const tradeMode = userConfig.tradeMode || 'both';

        clearTimeout(scheduledBufferTimeout);
        if ((tradeMode === 'both' || tradeMode === 'buffer') && delayLong > 0) {
            scheduledBufferTimeout = setTimeout(() => {
                if (botRunning) openBufferPosition(best.symbol, leverage, balance, bufferSide, false).catch(e => {});
            }, delayLong);
        }

        clearTimeout(scheduledMainTimeout);
        if ((tradeMode === 'both' || tradeMode === 'main') && delayShort >= 0) {
            scheduledMainTimeout = setTimeout(() => {
                if (botRunning && !currentMainPosition) {
                    openMainPosition(best.symbol, quantity, targetFundingTime, mainSide, false, best.estPnl).catch(e => {});
                }
            }, delayShort);
        }

        const msAfterFunding = targetFundingTime + 30000 - Date.now();
        schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(msAfterFunding, 60000));

    } catch (e) {
        log('ERROR', 'SCAN', `✖ Lỗi thực hiện chọn coin T-2m: ${getErrorMessage(e)}`);
        isOpeningPosition = false;
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 15000);
    }
}

async function openBufferPosition(symbol, leverage, balance, side, isTest = false) {
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        if(!currentPrice) throw new Error("Không thể lấy giá mở lệnh Buffer");
        
        let initialMargin = userConfig.amountMode === 'percent' 
            ? balance * (userConfig.amountValue / 100) 
            : userConfig.amountValue;
            
        let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);
        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: orderSide, positionSide: side, type: 'MARKET', quantity: quantity
        });
        
        const slDistance = currentPrice * (userConfig.slPercent / 100);
        const slPrice = side === 'LONG' ? currentPrice - slDistance : currentPrice + slDistance;

        log('TRADE', 'BUFFER', `🚀 Mở vị thế Buffer | Coin: ${symbol} | Hướng: ${side} | Qty: ${formatNumber(quantity)} | Đòn bẩy: ${leverage}x | Entry: ${formatPrice(currentPrice)}`);

        currentBufferPosition = { 
            symbol, side, quantity, entryPrice: currentPrice, slPrice, openTime: Date.now(), isTest 
        };
        saveStateToFile();
        
        if (bufferCheckInterval) clearInterval(bufferCheckInterval);
        bufferCheckInterval = setInterval(manageBufferPosition, 1200);

    } catch (error) {
        log('ERROR', 'BUFFER', `✖ Lỗi mở lệnh Buffer ${side} ${symbol}: ${getErrorMessage(error)}`);
    }
}

let isClosingBuffer = false;
async function manageBufferPosition() {
    if (!currentBufferPosition || isClosingBuffer) return;
    try {
        const currentPrice = await getCurrentPrice(currentBufferPosition.symbol);
        if(!currentPrice) return;
        
        const isLong = currentBufferPosition.side === 'LONG';
        let isSlHit = false;

        if (isLong && currentPrice <= currentBufferPosition.slPrice) isSlHit = true;
        if (!isLong && currentPrice >= currentBufferPosition.slPrice) isSlHit = true;

        if (isSlHit) {
            isClosingBuffer = true;
            try {
                log('WARN', 'SL', `⚠ Kích hoạt Stop Loss Buffer | Coin: ${currentBufferPosition.symbol} | Entry: ${formatPrice(currentBufferPosition.entryPrice)} | Giá hiện tại: ${formatPrice(currentPrice)}`);
                await closeBufferInternal('Chạm Stop Loss Buffer', currentBufferPosition.isTest);
            } finally {
                isClosingBuffer = false;
            }
        }
    } catch (e) { 
        isClosingBuffer = false; 
    }
}

async function closeBufferInternal(reason = 'Thời gian', isTest = false) {
    if (!currentBufferPosition) return;
    const { symbol, side, openTime, entryPrice } = currentBufferPosition;
    const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
    const duration = formatDuration(openTime);
    
    currentBufferPosition = null; 
    saveStateToFile();
    if (bufferCheckInterval) { clearInterval(bufferCheckInterval); bufferCheckInterval = null; }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && (p.positionSide === side || p.positionSide === 'BOTH'));
        const actualAmt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
        const markPrice = pos ? parseFloat(pos.markPrice) : entryPrice;

        if (actualAmt > 0) {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: orderSide, positionSide: pos.positionSide, type: 'MARKET', quantity: formatQty(symbol, actualAmt)
            });
            log('SUCCESS', 'BUFFER', `🛑 Đóng vị thế Buffer | Coin: ${symbol} | Hướng: ${side} | Giá thoát: ${formatPrice(markPrice)} | Lý do: ${reason} | Thời gian giữ: ${duration}`);
            fetchAndLogRealizedPnL(symbol, side, isTest);
        }
    } catch (error) {
        log('WARN', 'BUFFER', `⚠ Lỗi đóng Buffer ${symbol}: ${getErrorMessage(error)}.`);
        await aggressiveCleanup(symbol);
    }
}

let isClosingMain = false;
async function openMainPosition(symbol, quantity, nextFundingTime, side, isTest = false, estPnl = 0) {
    if (currentBufferPosition) {
        await closeBufferInternal('Chuyển giao Main', isTest); 
    }
    
    try {
        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: orderSide, positionSide: side, type: 'MARKET', quantity: quantity
        });
        
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
            const currentPrice = await getCurrentPrice(symbol);
            realEntryPrice = currentPrice || 0;
        }

        const margin = (quantity * realEntryPrice) / (lev || 1);
        log('TRADE', 'MAIN', `🚀 Mở vị thế Main | Coin: ${symbol} | Hướng: ${side} | Qty: ${formatNumber(quantity)} | Đòn bẩy: ${lev}x | Margin: ${margin.toFixed(2)} USDT | Entry: ${formatPrice(realEntryPrice)}`);

        currentMainPosition = { 
            symbol, side, quantity, openTime: Date.now(), entryPrice: realEntryPrice, extremePrice: realEntryPrice, nextFundingTime, isTest 
        };
        saveStateToFile();

        if (mainCheckInterval) clearInterval(mainCheckInterval);
        mainCheckInterval = setInterval(manageMainPosition, 1200);

        lastOrderOpenTime = Date.now();
        setTimeout(() => { isOpeningPosition = false; }, 60000);

    } catch (error) {
        log('ERROR', 'MAIN', `✖ Lỗi mở lệnh MAIN ${side} ${symbol}: ${getErrorMessage(error)}`);
        isOpeningPosition = false;
        armT2MinuteScheduler();
    }
}

async function manageMainPosition() {
    if (!currentMainPosition || isClosingMain) return;
    const { symbol, side, entryPrice, nextFundingTime, isTest } = currentMainPosition;
    const isLong = side === 'LONG';
    const currentServerTime = Date.now() + serverTimeOffset;

    if (nextFundingTime) {
        const timeRemaining = nextFundingTime - currentServerTime;
        if (isTest && timeRemaining <= 1500 && timeRemaining > 0) {
            isClosingMain = true;
            try {
                log('INFO', 'MAIN', `⏳ [TEST] Còn <= 1500ms tới giờ Funding. Tự động đóng lệnh TEST!`);
                await closeMainInternal('Test Auto Close', true);
            } finally {
                isClosingMain = false;
            }
            return;
        }
    }
    
    try {
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) return;

        let stateUpdated = false;
        if (isLong) {
            if (!currentMainPosition.extremePrice || currentPrice > currentMainPosition.extremePrice) {
                currentMainPosition.extremePrice = currentPrice;
                stateUpdated = true;
            }
        } else {
            if (!currentMainPosition.extremePrice || currentPrice < currentMainPosition.extremePrice) {
                currentMainPosition.extremePrice = currentPrice;
                stateUpdated = true;
            }
        }
        if (stateUpdated) saveStateToFile();

        const extremePrice = currentMainPosition.extremePrice;
        const tpPct = userConfig.tpPercent;
        const slPct = userConfig.slPercent;

        const maxGainPct = isLong ? 
            ((extremePrice - entryPrice) / entryPrice) * 100 : 
            ((entryPrice - extremePrice) / entryPrice) * 100;

        const fixedSL = isLong ? 
            entryPrice - (entryPrice * (slPct / 100)) : 
            entryPrice + (entryPrice * (slPct / 100));

        let activeSL = fixedSL;
        let isSlPositive = false;

        if (maxGainPct >= tpPct) {
            if (isLong) {
                const trailedSL = extremePrice - (entryPrice * (tpPct / 100));
                activeSL = Math.max(entryPrice, trailedSL);
            } else {
                const trailedSL = extremePrice + (entryPrice * (tpPct / 100));
                activeSL = Math.min(entryPrice, trailedSL);
            }
            isSlPositive = true;
        }

        currentMainPosition.dynamicSL = activeSL; 
        currentMainPosition.isSlPositive = isSlPositive;

        let triggerClose = false;
        if (isLong && currentPrice <= activeSL) triggerClose = true;
        if (!isLong && currentPrice >= activeSL) triggerClose = true;

        if (triggerClose) {
            isClosingMain = true;
            try {
                const slName = isSlPositive ? `Kích hoạt Chốt Lãi / SL Dương` : `Chạm Stop Loss`;
                if (isSlPositive) {
                    log('SUCCESS', 'TP', `🎯 Kích hoạt Chốt Lãi / SL Dương | Coin: ${symbol} | Entry: ${formatPrice(entryPrice)} | Giá chốt: ${formatPrice(activeSL)} | Giá hiện tại: ${formatPrice(currentPrice)}`);
                } else {
                    log('WARN', 'SL', `⚠ Kích hoạt Stop Loss | Coin: ${symbol} | Entry: ${formatPrice(entryPrice)} | Giá SL: ${formatPrice(activeSL)} | Giá hiện tại: ${formatPrice(currentPrice)}`);
                }
                await closeMainInternal(slName, isTest);
            } finally {
                isClosingMain = false;
            }
            return;
        }
    } catch (error) { 
        log('ERROR', 'MAIN_CHECK', `Lỗi kiểm tra vị thế Main: ${getErrorMessage(error)}`);
    }
}

async function closeMainInternal(reason = 'Thủ công', isTest = false) {
    if (!currentMainPosition) return;
    const { symbol, side, openTime, entryPrice } = currentMainPosition;
    const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
    const duration = formatDuration(openTime);

    if (mainCheckInterval) { clearInterval(mainCheckInterval); mainCheckInterval = null; }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && (p.positionSide === side || p.positionSide === 'BOTH'));
        const actualAmt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
        const markPrice = pos ? parseFloat(pos.markPrice) : entryPrice;

        if (actualAmt > 0) {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: orderSide, positionSide: pos.positionSide, type: 'MARKET', quantity: formatQty(symbol, actualAmt)
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
    currentMainPosition = null;
    saveStateToFile();
    if (mainCheckInterval) { clearInterval(mainCheckInterval); mainCheckInterval = null; }
    setTimeout(async () => {
        await aggressiveCleanup(symbol);
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

            if (totalWalletBalance > 0 && availableBalance <= (totalWalletBalance * 0.10)) {
                log('WARN', 'POSITION', `🚨 BÁO ĐỘNG: Margin còn lại <= 10% số dư tài khoản. KÍCH HOẠT CHỐNG THANH LÝ TOÀN BỘ SÀN!`);
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
                currentMainPosition = null;
                currentBufferPosition = null;
                saveStateToFile();
                log('SUCCESS', 'POSITION', `🛑 Đã ĐÓNG TOÀN BỘ vị thế trên tài khoản. Bot tự động TẮT để bảo toàn vốn.`);
            }
        } catch(e) {}
    }, 20000);
}

async function restoreActivePositionsOnStartup() {
    loadStateFromFile();
    if (!userConfig.apiKey || !userConfig.secretKey) return;
    try {
        await syncServerTime();
        await updateAllLeverageCache(); 
        await getExchangeInfo();
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        
        if (currentMainPosition) {
            const pos = positions.find(p => p.symbol === currentMainPosition.symbol && (p.positionSide === currentMainPosition.side || p.positionSide === 'BOTH'));
            if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) {
                log('SUCCESS', 'SYNC', `✓ Khôi phục quản lý MAIN ${currentMainPosition.side} ${currentMainPosition.symbol} (Entry: ${currentMainPosition.entryPrice})`);
                botRunning = true;
                if (mainCheckInterval) clearInterval(mainCheckInterval);
                mainCheckInterval = setInterval(manageMainPosition, 1200);
            } else {
                currentMainPosition = null;
                saveStateToFile();
            }
        }

        if (currentBufferPosition) {
            const pos = positions.find(p => p.symbol === currentBufferPosition.symbol && (p.positionSide === currentBufferPosition.side || p.positionSide === 'BOTH'));
            if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) {
                log('SUCCESS', 'SYNC', `✓ Khôi phục quản lý BUFFER ${currentBufferPosition.side} ${currentBufferPosition.symbol}`);
                botRunning = true;
                if (bufferCheckInterval) clearInterval(bufferCheckInterval);
                bufferCheckInterval = setInterval(manageBufferPosition, 1200);
            } else {
                currentBufferPosition = null;
                saveStateToFile();
            }
        }
        
        if (botRunning) {
            startAntiLiquidationMonitor();
            if (!currentMainPosition) armT2MinuteScheduler();
        }
    } catch (e) {
        log('ERROR', 'SYNC', `✖ Lỗi khôi phục vị thế: ${getErrorMessage(e)}`);
    }
}

async function getDashboardDataCached() {
    if (!botRunning) return { running: false };
    const now = Date.now();

    if (isOpeningPosition || (cachedDashboardData && (now - lastDashboardFetchTime < DASHBOARD_CACHE_TTL))) {
        if (cachedDashboardData) return cachedDashboardData;
    }

    if (!userConfig.apiKey || !userConfig.secretKey) {
        return { running: true, error: "Thiếu API Key" };
    }

    try {
        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        const walletBalance = parseFloat(acc.totalWalletBalance || 0);
        const totalUnrealizedProfit = parseFloat(acc.totalUnrealizedProfit || 0);
        const totalWalletBalance = walletBalance + totalUnrealizedProfit; 

        const openOrdersInfo = await callSignedAPI('/fapi/v1/openOrders', 'GET');
        const allPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositions = allPositions.filter(p => parseFloat(p.positionAmt) !== 0);
        
        let positionsRes = [];
        for (const p of openPositions) {
            const posAmt = parseFloat(p.positionAmt);
            const posAmtAbs = Math.abs(posAmt);
            const entryPrice = parseFloat(p.entryPrice);
            const markPrice = parseFloat(p.markPrice);
            const lev = parseInt(p.leverage);
            const margin = (posAmtAbs * entryPrice) / lev;
            const pnl = parseFloat(p.unRealizedProfit);
            const roi = margin > 0 ? (pnl / margin) * 100 : 0;
            const isLong = p.positionSide === 'LONG' || (p.positionSide === 'BOTH' && posAmt > 0);
            const sideStr = isLong ? 'LONG' : 'SHORT';
            
            let deepest = markPrice;
            let estTp = 0;
            let openTime = Date.now();
            let posType = 'MAIN';
            let slPnlRoi = 0;
            let slPnlAmount = 0;
            
            const isMatchMain = currentMainPosition && 
                               currentMainPosition.symbol === p.symbol && 
                               (currentMainPosition.side === p.positionSide || p.positionSide === 'BOTH');

            const isMatchBuffer = currentBufferPosition && 
                                 currentBufferPosition.symbol === p.symbol && 
                                 (currentBufferPosition.side === p.positionSide || p.positionSide === 'BOTH');

            if (isMatchMain) {
                deepest = currentMainPosition.extremePrice || markPrice;
                openTime = currentMainPosition.openTime || Date.now();
                posType = currentMainPosition.isTest ? 'TEST MAIN' : 'MAIN';

                const maxGainPct = isLong ? 
                    ((deepest - entryPrice) / entryPrice) * 100 : 
                    ((entryPrice - deepest) / entryPrice) * 100;

                if (maxGainPct >= userConfig.tpPercent) {
                    estTp = isLong ? 
                        Math.max(entryPrice, deepest - (entryPrice * (userConfig.tpPercent / 100))) : 
                        Math.min(entryPrice, deepest + (entryPrice * (userConfig.tpPercent / 100)));
                } else {
                    estTp = isLong ? 
                        entryPrice - (entryPrice * (userConfig.slPercent / 100)) : 
                        entryPrice + (entryPrice * (userConfig.slPercent / 100));
                }

                slPnlRoi = isLong ? ((estTp - entryPrice) / entryPrice) * 100 * lev : ((entryPrice - estTp) / entryPrice) * 100 * lev;
                slPnlAmount = margin * (slPnlRoi / 100);

            } else if (isMatchBuffer) {
                deepest = markPrice; 
                openTime = currentBufferPosition.openTime || Date.now();
                posType = currentBufferPosition.isTest ? 'TEST BUFFER' : 'BUFFER';
                estTp = currentBufferPosition.slPrice || (isLong ? (entryPrice - (entryPrice * (userConfig.slPercent / 100))) : (entryPrice + (entryPrice * (userConfig.slPercent / 100))));
                slPnlRoi = isLong ? ((estTp - entryPrice) / entryPrice) * 100 * lev : ((entryPrice - estTp) / entryPrice) * 100 * lev;
                slPnlAmount = margin * (slPnlRoi / 100);
            } else {
                openTime = Date.now();
                posType = 'MANUAL';
                estTp = isLong ? entryPrice * (1 - userConfig.slPercent / 100) : entryPrice * (1 + userConfig.slPercent / 100);
                slPnlRoi = -userConfig.slPercent * lev;
                slPnlAmount = margin * (slPnlRoi / 100);
            }
            
            positionsRes.push({
                coin: p.symbol,
                side: sideStr,
                size: formatNumber(posAmtAbs),
                leverage: lev,
                margin: margin,
                pnl: pnl,
                roi: roi,
                entryPrice: entryPrice,
                markPrice: markPrice,
                slPrice: estTp,
                slPnl: slPnlRoi,
                slPnlAmount: slPnlAmount,
                type: posType,
                openTime: openTime
            });
        }
        
        cachedDashboardData = {
            running: true, 
            balance, 
            totalWalletBalance, 
            openOrders: openOrdersInfo.length, 
            totalSessions: globalStats.totalSessions, 
            totalPnl: globalStats.totalPnl, 
            positions: positionsRes
        };
        lastDashboardFetchTime = now;
        return cachedDashboardData;
    } catch (e) { 
        return cachedDashboardData || { running: true, error: getErrorMessage(e) }; 
    }
}

async function startBotLogicInternal(query) {
    if (botRunning) return 'Bot đã đang chạy.';
    let isUpdated = false;
    
    if (query.apiKey && query.apiKey.trim() !== '') { userConfig.apiKey = query.apiKey.trim(); isUpdated = true; }
    if (query.secretKey && query.secretKey.trim() !== '') { userConfig.secretKey = query.secretKey.trim(); isUpdated = true; }
    if (query.amountMode) { userConfig.amountMode = query.amountMode; isUpdated = true; }
    if (query.amountValue !== undefined) { userConfig.amountValue = parseFloat(query.amountValue); isUpdated = true; }
    if (query.tp !== undefined) { userConfig.tpPercent = parseFloat(query.tp); isUpdated = true; } 
    if (query.sl !== undefined) { userConfig.slPercent = parseFloat(query.sl); isUpdated = true; }
    if (query.longMs !== undefined && query.longMs !== '') { userConfig.longOffsetMs = parseInt(query.longMs); isUpdated = true; }
    if (query.shortMs !== undefined && query.shortMs !== '') { userConfig.shortOffsetMs = parseInt(query.shortMs); isUpdated = true; }
    if (query.threshold !== undefined && query.threshold !== '') { userConfig.fundingThreshold = parseFloat(query.threshold); isUpdated = true; }
    if (query.tradeMode) { userConfig.tradeMode = query.tradeMode; isUpdated = true; }
    if (query.sortMode) { userConfig.sortMode = query.sortMode; isUpdated = true; }

    if (isUpdated) { saveConfigToFile(); }
    try {
        await syncServerTime();
        await updateAllLeverageCache();
        await getExchangeInfo();
        botRunning = true; 
        botStartTime = new Date();
        saveStateToFile();
        startAntiLiquidationMonitor();
        armT2MinuteScheduler();
        return 'Bot Khởi Động Thành Công.';
    } catch (e) { return 'Lỗi Khởi Động: ' + getErrorMessage(e); }
}

function stopBotLogicInternal() {
    botRunning = false;
    clearTimeout(schedulerTimeout);
    clearTimeout(scheduledBufferTimeout);
    clearTimeout(scheduledMainTimeout);
    if(mainCheckInterval) clearInterval(mainCheckInterval);
    if(bufferCheckInterval) clearInterval(bufferCheckInterval);
    if(antiLiquidationInterval) clearInterval(antiLiquidationInterval);
    saveStateToFile();
    return 'Bot Đã Dừng.';
}

loadConfigFromFile();
loadStateFromFile();

const app = express();
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/start', async (req, res) => { res.send(await startBotLogicInternal(req.query)); });
app.get('/api/stop', (req, res) => res.send(stopBotLogicInternal()));

app.get('/api/save_config', (req, res) => {
    try {
        const query = req.query;
        if (query.apiKey !== undefined && query.apiKey.trim() !== '') userConfig.apiKey = query.apiKey.trim();
        if (query.secretKey !== undefined && query.secretKey.trim() !== '') userConfig.secretKey = query.secretKey.trim();
        if (query.amountMode) userConfig.amountMode = query.amountMode;
        if (query.amountValue !== undefined && !isNaN(parseFloat(query.amountValue))) userConfig.amountValue = parseFloat(query.amountValue);
        if (query.tp !== undefined && !isNaN(parseFloat(query.tp))) userConfig.tpPercent = parseFloat(query.tp);
        if (query.sl !== undefined && !isNaN(parseFloat(query.sl))) userConfig.slPercent = parseFloat(query.sl);
        if (query.longMs !== undefined && query.longMs !== '') userConfig.longOffsetMs = parseInt(query.longMs);
        if (query.shortMs !== undefined && query.shortMs !== '') userConfig.shortOffsetMs = parseInt(query.shortMs);
        if (query.threshold !== undefined && query.threshold !== '') userConfig.fundingThreshold = parseFloat(query.threshold);
        if (query.tradeMode) userConfig.tradeMode = query.tradeMode;
        if (query.sortMode) userConfig.sortMode = query.sortMode;

        saveConfigToFile();
        log('SUCCESS', 'SYSTEM', '✓ Cập nhật & lưu cấu hình thành công.');
        res.send('✅ Đã lưu cấu hình thành công!');
    } catch (e) {
        res.status(500).send('Lỗi lưu cấu hình: ' + getErrorMessage(e));
    }
});

app.get('/api/logs', (req, res) => res.json(memoryLogs));

app.get('/api/status', (req, res) => {
    res.send(botRunning ? `RUNNING (Uptime: ${botStartTime ? ((Date.now() - botStartTime)/60000).toFixed(1) : 0}m)` : 'STOPPED');
});

app.get('/api/config', (req, res) => res.json(userConfig));

app.get('/api/funding_rates', async (req, res) => {
    try {
        const rates = await fetchFundingDataFromBinance(false);
        res.json(rates);
    } catch (e) { res.status(500).json({ error: getErrorMessage(e) }); }
});

app.get('/api/force_close', async (req, res) => {
    try {
        const { symbol, side } = req.query;
        if (!symbol) return res.status(400).send('Thiếu mã symbol.');
        
        log('TRADE', 'POSITION', `🛑 Đóng vị thế thị trường khẩn cấp cho ${symbol} (${side || 'ALL'})...`);
        
        if (currentMainPosition && currentMainPosition.symbol === symbol) {
            await closeMainInternal('Đóng khẩn cấp từ HTML', currentMainPosition.isTest);
        } else if (currentBufferPosition && currentBufferPosition.symbol === symbol) {
            await closeBufferInternal('Đóng khẩn cấp từ HTML', currentBufferPosition.isTest);
        } else {
            await aggressiveCleanup(symbol);
        }
        
        res.send(`✅ Đã đóng vị thế ${symbol}`);
    } catch (e) {
        log('ERROR', 'POSITION', `✖ Lỗi đóng vị thế khẩn cấp ${req.query.symbol}: ${getErrorMessage(e)}`);
        res.status(500).send('Lỗi: ' + getErrorMessage(e));
    }
});

app.get('/api/dashboard', async (req, res) => {
    const data = await getDashboardDataCached();
    res.json(data);
});

app.get('/api/test_fast', async (req, res) => {
    if(currentMainPosition) return res.send('⚠️ Lỗi: Đang có lệnh mở, không thể Test.');
    try {
        const allFunding = await fetchFundingDataFromBinance(true);
        let candidates = getFilteredCandidates(allFunding, null);
        
        const best = candidates[0];
        if(!best) return res.send(`⚠️ Không tìm thấy Coin nào để Test.`);

        log('INFO', 'SYSTEM', `🧪 [TEST NHANH] Khởi chạy Test Mở Main cho ${best.symbol}...`);

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        let leverage = best.lev;
        
        await setLeverage(best.symbol, leverage);
        await aggressiveCleanup(best.symbol);

        const symbolInfo = exchangeInfoCache[best.symbol];
        const currentPrice = await getCurrentPrice(best.symbol);
        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
        
        let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);

        botRunning = true; 
        
        const isNegative = best.fdType === 'negative';
        const mainSide = isNegative ? 'SHORT' : 'LONG';

        openMainPosition(best.symbol, quantity, best.nextFundingTime, mainSide, true, best.estPnl).catch(e => {});

        res.send(`✅ Test Nhanh thành công: Đã mở vị thế MAIN ${mainSide} cho ${best.symbol}`);
    } catch (e) {
        res.send('❌ Lỗi Test Nhanh: ' + getErrorMessage(e));
    }
});

app.listen(WEB_SERVER_PORT, () => {
    console.log(`Server Binance Funding Bot đang lắng nghe tại cổng ${WEB_SERVER_PORT}`);
    restoreActivePositionsOnStartup();
    setInterval(() => updateAllLeverageCache(true), 8 * 3600 * 1000); 
});
