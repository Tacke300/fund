import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Lấy __filename và __dirname trong ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH API KEY VÀ SECRET KEY ---
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim(); 
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); 

// --- BASE URL CỦA BINANCE FUTURES API ---
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; 
let exchangeInfoCache = null;
let isClosingPosition = false;
let botRunning = false;
let botStartTime = null; 

let currentOpenPosition = null; 
let currentLongPosition = null; 

let positionCheckInterval = null; 
let nextScheduledTimeout = null; 
let scheduledLongTimeout = null; 
let retryBotTimeout = null; 
let periodicLogInterval = null;
let lastLoggedMinute = -1; 

let currentCountdownMessage = "Không có lệnh đang chờ đóng.";
let countdownIntervalFrontend = null; 

// === BIẾN QUẢN LÝ LỖI ===
let consecutiveApiErrors = 0; 
const MAX_CONSECUTIVE_API_ERRORS = 5; 
const ERROR_RETRY_DELAY_MS = 60000; 

// Cache log RAM
const memoryLogs = [];
const MAX_LOG_SIZE = 1000; 
const logCounts = {}; 
const LOG_COOLDOWN_MS = 5000; 

class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}

// --- CẤU HÌNH BOT ---
const MIN_USDT_BALANCE_TO_OPEN = 0.1; 

// 0.5 = 50% vốn
const PERCENT_ACCOUNT_PER_TRADE = 0.5; 

// -0.1% = -0.001 trên API
const MIN_FUNDING_RATE_THRESHOLD = -0.001; 

const FUNDING_WINDOW_MINUTES = 3; 

const MAX_POSITION_LIFETIME_SECONDS = 60; 
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 60; 

const OPEN_TRADE_BEFORE_FUNDING_SECONDS = 1; 
const OPEN_TRADE_AFTER_SECOND_OFFSET_MS = 740; 
const OPEN_LONG_BEFORE_FUNDING_SECONDS = 10; 

const DELAY_BEFORE_CANCEL_ORDERS_MS = 3.5 * 60 * 1000; 
const RETRY_CHECK_POSITION_ATTEMPTS = 6; 
const RETRY_CHECK_POSITION_DELAY_MS = 30000; 

const WEB_SERVER_PORT = 9999; 

// --- HÀM TIỆN ÍCH ---

function addLog(message, isImportant = false) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    let consoleEntry = logEntry;
    if (message.startsWith('✅')) consoleEntry = `\x1b[32m${consoleEntry}\x1b[0m`;
    else if (message.startsWith('❌')) consoleEntry = `\x1b[31m${consoleEntry}\x1b[0m`;
    else if (message.startsWith('⚠️')) consoleEntry = `\x1b[33m${consoleEntry}\x1b[0m`;
    else if (message.startsWith('🔮')) consoleEntry = `\x1b[35m${consoleEntry}\x1b[0m`; 
    else if (isImportant) consoleEntry = `\x1b[36m${consoleEntry}\x1b[0m`;

    const messageHash = crypto.createHash('md5').update(message).digest('hex');
    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        if (!isImportant && (now.getTime() - logCounts[messageHash].lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return; 
        } else {
            if (logCounts[messageHash].count > 1) {
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        console.log(consoleEntry);
    }

    memoryLogs.push(logEntry);
    if (memoryLogs.length > MAX_LOG_SIZE) memoryLogs.shift(); 
}

function formatTimeUTC7(dateObject) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        fractionalSecondDigits: 3, hour12: false, timeZone: 'Asia/Ho_Chi_Minh'
    });
    return formatter.format(dateObject);
}

function formatHourMinuteUTC7(ms) {
    const date = new Date(ms);
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
}

const delay = ms => new Promise(resolve => setTimeout(() => resolve(), ms));

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
    const timestamp = Date.now() + serverTimeOffset;
    let queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath, requestBody = '', headers = { 'X-MBX-APIKEY': API_KEY };

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
        addLog(`❌ Lỗi API: ${error.code} - ${error.msg || error.message}`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new CriticalApiError("Lỗi API nghiêm trọng.");
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
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Lỗi API Public nghiêm trọng.");
        throw error;
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = data.serverTime - Date.now();
        addLog(`✅ Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`, true);
    } catch (error) {
        addLog(`❌ Lỗi đồng bộ thời gian: ${error.message}.`, true);
        throw error;
    }
}

async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol });
        return response[0]?.brackets[0]?.initialLeverage || null;
    } catch (error) { return null; }
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
            exchangeInfoCache[s.symbol] = {
                minQty: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE')?.minQty || 0),
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize || 0.001),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 0),
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

async function cancelOpenOrdersForSymbol(symbol) {
    try {
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        return true;
    } catch (error) { return false; }
}

async function logBestCandidate() {
    if (!botRunning) return;
    try {
        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        
        let candidates = [];
        for (const item of allFunding) {
            const fr = parseFloat(item.lastFundingRate);
            if (fr <= MIN_FUNDING_RATE_THRESHOLD && item.symbol.endsWith('USDT')) {
                candidates.push({ symbol: item.symbol, fr, time: item.nextFundingTime });
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => a.fr - b.fr);
            const topCoin = candidates[0];
            let leverage = await getLeverageBracketForSymbol(topCoin.symbol);
            if (!leverage) leverage = 20; 
            const initialMargin = balance * PERCENT_ACCOUNT_PER_TRADE;
            const notionalValue = initialMargin * leverage; 
            const displayFr = (topCoin.fr * 100).toFixed(4);

            addLog(`🔮 [DỰ BÁO] Ứng cử viên số 1 hiện tại:`, true);
            addLog(`   👉 Symbol: ${topCoin.symbol} | Funding: ${displayFr}%`);
            addLog(`   👉 Giờ Funding: ${formatHourMinuteUTC7(topCoin.time)} (UTC+7)`);
            addLog(`   👉 Vốn dự kiến: ${initialMargin.toFixed(2)}$ (x${leverage} = ${notionalValue.toFixed(2)}$)`);
        } else {
            addLog(`🔮 [DỰ BÁO] Hiện không có coin nào FR <= ${(MIN_FUNDING_RATE_THRESHOLD * 100)}%`);
        }
    } catch (error) {
        addLog(`🔮 Lỗi quét dự báo: ${error.message}`);
    }
}

// --- CẬP NHẬT CHO HEDGE MODE: THÊM positionSide ---
async function openLongPreFunding(symbol, maxLeverage, availableBalance) {
    addLog(`>>> Mở LONG lót đường cho ${symbol}...`, true);
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        
        const initialMargin = availableBalance * PERCENT_ACCOUNT_PER_TRADE;
        let quantity = (initialMargin * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        // Hedge Mode: Phải có positionSide: 'LONG'
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: quantity
        });

        addLog(`✅ Đã mở LONG lót đường ${symbol}. Qty: ${quantity}`, true);

        const slPriceRaw = currentPrice - (initialMargin / quantity);
        const slPrice = Math.floor(slPriceRaw / symbolInfo.tickSize) * symbolInfo.tickSize;

        try {
            // Hedge Mode: Đóng Long là SELL + positionSide: 'LONG'
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET',
                quantity: quantity, stopPrice: parseFloat(slPrice.toFixed(symbolInfo.pricePrecision))
            });
            addLog(`✅ Đã đặt SL 100% cho LONG ${symbol} @ ${slPrice}`, true);
        } catch (e) {
            addLog(`⚠️ Lỗi đặt SL cho Long: ${e.msg}`);
        }

        currentLongPosition = { symbol, quantity };

    } catch (error) {
        addLog(`❌ Lỗi mở LONG lót đường: ${error.msg || error.message}`, true);
    }
}

async function closeLongPreFunding() {
    if (!currentLongPosition) return;
    const { symbol, quantity } = currentLongPosition;
    addLog(`>>> Đóng lệnh LONG lót đường ${symbol}...`, true);
    try {
        // Hedge Mode: Đóng Long -> SELL + LONG
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', positionSide: 'LONG', type: 'MARKET',
            quantity: quantity
        });
        addLog(`✅ Đã đóng lệnh LONG lót đường.`, true);
    } catch (error) {
        addLog(`⚠️ Lỗi đóng Long (có thể đã đóng): ${error.msg}`);
    }
    currentLongPosition = null;
}

async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    if (isClosingPosition) return;
    isClosingPosition = true;
    addLog(`>>> Đóng lệnh SHORT ${symbol} (${reason})...`, true);
    
    try {
        if (currentLongPosition) await closeLongPreFunding();

        // Hedge Mode: Đóng Short -> BUY + SHORT
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', positionSide: 'SHORT', type: 'MARKET',
            quantity: quantityToClose
        });
        addLog(`✅ Đã đóng SHORT ${symbol}.`, true);
        cleanupAfterClose(symbol);
    } catch (error) {
        addLog(`❌ Lỗi đóng SHORT: ${error.msg}`);
        isClosingPosition = false;
    }
}

function cleanupAfterClose(symbol) {
    currentOpenPosition = null;
    stopCountdownFrontend();
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    
    setTimeout(async () => {
        await cancelOpenOrdersForSymbol(symbol);
        await checkAndHandleRemainingPosition(symbol);
        if (botRunning) scheduleNextMainCycle();
        isClosingPosition = false;
    }, DELAY_BEFORE_CANCEL_ORDERS_MS);
}

async function checkAndHandleRemainingPosition(symbol, attempt = 1) {
    if (attempt > RETRY_CHECK_POSITION_ATTEMPTS) return;
    await delay(RETRY_CHECK_POSITION_DELAY_MS);

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        // Hedge Mode check: positionSide = SHORT và positionAmt < 0
        const remPos = positions.find(p => p.symbol === symbol && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);
        
        if (remPos && Math.abs(parseFloat(remPos.positionAmt)) > 0) {
            addLog(`❌ Vị thế SHORT ${symbol} còn sót. Đóng lần ${attempt}...`, true);
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'BUY', positionSide: 'SHORT', type: 'MARKET',
                quantity: Math.abs(parseFloat(remPos.positionAmt))
            });
            checkAndHandleRemainingPosition(symbol, attempt + 1);
        }
    } catch (e) { 
        checkAndHandleRemainingPosition(symbol, attempt + 1);
    }
}

function startCountdownFrontend() {
    if (countdownIntervalFrontend) clearInterval(countdownIntervalFrontend);
    countdownIntervalFrontend = setInterval(() => {
        if (currentOpenPosition) {
            const timeLeft = MAX_POSITION_LIFETIME_SECONDS - Math.floor((new Date() - currentOpenPosition.openTime) / 1000);
            currentCountdownMessage = timeLeft >= 0 ? `Short ${currentOpenPosition.symbol}: còn ${timeLeft}s` : "Đang đóng...";
        } else stopCountdownFrontend();
    }, 1000);
}

function stopCountdownFrontend() {
    if (countdownIntervalFrontend) clearInterval(countdownIntervalFrontend);
    countdownIntervalFrontend = null;
    currentCountdownMessage = "Không có lệnh.";
}

async function openShortPosition(symbol, fundingRate, usdtBalance, maxLeverage) {
    addLog(`>>> Mở SHORT ${symbol} (FR: ${(fundingRate * 100).toFixed(4)}%)...`, true);
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        const initialMargin = usdtBalance * PERCENT_ACCOUNT_PER_TRADE;
        
        let quantity = (initialMargin * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        // Hedge Mode: Mở Short -> SELL + SHORT
        const orderRes = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', positionSide: 'SHORT', type: 'MARKET',
            quantity: quantity, newOrderRespType: 'FULL'
        });
        
        await closeLongPreFunding();

        const entryPrice = parseFloat(orderRes.avgFillPrice || currentPrice);
        addLog(`✅ Đã mở SHORT ${symbol} @ ${entryPrice}`, true);

        let targetRoe = 0.30; 
        if (fundingRate <= -0.005) targetRoe = 0.50;
        const stopLossRoe = 1.0; 

        const tpMovePercent = targetRoe / maxLeverage;
        const slMovePercent = stopLossRoe / maxLeverage;

        const tpPrice = parseFloat((entryPrice * (1 - tpMovePercent)).toFixed(symbolInfo.pricePrecision));
        const slPrice = parseFloat((entryPrice * (1 + slMovePercent)).toFixed(symbolInfo.pricePrecision));

        addLog(`>>> Cài đặt: TP ${targetRoe * 100}% | SL ${stopLossRoe * 100}% (ROE)`, true);
        addLog(`>>> TP @ ${tpPrice} | SL @ ${slPrice}`, true);

        try {
            // Hedge Mode: TP Short -> BUY + SHORT
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'BUY', positionSide: 'SHORT', type: 'STOP_MARKET',
                quantity: quantity, stopPrice: slPrice, closePosition: 'true'
            });
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'BUY', positionSide: 'SHORT', type: 'TAKE_PROFIT_MARKET',
                quantity: quantity, stopPrice: tpPrice, closePosition: 'true'
            });
        } catch (e) { addLog(`⚠️ Lỗi đặt TP/SL Short: ${e.msg}`); }

        currentOpenPosition = { symbol, quantity, openTime: new Date(), initialSLPrice: slPrice, initialTPPrice: tpPrice };
        
        positionCheckInterval = setInterval(manageOpenPosition, 300);
        startCountdownFrontend();

    } catch (error) {
        addLog(`❌ Lỗi mở SHORT: ${error.msg}`, true);
        await closeLongPreFunding(); 
        scheduleNextMainCycle();
    }
}

async function manageOpenPosition() {
    if (!currentOpenPosition || isClosingPosition) return;
    const { symbol, quantity, openTime } = currentOpenPosition;

    if ((new Date() - openTime) / 1000 >= MAX_POSITION_LIFETIME_SECONDS) {
        await closeShortPosition(symbol, quantity, 'Time Limit');
        return;
    }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const pos = positions.find(p => p.symbol === symbol && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);
        if (!pos || parseFloat(pos.positionAmt) === 0) {
            addLog(`✅ Vị thế ${symbol} đã đóng (TP/SL khớp).`, true);
            cleanupAfterClose(symbol);
        }
    } catch (error) { }
}

async function runTradingLogic() {
    if (!botRunning || currentOpenPosition) return;
    addLog('>>> Quét cơ hội (phút :59)...', true);

    try {
        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        if (balance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog('⚠️ Không đủ tiền.', true);
            scheduleNextMainCycle(); return;
        }

        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        const now = Date.now();
        let candidates = [];

        for (const item of allFunding) {
            const fr = parseFloat(item.lastFundingRate);
            if (fr <= MIN_FUNDING_RATE_THRESHOLD && item.symbol.endsWith('USDT')) {
                const timeLeftMin = (item.nextFundingTime - now) / 60000;
                if (timeLeftMin > 0 && timeLeftMin <= FUNDING_WIND
