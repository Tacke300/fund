import https from 'https';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(__dirname, 'state.json');

const DEFAULT_API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim();
const DEFAULT_SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim();

const LONG_SL_CAPITAL_PERCENT = 5; 

let userConfig = {
    apiKey: DEFAULT_API_KEY,
    secretKey: DEFAULT_SECRET_KEY,
    amountMode: 'percent', 
    amountValue: 40,       
    tpPercent: 5,        
    slPercent: 5,
    longOffsetMs: 1000, 
    shortOffsetMs: 222,
    fundingThreshold: 0.3 
};

let globalStats = {
    totalSessions: 0,
    totalPnl: 0
};

let currentOpenPosition = null; 
let currentLongPosition = null; 
let botRunning = false;
let botStartTime = null; 

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

function saveStateToFile() {
    try {
        const stateData = {
            currentOpenPosition,
            currentLongPosition,
            globalStats,
            botRunning,
            botStartTime
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2), 'utf8');
    } catch (error) {
        addLog('<span style="color: #ff4444">❌ Error saving state file: ' + error.message + '</span>');
    }
}

function loadStateFromFile() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const rawData = fs.readFileSync(STATE_FILE, 'utf8');
            const state = JSON.parse(rawData);
            if (state.currentOpenPosition) currentOpenPosition = state.currentOpenPosition;
            if (state.currentLongPosition) currentLongPosition = state.currentLongPosition;
            if (state.globalStats) globalStats = state.globalStats;
            if (state.botRunning !== undefined) botRunning = state.botRunning;
            if (state.botStartTime) botStartTime = state.botStartTime;
            addLog(`📁 Đã khôi phục trạng thái vị thế từ cache file thành công.`);
        }
    } catch (error) {
        addLog('<span style="color: #ffcc00">⚠️ Warning: Could not read state file.</span>');
    }
}

const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; 
let exchangeInfoCache = null;

let shortCheckInterval = null; 
let longCheckInterval = null;
let nextScheduledTimeout = null; 
let scheduledLongTimeout = null; 

let consecutiveApiErrors = 0; 
const MAX_CONSECUTIVE_API_ERRORS = 5; 
const memoryLogs = [];
const MAX_LOG_SIZE = 1000; 
const logCounts = {}; 
const LOG_COOLDOWN_MS = 60000; 

let pauseUntilTime = 0; 

const FUNDING_WINDOW_MINUTES = 3; 
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 60; 
const DELAY_BEFORE_CANCEL_ORDERS_MS = 3 * 60 * 1000; 
const WEB_SERVER_PORT = 9999; 

class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}

function addLog(message) {
    const now = new Date();
    const utc7 = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    
    const day = String(utc7.getUTCDate()).padStart(2, '0');
    const month = String(utc7.getUTCMonth() + 1).padStart(2, '0');
    const hours = String(utc7.getUTCHours()).padStart(2, '0');
    const minutes = String(utc7.getUTCMinutes()).padStart(2, '0');
    const seconds = String(utc7.getUTCSeconds()).padStart(2, '0');
    const ms = String(utc7.getUTCMilliseconds()).padStart(3, '0');

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
    } catch (error) { throw error; }
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
            if (s.status !== 'TRADING') return; 
            exchangeInfoCache[s.symbol] = {
                minQty: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE')?.minQty || 0),
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize || 0.001),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5),
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
    addLog(`>>> 🧹 CLEANUP: Clearing Orders & Positions for ${symbol}...`);
    try {
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        for (const pos of positions) {
            const amt = parseFloat(pos.positionAmt);
            if (Math.abs(amt) > 0) {
                const side = amt > 0 ? 'SELL' : 'BUY';
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol, side: side, positionSide: pos.positionSide, type: 'MARKET', quantity: Math.abs(amt)
                });
            }
        }
        addLog(`<span style="color: #00ffaa">✅ ${symbol} Cleaned. Ready.</span>`);
    } catch (e) {}
}

function fetchAndLogRealizedPnL(symbol, positionSide, isTest = false) {
    const closeTime = Date.now();
    setTimeout(async () => {
        try {
            const trades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol, limit: 30 });
            const closeTrades = trades.filter(t => 
                t.time >= closeTime - 12000 && 
                t.realizedPnl !== "0" && 
                t.positionSide === positionSide
            );
            const totalPnl = closeTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            
            if (!isTest) {
                globalStats.totalPnl += totalPnl;
                saveStateToFile();
            }
            
            addLog(`💰 [PnL ${isTest ? '(TEST) ' : ''}Khớp ${positionSide}] Tổng lãi/lỗ thực tế: ${totalPnl.toFixed(4)} USDT`);
        } catch (e) {
            addLog(`⚠️ Lỗi lấy PnL: ${e.message}`);
        }
    }, 10000); 
}

// --- QUY ĐỔI QUANTITY VÀ LÀM TRÒN MARGIN TỐI THIỂU THEO SÀN --- //
function calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage) {
    let notional = initialMargin * leverage;
    let minNotional = symbolInfo.minNotional || 5.0;
    
    // Nếu margin/notional không đủ min, dùng min của sàn và chỉ làm tròn số lẻ đuôi (tránh nhảy vọt lên số lớn)
    if (notional < minNotional) {
        notional = Math.ceil((minNotional * 1.02) * 100) / 100;
    }
    
    let quantity = notional / currentPrice;
    quantity = Math.ceil(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
    return parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));
}

// --- QUẢN LÝ LONG --- //
async function openLongPreFunding(symbol, maxLeverage, availableBalance, isTest = false) {
    addLog(`>>> Opening LONG buffer for ${symbol}...`);
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        
        let initialMargin = userConfig.amountMode === 'percent' 
            ? availableBalance * (userConfig.amountValue / 100) 
            : userConfig.amountValue;
            
        let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, maxLeverage);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: quantity
        });
        
        addLog(`<span style="color: #00ffaa">✅ Opened LONG buffer ${symbol}. Qty: ${quantity}</span>`);

        // TP/SL tính theo % giá entry
        const slPrice = currentPrice - (currentPrice * (userConfig.slPercent / 100));

        currentLongPosition = { 
            symbol, quantity, entryPrice: currentPrice, slPrice, openTime: Date.now(), isTest 
        };
        saveStateToFile();
        
        if (longCheckInterval) clearInterval(longCheckInterval);
        longCheckInterval = setInterval(manageLongPosition, 500);

    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error opening LONG: ${error.msg || error.message}</span>`);
    }
}

let isClosingLong = false;
async function manageLongPosition() {
    if (!currentLongPosition || isClosingLong) return;
    try {
        const currentPrice = await getCurrentPrice(currentLongPosition.symbol);
        if(!currentPrice) return;
        
        if (currentPrice <= currentLongPosition.slPrice) {
            isClosingLong = true;
            addLog(`⚡ Triggers Long SL (Tính theo % Entry)! Bot tự chốt Market...`);
            await closeLongInternal('SL Hit', currentLongPosition.isTest);
            isClosingLong = false;
        }
    } catch (e) { isClosingLong = false; }
}

async function closeLongInternal(reason = 'Time', isTest = false) {
    if (!currentLongPosition) return;
    const { symbol, quantity } = currentLongPosition;
    currentLongPosition = null; 
    saveStateToFile();
    if (longCheckInterval) { clearInterval(longCheckInterval); longCheckInterval = null; }

    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: quantity
        });
        addLog(`<span style="color: #00ffaa">✅ Closed LONG buffer (${reason}).</span>`);
        fetchAndLogRealizedPnL(symbol, 'LONG', isTest);
    } catch (error) {
        addLog(`<span style="color: #ffcc00">⚠️ Error closing Long: ${error.msg}</span>`);
    }
}

// --- QUẢN LÝ SHORT --- //
let isClosingShort = false;
async function openShortPosition(symbol, quantity, nextFundingTime, isTest = false) {
    addLog(`🚀 EXECUTING SHORT ${symbol} (Qty: ${quantity})...`);
    closeLongInternal('Chuyển giao Short', isTest); 
    
    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', positionSide: 'SHORT', type: 'MARKET', quantity: quantity
        });
        
        if (!isTest) {
            globalStats.totalSessions++;
        }
        
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && p.positionSide === 'SHORT');
        
        if (!pos || parseFloat(pos.positionAmt) === 0) {
            addLog(`<span style="color: #ffcc00">⚠️ Position failed to open.</span>`);
            scheduleNextMainCycle();
            return;
        }

        const realEntryPrice = parseFloat(pos.entryPrice);
        addLog(`<span style="color: #00ffaa">✅ SHORT Placed. Entry: ${realEntryPrice}</span>`);

        currentOpenPosition = { 
            symbol, quantity, openTime: Date.now(), entryPrice: realEntryPrice, lowestPrice: realEntryPrice, nextFundingTime, isTest 
        };
        saveStateToFile();

        if (shortCheckInterval) clearInterval(shortCheckInterval);
        shortCheckInterval = setInterval(manageShortPosition, 400);

    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error opening SHORT: ${error.message || error.msg}</span>`);
        scheduleNextMainCycle();
    }
}

async function manageShortPosition() {
    if (!currentOpenPosition || isClosingShort) return;
    const { symbol, quantity, entryPrice, nextFundingTime, isTest } = currentOpenPosition;

    if (!isTest && nextFundingTime && Date.now() >= nextFundingTime - (5 * 60 * 1000)) {
        isClosingShort = true;
        addLog(`⏳ Sắp tới mốc Funding tiếp theo. Đóng vị thế an toàn!`);
        await closeShortInternal('Pre-Funding Close', isTest);
        isClosingShort = false;
        return;
    }
    
    try {
        const currentPrice = await getCurrentPrice(symbol);
        if(!currentPrice) return;

        // Cập nhật giá sâu nhất (thấp nhất) cho Short
        if (currentPrice < currentOpenPosition.lowestPrice) {
            currentOpenPosition.lowestPrice = currentPrice;
            saveStateToFile();
        }

        // TP và SL tính theo % giá entry
        const tpDistance = entryPrice * (userConfig.tpPercent / 100);
        const slDistance = entryPrice * (userConfig.slPercent / 100);

        let dynamicSL;
        // Giá sâu nhất tụt so với entry >= khoảng tpDistance thì kích hoạt SL dương (Trailing)
        if (currentOpenPosition.lowestPrice <= entryPrice - tpDistance) {
            const trailingSL = currentOpenPosition.lowestPrice + tpDistance;
            dynamicSL = Math.min(trailingSL, entryPrice - (entryPrice * 0.001));
        } else {
            dynamicSL = entryPrice + slDistance;
        }
        
        currentOpenPosition.dynamicSL = dynamicSL; 

        if (currentPrice >= dynamicSL) {
            isClosingShort = true;
            addLog(`⚡ Triggers SHORT SL Dương / TP (Market Price chạm mốc ${dynamicSL.toFixed(4)})`);
            await closeShortInternal('Dynamic Trailing/SL Dương', isTest);
            isClosingShort = false;
            return;
        }
    } catch (error) { }
}

async function closeShortInternal(reason = 'manual', isTest = false) {
    if (!currentOpenPosition) return;
    const { symbol, quantity } = currentOpenPosition;
    addLog(`>>> Closing SHORT ${symbol} (${reason})...`);
    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', positionSide: 'SHORT', type: 'MARKET', quantity: quantity
        });
        addLog(`<span style="color: #00ffaa">✅ Closed SHORT ${symbol}.</span>`);
        fetchAndLogRealizedPnL(symbol, 'SHORT', isTest);
        cleanupAfterClose(symbol);
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error closing SHORT: ${error.msg}</span>`);
    }
}

function cleanupAfterClose(symbol) {
    currentOpenPosition = null;
    saveStateToFile();
    if (shortCheckInterval) { clearInterval(shortCheckInterval); shortCheckInterval = null; }
    setTimeout(async () => {
        await aggressiveCleanup(symbol);
        if (botRunning) scheduleNextMainCycle();
    }, DELAY_BEFORE_CANCEL_ORDERS_MS);
}

function getTargetFundingCoins(allFunding, reqThreshold = null, limit = null) {
    const now = Date.now();
    let valid = allFunding.filter(item => 
        item.symbol.endsWith('USDT') && 
        exchangeInfoCache[item.symbol] && 
        item.nextFundingTime > now 
    );

    if (valid.length === 0) return [];
    valid = valid.filter(item => parseFloat(item.lastFundingRate) < 0);

    if (reqThreshold !== null) {
        valid = valid.filter(item => parseFloat(item.lastFundingRate) <= reqThreshold);
    }

    valid.sort((a, b) => {
        if (a.nextFundingTime === b.nextFundingTime) {
            return parseFloat(a.lastFundingRate) - parseFloat(b.lastFundingRate);
        }
        return a.nextFundingTime - b.nextFundingTime;
    });

    if (limit) {
        return valid.slice(0, limit);
    }
    return valid;
}

async function runTradingLogic() {
    if (!botRunning || currentOpenPosition) return;
    try {
        const now = Date.now();
        if (now < pauseUntilTime) {
            scheduleNextMainCycle();
            return;
        }

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        
        if (!exchangeInfoCache) await getExchangeInfo();
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        const reqThreshold = -(userConfig.fundingThreshold / 100); 

        let candidates = getTargetFundingCoins(allFunding, reqThreshold, null);

        if (candidates.length > 0) {
            const best = candidates[0];
            const timeLeftMin = (best.nextFundingTime - now) / 60000;
            
            if (timeLeftMin > 0 && timeLeftMin <= FUNDING_WINDOW_MINUTES) {
                const leverage = await getLeverageBracketForSymbol(best.symbol);
                const currentServerTime = Date.now() + serverTimeOffset;
                
                const longOffsetMs = userConfig.longOffsetMs || 1500;
                const shortOffsetMs = userConfig.shortOffsetMs || 0;

                const delayLong = best.nextFundingTime - longOffsetMs - currentServerTime;
                const delayShort = best.nextFundingTime - shortOffsetMs - currentServerTime;

                if (delayShort > 0 && delayShort <= ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000) {
                    addLog(`<span style="color: #00ffaa">✅ SELECTED TOP COIN: ${best.symbol} (FR: ${(parseFloat(best.lastFundingRate) * 100).toFixed(4)}%)</span>`);
                    
                    const top10 = candidates.slice(0, 10).map(c => c.symbol).join(', ');
                    addLog(`📊 Danh sách Top 10 FD Âm Nhất: ${top10}`);
                    
                    await setLeverage(best.symbol, leverage);
                    await aggressiveCleanup(best.symbol);

                    const symbolInfo = exchangeInfoCache[best.symbol];
                    const currentPrice = await getCurrentPrice(best.symbol);
                    
                    let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
                    let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);

                    clearTimeout(scheduledLongTimeout);
                    if (delayLong > 0) {
                        scheduledLongTimeout = setTimeout(() => {
                            if (botRunning) openLongPreFunding(best.symbol, leverage, balance, false).catch(e => {});
                        }, delayLong);
                    }

                    clearTimeout(nextScheduledTimeout);
                    if (delayShort > 0) {
                        nextScheduledTimeout = setTimeout(() => {
                            if (botRunning && !currentOpenPosition) {
                                openShortPosition(best.symbol, quantity, best.nextFundingTime, false).catch(e => {});
                            }
                        }, delayShort);
                    }
                    
                    pauseUntilTime = best.nextFundingTime + 60000;
                    addLog(`⏳ Đã lên lịch vào lệnh. Tạm dừng update FD tới 01 phút sau Funding!`);
                    return; 
                }
            }
        }
        scheduleNextMainCycle();
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Logic Error: ${error.message}</span>`);
        scheduleNextMainCycle();
    }
}

async function scheduleNextMainCycle() {
    if (!botRunning || currentOpenPosition) return;
    clearTimeout(nextScheduledTimeout);
    nextScheduledTimeout = setTimeout(runTradingLogic, 5000);
}

async function startBotLogicInternal(query) {
    if (botRunning) return 'Bot is already running.';
    let isUpdated = false;
    
    if (query.apiKey && query.apiKey.trim() !== '') { userConfig.apiKey = query.apiKey.trim(); isUpdated = true; }
    if (query.secret && query.secret.trim() !== '') { userConfig.secretKey = query.secret.trim(); isUpdated = true; }
    if (query.amountMode) { userConfig.amountMode = query.amountMode; isUpdated = true; }
    if (query.amountVal) { userConfig.amountValue = parseFloat(query.amountVal); isUpdated = true; }
    if (query.tp) { userConfig.tpPercent = parseFloat(query.tp); isUpdated = true; } 
    if (query.sl) { userConfig.slPercent = parseFloat(query.sl); isUpdated = true; }
    if (query.longOffset !== undefined && query.longOffset !== '') { userConfig.longOffsetMs = parseInt(query.longOffset); isUpdated = true; }
    if (query.shortOffset !== undefined && query.shortOffset !== '') { userConfig.shortOffsetMs = parseInt(query.shortOffset); isUpdated = true; }
    if (query.fundingThreshold) { userConfig.fundingThreshold = parseFloat(query.fundingThreshold); isUpdated = true; }

    if (isUpdated) { saveConfigToFile(); addLog(`<span style="color: #00ffaa">Cập nhật Config thành công.</span>`); }
    addLog('--- STARTING BOT ---');
    try {
        await syncServerTime();
        await getExchangeInfo();
        botRunning = true; 
        botStartTime = new Date();
        saveStateToFile();
        scheduleNextMainCycle();
        return 'Bot Started Successfully.';
    } catch (e) { return 'Start Error: ' + e.message; }
}

function stopBotLogicInternal() {
    botRunning = false;
    clearTimeout(nextScheduledTimeout);
    clearTimeout(scheduledLongTimeout);
    if(shortCheckInterval) clearInterval(shortCheckInterval);
    if(longCheckInterval) clearInterval(longCheckInterval);
    saveStateToFile();
    addLog('--- BOT STOPPED ---');
    return 'Bot Stopped.';
}

loadConfigFromFile();
loadStateFromFile();

// Khôi phục interval quản lý vị thế nếu khi khởi động lại có vị thế đang lưu trong cache
if (currentOpenPosition) {
    addLog(`🔄 Khôi phục giám sát vị thế SHORT cho ${currentOpenPosition.symbol}`);
    shortCheckInterval = setInterval(manageShortPosition, 400);
}
if (currentLongPosition) {
    addLog(`🔄 Khôi phục giám sát vị thế LONG cho ${currentLongPosition.symbol}`);
    longCheckInterval = setInterval(manageLongPosition, 500);
}

const app = express();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => res.send(memoryLogs.join('\n')));
app.get('/api/status', (req, res) => res.send(botRunning ? `RUNNING (Uptime: ${botStartTime ? ((Date.now() - new Date(botStartTime))/60000).toFixed(1) : 0}m)` : 'STOPPED'));

app.get('/api/funding_rates', async (req, res) => {
    try {
        if (!exchangeInfoCache) await getExchangeInfo();
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        const reqThreshold = -(userConfig.fundingThreshold / 100);
        let candidates = getTargetFundingCoins(allFunding, reqThreshold, 10);
        res.json(candidates);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard', async (req, res) => {
    if (!botRunning && !currentOpenPosition && !currentLongPosition) return res.json({ running: false });
    try {
        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        const openOrdersInfo = await callSignedAPI('/fapi/v1/openOrders', 'GET');
        
        let positionsRes = [];
        const allPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositions = allPositions.filter(p => parseFloat(p.positionAmt) !== 0);
        
        for (const p of openPositions) {
            const posAmt = parseFloat(p.positionAmt);
            const entryPrice = parseFloat(p.entryPrice);
            const markPrice = parseFloat(p.markPrice);
            const lev = p.leverage;
            const margin = (Math.abs(posAmt) * entryPrice) / lev;
            const pnl = parseFloat(p.unRealizedProfit);
            const roi = (pnl / margin) * 100;
            
            let deepest = markPrice;
            let estTp = 0;
            let openTime = 'N/A';
            
            if (p.positionSide === 'SHORT' && currentOpenPosition && currentOpenPosition.symbol === p.symbol) {
                deepest = currentOpenPosition.lowestPrice; // Giá thấp nhất chính là giá sâu nhất của short
                estTp = currentOpenPosition.dynamicSL || 0; // SL dương
                openTime = currentOpenPosition.openTime;
            } else if (p.positionSide === 'LONG' && currentLongPosition && currentLongPosition.symbol === p.symbol) {
                deepest = markPrice; 
                estTp = currentLongPosition.slPrice;
                openTime = currentLongPosition.openTime;
            }
            
            const distToEntry = Math.abs(markPrice - entryPrice) / entryPrice * 100;
            const retrace = Math.abs(markPrice - deepest) / deepest * 100;
            
            positionsRes.push({
                coin: p.symbol, side: p.positionSide, lev, margin, pnl, roi, entryPrice, deepest, distToEntry, retrace, estTp, openTime
            });
        }
        
        res.json({
            running: true, balance, openOrders: openOrdersInfo.length, totalSessions: globalStats.totalSessions, totalPnl: globalStats.totalPnl, positions: positionsRes
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test_fast', async (req, res) => {
    if(currentOpenPosition) return res.send('⚠️ Lỗi: Đang có lệnh mở, không thể Test.');
    try {
        if (!exchangeInfoCache) await getExchangeInfo(); 
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        let candidates = getTargetFundingCoins(allFunding, null, 1);
        
        const best = candidates[0];
        if(!best) return res.send(`⚠️ Không tìm thấy Coin nào âm để Test.`);

        addLog(`🧪 Kích hoạt TEST NHANH ${best.symbol}...`);

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        let leverage = await getLeverageBracketForSymbol(best.symbol);
        
        await setLeverage(best.symbol, leverage);
        await aggressiveCleanup(best.symbol);

        const symbolInfo = exchangeInfoCache[best.symbol];
        const currentPrice = await getCurrentPrice(best.symbol);
        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
        
        let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);

        botRunning = true; 
        botStartTime = botStartTime || new Date();
        saveStateToFile();
        
        addLog(`>>> [TEST NHANH] Mở Long Buffer...`);
        openLongPreFunding(best.symbol, leverage, balance, true).catch(e=>{});
        
        let simDelay = userConfig.longOffsetMs || 1500; 
        if (simDelay <= 0) simDelay = 1000; 

        setTimeout(() => {
            if (botRunning && !currentOpenPosition) {
                 addLog(`>>> [TEST NHANH] Kích hoạt Short thật sau ${simDelay}ms...`);
                 openShortPosition(best.symbol, quantity, best.nextFundingTime, true).catch(e=>{});
            }
        }, simDelay);

        res.send(`✅ Test Nhanh: Đã mở Long Buffer và chuẩn bị đánh Market Short sau đúng ${simDelay}ms`);
    } catch (e) {
        res.send('❌ Lỗi Test Nhanh: ' + e.message);
    }
});

app.get('/start_bot_logic', async (req, res) => { res.send(await startBotLogicInternal(req.query)); });
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.get('/api/config', (req, res) => res.json(userConfig));

app.listen(WEB_SERVER_PORT);
