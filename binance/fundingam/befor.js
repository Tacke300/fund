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
    amountValue: 40,       
    tpPercent: 5,        
    slPercent: 5,
    longOffsetMs: 1000, 
    shortOffsetMs: 222,
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
let leverageCache = {}; // Cache leverage toàn sàn để không bị rate limit
let botRunning = false;
let botStartTime = null; 

let currentMainPosition = null; // Thay cho currentOpenPosition
let currentBufferPosition = null; // Thay cho currentLongPosition

let mainCheckInterval = null; 
let bufferCheckInterval = null;
let nextScheduledTimeout = null; 
let scheduledBufferTimeout = null; 
let antiLiquidationInterval = null;

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

let globalStats = {
    totalSessions: 0,
    totalPnl: 0
};

// --- QUẢN LÝ LƯU & KHÔI PHỤC CACHE VỊ THẾ (PERSISTENCE) --- //
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
        console.error("Lỗi lưu position state:", e.message);
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
        console.error("Lỗi đọc position state:", e.message);
    }
}

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
    } catch (error) { console.error("Update Leverage Cache Error:", error.message); }
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

// --- TÍNH TOÁN MARGIN TỐI THIỂU & LÀM TRÒN SỐ LẺ --- //
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

// --- QUẢN LÝ LỆNH BUFFER (MỞ TRƯỚC FUNDING) --- //
async function openBufferPosition(symbol, leverage, balance, side, isTest = false) {
    addLog(`>>> Opening ${side} buffer for ${symbol}...`);
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
        
        addLog(`<span style="color: #00ffaa">✅ Opened ${side} buffer ${symbol}. Qty: ${quantity}</span>`);

        const slDistance = currentPrice * (userConfig.slPercent / 100);
        const slPrice = side === 'LONG' ? currentPrice - slDistance : currentPrice + slDistance;

        currentBufferPosition = { 
            symbol, side, quantity, entryPrice: currentPrice, slPrice, openTime: Date.now(), isTest 
        };
        saveStateToFile();
        
        if (bufferCheckInterval) clearInterval(bufferCheckInterval);
        bufferCheckInterval = setInterval(manageBufferPosition, 500);

    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error opening ${side} buffer: ${error.msg || error.message}</span>`);
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
            addLog(`⚡ Triggers Buffer SL (% theo Giá Entry)! Bot tự chốt Market...`);
            await closeBufferInternal('SL Hit', currentBufferPosition.isTest);
            isClosingBuffer = false;
        }
    } catch (e) { isClosingBuffer = false; }
}

async function closeBufferInternal(reason = 'Time', isTest = false) {
    if (!currentBufferPosition) return;
    const { symbol, quantity, side } = currentBufferPosition;
    const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
    
    currentBufferPosition = null; 
    saveStateToFile();
    if (bufferCheckInterval) { clearInterval(bufferCheckInterval); bufferCheckInterval = null; }

    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: orderSide, positionSide: side, type: 'MARKET', quantity: quantity
        });
        addLog(`<span style="color: #00ffaa">✅ Closed ${side} buffer (${reason}).</span>`);
        fetchAndLogRealizedPnL(symbol, side, isTest);
    } catch (error) {
        addLog(`<span style="color: #ffcc00">⚠️ Error closing Buffer: ${error.msg}</span>`);
    }
}

// --- QUẢN LÝ LỆNH MAIN (MỞ ĂN FUNDING/SAU FUNDING) --- //
let isClosingMain = false;
async function openMainPosition(symbol, quantity, nextFundingTime, side, isTest = false, estPnl = 0) {
    addLog(`🚀 EXECUTING MAIN ${side} ${symbol} (Qty: ${quantity})...`);
    closeBufferInternal('Chuyển giao Main', isTest); 
    
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
            addLog(`<span style="color: #ffcc00">⚠️ Position failed to open.</span>`);
            scheduleNextMainCycle();
            return;
        }

        const realEntryPrice = parseFloat(pos.entryPrice);
        const lev = parseInt(pos.leverage);
        const margin = (Math.abs(parseFloat(pos.positionAmt)) * realEntryPrice) / lev;
        
        // Log đầy đủ yêu cầu: coin, lev, margin, entry, pnl ước tính
        addLog(`<span style="color: #00ffaa">✅ MỞ LỆNH ${side} ${symbol} | Lev: ${lev} | Margin: ${margin.toFixed(2)}$ | Entry: ${realEntryPrice} | Est PnL: ${estPnl.toFixed(2)}%</span>`);

        currentMainPosition = { 
            symbol, side, quantity, openTime: Date.now(), entryPrice: realEntryPrice, extremePrice: realEntryPrice, nextFundingTime, isTest 
        };
        saveStateToFile();

        if (mainCheckInterval) clearInterval(mainCheckInterval);
        mainCheckInterval = setInterval(manageMainPosition, 400);

    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error opening MAIN ${side}: ${error.message || error.msg}</span>`);
        scheduleNextMainCycle();
    }
}

async function manageMainPosition() {
    if (!currentMainPosition || isClosingMain) return;
    const { symbol, side, entryPrice, nextFundingTime, isTest } = currentMainPosition;
    const isLong = side === 'LONG';

    if (!isTest && nextFundingTime && Date.now() >= nextFundingTime - (5 * 60 * 1000)) {
        isClosingMain = true;
        addLog(`⏳ Sắp tới mốc Funding tiếp theo. Đóng vị thế an toàn!`);
        await closeMainInternal('Pre-Funding Close', isTest);
        isClosingMain = false;
        return;
    }
    
    try {
        const currentPrice = await getCurrentPrice(symbol);
        if(!currentPrice) return;

        // CẬP NHẬT GIÁ SÂU NHẤT (Thấp nhất cho Short, Cao nhất cho Long)
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

        // % giá biến động có lợi sâu nhất so với giá Entry
        const maxGainPct = isLong ? 
            ((extremePrice - entryPrice) / entryPrice) * 100 : 
            ((entryPrice - extremePrice) / entryPrice) * 100;

        // SL cố định khi chưa vượt qua % TP
        const fixedSL = isLong ? 
            entryPrice - (entryPrice * (slPct / 100)) : 
            entryPrice + (entryPrice * (slPct / 100));

        let activeSL = fixedSL;
        let isSlPositive = false;

        // BẮT BUỘC: Chỉ khi giá đạt lợi nhuận cực đại vượt quá TP thì mới bật SL Dương (Trailing)
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

        // KHI BOT CHẠM SL SẼ ĐÓNG BẰNG MỌI GIÁ (Sửa lỗi không đóng market)
        if (triggerClose) {
            isClosingMain = true;
            const retracePct = Math.abs((currentPrice - extremePrice) / entryPrice * 100).toFixed(2);
            const slName = isSlPositive ? `Khớp TP/SL Dương (Giá hồi ${retracePct}% so với đỉnh/đáy)` : `Khớp SL Cắt Lỗ`;
            addLog(`⚡ Triggers MAIN ${slName} tại mốc ${activeSL.toFixed(4)} (Entry: ${entryPrice}, Giá Đỉnh/Đáy: ${extremePrice}, Live: ${currentPrice})`);
            await closeMainInternal(slName, isTest);
            isClosingMain = false;
            return;
        }
    } catch (error) { }
}

async function closeMainInternal(reason = 'manual', isTest = false) {
    if (!currentMainPosition) return;
    const { symbol, quantity, side } = currentMainPosition;
    const orderSide = side === 'LONG' ? 'SELL' : 'BUY';

    addLog(`>>> Closing MAIN ${side} ${symbol} (Lý do: ${reason})...`);
    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: orderSide, positionSide: side, type: 'MARKET', quantity: quantity
        });
        addLog(`<span style="color: #00ffaa">✅ Closed MAIN ${side} ${symbol}.</span>`);
        fetchAndLogRealizedPnL(symbol, side, isTest);
        cleanupAfterClose(symbol);
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Error closing MAIN: ${error.msg}</span>`);
    }
}

function cleanupAfterClose(symbol) {
    currentMainPosition = null;
    saveStateToFile();
    if (mainCheckInterval) { clearInterval(mainCheckInterval); mainCheckInterval = null; }
    setTimeout(async () => {
        await aggressiveCleanup(symbol);
        if (botRunning) scheduleNextMainCycle();
    }, DELAY_BEFORE_CANCEL_ORDERS_MS);
}

// --- TÌM KIẾM ĐỒNG COIN, LẤY CẢ FUNDING DƯƠNG VÀ ÂM, XẾP THEO PNL ƯỚC TÍNH --- //
function getTargetFundingCoins(allFunding, reqThreshold = null, limit = null) {
    const now = Date.now();
    let valid = allFunding.filter(item => 
        item.symbol.endsWith('USDT') && 
        exchangeInfoCache[item.symbol] && 
        item.nextFundingTime > now 
    );

    if (valid.length === 0) return [];

    // Tính toán Est PnL và lấy loại Funding
    valid.forEach(item => {
        const lev = getLeverageFromCache(item.symbol);
        const fdValue = parseFloat(item.lastFundingRate); // VD: 0.003
        // Công thức: 100 * lev * chỉ số funding %
        item.estPnl = 100 * lev * (Math.abs(fdValue) * 100); 
        item.fdType = fdValue >= 0 ? 'positive' : 'negative';
        item.lev = lev;
    });

    // Lọc theo Threshold nếu cần (chỉ số tuyệt đối >= threshold)
    if (reqThreshold !== null) {
        valid = valid.filter(item => (Math.abs(parseFloat(item.lastFundingRate)) * 100) >= reqThreshold);
    }

    // Sắp xếp theo PnL Ước Tính (estPnl) giảm dần
    valid.sort((a, b) => b.estPnl - a.estPnl);

    if (limit) {
        return valid.slice(0, limit);
    }
    return valid;
}

async function runTradingLogic() {
    if (!botRunning || currentMainPosition) return;
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
        const reqThreshold = userConfig.fundingThreshold; 

        let candidates = getTargetFundingCoins(allFunding, reqThreshold, null);

        if (candidates.length > 0) {
            const best = candidates[0];
            const timeLeftMin = (best.nextFundingTime - now) / 60000;
            
            if (timeLeftMin > 0 && timeLeftMin <= FUNDING_WINDOW_MINUTES) {
                const leverage = best.lev;
                const currentServerTime = Date.now() + serverTimeOffset;
                
                const longOffsetMs = userConfig.longOffsetMs || 1500;
                const shortOffsetMs = userConfig.shortOffsetMs || 0;

                const delayLong = best.nextFundingTime - longOffsetMs - currentServerTime;
                const delayShort = best.nextFundingTime - shortOffsetMs - currentServerTime;

                if (delayShort > 0 && delayShort <= ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000) {
                    addLog(`<span style="color: #00ffaa">✅ SELECTED TOP COIN: ${best.symbol} (FD: ${(parseFloat(best.lastFundingRate) * 100).toFixed(4)}% | Lev: ${leverage}x | Est PnL: ${best.estPnl.toFixed(2)}%)</span>`);
                    
                    const top10 = candidates.slice(0, 10).map(c => `${c.symbol}(${c.estPnl.toFixed(0)}%)`).join(', ');
                    addLog(`📊 Danh sách Top 10 PnL: ${top10}`);
                    
                    await setLeverage(best.symbol, leverage);
                    await aggressiveCleanup(best.symbol);

                    const symbolInfo = exchangeInfoCache[best.symbol];
                    const currentPrice = await getCurrentPrice(best.symbol);
                    
                    let initialMargin = userConfig.amountMode === 'percent' ? balance * (userConfig.amountValue / 100) : userConfig.amountValue;
                    let quantity = calculateValidQuantity(symbolInfo, currentPrice, initialMargin, leverage);

                    // XÁC ĐỊNH SIDE CHO BUFFER VÀ MAIN DỰA VÀO ÂM/DƯƠNG
                    const isNegative = best.fdType === 'negative';
                    const bufferSide = isNegative ? 'LONG' : 'SHORT';
                    const mainSide = isNegative ? 'SHORT' : 'LONG';

                    clearTimeout(scheduledBufferTimeout);
                    if (delayLong > 0) {
                        scheduledBufferTimeout = setTimeout(() => {
                            if (botRunning) openBufferPosition(best.symbol, leverage, balance, bufferSide, false).catch(e => {});
                        }, delayLong);
                    }

                    clearTimeout(nextScheduledTimeout);
                    if (delayShort > 0) {
                        nextScheduledTimeout = setTimeout(() => {
                            if (botRunning && !currentMainPosition) {
                                openMainPosition(best.symbol, quantity, best.nextFundingTime, mainSide, false, best.estPnl).catch(e => {});
                            }
                        }, delayShort);
                    }
                    
                    pauseUntilTime = best.nextFundingTime + 60000;
                    addLog(`⏳ Đã lên lịch vào lệnh. Tạm dừng update FD tới 01 phút sau Funding!`);
                    return; 
                }
            }
            
            const exactLongTrigger = best.nextFundingTime - (userConfig.longOffsetMs || 1500) - (Date.now() + serverTimeOffset);
            if (exactLongTrigger > (4 * 60 * 1000) && exactLongTrigger <= (5 * 60 * 1000)) {
                addLog(`🔮 [FORECAST] ${best.symbol} đang là Top 1. Sắp chuẩn bị vào Buffer sau ~5 phút...`);
            }
        }
        scheduleNextMainCycle();
    } catch (error) {
        addLog(`<span style="color: #ff4444">❌ Logic Error: ${error.message}</span>`);
        scheduleNextMainCycle();
    }
}

async function scheduleNextMainCycle() {
    if (!botRunning || currentMainPosition) return;
    clearTimeout(nextScheduledTimeout);
    nextScheduledTimeout = setTimeout(runTradingLogic, 5000);
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
                addLog('<span style="color: #ff4444">🚨 BÁO ĐỘNG: Ký quỹ khả dụng dưới 10%. KÍCH HOẠT CHỐNG THANH LÝ TOÀN BỘ SÀN!</span>');
                botRunning = false; // Ngừng bot ngay lập tức
                
                await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE'); // Hủy mọi order
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
                addLog('<span style="color: #ff4444">🛑 Đã ĐÓNG TOÀN BỘ vị thế trên tài khoản. Bot tự động TẮT để bảo toàn vốn.</span>');
            }
        } catch(e) {}
    }, 10000); // Check mỗi 10s
}

// --- TỰ ĐỘNG KHÔI PHỤC VỊ THẾ TỪ CACHE KHI KHỞI ĐỘNG VÀ F5 --- //
async function restoreActivePositionsOnStartup() {
    loadStateFromFile();
    if (!userConfig.apiKey || !userConfig.secretKey) return;
    try {
        await syncServerTime();
        await updateAllLeverageCache(); // Load cache lev
        await getExchangeInfo();
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        
        if (currentMainPosition) {
            const pos = positions.find(p => p.symbol === currentMainPosition.symbol && p.positionSide === currentMainPosition.side);
            if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) {
                addLog(`<span style="color: #00ffaa">🔄 [CACHE RESTORE] Tiếp tục quản lý MAIN ${currentMainPosition.side} ${currentMainPosition.symbol} (Entry: ${currentMainPosition.entryPrice})</span>`);
                botRunning = true;
                if (mainCheckInterval) clearInterval(mainCheckInterval);
                mainCheckInterval = setInterval(manageMainPosition, 400);
            } else {
                addLog(`⚠️ Vị thế MAIN ${currentMainPosition.symbol} đã đóng trên sàn. Xóa cache.`);
                currentMainPosition = null;
                saveStateToFile();
            }
        }

        if (currentBufferPosition) {
            const pos = positions.find(p => p.symbol === currentBufferPosition.symbol && p.positionSide === currentBufferPosition.side);
            if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) {
                addLog(`<span style="color: #00ffaa">🔄 [CACHE RESTORE] Tiếp tục quản lý BUFFER ${currentBufferPosition.side} ${currentBufferPosition.symbol}</span>`);
                botRunning = true;
                if (bufferCheckInterval) clearInterval(bufferCheckInterval);
                bufferCheckInterval = setInterval(manageBufferPosition, 500);
            } else {
                addLog(`⚠️ Vị thế BUFFER ${currentBufferPosition.symbol} đã đóng trên sàn. Xóa cache.`);
                currentBufferPosition = null;
                saveStateToFile();
            }
        }
        
        if (botRunning) {
            startAntiLiquidationMonitor();
        }
    } catch (e) {
        console.error("Restore position error:", e.message);
    }
}

// --- API ROUTES --- //
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
        await updateAllLeverageCache();
        await getExchangeInfo();
        botRunning = true; 
        botStartTime = new Date();
        saveStateToFile();
        startAntiLiquidationMonitor();
        scheduleNextMainCycle();
        return 'Bot Started Successfully.';
    } catch (e) { return 'Start Error: ' + e.message; }
}

function stopBotLogicInternal() {
    botRunning = false;
    clearTimeout(nextScheduledTimeout);
    clearTimeout(scheduledBufferTimeout);
    if(mainCheckInterval) clearInterval(mainCheckInterval);
    if(bufferCheckInterval) clearInterval(bufferCheckInterval);
    if(antiLiquidationInterval) clearInterval(antiLiquidationInterval);
    saveStateToFile();
    addLog('--- BOT STOPPED ---');
    return 'Bot Stopped.';
}

loadConfigFromFile();
loadStateFromFile();

const app = express();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => res.send(memoryLogs.join('\n')));
app.get('/api/status', (req, res) => res.send(botRunning ? `RUNNING (Uptime: ${botStartTime ? ((Date.now() - botStartTime)/60000).toFixed(1) : 0}m)` : 'STOPPED'));

app.get('/api/funding_rates', async (req, res) => {
    try {
        if (!exchangeInfoCache) await getExchangeInfo();
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        const reqThreshold = userConfig.fundingThreshold;
        let candidates = getTargetFundingCoins(allFunding, reqThreshold, 10);
        res.json(candidates);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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
            const posAmtAbs = Math.abs(posAmt);
            const entryPrice = parseFloat(p.entryPrice);
            const markPrice = parseFloat(p.markPrice);
            const lev = parseInt(p.leverage);
            const maxLev = getLeverageFromCache(p.symbol);
            const margin = (posAmtAbs * entryPrice) / lev;
            const pnl = parseFloat(p.unRealizedProfit);
            const roi = (pnl / margin) * 100;
            const isLong = p.positionSide === 'LONG';
            
            let deepest = markPrice;
            let estTp = 0;
            let openTime = Date.now();
            let isSlPositive = false;
            let retracePct = 0;
            let distToEntryPct = 0;
            let slPnl = 0;
            
            if (currentMainPosition && currentMainPosition.symbol === p.symbol && currentMainPosition.side === p.positionSide) {
                deepest = currentMainPosition.extremePrice || markPrice;
                openTime = currentMainPosition.openTime || Date.now();

                const maxGainPct = isLong ? 
                    ((deepest - entryPrice) / entryPrice) * 100 : 
                    ((entryPrice - deepest) / entryPrice) * 100;
                
                retracePct = Math.abs((markPrice - deepest) / entryPrice) * 100;
                distToEntryPct = Math.abs((markPrice - entryPrice) / entryPrice) * 100;

                if (maxGainPct >= userConfig.tpPercent) {
                    isSlPositive = true;
                    estTp = isLong ? 
                        deepest - (entryPrice * (userConfig.tpPercent / 100)) : 
                        deepest + (entryPrice * (userConfig.tpPercent / 100));
                } else {
                    isSlPositive = false;
                    estTp = isLong ? 
                        entryPrice - (entryPrice * (userConfig.slPercent / 100)) : 
                        entryPrice + (entryPrice * (userConfig.slPercent / 100));
                }

                slPnl = isLong ? (estTp - entryPrice) * posAmtAbs : (entryPrice - estTp) * posAmtAbs;

            } else if (currentBufferPosition && currentBufferPosition.symbol === p.symbol && currentBufferPosition.side === p.positionSide) {
                deepest = markPrice; 
                openTime = currentBufferPosition.openTime || Date.now();
                estTp = currentBufferPosition.slPrice || (isLong ? (entryPrice - (entryPrice * (userConfig.slPercent / 100))) : (entryPrice + (entryPrice * (userConfig.slPercent / 100))));
                isSlPositive = false;
                retracePct = 0;
                distToEntryPct = Math.abs((entryPrice - markPrice) / entryPrice) * 100;
                slPnl = isLong ? (estTp - entryPrice) * posAmtAbs : (entryPrice - estTp) * posAmtAbs;
            } else {
                openTime = Date.now();
                estTp = isLong ? entryPrice * 0.99 : entryPrice * 1.01;
                distToEntryPct = Math.abs(markPrice - entryPrice) / entryPrice * 100;
            }
            
            positionsRes.push({
                coin: p.symbol,
                side: p.positionSide,
                lev,
                maxLev,
                margin,
                pnl,
                roi,
                entryPrice,
                markPrice,
                deepest,
                distToEntry: distToEntryPct,
                retrace: retracePct,
                estTp,
                isSlPositive,
                slPnl,
                openTime
            });
        }
        
        res.json({
            running: true, balance, openOrders: openOrdersInfo.length, totalSessions: globalStats.totalSessions, totalPnl: globalStats.totalPnl, positions: positionsRes
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test_fast', async (req, res) => {
    if(currentMainPosition) return res.send('⚠️ Lỗi: Đang có lệnh mở, không thể Test.');
    try {
        if (!exchangeInfoCache) await getExchangeInfo(); 
        await updateAllLeverageCache();
        const allFunding = await callPublicAPI('/fapi/v1/premiumIndex');
        let candidates = getTargetFundingCoins(allFunding, null, 1);
        
        const best = candidates[0];
        if(!best) return res.send(`⚠️ Không tìm thấy Coin nào để Test.`);

        addLog(`🧪 Kích hoạt TEST NHANH ${best.symbol}...`);

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
        const bufferSide = isNegative ? 'LONG' : 'SHORT';
        const mainSide = isNegative ? 'SHORT' : 'LONG';

        addLog(`>>> [TEST NHANH] Mở Buffer ${bufferSide}...`);
        openBufferPosition(best.symbol, leverage, balance, bufferSide, true).catch(e=>{});
        
        let simDelay = userConfig.longOffsetMs || 1500; 
        if (simDelay <= 0) simDelay = 1000; 

        setTimeout(() => {
            if (botRunning && !currentMainPosition) {
                 addLog(`>>> [TEST NHANH] Kích hoạt Main ${mainSide} sau ${simDelay}ms...`);
                 openMainPosition(best.symbol, quantity, best.nextFundingTime, mainSide, true, best.estPnl).catch(e=>{});
            }
        }, simDelay);

        res.send(`✅ Test Nhanh: Đã mở ${bufferSide} Buffer và chuẩn bị đánh Market ${mainSide} sau đúng ${simDelay}ms`);
    } catch (e) {
        res.send('❌ Lỗi Test Nhanh: ' + e.message);
    }
});

app.get('/start_bot_logic', async (req, res) => { res.send(await startBotLogicInternal(req.query)); });
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.get('/api/config', (req, res) => res.json(userConfig));

app.listen(WEB_SERVER_PORT, () => {
    console.log(`Server listening on port ${WEB_SERVER_PORT}`);
    restoreActivePositionsOnStartup();
    setInterval(updateAllLeverageCache, 3600000); // 1 tiếng cập nhật leverage 1 lần
});
