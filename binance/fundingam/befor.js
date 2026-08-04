import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import http from 'http';
import https from 'https';

// Cấu hình Header chống WAF/Rate limit và Keep-Alive của Binance
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] = 'application/json';
axios.defaults.headers.common['Cache-Control'] = 'no-cache';
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });
axios.defaults.timeout = 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(__dirname));

let apiKey = '';
let secretKey = '';

let IS_RUNNING = false;
let globalStats = { totalPnl: 0, totalSessions: 0 };
let currentMainPosition = null;
let currentBufferPosition = null; 

let fundingThreshold = 0.3;
let amountMode = 'percent'; 
let amountValue = 25; 
let longOffsetMs = 1500;
let shortOffsetMs = 0;
let tpPercent = 1;
let slPercent = 2;

let nextFundingTimeGlobal = null;
let exchangeInfoCache = {};
const EXCHANGE_INFO_PATH = path.join(__dirname, 'exchangeInfoCache.json');

let memoryLogs = [];
const MAX_LOG_SIZE = 150;
let logCounts = {};
const LOG_COOLDOWN_MS = 10000;

// Cơ chế quản lý Backoff chống lỗi 418/429
let isApiBlocked = false;
let blockedUntil = 0;
let backoff418Count = 0;
let backoff429Count = 0;

function checkApiBlocked() {
    if (isApiBlocked) {
        if (Date.now() > blockedUntil) {
            isApiBlocked = false;
            logBot('INFO', 'SYSTEM', '🔄 Đã hết thời gian chờ xả Rate Limit. Tiếp tục gọi API.');
            return false;
        }
        return true;
    }
    return false;
}

function triggerApiBackoff(status) {
    if (!isApiBlocked) {
        isApiBlocked = true;
        let seconds = 60;
        if (status === 418) {
            backoff418Count++;
            seconds = backoff418Count === 1 ? 60 : (backoff418Count === 2 ? 120 : 300);
        } else if (status === 429) {
            backoff429Count++;
            seconds = backoff429Count === 1 ? 15 : (backoff429Count === 2 ? 30 : 60);
        }
        blockedUntil = Date.now() + (seconds * 1000);
        logBot('WARN', 'API', `⚠ Binance trả về lỗi HTTP ${status} (Rate Limit / WAF Block). Tạm dừng toàn bộ API trong ${seconds}s để tránh bị khóa IP...`);
    }
}

// Request Scheduler Queue (Giới hạn 9 request/giây, ưu tiên lệnh)
class RequestScheduler {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.tokens = 9; 
        setInterval(() => { this.tokens = 9; this.processQueue(); }, 1000);
    }
    add(reqFn, priority = 0) {
        return new Promise((resolve, reject) => {
            this.queue.push({ reqFn, resolve, reject, priority });
            this.queue.sort((a, b) => b.priority - a.priority);
            this.processQueue();
        });
    }
    async processQueue() {
        if (this.processing) return;
        this.processing = true;
        while (this.queue.length > 0 && this.tokens > 0) {
            this.tokens--;
            const item = this.queue.shift();
            try {
                const result = await item.reqFn();
                item.resolve(result);
            } catch (err) {
                item.reject(err);
            }
        }
        this.processing = false;
    }
}
const scheduler = new RequestScheduler();

// Cache Hệ Thống API
const memoryCache = {
    account: { data: null, ts: 0 },
    positionRisk: { data: null, ts: 0 },
    openOrders: { data: null, ts: 0 },
    premiumIndex: { data: [], ts: 0 }
};

// WebSocket Streaming Giá
let wsPrices = {};
let wsConnection = null;

function initWebSocket() {
    if (wsConnection) {
        try { wsConnection.terminate(); } catch (e) {}
    }
    wsConnection = new WebSocket('wss://fstream.binance.com/ws/!markPrice@arr@1s');
    wsConnection.on('open', () => {
        logBot('INFO', 'WS', '🔗 Đã kết nối WebSocket Binance thành công (!markPrice@arr@1s)');
    });
    wsConnection.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    wsPrices[item.s] = parseFloat(item.p);
                }
            }
        } catch (e) {}
    });
    wsConnection.on('close', () => {
        logBot('WARN', 'WS', '⚠ WebSocket đóng. Đang kết nối lại sau 3s...');
        setTimeout(initWebSocket, 3000);
    });
    wsConnection.on('error', (err) => {
        logBot('ERROR', 'WS', `✖ Lỗi WebSocket: ${err.message}`);
    });
}

async function getLatestPrice(symbol) {
    if (wsPrices[symbol]) return wsPrices[symbol];
    const res = await scheduler.add(() => axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`), 2);
    return parseFloat(res.data.price);
}

function formatLogNum(num, dec = 6) {
    if (!num || isNaN(num)) return '0';
    let str = Number(num).toFixed(dec);
    if (str.includes('.')) {
        str = str.replace(/0+$/, '').replace(/\.$/, '');
    }
    return str;
}

function logBot(level, moduleName, linesObj) {
    const now = new Date();
    const utc7 = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    const day = String(utc7.getUTCDate()).padStart(2, '0');
    const month = String(utc7.getUTCMonth() + 1).padStart(2, '0');
    const hours = String(utc7.getUTCHours()).padStart(2, '0');
    const minutes = String(utc7.getUTCMinutes()).padStart(2, '0');
    const seconds = String(utc7.getUTCSeconds()).padStart(2, '0');
    const ms = String(utc7.getUTCMilliseconds()).padStart(3, '0');
    const timeStr = `${day}/${month} ${hours}:${minutes}:${seconds}.${ms}`;

    const levelPad = level.padEnd(7, ' ');
    const modulePad = moduleName.padEnd(8, ' ');
    const header = `[${timeStr}] [${levelPad}] [${modulePad}]`;

    let content = '';
    if (typeof linesObj === 'string') {
        content = linesObj;
    } else if (Array.isArray(linesObj)) {
        content = linesObj.join('\n');
    }

    const fullLog = content.includes('\n') ? `${header}\n${content}` : `${header} ${content}`;

    const plainTextMsg = fullLog;
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

    console.log(`[${timeStr}] [${levelPad}] [${modulePad}] ${content.split('\n')[0]}`);
    if (content.includes('\n')) {
         console.log(content.split('\n').slice(1).join('\n'));
    }

    memoryLogs.push(fullLog);
    if (memoryLogs.length > MAX_LOG_SIZE) memoryLogs.shift();
}

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadStateFromFile() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            if(data.globalStats) globalStats = data.globalStats;
            if(data.apiKey) apiKey = data.apiKey;
            if(data.secretKey) secretKey = data.secretKey;
            
            if(data.fundingThreshold !== undefined) fundingThreshold = data.fundingThreshold;
            if(data.amountMode) amountMode = data.amountMode;
            if(data.amountValue !== undefined) amountValue = data.amountValue;
            if(data.longOffsetMs !== undefined) longOffsetMs = data.longOffsetMs;
            if(data.shortOffsetMs !== undefined) shortOffsetMs = data.shortOffsetMs;
            if(data.tpPercent !== undefined) tpPercent = data.tpPercent;
            if(data.slPercent !== undefined) slPercent = data.slPercent;
            
            if(data.currentMainPosition) {
                currentMainPosition = data.currentMainPosition;
                logBot('INFO', 'SYSTEM', `▶ [CACHE RESTORE] Khôi phục lệnh MAIN ${currentMainPosition.side} ${currentMainPosition.symbol}`);
                monitorMainPosition(); 
            }
            if(data.currentBufferPosition) {
                currentBufferPosition = data.currentBufferPosition;
                logBot('INFO', 'SYSTEM', `▶ [CACHE RESTORE] Khôi phục lệnh BUFFER ${currentBufferPosition.side} ${currentBufferPosition.symbol}`);
                monitorBufferPosition();
            }
        }
    } catch (e) {
        logBot('WARN', 'SYSTEM', `⚠ Không thể đọc file config: ${e.message}`);
    }
}

function loadExchangeInfoCache() {
    try {
        if (fs.existsSync(EXCHANGE_INFO_PATH)) {
            exchangeInfoCache = JSON.parse(fs.readFileSync(EXCHANGE_INFO_PATH, 'utf8'));
            logBot('INFO', 'SYSTEM', 'Đã tải ExchangeInfo & LeverageBracket từ file cache');
        }
    } catch (e) { }
}

function saveStateToFile() {
    try {
        const dataToSave = {
            globalStats, apiKey, secretKey,
            fundingThreshold, amountMode, amountValue, 
            longOffsetMs, shortOffsetMs, tpPercent, slPercent,
            currentMainPosition, currentBufferPosition
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(dataToSave, null, 2));
    } catch (e) {
        logBot('ERROR', 'SYSTEM', `✖ Lỗi lưu file config: ${e.message}`);
    }
}

function getBinanceSignature(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function callSignedAPI(endpoint, method = 'GET', data = {}, priority = 1) {
    if (checkApiBlocked()) throw new Error("API đang bị tạm dừng do Rate Limit (418/429)");
    if (!apiKey || !secretKey) throw new Error("Chưa có API Key!");
    
    return scheduler.add(async () => {
        data.timestamp = Date.now();
        data.recvWindow = 50000;
        const queryString = new URLSearchParams(data).toString();
        const signature = getBinanceSignature(queryString, secretKey);
        const url = `https://fapi.binance.com${endpoint}?${queryString}&signature=${signature}`;
        
        try {
            const response = await axios({
                method: method,
                url: url,
                headers: { 
                    'X-MBX-APIKEY': apiKey
                }
            });
            backoff418Count = 0;
            backoff429Count = 0;
            return response.data;
        } catch (e) {
            if (e.response?.status === 418 || e.response?.status === 429) {
                triggerApiBackoff(e.response.status);
            }
            throw e;
        }
    }, priority);
}

// Caching Functions
async function getCachedAccount(priority = 1) {
    const now = Date.now();
    if (memoryCache.account.data && (now - memoryCache.account.ts < 5000)) {
        return memoryCache.account.data;
    }
    const data = await callSignedAPI('/fapi/v2/account', 'GET', {}, priority);
    memoryCache.account.data = data;
    memoryCache.account.ts = Date.now();
    return data;
}

async function getCachedPositionRisk(symbol = null, priority = 1) {
    const now = Date.now();
    if (memoryCache.positionRisk.data && (now - memoryCache.positionRisk.ts < 5000)) {
        if (symbol) return memoryCache.positionRisk.data.filter(p => p.symbol === symbol);
        return memoryCache.positionRisk.data;
    }
    const params = symbol ? { symbol } : {};
    const data = await callSignedAPI('/fapi/v2/positionRisk', 'GET', params, priority);
    if (!symbol) {
        memoryCache.positionRisk.data = data;
        memoryCache.positionRisk.ts = Date.now();
    }
    return data;
}

async function getCachedOpenOrders(priority = 1) {
    const now = Date.now();
    if (memoryCache.openOrders.data && (now - memoryCache.openOrders.ts < 5000)) {
        return memoryCache.openOrders.data;
    }
    const data = await callSignedAPI('/fapi/v1/openOrders', 'GET', {}, priority);
    memoryCache.openOrders.data = data;
    memoryCache.openOrders.ts = Date.now();
    return data;
}

async function fetchExchangeInfo() {
    if (checkApiBlocked()) return;
    try {
        const res = await scheduler.add(() => axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo'), 1);
        res.data.symbols.forEach(sym => {
            if (sym.status === 'TRADING' && sym.contractType === 'PERPETUAL') {
                const stepSizeFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
                const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
                if (!exchangeInfoCache[sym.symbol]) exchangeInfoCache[sym.symbol] = {};
                exchangeInfoCache[sym.symbol].qtyStep = stepSizeFilter ? stepSizeFilter.stepSize : '1';
                exchangeInfoCache[sym.symbol].priceStep = priceFilter ? priceFilter.tickSize : '0.1';
            }
        });
        fs.writeFileSync(EXCHANGE_INFO_PATH, JSON.stringify(exchangeInfoCache, null, 2));
        backoff418Count = 0; backoff429Count = 0;
    } catch (e) {
        if (e.response?.status === 418 || e.response?.status === 429) {
            triggerApiBackoff(e.response.status);
        }
        logBot('ERROR', 'API', `✖ Không thể tải ExchangeInfo: ${e.message}`);
    }
}

let hasFetchedLeverageBracket = false;
async function fetchMaxLeverageBrackets() {
    if (hasFetchedLeverageBracket) return;
    try {
        const data = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', {}, 1);
        data.forEach(item => {
            if (exchangeInfoCache[item.symbol]) {
                exchangeInfoCache[item.symbol].maxLeverage = item.brackets[0].initialLeverage;
            }
        });
        fs.writeFileSync(EXCHANGE_INFO_PATH, JSON.stringify(exchangeInfoCache, null, 2));
        hasFetchedLeverageBracket = true;
    } catch (e) { }
}

function getLeverageFromCache(symbol) {
    if (!exchangeInfoCache[symbol]) return 1;
    let maxLev = exchangeInfoCache[symbol].maxLeverage || 20; 
    if (maxLev >= 75) return 75; 
    if (maxLev >= 50) return 50;
    return maxLev;
}

function roundQty(qtyStr, stepSizeStr) {
    const qty = parseFloat(qtyStr);
    const stepSize = parseFloat(stepSizeStr);
    if (!stepSize || isNaN(stepSize)) return String(qty);
    const stepDecimals = stepSizeStr.indexOf('.') !== -1 ? stepSizeStr.split('.')[1].length : 0;
    const rounded = Math.floor(qty / stepSize) * stepSize;
    return rounded.toFixed(stepDecimals);
}

function getTargetFundingCoins(allFunding, reqThreshold = null, limit = null) {
    const now = Date.now();
    let valid = allFunding.filter(item => 
        item.symbol.endsWith('USDT') && 
        exchangeInfoCache[item.symbol] && 
        item.nextFundingTime > now
    );

    valid.forEach(item => {
        const lev = getLeverageFromCache(item.symbol);
        const fdValue = parseFloat(item.lastFundingRate);
        item.estPnl = lev * (Math.abs(fdValue) * 100);
        item.fdType = fdValue >= 0 ? 'positive' : 'negative';
        item.lev = lev;
    });

    if (reqThreshold !== null) {
        valid = valid.filter(item => (Math.abs(parseFloat(item.lastFundingRate)) * 100) >= reqThreshold);
    }

    valid.sort((a, b) => {
        const timeA = Math.floor(a.nextFundingTime / 60000);
        const timeB = Math.floor(b.nextFundingTime / 60000);
        if (timeA !== timeB) return timeA - timeB; 
        return Math.abs(parseFloat(b.lastFundingRate)) - Math.abs(parseFloat(a.lastFundingRate));
    });

    if (limit) return valid.slice(0, limit);
    return valid;
}

async function closeAllPositionsAndOrders(symbol) {
    try {
        logBot('INFO', 'CLEANUP', `🧹 Bắt đầu dọn môi trường\nCoin: ${symbol}\n🧹 Hủy toàn bộ lệnh chờ\n🧹 Đóng toàn bộ vị thế`);
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol }, 3);
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol }, 3);
        for (const p of positions) {
            const amt = parseFloat(p.positionAmt);
            if (amt !== 0) {
                const side = amt > 0 ? 'SELL' : 'BUY';
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: p.symbol, side: side, type: 'MARKET', quantity: Math.abs(amt)
                }, 3);
            }
        }
        await callSignedAPI('/fapi/v1/marginType', 'POST', { symbol, marginType: 'ISOLATED' }, 3).catch(() => {});
        logBot('SUCCESS', 'CLEANUP', `✓ Môi trường đã sẵn sàng\nCoin: ${symbol}`);
    } catch (e) {
        logBot('ERROR', 'CLEANUP', `✖ Lỗi dọn dẹp ${symbol}: ${e.message}`);
    }
}

async function setLeverage(symbol, lev) {
    try {
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage: lev }, 3);
    } catch (e) { }
}

async function openBufferPosition(symbol, side, marginTarget, leverage, fdRateValue, isTest = false) {
    try {
        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
        const currentPrice = await getLatestPrice(symbol);
        
        const rawQty = (marginTarget * leverage) / currentPrice;
        const stepSize = exchangeInfoCache[symbol].qtyStep;
        const finalQtyStr = roundQty(rawQty, stepSize);
        if (parseFloat(finalQtyStr) <= 0) throw new Error("Size quá nhỏ");

        await setLeverage(symbol, leverage);
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: orderSide, type: 'MARKET', quantity: finalQtyStr, positionSide: 'BOTH'
        }, 3);

        const posInfo = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol }, 3);
        const realPos = posInfo.find(p => p.positionSide === 'BOTH' && parseFloat(p.positionAmt) !== 0);
        if(!realPos) throw new Error("API báo thành công nhưng không thấy vị thế");

        const realEntry = parseFloat(realPos.entryPrice);
        
        currentBufferPosition = {
            symbol, side, type: 'BUFFER', 
            qty: finalQtyStr, entryPrice: realEntry, 
            leverage, marginTarget, fdRateValue, 
            isTest,
            openTime: Date.now()
        };
        saveStateToFile();
        
        logBot('TRADE', 'BUFFER', [
            `🚀 Mở vị thế Buffer`,
            `Coin      : ${symbol}`,
            `Hướng     : ${side}`,
            `Khối lượng: ${formatLogNum(finalQtyStr)}`
        ]);
        
        monitorBufferPosition();
    } catch(e) {
        logBot('ERROR', 'BUFFER', `✖ Lỗi mở Buffer ${side} ${symbol}: ${e.message}`);
    }
}

async function monitorBufferPosition() {
    if (!currentBufferPosition) return;
    const { symbol, side, entryPrice, isTest } = currentBufferPosition;
    
    let bufferMonitorInterval = setInterval(async () => {
        if (!currentBufferPosition || currentBufferPosition.symbol !== symbol) {
            clearInterval(bufferMonitorInterval);
            return;
        }
        if (checkApiBlocked()) return;
        
        try {
            const currentPrice = await getLatestPrice(symbol);
            
            const pnlPercent = side === 'LONG' 
                ? ((currentPrice - entryPrice) / entryPrice) * 100 
                : ((entryPrice - currentPrice) / entryPrice) * 100;
                
            if (pnlPercent <= -0.5) {
                clearInterval(bufferMonitorInterval);
                logBot('WARN', 'SL', `⚠ Kích hoạt Stop Loss Buffer\nCoin      : ${symbol}`);
                await closeBufferInternal('Chạm SL Âm', isTest);
            }
        } catch(e) {
            if (e.response?.status === 418 || e.response?.status === 429) {
                triggerApiBackoff(e.response.status);
            }
        }
    }, 500);
}

async function closeBufferInternal(reason, isTest) {
    if (!currentBufferPosition) return;
    const { symbol, qty, side } = currentBufferPosition;
    try {
        const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: orderSide, type: 'MARKET', quantity: qty, positionSide: 'BOTH'
        }, 3);
        logBot('SUCCESS', 'BUFFER', `🛑 Đóng vị thế Buffer\nCoin      : ${symbol}\nLý do     : ${reason}`);
        currentBufferPosition = null;
        saveStateToFile();
    } catch (e) {
        logBot('ERROR', 'BUFFER', `✖ Lỗi đóng Buffer: ${e.message}`);
    }
}

async function executeMainTrade(symbol, side, fdRateValue, isTest = false) {
    try {
        if (currentBufferPosition && currentBufferPosition.symbol === symbol) {
            await closeBufferInternal('Đóng chuyển sang Main', isTest);
        }

        const acc = await getCachedAccount(3);
        const available = parseFloat(acc.availableBalance);
        if (available < 5) throw new Error(`Số dư quá thấp (${available.toFixed(2)} USDT)`);

        let marginTarget = 0;
        if (amountMode === 'percent') marginTarget = available * (amountValue / 100);
        else marginTarget = amountValue;

        if (marginTarget > available) marginTarget = available * 0.95; 

        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
        const currentPrice = await getLatestPrice(symbol);
        
        const lev = getLeverageFromCache(symbol);
        const rawQty = (marginTarget * lev) / currentPrice;
        const stepSize = exchangeInfoCache[symbol].qtyStep;
        const finalQtyStr = roundQty(rawQty, stepSize);

        if (parseFloat(finalQtyStr) <= 0) throw new Error("Size quá nhỏ");
        
        await setLeverage(symbol, lev);
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol, side: orderSide, type: 'MARKET', quantity: finalQtyStr, positionSide: 'BOTH'
        }, 3);

        const posInfo = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol }, 3);
        const realPos = posInfo.find(p => p.positionSide === 'BOTH' && parseFloat(p.positionAmt) !== 0);
        if (!realPos) throw new Error("API thành công nhưng không thấy vị thế");

        const realEntryPrice = parseFloat(realPos.entryPrice);
        const activeSL = side === 'LONG' 
            ? realEntryPrice * (1 - slPercent/100) 
            : realEntryPrice * (1 + slPercent/100);
            
        const estPnl = lev * (Math.abs(fdRateValue) * 100);

        currentMainPosition = {
            symbol, side, type: 'MAIN',
            qty: finalQtyStr,
            entryPrice: realEntryPrice,
            leverage: lev,
            marginTarget, fdRateValue, isTest,
            activeSL: activeSL,
            highestPnlPercent: 0,
            openTime: Date.now()
        };
        saveStateToFile();
        
        logBot('TRADE', 'MAIN', [
            `🚀 Mở vị thế`,
            `Coin      : ${symbol}`,
            `Hướng     : ${side}`,
            `Khối lượng: ${formatLogNum(finalQtyStr)}`,
            `Đòn bẩy   : ${lev}x`,
            `Margin    : ${marginTarget.toFixed(2)} USDT`,
            `Entry     : ${formatLogNum(realEntryPrice)}`,
            `Funding   : ${(fdRateValue * 100).toFixed(4)}%`,
            `Est PnL   : ${estPnl.toFixed(2)}%`
        ]);

        monitorMainPosition();
    } catch(e) {
        logBot('ERROR', 'MAIN', `✖ Lỗi mở lệnh MAIN: ${e.message}`);
        currentMainPosition = null;
        saveStateToFile();
    }
}

async function monitorMainPosition() {
    if (!currentMainPosition) return;
    
    let mainMonitorInterval = setInterval(async () => {
        if (!currentMainPosition) {
            clearInterval(mainMonitorInterval);
            return;
        }
        if (checkApiBlocked()) return;

        try {
            const accInfo = await getCachedAccount(1);
            const totalMarginBalance = parseFloat(accInfo.totalMarginBalance);
            const totalWalletBalance = parseFloat(accInfo.totalWalletBalance);
            if(totalWalletBalance > 0 && totalMarginBalance / totalWalletBalance < 0.1) {
                logBot('ERROR', 'SYSTEM', `✖ BÁO ĐỘNG: Ký quỹ dưới 10%. KÍCH HOẠT CHỐNG THANH LÝ.`);
                await closeMainInternal('CHỐNG THANH LÝ BẢO VỆ TÀI KHOẢN', currentMainPosition.isTest);
                clearInterval(mainMonitorInterval);
                return;
            }

            const { symbol, side, entryPrice, isTest } = currentMainPosition;
            const currentPrice = await getLatestPrice(symbol);
            
            const rawPnlPercent = side === 'LONG' 
                ? ((currentPrice - entryPrice) / entryPrice) * 100 
                : ((entryPrice - currentPrice) / entryPrice) * 100;
                
            if (rawPnlPercent > currentMainPosition.highestPnlPercent) {
                currentMainPosition.highestPnlPercent = rawPnlPercent;
                if (currentMainPosition.highestPnlPercent >= tpPercent) {
                    const dynamicSlPercent = currentMainPosition.highestPnlPercent - (tpPercent / 2);
                    const dynamicSlPrice = side === 'LONG'
                        ? entryPrice * (1 + dynamicSlPercent/100)
                        : entryPrice * (1 - dynamicSlPercent/100);
                        
                    const isBetterSL = side === 'LONG' 
                        ? dynamicSlPrice > currentMainPosition.activeSL 
                        : dynamicSlPrice < currentMainPosition.activeSL;
                        
                    if (isBetterSL) currentMainPosition.activeSL = dynamicSlPrice;
                }
            }

            let triggerClose = false;
            let closeReason = "";

            if (side === 'LONG' && currentPrice <= currentMainPosition.activeSL) {
                triggerClose = true;
                closeReason = currentMainPosition.activeSL > entryPrice ? "Chốt Lời Trailing (Dương)" : "Chạm Stop Loss (Âm)";
            } else if (side === 'SHORT' && currentPrice >= currentMainPosition.activeSL) {
                triggerClose = true;
                closeReason = currentMainPosition.activeSL < entryPrice ? "Chốt Lời Trailing (Dương)" : "Chạm Stop Loss (Âm)";
            }
            
            if (triggerClose) {
                clearInterval(mainMonitorInterval);
                logBot('WARN', 'TP', [
                    `⚠ Kích hoạt Stop Loss / Take Profit`,
                    `Coin      : ${symbol}`,
                    `Entry     : ${formatLogNum(entryPrice)}`,
                    `Giá kích hoạt : ${formatLogNum(currentMainPosition.activeSL)}`,
                    `Giá hiện tại : ${formatLogNum(currentPrice)}`,
                    `Lý do:\n${closeReason}`
                ]);
                await closeMainInternal(closeReason, isTest);
            }
        } catch(e) {
            if (e.response?.status === 418 || e.response?.status === 429) {
                triggerApiBackoff(e.response.status);
            }
        }
    }, 500);
}

function fetchAndLogRealizedPnL(symbol, positionSide, isTest = false, margin = 0, holdStr) {
    const closeTime = Date.now();
    setTimeout(async () => {
        try {
            const trades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol, limit: 30 }, 1);
            const closeTrades = trades.filter(t => 
                t.time >= closeTime - 15000 && 
                t.realizedPnl !== "0"
            );
            
            const totalPnl = closeTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            const totalCommission = closeTrades.reduce((sum, t) => sum + parseFloat(t.commission), 0);
            const finalPnl = totalPnl - totalCommission;
            
            let roiStr = '--%';
            if(margin > 0) {
                roiStr = ((finalPnl / margin) * 100).toFixed(2) + '%';
            }

            if (!isTest) {
                globalStats.totalPnl += finalPnl;
                globalStats.totalSessions += 1;
                saveStateToFile();
            }

            logBot('PNL', 'PNL', [
                `💰 Kết quả giao dịch`,
                `Coin          : ${symbol}`,
                `PnL thực tế   : ${totalPnl.toFixed(4)} USDT`,
                `ROI           : ${roiStr}`,
                `Phí giao dịch : -${totalCommission.toFixed(4)} USDT`,
                `Kết quả cuối  : ${finalPnl.toFixed(4)} USDT`
            ]);
        } catch (e) {
            logBot('ERROR', 'PNL', `✖ Lỗi lấy PnL: ${e.message}`);
        }
    }, 8000);
}

async function closeMainInternal(reason, isTest) {
    if (!currentMainPosition) return;
    const { symbol, side, entryPrice, openTime } = currentMainPosition;
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol }, 3);
        const pos = positions.find(p => p.positionSide === 'BOTH' && p.symbol === symbol);
        const actualAmt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
        const exitPrice = pos ? parseFloat(pos.markPrice) : 0;
        
        let holdStr = "--m --s";
        if (openTime) {
            const ms = Date.now() - openTime;
            const m = Math.floor(ms / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            holdStr = `${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
        }

        if (actualAmt > 0) {
            const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol, side: orderSide, type: 'MARKET', quantity: actualAmt, positionSide: 'BOTH'
            }, 3);
        }
        
        const marginUsed = pos ? (actualAmt * parseFloat(pos.entryPrice)) / parseInt(pos.leverage) : 0;
        
        logBot('SUCCESS', 'MAIN', [
            `🛑 Đóng vị thế`,
            `Coin      : ${symbol}`,
            `Hướng     : ${side}`,
            `Giá vào   : ${formatLogNum(entryPrice)}`,
            `Giá thoát : ${formatLogNum(exitPrice)}`,
            `Lý do     : ${reason}`,
            `Thời gian giữ : ${holdStr}`
        ]);
        
        fetchAndLogRealizedPnL(symbol, 'BOTH', isTest, marginUsed, holdStr);
        currentMainPosition = null;
        saveStateToFile();
    } catch (e) {
        logBot('ERROR', 'MAIN', `✖ Lỗi đóng MAIN: ${e.message}`);
    }
}

async function runTradingLogic() {
    if (!IS_RUNNING) return;
    if (checkApiBlocked()) return;
    
    const now = Date.now();
    let pollInterval = 60000;

    if (nextFundingTimeGlobal) {
        const timeToFunding = nextFundingTimeGlobal - now;
        if (timeToFunding > 0 && timeToFunding <= 120000) {
            pollInterval = 5000;
        }
    }

    if (now - memoryCache.premiumIndex.ts >= pollInterval || memoryCache.premiumIndex.data.length === 0) {
        try {
            const res = await scheduler.add(() => axios.get('https://fapi.binance.com/fapi/v1/premiumIndex'), 1);
            memoryCache.premiumIndex.data = res.data;
            memoryCache.premiumIndex.ts = now;
            backoff418Count = 0; backoff429Count = 0;
        } catch (e) {
            if (e.response?.status === 418 || e.response?.status === 429) {
                triggerApiBackoff(e.response.status);
            }
            return;
        }
    }

    const candidates = getTargetFundingCoins(memoryCache.premiumIndex.data, fundingThreshold, null);
    
    if (candidates.length === 0) return;
    
    const best = candidates[0]; 
    nextFundingTimeGlobal = best.nextFundingTime; 
    const timeToFunding = best.nextFundingTime - Date.now();

    if (timeToFunding <= (longOffsetMs + 60000) && timeToFunding > longOffsetMs && !currentMainPosition && !currentBufferPosition) {
        logBot('INFO', 'SCAN', `🔍 Quét Funding...\nĐã quét: ${memoryCache.premiumIndex.data.length} cặp\nĐủ điều kiện: ${candidates.length}\nĐang kiểm tra biến động...`);
        logBot('INFO', 'FILTER', `📌 Chọn cặp giao dịch\nCoin: ${best.symbol}\nFunding: ${(parseFloat(best.lastFundingRate)*100).toFixed(4)}%\nĐòn bẩy: ${best.lev}x`);
    }

    if (timeToFunding > 0 && timeToFunding <= longOffsetMs && !currentBufferPosition && !currentMainPosition) {
        await fetchMaxLeverageBrackets();
        const lev = getLeverageFromCache(best.symbol);
        const side = parseFloat(best.lastFundingRate) > 0 ? 'SHORT' : 'LONG';
        
        const acc = await getCachedAccount(2);
        const available = parseFloat(acc.availableBalance);
        let marginTarget = amountMode === 'percent' ? available * (amountValue / 100) : amountValue;
        if (marginTarget > available) marginTarget = available * 0.95;
        
        await closeAllPositionsAndOrders(best.symbol);
        await openBufferPosition(best.symbol, side, marginTarget, lev, parseFloat(best.lastFundingRate), false);
    }

    if (currentBufferPosition && timeToFunding <= shortOffsetMs && !currentMainPosition) {
        const sym = currentBufferPosition.symbol;
        const side = currentBufferPosition.side;
        const fdRate = currentBufferPosition.fdRateValue;
        await executeMainTrade(sym, side, fdRate, false);
    }
}

app.get('/api/start', async (req, res) => {
    if (req.query.apiKey) apiKey = req.query.apiKey;
    if (req.query.secretKey) secretKey = req.query.secretKey;
    fundingThreshold = parseFloat(req.query.threshold) || 0;
    amountMode = req.query.amountMode || 'percent';
    amountValue = parseFloat(req.query.amountValue) || 25;
    longOffsetMs = parseInt(req.query.longMs) || 1500;
    shortOffsetMs = parseInt(req.query.shortMs) || 0;
    tpPercent = parseFloat(req.query.tp) || 1;
    slPercent = parseFloat(req.query.sl) || 2;
    
    saveStateToFile();
    
    if (!apiKey || !secretKey) return res.status(400).send("Cần API Key và Secret Key");
    try {
        await getCachedAccount(3);
    } catch(e) {
        return res.status(400).send("API Key không hợp lệ hoặc thiếu quyền Futures");
    }

    IS_RUNNING = true;
    logBot('INFO', 'SYSTEM', '▶ Bắt đầu khởi động Bot');
    await fetchExchangeInfo();
    await fetchMaxLeverageBrackets();
    res.send("Bot started");
});

app.get('/api/stop', (req, res) => {
    IS_RUNNING = false;
    logBot('INFO', 'SYSTEM', '🛑 Bot đã dừng');
    res.send("Bot stopped");
});

app.get('/api/test_fast', async (req, res) => {
    if (!apiKey || !secretKey) return res.status(400).send("Chưa có API Key");
    res.send("Bắt đầu quy trình TEST NHANH (Mô phỏng đếm ngược Funding)!");
    logBot('INFO', 'SYSTEM', '📌 [TEST] Kích hoạt chạy thử nghiệm nghiệm ngay lập tức');
    
    try {
        await fetchExchangeInfo();
        let fundingData = memoryCache.premiumIndex.data;
        if (fundingData.length === 0) {
            const fundingInfo = await scheduler.add(() => axios.get('https://fapi.binance.com/fapi/v1/premiumIndex'), 1);
            fundingData = fundingInfo.data;
        }
        
        const candidates = getTargetFundingCoins(fundingData, 0, 10);
        if (candidates.length === 0) return logBot('WARN', 'SYSTEM', '⚠ Không tìm thấy cặp coin nào để Test');
        
        const testCoin = candidates[0];
        logBot('INFO', 'FILTER', `📌 Chọn cặp giao dịch (TEST)\nCoin: ${testCoin.symbol}`);
        
        const lev = getLeverageFromCache(testCoin.symbol);
        const side = parseFloat(testCoin.lastFundingRate) > 0 ? 'SHORT' : 'LONG';
        const acc = await getCachedAccount(3);
        const available = parseFloat(acc.availableBalance);
        let marginTarget = amountMode === 'percent' ? available * (amountValue / 100) : amountValue;
        if (marginTarget > available) marginTarget = available * 0.95;
        
        await closeAllPositionsAndOrders(testCoin.symbol);
        
        logBot('INFO', 'SYSTEM', `📌 [TEST] Kích hoạt Buffer giả lập trước Funding`);
        await openBufferPosition(testCoin.symbol, side, marginTarget, lev, parseFloat(testCoin.lastFundingRate), true);
        
        setTimeout(async () => {
            logBot('INFO', 'SYSTEM', `📌 [TEST] Đóng lệnh Buffer, chuyển Main`);
            await executeMainTrade(testCoin.symbol, side, parseFloat(testCoin.lastFundingRate), true);
        }, longOffsetMs - shortOffsetMs > 0 ? longOffsetMs - shortOffsetMs : 500);

    } catch(e) {
        if (e.response?.status === 418 || e.response?.status === 429) {
            triggerApiBackoff(e.response.status);
        }
        logBot('ERROR', 'SYSTEM', `✖ Lỗi Test Nhanh: ${e.message}`);
    }
});

app.get('/api/force_close', async (req, res) => {
    const { symbol, side } = req.query;
    try {
        if (currentMainPosition && currentMainPosition.symbol === symbol && currentMainPosition.side === side) {
            await closeMainInternal('Đóng Market Thủ Công', currentMainPosition.isTest);
        } else if (currentBufferPosition && currentBufferPosition.symbol === symbol && currentBufferPosition.side === side) {
            await closeBufferInternal('Đóng Market Thủ Công', currentBufferPosition.isTest);
        } else {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol }, 3);
            const pos = positions.find(p => p.symbol === symbol && p.positionSide === 'BOTH');
            const actualAmt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
            if (actualAmt > 0) {
                 const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
                 await callSignedAPI('/fapi/v1/order', 'POST', {
                     symbol: symbol, side: orderSide, type: 'MARKET', quantity: actualAmt, positionSide: 'BOTH'
                 }, 3);
                 logBot('SUCCESS', 'MAIN', `🛑 Đóng vị thế thủ công\nCoin: ${symbol}`);
            }
        }
        res.send('✅ Đã đóng vị thế thành công!');
    } catch (e) {
        res.send('❌ Lỗi đóng vị thế: ' + e.message);
    }
});

app.get('/api/status', (req, res) => {
    res.send(IS_RUNNING ? "RUNNING" : "STOPPED");
});

app.get('/api/logs', (req, res) => {
    res.json(memoryLogs);
});

app.get('/api/config', (req, res) => {
    res.json({
        apiKey, secretKey, fundingThreshold, amountMode, amountValue, 
        longOffsetMs, shortOffsetMs, tpPercent, slPercent
    });
});

app.get('/api/funding_rates', async (req, res) => {
    try {
        if (checkApiBlocked()) return res.json([]);
        if (memoryCache.premiumIndex.data.length === 0) {
            const info = await scheduler.add(() => axios.get('https://fapi.binance.com/fapi/v1/premiumIndex'), 0);
            memoryCache.premiumIndex.data = info.data;
            memoryCache.premiumIndex.ts = Date.now();
            backoff418Count = 0; backoff429Count = 0;
        }
        if (Object.keys(exchangeInfoCache).length === 0) await fetchExchangeInfo();
        const top = getTargetFundingCoins(memoryCache.premiumIndex.data, fundingThreshold, null);
        res.json(top);
    } catch (e) {
        if (e.response?.status === 418 || e.response?.status === 429) {
            triggerApiBackoff(e.response.status);
        }
        res.json([]);
    }
});

app.get('/api/dashboard', async (req, res) => {
    if (!IS_RUNNING || !apiKey || !secretKey) return res.json({ running: false, error: "Not running" });
    if (checkApiBlocked()) return res.json({ running: true, error: "API đang chờ xả Rate Limit 418" });
    
    try {
        const accInfo = await getCachedAccount(0);
        const posRisk = await getCachedPositionRisk(null, 0);
        
        let balance = parseFloat(accInfo.availableBalance);
        let totalWalletBalance = parseFloat(accInfo.totalWalletBalance || 0);

        const openOrdersRes = await getCachedOpenOrders(0);
        let openOrdersCount = openOrdersRes.length;

        let activePositions = [];
        posRisk.forEach(p => {
            const amt = parseFloat(p.positionAmt);
            if (amt !== 0) {
                const side = amt > 0 ? 'LONG' : 'SHORT';
                const entry = parseFloat(p.entryPrice);
                const mark = parseFloat(p.markPrice);
                const lev = parseInt(p.leverage);
                const unPnl = parseFloat(p.unRealizedProfit);
                const margin = (Math.abs(amt) * entry) / lev;
                const roi = (unPnl / margin) * 100;
                
                let slPriceStr = "N/A";
                let slPnlEst = 0;
                let typeStr = "MANUAL";
                if (currentMainPosition && currentMainPosition.symbol === p.symbol) {
                    slPriceStr = currentMainPosition.activeSL;
                    typeStr = currentMainPosition.isTest ? "MAIN (TEST)" : "MAIN";
                    
                    const slPnlVal = side === 'LONG' 
                        ? ((slPriceStr - entry)/entry)*100 
                        : ((entry - slPriceStr)/entry)*100;
                    slPnlEst = slPnlVal;
                } else if (currentBufferPosition && currentBufferPosition.symbol === p.symbol) {
                    typeStr = currentBufferPosition.isTest ? "BUFFER (TEST)" : "BUFFER";
                }

                activePositions.push({
                    coin: p.symbol, side: side, size: Math.abs(amt), margin: margin,
                    entryPrice: entry, markPrice: mark, pnl: unPnl, roi: roi,
                    leverage: lev, type: typeStr, slPrice: slPriceStr, slPnl: slPnlEst,
                    openTime: (currentMainPosition && currentMainPosition.symbol === p.symbol) ? currentMainPosition.openTime : 
                              (currentBufferPosition && currentBufferPosition.symbol === p.symbol) ? currentBufferPosition.openTime : null
                });
            }
        });

        res.json({
            running: true,
            totalWalletBalance: totalWalletBalance,
            balance: balance,
            openOrders: openOrdersCount,
            totalSessions: globalStats.totalSessions,
            totalPnl: globalStats.totalPnl,
            positions: activePositions
        });

    } catch(e) {
        res.json({ running: true, error: "Lỗi lấy dữ liệu dashboard" });
    }
});

loadStateFromFile();
loadExchangeInfoCache();
setInterval(runTradingLogic, 200); 
setInterval(saveStateToFile, 10000); 
setInterval(fetchExchangeInfo, 6 * 60 * 60 * 1000); // 6 tiếng reload ExchangeInfo
initWebSocket(); // Khởi chạy WS stream cho Giá Mark/Ticker

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Bot Server đang chạy tại cổng http://localhost:${PORT}`);
});
