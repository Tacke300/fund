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

// Cấu hình ngầm định để tính toán phần trăm ký quỹ và cắt lỗ dựa trên Tổng Vốn (theo User Correction)
const LONG_SL_CAPITAL_PERCENT = 5; 
const TARGET_SYMBOL = 'NEIROUSDT'; 

let userConfig = {
    apiKey: DEFAULT_API_KEY,
    secretKey: DEFAULT_SECRET_KEY,
    amountMode: 'percent', 
    amountValue: 25,       
    tpPercent: 5,        
    slPercent: 5,
    longOffsetMs: 1500, 
    shortOffsetMs: 0,
    fundingThreshold: 0.3 
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
let botRunning = false;
let botStartTime = null; 

let currentOpenPosition = null; 
let currentLongPosition = null; 

let shortCheckInterval = null; 
let longCheckInterval = null;
let nextScheduledTimeout = null; 
let scheduledLongTimeout = null; 

let consecutiveApiErrors = 0; 
const MAX_CONSECUTIVE_API_ERRORS = 5; 
const memoryLogs = [];
const MAX_LOG_SIZE = 1000; 
const logCounts = {}; 
const LOG_COOLDOWN_MS = 5000; 

const FUNDING_WINDOW_MINUTES = 3; 
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 60; 
const DELAY_BEFORE_CANCEL_ORDERS_MS = 3 * 60 * 1000; 
const WEB_SERVER_PORT = 9999; 

let globalStats = {
    totalOrders: 0,
    totalPnl: 0
};

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
            if (s.status !== 'TRADING') return; 
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
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol, side: side, positionSide: pos.positionSide, type: 'MARKET', quantity: Math.abs(amt)
                });
                globalStats.totalOrders++;
            }
        }
        addLog(`<span style="color: #00ffaa">✅ ${symbol} Cleaned. Ready.</span>`);
    } catch (e) {}
}

function fetchAndLogRealizedPnL(symbol, positionSide) {
    const closeTime = Date.now();
    // Chờ 10 giây gom toàn bộ PnL thực tế của từng chunk chia nhỏ
    setTimeout(async () => {
        try {
            const trades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol, limit: 30 });
            const closeTrades = trades.filter(t => 
                t.time >= closeTime - 12000 && 
                t.realizedPnl !== "0" && 
                t.positionSide === positionSide
            );
            const totalPnl = closeTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            globalStats.totalPnl += totalPnl;
            addLog(`💰 [PnL Khớp ${positionSide}] Tổng lãi/lỗ thực tế: ${totalPnl.toFixed(4)} USDT`);
        } catch (e) {
            addLog(`⚠️ Lỗi lấy PnL: ${e.message}`);
        }
    }, 10000); 
}


// --- QUẢN LÝ LONG ĐỘC LẬP --- //
async function openLongPreFunding(symbol, maxLeverage, availableBalance) {
    addLog(`>>> Opening LONG buffer for ${symbol}...`);
    try {
        const symbolInfo = exchangeInfoCache[symbol];
        const currentPrice = await getCurrentPrice(symbol);
        
        let initialMargin = userConfig.amountMode === 'percent' 
            ? availableBalance * (userConfig.amountValue / 100) 
            : userConfig.amountValue;
            
        let quantity = (initialMargin * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: quantity
        });
        globalStats.totalOrders++;
        addLog(`<span style="color: #00ffaa">✅ Opened LONG buffer ${symbol}. Qty: ${quantity}</span>`);

        // Tính SL theo % Tổng Vốn 
        const maxLoss = availableBalance * (LONG_SL_CAPITAL_PERCENT / 100);
        const slPrice = currentPrice - (maxLoss / quantity);

        currentLongPosition = { 
            symbol, quantity, entryPrice: currentPrice, slPrice, openTime: Date.now() 
        };
        
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
            addLog(`⚡ Triggers Long SL (5% Tài khoản)! Bot tự chốt Market...`);
            await closeLongInternal('SL Hit');
            isClosingLong = false;
        }
    } catch (e) { isClosingLong = false; }
}

async function closeLongInternal(reason = 'Time') {
    if (!currentLongPosition) return;
    const { symbol, quantity } = currentLongPosition;
    currentLongPosition = null; 
    if (longCheckInterval) { clearInterval(longCheckInterval); longCheckInterval = null; }

    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: quantity
        });
        globalStats.totalOrders++;
        addLog(`<span style="color: #00ffaa">✅ Closed LONG buffer (${reason}).</span>`);
        fetchAndLogRealizedPnL(symbol, 'LONG');
    } catch (error) {
        addLog(`<span style="color: #ffcc00">⚠️ Error closing Long: ${error.msg}</span>`);
    }
}


// --- QUẢN LÝ SHORT ĐỘC LẬP --- //
let isClosingShort = false;
async function openShortPosition(symbol, quantity, nextFundingTime) {
    addLog(`🚀 EXECUTING SHORT ${symbol} (Qty: ${quantity})...`);
    closeLongInternal('Chuyển giao Short'); // Đóng Long không gây block
    
    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'SELL', positionSide: 'SHORT', type: 'MARKET', quantity: quantity
        });
        globalStats.totalOrders++;
        
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
            symbol, quantity, openTime: Date.now(), entryPrice: realEntryPrice, lowestPrice: realEntryPrice, nextFundingTime 
        };

        if (shortCheckInterval) clearInterval(shortCheckInterval);
        shortCheckInterval = setInterval(manageShortPosition, 400);

    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error opening SHORT: ${error.message || error.msg}</span>`);
        scheduleNextMainCycle();
    }
}

async function manageShortPosition() {
    if (!currentOpenPosition || isClosingShort) return;
    const { symbol, quantity, entryPrice, nextFundingTime } = currentOpenPosition;

    // ĐÓNG TRƯỚC FUNDING 5 PHÚT
    if (nextFundingTime && Date.now() >= nextFundingTime - (5 * 60 * 1000)) {
        isClosingShort = true;
        addLog(`⏳ Sắp tới mốc Funding tiếp theo. Đóng vị thế an toàn!`);
        await closeShortInternal('Pre-Funding Close');
        isClosingShort = false;
        return;
    }
    
    try {
        const currentPrice = await getCurrentPrice(symbol);
        if(!currentPrice) return;

        if (currentPrice < currentOpenPosition.lowestPrice) {
            currentOpenPosition.lowestPrice = currentPrice;
        }

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        // Tính SL TP hoàn toàn bằng % trên Vốn Tài Khoản
        const tpTargetUsdt = balance * (userConfig.tpPercent / 100);
        const slTargetUsdt = balance * (userConfig.slPercent / 100);
        const tpDistance = tpTargetUsdt / quantity;
        const slDistance = slTargetUsdt / quantity;

        let dynamicSL;
        if (currentOpenPosition.lowestPrice <= entryPrice - tpDistance) {
            const trailingSL = currentOpenPosition.lowestPrice + tpDistance;
            dynamicSL = Math.min(trailingSL, entryPrice - (entryPrice * 0.002)); // Đã lãi thì bảo toàn nhẹ
        } else {
            dynamicSL = entryPrice + slDistance;
        }
        
        currentOpenPosition.dynamicSL = dynamicSL; // Phục vụ cho UI hiển thị

        if (currentPrice >= dynamicSL) {
            isClosingShort = true;
            addLog(`⚡ Triggers SHORT Chốt (Market Price chạm mốc ${dynamicSL.toFixed(4)})`);
            await closeShortInternal('Dynamic Trailing/SL');
            isClosingShort = false;
            return;
        }

        if (Math.random() < 0.1) { 
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const pos = positions.find(p => p.symbol === symbol && p.positionSide === 'SHORT');
            if (!pos || parseFloat(pos.positionAmt) === 0) {
                addLog(`<span style="color: #00ffaa">✅ Position ${symbol} closed externally.</span>`);
                cleanupAfterClose(symbol);
            }
        }
    } catch (error) { }
}

async function closeShortInternal(reason = 'manual') {
    if (!currentOpenPosition) return;
    const { symbol, quantity } = currentOpenPosition;
    addLog(`>>> Closing SHORT ${symbol} (${reason})...`);
    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: 'BUY', positionSide: 'SHORT', type: 'MARKET', quantity: quantity
        });
        globalStats.totalOrders++;
        addLog(`<span style="color: #00ffaa">✅ Closed SHORT ${symbol}.</span>`);
        fetchAndLogRealizedPnL(symbol, 'SHORT');
        cleanupAfterClose(symbol);
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error closing SHORT: ${error.msg}</span>`);
    }
}

function cleanupAfterClose(symbol) {
    currentOpenPosition = null;
    if (shortCheckInterval) { clearInterval(shortCheckInterval); shortCheckInterval = null; }
    setTimeout(async () => {
        await aggressiveCleanup(symbol);
        if (botRunning) scheduleNextMainCycle();
    }, DELAY_BEFORE_CANCEL_ORDERS_MS);
}


// --- MAIN LOGIC --- //
async function runTradingLogic() {
    if (!botRunning || currentOpenPosition) return;
    try {
        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        const now = Date.now();
        
        // Quét độc lập 1 coin theo cấu hình thay vì quét mảng
        const best = allFunding.find(item => item.symbol === TARGET_SYMBOL);
        
        if (best && exchangeInfoCache[best.symbol]) {
            const fr = parseFloat(best.lastFundingRate);
            const reqThreshold = -(userConfig.fundingThreshold / 100);

            if (fr <= reqThreshold) {
                const timeLeftMin = (best.nextFundingTime - now) / 60000;
                
                if (timeLeftMin > 0 && timeLeftMin <= FUNDING_WINDOW_MINUTES) {
                    const leverage = await getLeverageBracketForSymbol(best.symbol);
                    const currentServerTime = Date.now() + serverTimeOffset;
                    
                    const longOffsetMs = userConfig.longOffsetMs || 1500;
                    const shortOffsetMs = userConfig.shortOffsetMs || 0;

                    const delayLong = best.nextFundingTime - longOffsetMs - currentServerTime;
                    const delayShort = best.nextFundingTime - shortOffsetMs - currentServerTime;

                    if (delayShort > 0 && delayShort <= ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000) {
                        addLog(`<span style="color: #00ffaa">✅ SELECTED: ${best.symbol} (FR: ${(fr * 100).toFixed(4)}%)</span>`);
                        
                        await setLeverage(best.symbol, leverage);
                        await aggressiveCleanup(best.symbol);

                        const symbolInfo = exchangeInfoCache[best.symbol];
                        const currentPrice = await getCurrentPrice(best.symbol);
                        
                        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
                        let quantity = (initialMargin * leverage) / currentPrice;
                        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

                        clearTimeout(scheduledLongTimeout);
                        if (delayLong > 0) {
                            scheduledLongTimeout = setTimeout(() => {
                                if (botRunning) openLongPreFunding(best.symbol, leverage, balance).catch(e => {});
                            }, delayLong);
                        }

                        clearTimeout(nextScheduledTimeout);
                        if (delayShort > 0) {
                            nextScheduledTimeout = setTimeout(() => {
                                if (botRunning && !currentOpenPosition) {
                                    openShortPosition(best.symbol, quantity, best.nextFundingTime).catch(e => {});
                                }
                            }, delayShort);
                        }
                        return; // Successfully scheduled
                    }
                }
                
                // Log báo hiệu 5 phút trước nếu chạm điều kiện
                const exactLongTrigger = best.nextFundingTime - (userConfig.longOffsetMs || 1500) - currentServerTime;
                if (exactLongTrigger > (4 * 60 * 1000) && exactLongTrigger <= (5 * 60 * 1000)) {
                    addLog(`🔮 [FORECAST] ${best.symbol} thoả mãn FR. Chuẩn bị Long sau ~5 phút...`);
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
    const now = Date.now();
    const min = new Date(now).getUTCMinutes();
    let delayMs = ((59 - min + (min >= 59 ? 60 : 0)) * 60 * 1000) - (now % 60000) - 500; 
    if (delayMs < 1000) delayMs = 1000;
    nextScheduledTimeout = setTimeout(runTradingLogic, delayMs);
}


// --- API XỬ LÝ KHỞI ĐỘNG BOT VÀ ROUTER --- //
async function startBotLogicInternal(query) {
    if (botRunning) return 'Bot is already running.';
    let isUpdated = false;
    
    if (query.apiKey && query.apiKey.trim() !== '') { userConfig.apiKey = query.apiKey.trim(); isUpdated = true; }
    if (query.secret && query.secret.trim() !== '') { userConfig.secretKey = query.secret.trim(); isUpdated = true; }
    if (query.amountMode) { userConfig.amountMode = query.amountMode; isUpdated = true; }
    if (query.amountVal) { userConfig.amountValue = parseFloat(query.amountVal); isUpdated = true; }
    if (query.tp) { userConfig.tpPercent = parseFloat(query.tp); isUpdated = true; } else if (!userConfig.tpPercent) { userConfig.tpPercent = 5; }
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
    addLog('--- BOT STOPPED ---');
    return 'Bot Stopped.';
}

loadConfigFromFile();

const app = express();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => res.send(memoryLogs.join('\n')));
app.get('/api/status', (req, res) => res.send(botRunning ? `RUNNING (Uptime: ${botStartTime ? ((Date.now() - botStartTime)/60000).toFixed(1) : 0}m)` : 'STOPPED'));

app.get('/api/funding_rates', async (req, res) => {
    try {
        if (!exchangeInfoCache) await getExchangeInfo();
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        const target = allFunding.find(item => item.symbol === TARGET_SYMBOL && exchangeInfoCache[item.symbol]);
        res.json(target ? [target] : []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API Thống kê chuyên sâu
app.get('/api/dashboard', async (req, res) => {
    if (!botRunning) return res.json({ running: false });
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
                deepest = currentOpenPosition.lowestPrice;
                estTp = currentOpenPosition.dynamicSL || 0;
                openTime = currentOpenPosition.openTime;
            } else if (p.positionSide === 'LONG' && currentLongPosition && currentLongPosition.symbol === p.symbol) {
                deepest = markPrice; 
                estTp = currentLongPosition.slPrice;
                openTime = currentLongPosition.openTime;
            }
            
            const distToEntry = Math.abs(markPrice - entryPrice) / entryPrice * 100;
            const retrace = Math.abs(markPrice - deepest) / deepest * 100;
            
            positionsRes.push({
                coin: p.symbol, side: p.positionSide, lev, margin, pnl, roi, deepest, distToEntry, retrace, estTp, openTime
            });
        }
        
        res.json({
            running: true, balance, openOrders: openOrdersInfo.length, totalOrders: globalStats.totalOrders, totalPnl: globalStats.totalPnl, positions: positionsRes
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/test_fast', async (req, res) => {
    if(currentOpenPosition) return res.send('⚠️ Lỗi: Đang có lệnh mở, không thể Test.');
    try {
        addLog(`🧪 Kích hoạt TEST NHANH ${TARGET_SYMBOL}...`);
        if (!exchangeInfoCache) await getExchangeInfo(); 
        
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        const best = allFunding.find(item => item.symbol === TARGET_SYMBOL);
        if(!best) return res.send(`⚠️ Không tìm thấy ${TARGET_SYMBOL}.`);

        const acc = await callSignedAPI('/fapi/v2/account', 'GET');
        const balance = parseFloat(acc.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        let leverage = await getLeverageBracketForSymbol(best.symbol);
        
        await setLeverage(best.symbol, leverage);
        await aggressiveCleanup(best.symbol);

        const symbolInfo = exchangeInfoCache[best.symbol];
        const currentPrice = await getCurrentPrice(best.symbol);
        let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
        
        let quantity = (initialMargin * leverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        botRunning = true; 
        
        addLog(`>>> [TEST NHANH] Mở Long Buffer...`);
        openLongPreFunding(best.symbol, leverage, balance).catch(e=>{});
        
        let simDelay = (userConfig.longOffsetMs || 1500) - (userConfig.shortOffsetMs || 0);
        if (simDelay <= 0) simDelay = 1000; 

        setTimeout(() => {
            if (botRunning && !currentOpenPosition) {
                 addLog(`>>> [TEST NHANH] Kích hoạt Short thật...`);
                 openShortPosition(best.symbol, quantity, best.nextFundingTime).catch(e=>{});
            }
        }, simDelay);

        res.send(`✅ Test Nhanh: Đã mở Long Buffer và chuẩn bị đánh Market Short sau ${simDelay}ms`);
    } catch (e) {
        res.send('❌ Lỗi Test Nhanh: ' + e.message);
    }
});

app.get('/start_bot_logic', async (req, res) => { res.send(await startBotLogicInternal(req.query)); });
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.listen(WEB_SERVER_PORT);
