import https from 'https';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim();
const DEFAULT_SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim();

let userConfig = {
    apiKey: DEFAULT_API_KEY,
    secretKey: DEFAULT_SECRET_KEY,
    amountMode: 'percent', 
    amountValue: 25,       
    tpPercent: 5,        
    slPercent: 5         
};

function loadConfigFromFile() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE, 'utf8');
            const savedConfig = JSON.parse(rawData);
            userConfig = { ...userConfig, ...savedConfig };
        }
    } catch (error) {
        addLog('<span style="color: #ffcc00">⚠️ Warning: Could not read config file.</span>');
    }
}

function saveConfigToFile() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(userConfig, null, 2), 'utf8');
    } catch (error) {
        addLog('<span style="color: #ff4444">❌ Error saving config file: ' + error.message + '</span>');
    }
}

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
let periodicLogInterval = null;
let lastLoggedMinute = -1; 

let consecutiveApiErrors = 0; 
const MAX_CONSECUTIVE_API_ERRORS = 5; 
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

const MIN_FUNDING_RATE_THRESHOLD = -0.001; 
const FUNDING_WINDOW_MINUTES = 3; 
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 60; 
const OPEN_TRADE_BEFORE_FUNDING_SECONDS = 1; 
const OPEN_TRADE_AFTER_SECOND_OFFSET_MS = 1000; 
const OPEN_LONG_BEFORE_FUNDING_SECONDS = 1.5; 
const DELAY_BEFORE_CANCEL_ORDERS_MS = 3.5 * 60 * 1000; 
const RETRY_CHECK_POSITION_ATTEMPTS = 6; 
const RETRY_CHECK_POSITION_DELAY_MS = 30000; 
const WEB_SERVER_PORT = 9999; 

function addLog(message) {
    const now = new Date();
    
    const day = String(now.getUTCDate()).padStart(2, '0');
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    const ms = String(now.getUTCMilliseconds()).padStart(3, '0');

    const time = `${day}/${month} ${hours}:${minutes}:${seconds}.${ms}`;
    let logEntry = `[${time}] ${message}`;

    const plainTextMsg = message.replace(/<[^>]*>?/gm, ''); 
    const messageHash = crypto.createHash('md5').update(plainTextMsg).digest('hex');
    
    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        if ((now.getTime() - logCounts[messageHash].lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return; 
        } else {
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }

    console.log(`[${time}] ${plainTextMsg}`); 
    memoryLogs.push(logEntry);
    if (memoryLogs.length > MAX_LOG_SIZE) memoryLogs.shift(); 
}

function formatTimeUTC(ms) {
    const date = new Date(ms);
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
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
    if (!userConfig.apiKey || !userConfig.secretKey) {
        throw new CriticalApiError("Missing API Key/Secret Key.");
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
        addLog(`<span style="color: #ff4444">❌ API Error: ${error.code} - ${error.msg || error.message}</span>`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new CriticalApiError("Critical API Error.");
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
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Critical Public API Error.");
        throw error;
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = data.serverTime - Date.now();
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Sync time error: ${error.message}.</span>`);
        throw error;
    }
}

async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol });
        const brackets = response[0]?.brackets || [];
        brackets.sort((a, b) => b.initialLeverage - a.initialLeverage);
        if (brackets.length > 0) return brackets[0].initialLeverage;
        return 20;
    } catch (error) { return 20; }
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

async function aggressiveCleanup(symbol) {
    addLog(`>>> 🧹 CLEANUP: Clearing Orders & Positions for ${symbol}...`);
    try {
        await cancelOpenOrdersForSymbol(symbol);
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        for (const pos of positions) {
            const amt = parseFloat(pos.positionAmt);
            if (Math.abs(amt) > 0) {
                const side = amt > 0 ? 'SELL' : 'BUY';
                addLog(`<span style="color: #ffcc00">⚠️ Closing existing ${pos.positionSide} (${amt})...</span>`);
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol,
                    side: side,
                    positionSide: pos.positionSide,
                    type: 'MARKET',
                    quantity: Math.abs(amt)
                });
            }
        }
        addLog(`<span style="color: #00ffaa">✅ ${symbol} Cleaned. Ready.</span>`);
    } catch (e) {
        addLog(`<span style="color: #ff4444">⚠️ Cleanup error: ${e.message}</span>`);
    }
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
            candidates.sort((a, b) => {
                if (a.time === b.time) {
                    return a.fr - b.fr; 
                }
                return a.time - b.time; 
            });
            const topCoin = candidates[0];
            let leverage = await getLeverageBracketForSymbol(topCoin.symbol);
            if (!leverage) leverage = 20; 
            let marginUsed = 0;
            if (userConfig.amountMode === 'percent') {
                marginUsed = balance * (userConfig.amountValue / 100);
            } else {
                marginUsed = userConfig.amountValue;
            }
            const displayFr = (topCoin.fr * 100).toFixed(4);
            const timeStr = formatTimeUTC(topCoin.time);
            addLog(`<span style="color: #FCD535">🔮 [FORECAST] ${topCoin.symbol}</span> | <span style="color: #FCD535">FR:</span> ${displayFr}% | <span style="color: #FCD535">Time:</span> ${timeStr} | <span style="color: #FCD535">Margin:</span> ${marginUsed.toFixed(2)}$`);
        } else {
            addLog(`<span style="color: #FCD535">🔮 [FORECAST] No coin found with FR <= ${(MIN_FUNDING_RATE_THRESHOLD * 100)}%</span>`);
        }
    } catch (error) {
        addLog(`<span style="color: #ff4444">🔮 Forecast Error: ${error.message}</span>`);
    }
}

async function openLongPreFunding(symbol, maxLeverage, availableBalance) {
    addLog(`>>> Opening LONG buffer for ${symbol}...`);
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        
        let initialMargin = 0;
        if (userConfig.amountMode === 'percent') {
            initialMargin = availableBalance * (userConfig.amountValue / 100);
        } else {
            initialMargin = userConfig.amountValue;
        }
        if (initialMargin > availableBalance) throw new Error("Insufficient funds for order.");

        let quantity = (initialMargin * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: quantity
        });

        addLog(`<span style="color: #00ffaa">✅ Opened LONG buffer ${symbol}. Qty: ${quantity}</span>`);

        const slPriceRaw = currentPrice - (initialMargin / quantity);
        const slPrice = Math.floor(slPriceRaw / symbolInfo.tickSize) * symbolInfo.tickSize;

        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET',
                quantity: quantity, stopPrice: parseFloat(slPrice.toFixed(symbolInfo.pricePrecision)), closePosition: 'true'
            });
            addLog(`<span style="color: #00ffaa">✅ Set SL for LONG ${symbol} @ ${slPrice}</span>`);
        } catch (e) {
            addLog(`<span style="color: #ffcc00">⚠️ Error setting SL for Long: ${e.msg}</span>`);
        }
        currentLongPosition = { symbol, quantity };
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error opening LONG buffer: ${error.msg || error.message}</span>`);
    }
}

async function closeLongPreFunding() {
    if (!currentLongPosition) return;
    const { symbol, quantity } = currentLongPosition;
    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: quantity
        });
        addLog(`<span style="color: #00ffaa">✅ Closed LONG buffer.</span>`);
    } catch (error) {
        addLog(`<span style="color: #ffcc00">⚠️ Error closing Long: ${error.msg}</span>`);
    }
    currentLongPosition = null;
}

async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    if (isClosingPosition) return;
    isClosingPosition = true;
    addLog(`>>> Closing SHORT ${symbol} (${reason})...`);
    try {
        if (currentLongPosition) await closeLongPreFunding();
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', positionSide: 'SHORT', type: 'MARKET', quantity: quantityToClose
        });
        addLog(`<span style="color: #00ffaa">✅ Closed SHORT ${symbol}.</span>`);
        cleanupAfterClose(symbol);
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error closing SHORT: ${error.msg}</span>`);
        isClosingPosition = false;
    }
}

function cleanupAfterClose(symbol) {
    currentOpenPosition = null;
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    setTimeout(async () => {
        await aggressiveCleanup(symbol);
        if (botRunning) scheduleNextMainCycle();
        isClosingPosition = false;
    }, DELAY_BEFORE_CANCEL_ORDERS_MS);
}

// [MODIFIED] Không set lệnh TP SL lên Binance. Quản lý ở Local memory
async function openShortPosition(symbol, fundingRate, quantity) {
    const shortOrderPromise = callSignedAPI('/fapi/v1/order', 'POST', {
        symbol: symbol, side: 'SELL', positionSide: 'SHORT', type: 'MARKET',
        quantity: quantity, newOrderRespType: 'FULL'
    });
    
    closeLongPreFunding(); 
    addLog(`🚀 EXECUTING SHORT ${symbol} (Qty: ${quantity})...`);

    try {
        const orderRes = await shortOrderPromise;
        
        // Fetch ngay position để lấy chuẩn xác Entry Price
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && p.positionSide === 'SHORT');
        
        if (!pos || parseFloat(pos.positionAmt) === 0) {
            addLog(`<span style="color: #ffcc00">⚠️ Position failed to open or closed instantly.</span>`);
            scheduleNextMainCycle();
            return;
        }

        const realEntryPrice = parseFloat(pos.entryPrice);
        addLog(`<span style="color: #00ffaa">✅ SHORT Placed. Entry: ${realEntryPrice} | Tracking Trailing SL/TP internally.</span>`);

        currentOpenPosition = { 
            symbol, 
            quantity, 
            openTime: new Date(), 
            entryPrice: realEntryPrice,
            lowestPrice: realEntryPrice, // Bắt đầu tính lowest price
            timeLimit: (fundingRate > -0.005) ? 60 : 120
        };

        // Check giá liên tục 300ms
        positionCheckInterval = setInterval(manageOpenPosition, 300);

    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error opening SHORT: ${error.message || error.msg}</span>`);
        await closeLongPreFunding(); 
        scheduleNextMainCycle();
    }
}

// [MODIFIED] Xử lý Trailing TP/SL nội bộ ở đây
async function manageOpenPosition() {
    if (!currentOpenPosition || isClosingPosition) return;
    const { symbol, quantity, openTime, timeLimit, entryPrice } = currentOpenPosition;
    const limitSeconds = timeLimit || 120;

    if ((new Date() - openTime) / 1000 >= limitSeconds) {
        await closeShortPosition(symbol, quantity, 'Time Limit');
        return;
    }
    
    try {
        // Dùng ticker nhanh nhất để tính toán trailing
        const currentPrice = await getCurrentPrice(symbol);
        if(!currentPrice) return;

        // Cập nhật giá thấp nhất đã đạt được
        if (currentPrice < currentOpenPosition.lowestPrice) {
            currentOpenPosition.lowestPrice = currentPrice;
        }

        const tpDistance = entryPrice * (userConfig.tpPercent / 100);
        const slDistance = entryPrice * (userConfig.slPercent / 100);
        const guaranteedProfitPrice = entryPrice * (1 - 0.005); // Lãi mặc định 0.5% Entry

        let dynamicSL;

        // Nếu giá tụt chạm mốc TP -> Kích hoạt Trailing / Khóa lãi
        if (currentOpenPosition.lowestPrice <= entryPrice - tpDistance) {
            const trailingSL = currentOpenPosition.lowestPrice + tpDistance;
            // Lấy mức thấp hơn (tốt hơn cho Short) giữa khóa lãi 0.5% và Trailing
            dynamicSL = Math.min(trailingSL, guaranteedProfitPrice);
        } else {
            // SL mặc định ban đầu
            dynamicSL = entryPrice + slDistance;
        }

        // TRIGGER CHỐT LỜI / CẮT LỖ
        if (currentPrice >= dynamicSL) {
            addLog(`⚡ Triggers! Price ${currentPrice} chạm mốc chốt (SL/TP: ${dynamicSL.toFixed(4)})`);
            await closeShortPosition(symbol, quantity, 'Dynamic Trailing/SL');
            return;
        }

        // Đề phòng sập hầm chia to (99% từ entry)
        if (currentPrice <= entryPrice * 0.01) {
            addLog(`⚡ Triggers! Giá tụt 99%`);
            await closeShortPosition(symbol, quantity, '99% Drop');
            return;
        }

        // Kiểm tra cross-check với Binance đề phòng tự đóng lệnh
        if (Math.random() < 0.1) { // Check positionRisk tần suất thấp (cứ ~10 lần quét ticker thì gọi 1 lần)
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const pos = positions.find(p => p.symbol === symbol && p.positionSide === 'SHORT');
            if (!pos || parseFloat(pos.positionAmt) === 0) {
                addLog(`<span style="color: #00ffaa">✅ Position ${symbol} closed externally.</span>`);
                cleanupAfterClose(symbol);
            }
        }
    } catch (error) { }
}

async function runTradingLogic() {
    if (!botRunning || currentOpenPosition) return;
    
    try {
        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
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
            candidates.sort((a, b) => {
                if (a.time === b.time) return a.fr - b.fr; 
                return a.time - b.time; 
            });

            const best = candidates[0];
            
            const shortTime = best.time - (OPEN_TRADE_BEFORE_FUNDING_SECONDS * 1000) + OPEN_TRADE_AFTER_SECOND_OFFSET_MS;
            const delayShort = shortTime - Date.now();
            const longTime = best.time - (OPEN_LONG_BEFORE_FUNDING_SECONDS * 1000);
            const delayLong = longTime - Date.now();

            if (delayShort > 0 && delayShort <= ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000) {
                addLog(`<span style="color: #00ffaa">✅ SELECTED: ${best.symbol} (FR: ${(best.fr * 100).toFixed(4)}%)</span>`);
                addLog(`-> Short Main in: ${Math.ceil(delayShort/1000)}s`);
                
                await setLeverage(best.symbol, best.leverage);
                await aggressiveCleanup(best.symbol);

                const symbolInfo = exchangeInfoCache[best.symbol];
                const currentPrice = await getCurrentPrice(best.symbol);
                let initialMargin = 0;
                if (userConfig.amountMode === 'percent') initialMargin = balance * (userConfig.amountValue / 100);
                else initialMargin = userConfig.amountValue;

                let quantity = (initialMargin * best.leverage) / currentPrice;
                quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));
                
                addLog(`>>> Pre-calculated Qty: ${quantity} (at price ~${currentPrice})`);

                clearTimeout(scheduledLongTimeout);
                if (delayLong > 0) {
                    scheduledLongTimeout = setTimeout(() => {
                        if (botRunning) openLongPreFunding(best.symbol, best.leverage, balance);
                    }, delayLong);
                }

                clearTimeout(nextScheduledTimeout);
                nextScheduledTimeout = setTimeout(() => {
                    if (botRunning && !currentOpenPosition) {
                        openShortPosition(best.symbol, best.fr, quantity);
                    }
                }, delayShort);
            } else {
                addLog('<span style="color: #ffcc00">⚠️ Opportunity too close/passed.</span>');
                scheduleNextMainCycle();
            }
        } else {
            addLog(`<span style="color: #ffcc00">⚠️ No coin FR <= ${(MIN_FUNDING_RATE_THRESHOLD * 100)}%.</span>`);
            scheduleNextMainCycle();
        }
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Logic Error: ${error.message}</span>`);
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
    addLog(`>>> Next scan scheduled at :59...`);
    nextScheduledTimeout = setTimeout(runTradingLogic, delayMs);
}

async function startBotLogicInternal(query) {
    if (botRunning) return 'Bot is already running.';
    let isUpdated = false;
    if (query.apiKey && query.apiKey.trim() !== '') { userConfig.apiKey = query.apiKey.trim(); isUpdated = true; }
    if (query.secret && query.secret.trim() !== '') { userConfig.secretKey = query.secret.trim(); isUpdated = true; }
    if (query.amountMode) { userConfig.amountMode = query.amountMode; isUpdated = true; }
    if (query.amountVal) { userConfig.amountValue = parseFloat(query.amountVal); isUpdated = true; }
    if (query.tp) { userConfig.tpPercent = parseFloat(query.tp); isUpdated = true; } else if (!userConfig.tpPercent) { userConfig.tpPercent = 5; }
    if (query.sl) { userConfig.slPercent = parseFloat(query.sl); isUpdated = true; }
    if (isUpdated) { saveConfigToFile(); addLog(`<span style="color: #00ffaa">Update done.</span>`); }
    addLog('--- STARTING BOT ---');
    try {
        await syncServerTime();
        await getExchangeInfo();
        botRunning = true; 
        botStartTime = new Date();
        scheduleNextMainCycle();
        if (periodicLogInterval) clearInterval(periodicLogInterval);
        periodicLogInterval = setInterval(() => { logBestCandidate(); }, 120000); 
        logBestCandidate(); 
        return 'Bot Started Successfully.';
    } catch (e) { return 'Start Error: ' + e.message; }
}

function stopBotLogicInternal() {
    botRunning = false;
    clearTimeout(nextScheduledTimeout);
    clearTimeout(scheduledLongTimeout);
    clearInterval(positionCheckInterval);
    clearInterval(periodicLogInterval);
    positionCheckInterval = null;
    periodicLogInterval = null;
    addLog('--- BOT STOPPED ---');
    return 'Bot Stopped.';
}

loadConfigFromFile();

const app = express();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => res.send(memoryLogs.join('\n')));
app.get('/api/status', (req, res) => res.send(botRunning ? `RUNNING (Uptime: ${botStartTime ? ((Date.now() - botStartTime)/60000).toFixed(1) : 0}m)` : 'STOPPED'));

// [NEW API] Lấy Top 10 coin có Funding âm nhất và thời gian gần nhất
app.get('/api/funding_rates', async (req, res) => {
    try {
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        let candidates = allFunding.filter(item => item.symbol.endsWith('USDT'));
        candidates.sort((a, b) => {
            if (a.nextFundingTime === b.nextFundingTime) {
                return parseFloat(a.lastFundingRate) - parseFloat(b.lastFundingRate);
            }
            return a.nextFundingTime - b.nextFundingTime;
        });
        res.json(candidates.slice(0, 10));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// [NEW API] Kích hoạt Test Nhanh lập tức đánh Market Short
app.get('/api/test_fast', async (req, res) => {
    if(currentOpenPosition) return res.send('⚠️ Lỗi: Đang có lệnh mở, không thể Test.');
    try {
        addLog(`🧪 Đang kích hoạt TEST NHANH...`);
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        let candidates = allFunding.filter(item => item.symbol.endsWith('USDT'));
        candidates.sort((a, b) => {
            if (a.nextFundingTime === b.nextFundingTime) return parseFloat(a.lastFundingRate) - parseFloat(b.lastFundingRate);
            return a.nextFundingTime - b.nextFundingTime;
        });
        const best = candidates[0];
        if(!best) return res.send('⚠️ Không tìm thấy coin.');

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        let leverage = await getLeverageBracketForSymbol(best.symbol);
        if (!leverage) leverage = 20;
        
        await setLeverage(best.symbol, leverage);
        await aggressiveCleanup(best.symbol);

        const symbolInfo = exchangeInfoCache[best.symbol];
        const currentPrice = await getCurrentPrice(best.symbol);
        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
        
        let quantity = (initialMargin * leverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        botRunning = true; 
        openShortPosition(best.symbol, parseFloat(best.lastFundingRate), quantity);
        res.send(`✅ Test Nhanh: Đã gọi lệnh Market Short ${best.symbol}`);
    } catch (e) {
        res.send('❌ Lỗi Test Nhanh: ' + e.message);
    }
});

app.get('/start_bot_logic', async (req, res) => { res.send(await startBotLogicInternal(req.query)); });
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.listen(WEB_SERVER_PORT);
