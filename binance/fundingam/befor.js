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
    fundingThreshold: 0.3 
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

let consecutiveApiErrors = 0; 
const MAX_CONSECUTIVE_API_ERRORS = 5; 
const memoryLogs = [];
const MAX_LOG_SIZE = 1000; 
const logCounts = {}; 
const LOG_COOLDOWN_MS = 60000; 

const WEB_SERVER_PORT = 9999; 

let globalStats = {
    totalSessions: 0,
    totalPnl: 0
};

// --- CACHE BẢO VỆ RATE LIMIT --- //
let cachedFundingRates = [];
let lastFundingFetchTime = 0;
const FUNDING_CACHE_TTL = 30000; // 30s

let cachedDashboardData = null;
let lastDashboardFetchTime = 0;
const DASHBOARD_CACHE_TTL = 2000; // 2s

function formatTime(date = new Date()) {
    const utc7 = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    const day = String(utc7.getUTCDate()).padStart(2, '0');
    const month = String(utc7.getUTCMonth() + 1).padStart(2, '0');
    const hours = String(utc7.getUTCHours()).padStart(2, '0');
    const minutes = String(utc7.getUTCMinutes()).padStart(2, '0');
    const seconds = String(utc7.getUTCSeconds()).padStart(2, '0');
    const ms = String(utc7.getUTCMilliseconds()).padStart(3, '0');
    return `${day}/${month} ${hours}:${minutes}:${seconds}.${ms}`;
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
            globalStats,
            botRunning
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
            if (data.globalStats) globalStats = data.globalStats;
            if (data.botRunning !== undefined) botRunning = data.botRunning;
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
            throw new CriticalApiError("Lỗi API liên tiếp vượt ngưỡng cho phép.");
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
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Lỗi API Public liên tiếp.");
        throw error;
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = data.serverTime - Date.now();
        log('INFO', 'SYNC', `✓ Đồng bộ thời gian máy chủ Binance thành công (Độ lệch: ${serverTimeOffset}ms)`);
    } catch (error) {
        log('ERROR', 'SYNC', `✖ Lỗi đồng bộ thời gian Binance: ${getErrorMessage(error)}`);
        throw error; 
    }
}

async function updateAllLeverageCache() {
    try {
        if (!userConfig.apiKey || !userConfig.secretKey) return;
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET');
        if (Array.isArray(response)) {
            response.forEach(item => {
                const brackets = item.brackets || [];
                brackets.sort((a, b) => b.initialLeverage - a.initialLeverage);
                leverageCache[item.symbol] = brackets.length > 0 ? brackets[0].initialLeverage : 20;
            });
        }
    } catch (error) { 
        log('WARN', 'API', `⚠ Lỗi cập nhật Cache Đòn bẩy: ${getErrorMessage(error)}`);
    }
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
    } catch (error) { return null; }
}

async function aggressiveCleanup(symbol) {
    log('INFO', 'CLEANUP', `🧹 ${symbol} → Bắt đầu dọn dẹp sẵn môi trường`);
    try {
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        log('INFO', 'CLEANUP', `🧹 Hủy toàn bộ lệnh chờ cho ${symbol}`);
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        for (const pos of positions) {
            const amt = parseFloat(pos.positionAmt);
            if (Math.abs(amt) > 0) {
                const side = amt > 0 ? 'SELL' : 'BUY';
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol, side: side, positionSide: pos.positionSide, type: 'MARKET', quantity: Math.abs(amt)
                });
                log('INFO', 'CLEANUP', `🧹 Đóng vị thế thừa ${symbol} (${pos.positionSide})`);
            }
        }
        log('SUCCESS', 'CLEANUP', `✓ Môi trường ${symbol} đã chuẩn bị sẵn sàng`);
    } catch (e) {
        log('WARN', 'CLEANUP', `⚠ Lỗi quá trình dọn dẹp ${symbol}: ${getErrorMessage(e)}`);
    }
}

function fetchAndLogRealizedPnL(symbol, positionSide, isTest = false) {
    const closeTime = Date.now();
    setTimeout(async () => {
        try {
            const trades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol, limit: 15 });
            const closeTrades = trades.filter(t => 
                t.time >= closeTime - 15000 && 
                t.realizedPnl !== "0" && 
                t.positionSide === positionSide
            );
            const totalPnl = closeTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            
            if (!isTest) {
                globalStats.totalPnl += totalPnl;
                saveStateToFile();
            }
            
            log('PNL', 'PNL', `💰 Kết quả giao dịch | Coin: ${symbol} | Position: ${positionSide} | PnL thực tế: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT ${isTest ? '(TEST)' : ''}`);
        } catch (e) { }
    }, 8000); 
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

// --- TÍNH TOÁN VÀ LỌC DANH SÁCH FUNDING --- //
async function fetchFundingDataFromBinance(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedFundingRates.length > 0 && (now - lastFundingFetchTime < FUNDING_CACHE_TTL)) {
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
    return cachedFundingRates;
}

function getFilteredCandidates(allFunding, reqThreshold = null) {
    let valid = [...allFunding];
    if (reqThreshold !== null) {
        valid = valid.filter(item => (Math.abs(parseFloat(item.lastFundingRate)) * 100) >= reqThreshold);
    }
    return valid;
}

// --- QUẢN LÝ T-2 PHÚT SINGLE SCAN SCHEDULER --- //
async function armT2MinuteScheduler() {
    if (!botRunning || currentMainPosition) return;
    
    clearTimeout(schedulerTimeout);
    
    try {
        const allFunding = await fetchFundingDataFromBinance(true);
        if (!allFunding || allFunding.length === 0) {
            log('WARN', 'SCHEDULER', '⚠️ Không có dữ liệu Funding. Thử lại sau 30 giây...');
            schedulerTimeout = setTimeout(armT2MinuteScheduler, 30000);
            return;
        }

        const nextFdTime = allFunding[0].nextFundingTime;
        const nowServer = Date.now() + serverTimeOffset;
        
        // Mốc T-2 phút = 120 giây trước giờ Funding
        const t2TargetTime = nextFdTime - 120000;
        const msToWait = t2TargetTime - nowServer;

        if (msToWait > 0) {
            const waitSec = Math.round(msToWait / 1000);
            const targetClockStr = new Date(t2TargetTime + 7*3600000).toISOString().substr(11, 8);
            log('INFO', 'SCHEDULER', `⏳ Lên lịch thành công: Bot nghỉ chờ ${waitSec}s (đến mốc T-2 phút lúc ${targetClockStr} UTC+7) để QUÉT 1 LẦN DUY NHẤT.`);
            
            schedulerTimeout = setTimeout(() => {
                executeT2MinuteSingleScan(nextFdTime);
            }, msToWait);
        } else {
            // Đã nằm trong khung T-2 phút -> Quét 1 phát ngay lập tức!
            executeT2MinuteSingleScan(nextFdTime);
        }
    } catch (e) {
        log('ERROR', 'SCHEDULER', `✖ Lỗi lên lịch T-2m: ${getErrorMessage(e)}`);
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 15000);
    }
}

async function executeT2MinuteSingleScan(targetFundingTime) {
    if (!botRunning || currentMainPosition) return;
    
    log('INFO', 'SCAN', `🔍 [QUÉT DUY NHẤT T-2 PHÚT] Tiến hành quét Funding Rate toàn bộ các cặp...`);
    
    try {
        const allFunding = await fetchFundingDataFromBinance(true);
        const candidates = getFilteredCandidates(allFunding, userConfig.fundingThreshold);

        log('INFO', 'SCAN', `📊 Kết quả quét T-2 phút: ${allFunding.length} cặp khả thi | Đủ threshold (>=${userConfig.fundingThreshold}%): ${candidates.length} cặp`);

        if (candidates.length === 0) {
            log('WARN', 'SCAN', `⚠️ Không có coin nào đủ điều kiện threshold. Hủy phiên Funding này, lên lịch cho đợt tiếp theo.`);
            const timeToNextFd = targetFundingTime - (Date.now() + serverTimeOffset);
            schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(timeToNextFd + 10000, 30000));
            return;
        }

        const best = candidates[0];
        const leverage = best.lev;
        const nowServer = Date.now() + serverTimeOffset;

        log('SUCCESS', 'SCAN', `🎯 TOP 1 CHỌN ĐƯỢC: ${best.symbol} | FD Rate: ${(parseFloat(best.lastFundingRate) * 100).toFixed(4)}% | Lev: ${leverage}x | Est PnL: ${best.estPnl.toFixed(2)}%`);

        // DỌN DẸP SẴN MÔI TRƯỜNG NGAY TẠI MỐC T-2 PHÚT
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

        clearTimeout(scheduledBufferTimeout);
        if (delayLong > 0) {
            scheduledBufferTimeout = setTimeout(() => {
                if (botRunning) openBufferPosition(best.symbol, leverage, balance, bufferSide, false).catch(e => {});
            }, delayLong);
            log('INFO', 'TIMER', `⏱ Đặt lịch mở BUFFER ${bufferSide} ${best.symbol} trước Funding ${(longOffsetMs/1000).toFixed(2)}s`);
        }

        clearTimeout(scheduledMainTimeout);
        if (delayShort >= 0) {
            scheduledMainTimeout = setTimeout(() => {
                if (botRunning && !currentMainPosition) {
                    openMainPosition(best.symbol, quantity, targetFundingTime, mainSide, false, best.estPnl).catch(e => {});
                }
            }, delayShort);
            log('INFO', 'TIMER', `⏱ Đặt lịch mở MAIN ${mainSide} ${best.symbol} trước Funding ${(shortOffsetMs/1000).toFixed(2)}s`);
        }

        // Đặt lịch khởi tạo lại Scheduler cho chu kỳ tiếp theo sau khi Funding diễn ra
        const msAfterFunding = targetFundingTime + 30000 - Date.now();
        schedulerTimeout = setTimeout(armT2MinuteScheduler, Math.max(msAfterFunding, 60000));

    } catch (e) {
        log('ERROR', 'SCAN', `✖ Lỗi trong khi thực hiện quét T-2m: ${getErrorMessage(e)}`);
        schedulerTimeout = setTimeout(armT2MinuteScheduler, 15000);
    }
}

// --- QUẢN LÝ LỆNH BUFFER --- //
async function openBufferPosition(symbol, leverage, balance, side, isTest = false) {
    log('INFO', 'BUFFER', `▶ Chuẩn bị mở Buffer ${side} cho ${symbol}...`);
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        
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
        bufferCheckInterval = setInterval(manageBufferPosition, 800);

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
            log('WARN', 'SL', `⚠ Kích hoạt Stop Loss Buffer | Coin: ${currentBufferPosition.symbol} | Entry: ${formatPrice(currentBufferPosition.entryPrice)} | Giá hiện tại: ${formatPrice(currentPrice)}`);
            await closeBufferInternal('Chạm Stop Loss Buffer', currentBufferPosition.isTest);
            isClosingBuffer = false;
        }
    } catch (e) { isClosingBuffer = false; }
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
        const pos = positions.find(p => p.symbol === symbol && p.positionSide === side);
        const actualAmt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
        const markPrice = pos ? parseFloat(pos.markPrice) : entryPrice;

        if (actualAmt > 0) {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: orderSide, positionSide: side, type: 'MARKET', quantity: actualAmt
            });
            log('SUCCESS', 'BUFFER', `🛑 Đóng vị thế Buffer | Coin: ${symbol} | Hướng: ${side} | Giá thoát: ${formatPrice(markPrice)} | Lý do: ${reason} | Thời gian giữ: ${duration}`);
            fetchAndLogRealizedPnL(symbol, side, isTest);
        } else {
            log('INFO', 'BUFFER', `📌 Vị thế Buffer ${side} ${symbol} đã được đóng trước trên sàn.`);
        }
    } catch (error) {
        log('WARN', 'BUFFER', `⚠ Lỗi khi đóng Buffer ${symbol}: ${getErrorMessage(error)}. Thực hiện dọn dẹp môi trường...`);
        await aggressiveCleanup(symbol);
    }
}

// --- QUẢN LÝ LỆNH MAIN --- //
let isClosingMain = false;
async function openMainPosition(symbol, quantity, nextFundingTime, side, isTest = false, estPnl = 0) {
    log('INFO', 'MAIN', `▶ Kích hoạt vào lệnh MAIN ${side} cho ${symbol}...`);
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
        
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && p.positionSide === side);
        
        if (!pos || parseFloat(pos.positionAmt) === 0) {
            log('WARN', 'MAIN', `⚠ Không thể khởi tạo vị thế MAIN cho ${symbol}.`);
            armT2MinuteScheduler();
            return;
        }

        const realEntryPrice = parseFloat(pos.entryPrice);
        const lev = parseInt(pos.leverage);
        const margin = (Math.abs(parseFloat(pos.positionAmt)) * realEntryPrice) / lev;
        
        log('TRADE', 'MAIN', `🚀 Mở vị thế Main | Coin: ${symbol} | Hướng: ${side} | Qty: ${formatNumber(Math.abs(parseFloat(pos.positionAmt)))} | Đòn bẩy: ${lev}x | Margin: ${margin.toFixed(2)} USDT | Entry: ${formatPrice(realEntryPrice)}`);

        currentMainPosition = { 
            symbol, side, quantity: Math.abs(parseFloat(pos.positionAmt)), openTime: Date.now(), entryPrice: realEntryPrice, extremePrice: realEntryPrice, nextFundingTime, isTest 
        };
        saveStateToFile();

        if (mainCheckInterval) clearInterval(mainCheckInterval);
        mainCheckInterval = setInterval(manageMainPosition, 1000);

    } catch (error) {
        log('ERROR', 'MAIN', `✖ Lỗi mở lệnh MAIN ${side} ${symbol}: ${getErrorMessage(error)}`);
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
            log('INFO', 'MAIN', `⏳ [TEST] Còn <= 1500ms tới giờ Funding. Tự động đóng lệnh TEST!`);
            await closeMainInternal('Test Auto Close', true);
            isClosingMain = false;
            return;
        }
    }
    
    try {
        const currentPrice = await getCurrentPrice(symbol);
        if(!currentPrice) return;

        if (isLong) {
            if (!currentMainPosition.extremePrice || currentPrice > currentMainPosition.extremePrice) {
                currentMainPosition.extremePrice = currentPrice;
                saveStateToFile();
            }
        } else {
            if (!currentMainPosition.extremePrice || currentPrice < currentMainPosition.extremePrice) {
                currentMainPosition.extremePrice = currentPrice;
                saveStateToFile();
            }
        }

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
            activeSL = isLong ? 
                extremePrice - (entryPrice * (tpPct / 100)) : 
                extremePrice + (entryPrice * (tpPct / 100));
            isSlPositive = true;
        }

        currentMainPosition.dynamicSL = activeSL; 
        currentMainPosition.isSlPositive = isSlPositive;

        let triggerClose = false;
        if (isLong && currentPrice <= activeSL) triggerClose = true;
        if (!isLong && currentPrice >= activeSL) triggerClose = true;

        if (triggerClose) {
            isClosingMain = true;
            const slName = isSlPositive ? `Kích hoạt Chốt Lãi / SL Dương` : `Chạm Stop Loss`;
            if (isSlPositive) {
                log('SUCCESS', 'TP', `🎯 Kích hoạt Chốt Lãi / SL Dương | Coin: ${symbol} | Entry: ${formatPrice(entryPrice)} | Giá chốt: ${formatPrice(activeSL)} | Giá hiện tại: ${formatPrice(currentPrice)}`);
            } else {
                log('WARN', 'SL', `⚠ Kích hoạt Stop Loss | Coin: ${symbol} | Entry: ${formatPrice(entryPrice)} | Giá SL: ${formatPrice(activeSL)} | Giá hiện tại: ${formatPrice(currentPrice)}`);
            }
            await closeMainInternal(slName, isTest);
            isClosingMain = false;
            return;
        }
    } catch (error) { }
}

async function closeMainInternal(reason = 'Thủ công', isTest = false) {
    if (!currentMainPosition) return;
    const { symbol, side, openTime, entryPrice } = currentMainPosition;
    const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
    const duration = formatDuration(openTime);

    if (mainCheckInterval) { clearInterval(mainCheckInterval); mainCheckInterval = null; }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && p.positionSide === side);
        const actualAmt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
        const markPrice = pos ? parseFloat(pos.markPrice) : entryPrice;

        if (actualAmt > 0) {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: orderSide, positionSide: side, type: 'MARKET', quantity: actualAmt
            });
            log('SUCCESS', 'MAIN', `🛑 Đóng vị thế Main | Coin: ${symbol} | Hướng: ${side} | Giá vào: ${formatPrice(entryPrice)} | Giá thoát: ${formatPrice(markPrice)} | Lý do: ${reason} | Thời gian giữ: ${duration}`);
            fetchAndLogRealizedPnL(symbol, side, isTest);
        } else {
            log('INFO', 'MAIN', `📌 Vị thế MAIN ${side} ${symbol} đã được đóng trước đó.`);
        }
    } catch (error) {
        log('ERROR', 'MAIN', `✖ Lỗi khi đóng MAIN ${symbol}: ${getErrorMessage(error)}. Tiến hành dọn dẹp...`);
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

// --- TÍNH NĂNG CHỐNG THANH LÝ TOÀN BỘ (DƯỚI 10%) --- //
function startAntiLiquidationMonitor() {
    if (antiLiquidationInterval) clearInterval(antiLiquidationInterval);
    antiLiquidationInterval = setInterval(async () => {
        if (!botRunning) return;
        try {
            const acc = await callSignedAPI('/fapi/v2/account', 'GET');
            const totalWalletBalance = parseFloat(acc.totalWalletBalance);
            const availableBalance = parseFloat(acc.availableBalance);

            if (totalWalletBalance > 0 && availableBalance < (totalWalletBalance * 0.1)) {
                log('WARN', 'POSITION', `🚨 BÁO ĐỘNG: Ký quỹ khả dụng dưới 10%. KÍCH HOẠT CHỐNG THANH LÝ TOÀN BỘ SÀN!`);
                botRunning = false; 
                
                await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE'); 
                const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
                
                for (const p of positions) {
                    const amt = parseFloat(p.positionAmt);
                    if (Math.abs(amt) > 0) {
                        const side = amt > 0 ? 'SELL' : 'BUY';
                        await callSignedAPI('/fapi/v1/order', 'POST', {
                            symbol: p.symbol, side: side, positionSide: p.positionSide, type: 'MARKET', quantity: Math.abs(amt)
                        });
                    }
                }
                currentMainPosition = null;
                currentBufferPosition = null;
                saveStateToFile();
                log('SUCCESS', 'POSITION', `🛑 Đã ĐÓNG TOÀN BỘ vị thế trên tài khoản. Bot tự động TẮT để bảo toàn vốn.`);
            }
        } catch(e) {}
    }, 15000);
}

// --- KHÔI PHỤC CACHE KHI KHỞI ĐỘNG --- //
async function restoreActivePositionsOnStartup() {
    loadStateFromFile();
    if (!userConfig.apiKey || !userConfig.secretKey) return;
    try {
        await syncServerTime();
        await updateAllLeverageCache(); 
        await getExchangeInfo();
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        
        if (currentMainPosition) {
            const pos = positions.find(p => p.symbol === currentMainPosition.symbol && p.positionSide === currentMainPosition.side);
            if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) {
                log('SUCCESS', 'SYNC', `✓ [CACHE RESTORE] Tiếp tục quản lý MAIN ${currentMainPosition.side} ${currentMainPosition.symbol} (Entry: ${currentMainPosition.entryPrice})`);
                botRunning = true;
                if (mainCheckInterval) clearInterval(mainCheckInterval);
                mainCheckInterval = setInterval(manageMainPosition, 1000);
            } else {
                log('WARN', 'SYNC', `⚠ Vị thế MAIN ${currentMainPosition.symbol} đã đóng trên sàn. Xóa cache.`);
                currentMainPosition = null;
                saveStateToFile();
            }
        }

        if (currentBufferPosition) {
            const pos = positions.find(p => p.symbol === currentBufferPosition.symbol && p.positionSide === currentBufferPosition.side);
            if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) {
                log('SUCCESS', 'SYNC', `✓ [CACHE RESTORE] Tiếp tục quản lý BUFFER ${currentBufferPosition.side} ${currentBufferPosition.symbol}`);
                botRunning = true;
                if (bufferCheckInterval) clearInterval(bufferCheckInterval);
                bufferCheckInterval = setInterval(manageBufferPosition, 800);
            } else {
                log('WARN', 'SYNC', `⚠ Vị thế BUFFER ${currentBufferPosition.symbol} đã đóng trên sàn. Xóa cache.`);
                currentBufferPosition = null;
                saveStateToFile();
            }
        }
        
        if (botRunning) {
            startAntiLiquidationMonitor();
            if (!currentMainPosition) armT2MinuteScheduler();
        }
    } catch (e) {
        log('ERROR', 'SYNC', `✖ Lỗi khôi phục vị thế cache: ${getErrorMessage(e)}`);
    }
}

// --- DASHBOARD DATA PROVIDER (SỬ DỤNG CACHE 2 GIÂY CHỐNG API RATE LIMIT) --- //
async function getDashboardDataCached() {
    if (!botRunning) return { running: false };
    const now = Date.now();
    if (cachedDashboardData && (now - lastDashboardFetchTime < DASHBOARD_CACHE_TTL)) {
        return cachedDashboardData;
    }

    try {
        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        const walletBalance = parseFloat(acc.totalWalletBalance || 0);
        const totalUnrealizedProfit = parseFloat(acc.totalUnrealizedProfit || 0);
        const totalWalletBalance = walletBalance + totalUnrealizedProfit; 

        const openOrdersInfo = await callSignedAPI('/fapi/v1/openOrders', 'GET');
        
        let positionsRes = [];
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
            const roi = margin > 0 ? (pnl / margin) * 100 : 0;
            const isLong = p.positionSide === 'LONG';
            
            let deepest = markPrice;
            let estTp = 0;
            let openTime = Date.now();
            let posType = 'MAIN';
            let slPnlPct = 0;
            
            if (currentMainPosition && currentMainPosition.symbol === p.symbol && currentMainPosition.side === p.positionSide) {
                deepest = currentMainPosition.extremePrice || markPrice;
                openTime = currentMainPosition.openTime || Date.now();
                posType = currentMainPosition.isTest ? 'TEST MAIN' : 'MAIN';

                const maxGainPct = isLong ? 
                    ((deepest - entryPrice) / entryPrice) * 100 : 
                    ((entryPrice - deepest) / entryPrice) * 100;

                if (maxGainPct >= userConfig.tpPercent) {
                    estTp = isLong ? 
                        deepest - (entryPrice * (userConfig.tpPercent / 100)) : 
                        deepest + (entryPrice * (userConfig.tpPercent / 100));
                } else {
                    estTp = isLong ? 
                        entryPrice - (entryPrice * (userConfig.slPercent / 100)) : 
                        entryPrice + (entryPrice * (userConfig.slPercent / 100));
                }

                slPnlPct = isLong ? ((estTp - entryPrice) / entryPrice) * 100 * lev : ((entryPrice - estTp) / entryPrice) * 100 * lev;

            } else if (currentBufferPosition && currentBufferPosition.symbol === p.symbol && currentBufferPosition.side === p.positionSide) {
                deepest = markPrice; 
                openTime = currentBufferPosition.openTime || Date.now();
                posType = currentBufferPosition.isTest ? 'TEST BUFFER' : 'BUFFER';
                estTp = currentBufferPosition.slPrice || (isLong ? (entryPrice - (entryPrice * (userConfig.slPercent / 100))) : (entryPrice + (entryPrice * (userConfig.slPercent / 100))));
                slPnlPct = isLong ? ((estTp - entryPrice) / entryPrice) * 100 * lev : ((entryPrice - estTp) / entryPrice) * 100 * lev;
            } else {
                openTime = Date.now();
                posType = 'MANUAL';
                estTp = isLong ? entryPrice * (1 - userConfig.slPercent / 100) : entryPrice * (1 + userConfig.slPercent / 100);
                slPnlPct = -userConfig.slPercent * lev;
            }
            
            positionsRes.push({
                coin: p.symbol,
                side: p.positionSide,
                size: formatNumber(posAmtAbs),
                leverage: lev,
                margin: margin,
                pnl: pnl,
                roi: roi,
                entryPrice: entryPrice,
                markPrice: markPrice,
                slPrice: estTp,
                slPnl: slPnlPct,
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
        return { running: true, error: getErrorMessage(e) }; 
    }
}

// --- API ROUTES --- //
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

    if (isUpdated) { saveConfigToFile(); log('SUCCESS', 'SYSTEM', '✓ Cập nhật cấu hình mới thành công.'); }
    log('INFO', 'SYSTEM', '▶ BẮT ĐẦU KÍCH HOẠT BOT');
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
    log('INFO', 'SYSTEM', '🛑 ĐÃ DỪNG BOT GIAO DỊCH');
    return 'Bot Đã Dừng.';
}

loadConfigFromFile();
loadStateFromFile();

const app = express();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/start', async (req, res) => { res.send(await startBotLogicInternal(req.query)); });
app.get('/api/stop', (req, res) => res.send(stopBotLogicInternal()));

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

// --- CHỨC NĂNG TEST NHANH: MỞ THẲNG LỆNH MAIN KHÔNG QUA BUFFER --- //
app.get('/api/test_fast', async (req, res) => {
    if(currentMainPosition) return res.send('⚠️ Lỗi: Đang có lệnh mở, không thể Test.');
    try {
        const allFunding = await fetchFundingDataFromBinance(true);
        let candidates = getFilteredCandidates(allFunding, null);
        
        const best = candidates[0];
        if(!best) return res.send(`⚠️ Không tìm thấy Coin nào để Test.`);

        log('INFO', 'SYSTEM', `🧪 [TEST NHANH MỞ THẲNG MAIN] Khởi chạy Test cho ${best.symbol}...`);

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

        // MỞ THẲNG LỆNH MAIN TRỰC TIẾP
        openMainPosition(best.symbol, quantity, best.nextFundingTime, mainSide, true, best.estPnl).catch(e => {});

        res.send(`✅ Test Nhanh thành công: Đã dọn dẹp môi trường & MỞ THẲNG VỊ THẾ MAIN ${mainSide} cho ${best.symbol}`);
    } catch (e) {
        res.send('❌ Lỗi Test Nhanh: ' + getErrorMessage(e));
    }
});

app.listen(WEB_SERVER_PORT, () => {
    console.log(`Server Binance Funding Bot đang lắng nghe tại cổng ${WEB_SERVER_PORT}`);
    restoreActivePositionsOnStartup();
    setInterval(updateAllLeverageCache, 3600000); 
});
