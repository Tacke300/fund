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
// !!! QUAN TRỌNG: DÁN API Key và Secret Key THẬT của bạn vào đây. !!!
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim(); 
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); 

// --- BASE URL CỦA BINANCE FUTURES API ---
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; // Offset thời gian để đồng bộ với server Binance

// Biến cache cho exchangeInfo để tránh gọi API lặp lại
let exchangeInfoCache = null;

// Biến cờ để tránh gửi nhiều lệnh đóng cùng lúc
let isClosingPosition = false;

// Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động

// Biến theo dõi vị thế
let currentOpenPosition = null; // Vị thế SHORT chính
let currentLongPosition = null; // Vị thế LONG lót đường

// Các biến timeout/interval
let positionCheckInterval = null; 
let nextScheduledTimeout = null; 
let scheduledLongTimeout = null; // Timeout cho lệnh Long
let retryBotTimeout = null; 

// Biến và interval cho việc hiển thị đếm ngược trên giao diện web
let currentCountdownMessage = "Không có lệnh đang chờ đóng.";
let countdownIntervalFrontend = null; 

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===
let consecutiveApiErrors = 0; 
const MAX_CONSECUTIVE_API_ERRORS = 5; 
const ERROR_RETRY_DELAY_MS = 60000; 

// Cache log trong RAM để hiển thị lên Web
const memoryLogs = [];
const MAX_LOG_SIZE = 1000; 
const logCounts = {}; 
const LOG_COOLDOWN_MS = 5000; 

// Custom Error class cho lỗi API nghiêm trọng
class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH ---
const MIN_USDT_BALANCE_TO_OPEN = 0.1; 

// SỐ PHẦN TRĂM CỦA TÀI KHOẢN USDT KHẢ DỤNG SẼ DÙNG CHO MỖI LỆNH
const PERCENT_ACCOUNT_PER_TRADE = 0.5; // 1 = 100% (All-in)

// Bảng ánh xạ maxLeverage với Target ROE gốc (Sẽ được nhân 3 trong logic).
// Ví dụ: 0.15 (15%) * 3 = 45% ROE
const TAKE_PROFIT_PERCENTAGES = {
    20: 0.15,  
    25: 0.15,  
    50: 0.18,  
    75: 0.2,  
    100: 0.25, 
    125: 0.33, 
};

// --- ĐIỀU KIỆN FUNDING ---
const MIN_FUNDING_RATE_THRESHOLD = -0.3; 

// Thời gian tối đa giữ một vị thế (ví dụ: 180 giây = 3 phút)
const MAX_POSITION_LIFETIME_SECONDS = 180; 

// Cửa sổ thời gian (tính bằng phút) TRƯỚC giờ funding mà bot sẽ bắt đầu quét.
const FUNDING_WINDOW_MINUTES = 1; 

// Chỉ mở lệnh nếu thời gian còn lại đến funding <= X giây.
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 60; 

// --- CẤU HÌNH THỜI GIAN VÀO LỆNH ---
// 1. LỆNH SHORT (CHÍNH)
const OPEN_TRADE_BEFORE_FUNDING_SECONDS = 1; // Mở trước 1s
const OPEN_TRADE_AFTER_SECOND_OFFSET_MS = 740; // Cộng thêm 740ms

// 2. LỆNH LONG (LÓT ĐƯỜNG)
const OPEN_LONG_BEFORE_FUNDING_SECONDS = 10; // Mở trước 10s

// Hằng số cho thời gian chờ hủy lệnh sau khi đóng vị thế
const DELAY_BEFORE_CANCEL_ORDERS_MS = 3.5 * 60 * 1000; 

// Số lần thử lại kiểm tra vị thế sau khi đóng và thời gian delay
const RETRY_CHECK_POSITION_ATTEMPTS = 6; 
const RETRY_CHECK_POSITION_DELAY_MS = 30000; 

// --- CẤU HÌNH WEB SERVER ---
const WEB_SERVER_PORT = 9999; 
const THIS_BOT_PM2_NAME = 'befor'; 

// --- HÀM TIỆN ÍCH ---

// Hàm addLog lưu RAM
function addLog(message, isImportant = false) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    let consoleEntry = logEntry;
    if (message.startsWith('✅')) consoleEntry = `\x1b[32m${consoleEntry}\x1b[0m`;
    else if (message.startsWith('❌')) consoleEntry = `\x1b[31m${consoleEntry}\x1b[0m`;
    else if (message.startsWith('⚠️')) consoleEntry = `\x1b[33m${consoleEntry}\x1b[0m`;
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

// --- HÀM XỬ LÝ LỆNH LONG LÓT ĐƯỜNG ---
async function openLongPreFunding(symbol, maxLeverage, availableBalance) {
    addLog(`>>> Mở LONG lót đường cho ${symbol}...`, true);
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        
        const initialMargin = availableBalance * PERCENT_ACCOUNT_PER_TRADE;
        let quantity = (initialMargin * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', type: 'MARKET', quantity: quantity
        });

        addLog(`✅ Đã mở LONG lót đường ${symbol}. Qty: ${quantity}`, true);

        // SL Long vẫn giữ 100% theo yêu cầu trước
        const slPriceRaw = currentPrice - (initialMargin / quantity);
        const slPrice = Math.floor(slPriceRaw / symbolInfo.tickSize) * symbolInfo.tickSize;

        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'SELL', type: 'STOP_MARKET',
                quantity: quantity, stopPrice: parseFloat(slPrice.toFixed(symbolInfo.pricePrecision)),
                closePosition: 'true'
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
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', type: 'MARKET',
            quantity: quantity, reduceOnly: 'true'
        });
        addLog(`✅ Đã đóng lệnh LONG lót đường.`, true);
    } catch (error) {
        addLog(`⚠️ Lỗi đóng Long (có thể đã đóng): ${error.msg}`);
    }
    currentLongPosition = null;
}


// --- HÀM ĐÓNG LỆNH SHORT CHÍNH ---
async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    if (isClosingPosition) return;
    isClosingPosition = true;
    addLog(`>>> Đóng lệnh SHORT ${symbol} (${reason})...`, true);
    
    try {
        if (currentLongPosition) await closeLongPreFunding();

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', type: 'MARKET',
            quantity: quantityToClose, reduceOnly: 'true'
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
        const remPos = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) < 0);
        
        if (remPos && Math.abs(parseFloat(remPos.positionAmt)) > 0) {
            addLog(`❌ Vị thế SHORT ${symbol} còn sót. Đóng lần ${attempt}...`, true);
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'BUY', type: 'MARKET',
                quantity: Math.abs(parseFloat(remPos.positionAmt)), reduceOnly: 'true'
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

// --- HÀM MỞ LỆNH SHORT CHÍNH (ĐÃ SỬA LOGIC TP/SL THEO ROE X3) ---
async function openShortPosition(symbol, fundingRate, usdtBalance, maxLeverage) {
    addLog(`>>> Mở SHORT ${symbol} (FR: ${fundingRate})...`, true);
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        const initialMargin = usdtBalance * PERCENT_ACCOUNT_PER_TRADE;
        
        let quantity = (initialMargin * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        // 1. Mở SHORT
        const orderRes = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', type: 'MARKET',
            quantity: quantity, newOrderRespType: 'FULL'
        });
        
        // 2. NGAY LẬP TỨC ĐÓNG LONG LÓT ĐƯỜNG
        await closeLongPreFunding();

        const entryPrice = parseFloat(orderRes.avgFillPrice || currentPrice);
        addLog(`✅ Đã mở SHORT ${symbol} @ ${entryPrice}`, true);

        // 3. TÍNH TOÁN TP VÀ SL THEO ROE (X3)
        // Lấy % gốc (ví dụ 0.15)
        const baseTpPercent = TAKE_PROFIT_PERCENTAGES[maxLeverage] || 0.1;
        
        // Nhân 3 lên theo yêu cầu (ví dụ 0.15 * 3 = 0.45 hay 45% ROE)
        const targetRoe = baseTpPercent * 3;
        
        // Quy đổi ROE ra % biến động giá cần thiết: PriceMove = ROE / Leverage
        const priceMovePercent = targetRoe / maxLeverage;

        // Tính giá TP (Short thì giá giảm -> trừ đi)
        const tpPrice = parseFloat((entryPrice * (1 - priceMovePercent)).toFixed(symbolInfo.pricePrecision));

        // Tính giá SL (Short thì giá tăng -> cộng vào) - SL bằng TP (theo ROE)
        const slPrice = parseFloat((entryPrice * (1 + priceMovePercent)).toFixed(symbolInfo.pricePrecision));

        addLog(`>>> Cài đặt: Target ROE ${targetRoe * 100}% | SL/TP Price Move: ${(priceMovePercent * 100).toFixed(2)}%`, true);
        addLog(`>>> TP @ ${tpPrice} | SL @ ${slPrice}`, true);

        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'BUY', type: 'STOP_MARKET',
                quantity: quantity, stopPrice: slPrice, closePosition: 'true'
            });
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET',
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
    const { symbol, quantity, openTime, initialSLPrice, initialTPPrice } = currentOpenPosition;

    if ((new Date() - openTime) / 1000 >= MAX_POSITION_LIFETIME_SECONDS) {
        await closeShortPosition(symbol, quantity, 'Time Limit');
        return;
    }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const pos = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) < 0);
        
        if (!pos || parseFloat(pos.positionAmt) === 0) {
            addLog(`✅ Vị thế ${symbol} đã đóng (TP/SL khớp).`, true);
            cleanupAfterClose(symbol);
        }
    } catch (error) { }
}

// --- LOGIC QUÉT THỊ TRƯỜNG ---
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
                if (timeLeftMin > 0 && timeLeftMin <= FUNDING_WINDOW_MINUTES) {
                    const leverage = await getLeverageBracketForSymbol(item.symbol);
                    if (leverage) candidates.push({ symbol: item.symbol, fr, time: item.nextFundingTime, leverage });
                }
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => a.fr - b.fr);
            const best = candidates[0];
            
            const shortTime = best.time - (OPEN_TRADE_BEFORE_FUNDING_SECONDS * 1000) + OPEN_TRADE_AFTER_SECOND_OFFSET_MS;
            const delayShort = shortTime - Date.now();

            const longTime = best.time - (OPEN_LONG_BEFORE_FUNDING_SECONDS * 1000);
            const delayLong = longTime - Date.now();

            if (delayShort > 0 && delayShort <= ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000) {
                addLog(`✅ CHỌN: ${best.symbol} (FR: ${best.fr})`, true);
                addLog(`-> Long lót đường sau: ${Math.ceil(delayLong/1000)}s`);
                addLog(`-> Short chính sau: ${Math.ceil(delayShort/1000)}s`);
                
                await setLeverage(best.symbol, best.leverage);

                clearTimeout(scheduledLongTimeout);
                if (delayLong > 0) {
                    scheduledLongTimeout = setTimeout(() => {
                        if (botRunning) openLongPreFunding(best.symbol, best.leverage, balance);
                    }, delayLong);
                }

                clearTimeout(nextScheduledTimeout);
                nextScheduledTimeout = setTimeout(() => {
                    if (botRunning && !currentOpenPosition) {
                        openShortPosition(best.symbol, best.fr, balance, best.leverage);
                    }
                }, delayShort);
            } else {
                addLog('⚠️ Không kịp giờ vào lệnh.', true);
                scheduleNextMainCycle();
            }
        } else {
            addLog('⚠️ Không tìm thấy coin FR <= -0.3%.', true);
            scheduleNextMainCycle();
        }

    } catch (error) {
        addLog('❌ Lỗi Logic: ' + error.message);
        scheduleNextMainCycle();
    }
}

async function scheduleNextMainCycle() {
    if (!botRunning || currentOpenPosition) return;
    clearTimeout(nextScheduledTimeout);
    const now = Date.now();
    const min = new Date(now).getUTCMinutes();
    let delayMs = ((59 - min + (min >= 59 ? 60 : 0)) * 60 * 1000) - (now % 60000) - 500; 
    if (delayMs < 1000) delayMs = 1000;
    
    addLog(`>>> Chờ quét tiếp theo vào phút :59...`);
    nextScheduledTimeout = setTimeout(runTradingLogic, delayMs);
}

// --- SERVER & API ---
async function startBotLogicInternal() {
    if (botRunning) return 'Bot đang chạy.';
    addLog('--- KHỞI ĐỘNG BOT ---', true);
    try {
        await syncServerTime();
        await getExchangeInfo();
        botRunning = true; 
        botStartTime = new Date();
        scheduleNextMainCycle();
        return 'Bot đã bắt đầu.';
    } catch (e) { return 'Lỗi khởi động: ' + e.message; }
}

function stopBotLogicInternal() {
    botRunning = false;
    clearTimeout(nextScheduledTimeout);
    clearTimeout(scheduledLongTimeout);
    clearInterval(positionCheckInterval);
    positionCheckInterval = null;
    addLog('--- ĐÃ DỪNG BOT ---', true);
    return 'Bot đã dừng.';
}

const app = express();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => res.send(memoryLogs.join('\n')));
app.get('/api/status', (req, res) => res.send(botRunning ? `BOT ĐANG CHẠY (Uptime: ${botStartTime ? ((Date.now() - botStartTime)/60000).toFixed(1) : 0}m)` : 'BOT ĐÃ DỪNG'));
app.get('/api/countdown', (req, res) => res.send(currentCountdownMessage));
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));

app.listen(WEB_SERVER_PORT, () => addLog(`Server running on port ${WEB_SERVER_PORT}`, true));
