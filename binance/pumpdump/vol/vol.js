
import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

// =========================================================================
// CẤU HÌNH HỆ THỐNG GRID VOLUME FUTURES & SPOT HYBRID (CHUẨN INV VALUE)
// =========================================================================
const PORT = 3334;
const MIN_ORDER_DELAY_MS = 120;
const LIQUIDATION_PROTECT_RATIO = 15;
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bot_data.json');

const SAFE_WEIGHT_CEILING = 2000;
const MAX_ORDERS_PER_10S = 240;
const SL_MARKET_TIMEOUT_MS = 15000;
const SL_MARKET_SLIPPAGE_PCT = 0.2;
const OPEN_MARKET_TIMEOUT_MS = 15000;
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceFutures = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const binanceSpot = axios.create({ 
    baseURL: 'https://api.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

// CẤU HÌNH FUTURES (SL = 50% TP)
let botSettings = {
    isRunning: false,
    isSpamVol: false,
    invValue: "5",          // Dùng đúng số tiền người dùng cấu hình
    gridOpenPct: 1.0,
    tpSlPct: 1.0,
    gridLevels: 5,
    coinList: ['BTCUSDC', 'ETHUSDT']
};

// CẤU HÌNH SPOT (SL = 50% TP)
let spotSettings = {
    isRunning: false,
    isSpamVol: false,
    invValue: "10",         // Dùng đúng số tiền người dùng cấu hình
    gridOpenPct: 1.0,
    tpSlPct: 1.2,
    gridLevels: 5,
    coinList: ['BTCUSDT', 'ETHUSDT']
};

let status = {
    botLogs: [],
    spotLogs: [],
    exchangeInfo: {},
    spotExchangeInfo: {},
    isReady: false,
    ipBannedUntil: 0
};

let accountCache = {
    totalWalletBalance: "0.00",
    availableBalance: "0.00",
    totalUnrealizedProfit: "0.00",
    rawPositions: [],
    lastUpdate: 0
};

let spotAccountCache = {
    totalWalletBalance: "0.00",
    availableBalance: "0.00",
    holdingValue: "0.00",
    totalBuyCount: 0,
    totalBuyVolume: 0,
    totalSellCount: 0,
    totalSellVolume: 0,
    balances: []
};

let activeProtectedPositions = new Map();
let slWatchTracker = new Map();
let marketOpenedGrids = new Set();

let futuresSpamSessions = new Map();
let spotSpamSessions = new Map();

let spotGridState = new Map();
let spotStats = new Map();
let spotSlWatchTracker = new Map();

let gridState = new Map();
let volumeStats = new Map();
let initCoinQueue = [];
let spotInitCoinQueue = [];
let isQueueProcessing = false;
let timestampOffset = 0;

let lastLogText = '';
const errorThrottleMap = new Map();

// =========================================================================
// HỆ THỐNG LOG: GỌN GÀNG, CHỐNG SPAM & DÒNG GHIM CỐ ĐỊNH Ở ĐẦU
// =========================================================================
function addBotLog(msg, type = 'info') {
    const cleanMsg = msg.replace(/<[^>]*>?/gm, '').trim();
    const now = Date.now();

    if (cleanMsg === lastLogText) return;
    if (type === 'error' || type === 'warn' || cleanMsg.includes('Lỗi') || cleanMsg.includes('CẢNH BÁO') || cleanMsg.includes('BANNED')) {
        if (errorThrottleMap.has(cleanMsg)) {
            const lastTime = errorThrottleMap.get(cleanMsg);
            if (now - lastTime < 120000) return;
        }
        errorThrottleMap.set(cleanMsg, now);
    }
    lastLogText = cleanMsg;

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type, isHeader: false };

    let insertIdx = 0;
    while (insertIdx < status.botLogs.length && status.botLogs[insertIdx].isHeader) {
        insertIdx++;
    }
    status.botLogs.splice(insertIdx, 0, logItem);

    if (status.botLogs.length > 200) status.botLogs.pop();
    console.log(`[FUTU ${time}] ${cleanMsg}`);
}

function addSpotLog(msg, type = 'info') {
    const cleanMsg = msg.replace(/<[^>]*>?/gm, '').trim();
    const now = Date.now();

    if (type === 'error' || type === 'warn' || cleanMsg.includes('Lỗi')) {
        if (errorThrottleMap.has(cleanMsg)) {
            const lastTime = errorThrottleMap.get(cleanMsg);
            if (now - lastTime < 60000) return;
        }
        errorThrottleMap.set(cleanMsg, now);
    }

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type, isHeader: false };

    let insertIdx = 0;
    while (insertIdx < status.spotLogs.length && status.spotLogs[insertIdx].isHeader) {
        insertIdx++;
    }
    status.spotLogs.splice(insertIdx, 0, logItem);

    if (status.spotLogs.length > 200) status.spotLogs.pop();
    console.log(`[SPOT ${time}] ${cleanMsg}`);
}

function updateFuturesSpamHeader(symbol, session) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const pnlColor = session.totalPnL >= 0 ? '#00ff88' : '#ff3355';
    const pnlStr = session.totalPnL >= 0 ? `+${session.totalPnL.toFixed(4)}$` : `${session.totalPnL.toFixed(4)}$`;
    const headerMsg = `⚡ <b>[LIVE SPAM VOL FUTU]</b> Coin: <b style="color:#facc15">${symbol}</b> | Lev: <b style="color:#facc15">x${session.lev}</b> | Margin: <b style="color:#facc15">${session.margin}$</b> | Đã chạy: <b style="color:#facc15">${session.roundCount} cặp</b> | Tổng KL: <b style="color:#00ff88">${session.totalVolume.toFixed(2)}$</b> | PnL: <b style="color:${pnlColor}">${pnlStr}</b>`;

    const idx = status.botLogs.findIndex(l => l.isFuturesSpamHeader);
    if (idx !== -1) {
        status.botLogs[idx].msg = headerMsg;
        status.botLogs[idx].time = time;
    } else {
        const newHeader = { time, msg: headerMsg, type: 'info', isHeader: true, isFuturesSpamHeader: true };
        if (status.botLogs.length > 0 && status.botLogs[0].isHeader) {
            status.botLogs.splice(1, 0, newHeader);
        } else {
            status.botLogs.unshift(newHeader);
        }
    }
}

function finalizeFuturesSpamSession() {
    for (const [symbol, session] of futuresSpamSessions.entries()) {
        if (session.roundCount > 0) {
            const durationSec = Math.round((Date.now() - session.startTime) / 1000);
            const pnlColor = session.totalPnL >= 0 ? '#00ff88' : '#ff3355';
            const pnlStr = session.totalPnL >= 0 ? `+${session.totalPnL.toFixed(4)}$` : `${session.totalPnL.toFixed(4)}$`;
            addBotLog(`🏁 <b style="color:#00ff88">[TỔNG KẾT SPAM VOL FUTURES]</b> <b style="color:#facc15">${symbol}</b>: Chạy trong <b style="color:#facc15">${durationSec}s</b> | Hoàn thành: <b style="color:#facc15">${session.roundCount} cặp</b> | Tổng KL: <b style="color:#00ff88">${session.totalVolume.toFixed(2)}$</b> | Phí sàn: <span style="color:#ff3355">${session.totalFee.toFixed(4)}$</span> | Tổng PnL: <b style="color:${pnlColor}">${pnlStr}</b>`, "success");
        }
    }
    status.botLogs = status.botLogs.filter(l => !l.isFuturesSpamHeader);
    futuresSpamSessions.clear();
}

function updateSpotSpamHeader(symbol, session) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const pnlColor = session.totalPnL >= 0 ? '#00ff88' : '#ff3355';
    const pnlStr = session.totalPnL >= 0 ? `+${session.totalPnL.toFixed(4)}$` : `${session.totalPnL.toFixed(4)}$`;
    const headerMsg = `⚡ <b>[LIVE SPAM VOL SPOT]</b> Coin: <b style="color:#facc15">${symbol}</b> | Vốn mua: <b style="color:#facc15">${session.margin}$</b> | Đã chạy: <b style="color:#facc15">${session.roundCount} lần</b> | Tổng KL: <b style="color:#00ff88">${session.totalVolume.toFixed(2)}$</b> | PnL: <b style="color:${pnlColor}">${pnlStr}</b>`;

    const idx = status.spotLogs.findIndex(l => l.isSpotSpamHeader);
    if (idx !== -1) {
        status.spotLogs[idx].msg = headerMsg;
        status.spotLogs[idx].time = time;
    } else {
        status.spotLogs.unshift({ time, msg: headerMsg, type: 'info', isHeader: true, isSpotSpamHeader: true });
    }
}

function finalizeSpotSpamSession() {
    for (const [symbol, session] of spotSpamSessions.entries()) {
        if (session.roundCount > 0) {
            const durationSec = Math.round((Date.now() - session.startTime) / 1000);
            const pnlColor = session.totalPnL >= 0 ? '#00ff88' : '#ff3355';
            const pnlStr = session.totalPnL >= 0 ? `+${session.totalPnL.toFixed(4)}$` : `${session.totalPnL.toFixed(4)}$`;
            addSpotLog(`🏁 <b style="color:#00ff88">[TỔNG KẾT SPAM VOL SPOT]</b> <b style="color:#facc15">${symbol}</b>: Chạy trong <b style="color:#facc15">${durationSec}s</b> | Hoàn thành: <b style="color:#facc15">${session.roundCount} lần</b> | Tổng KL: <b style="color:#00ff88">${session.totalVolume.toFixed(2)}$</b> | Phí sàn: <span style="color:#ff3355">${session.totalFee.toFixed(4)}$</span> | Tổng PnL: <b style="color:${pnlColor}">${pnlStr}</b>`, "success");
        }
    }
    status.spotLogs = status.spotLogs.filter(l => !l.isSpotSpamHeader);
    spotSpamSessions.clear();
}

let rateLimiter = {
    currentUsedWeight1m: 0,
    orderCount10s: 0,
    last10sWindow: Date.now(),
    isThrottled: false
};

binanceFutures.interceptors.response.use(
    response => {
        const usedWeight = response.headers['x-mbx-used-weight-1m'];
        if (usedWeight) {
            rateLimiter.currentUsedWeight1m = parseInt(usedWeight, 10);
            updateRateLimitHeader();
        }
        return response;
    },
    error => {
        const usedWeight = error.response?.headers?.['x-mbx-used-weight-1m'];
        if (usedWeight) {
            rateLimiter.currentUsedWeight1m = parseInt(usedWeight, 10);
            updateRateLimitHeader();
        }
        return Promise.reject(error);
    }
);

function updateRateLimitHeader() {
    const w = rateLimiter.currentUsedWeight1m;
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const color = w >= SAFE_WEIGHT_CEILING ? '#ff3355' : (w >= 1600 ? '#facc15' : '#00ff88');
    const headerMsg = `⚡ <b>[HỆ THỐNG RATE LIMIT]</b> Request Weight: <b style="color:${color}">${w} / 2400</b> (Trần: ${SAFE_WEIGHT_CEILING}) | Lệnh 10s: <b style="color:#facc15">${rateLimiter.orderCount10s} / ${MAX_ORDERS_PER_10S}</b>`;

    const idx = status.botLogs.findIndex(l => l.isRateLimitHeader);
    if (idx !== -1) {
        status.botLogs[idx].msg = headerMsg;
        status.botLogs[idx].time = time;
    } else {
        status.botLogs.unshift({ time, msg: headerMsg, type: 'info', isHeader: true, isRateLimitHeader: true });
    }
}

async function waitForSafeRateLimit() {
    const now = Date.now();
    if (now - rateLimiter.last10sWindow >= 10000) {
        rateLimiter.orderCount10s = 0;
        rateLimiter.last10sWindow = now;
    }
    if (rateLimiter.orderCount10s >= MAX_ORDERS_PER_10S) {
        const waitMs = Math.max(10000 - (now - rateLimiter.last10sWindow), 1000);
        await new Promise(r => setTimeout(r, waitMs));
        rateLimiter.orderCount10s = 0;
        rateLimiter.last10sWindow = Date.now();
    }
    if (rateLimiter.currentUsedWeight1m >= SAFE_WEIGHT_CEILING) {
        rateLimiter.isThrottled = true;
        updateRateLimitHeader();
        await new Promise(r => setTimeout(r, 2000));
        rateLimiter.isThrottled = false;
    }
}

function loadSavedData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.botSettings) {
                botSettings = { ...botSettings, ...parsed.botSettings };
                botSettings.isRunning = false;
            }
            if (parsed.spotSettings) {
                spotSettings = { ...spotSettings, ...parsed.spotSettings };
                spotSettings.isRunning = false;
            }
            if (parsed.volumeStats) {
                for (const [sym, st] of Object.entries(parsed.volumeStats)) {
                    volumeStats.set(sym, {
                        ...st,
                        recordedTradeIds: new Set((st.recordedTradeIds || []).map(String))
                    });
                }
            }
            if (parsed.spotStats) {
                for (const [sym, st] of Object.entries(parsed.spotStats)) {
                    spotStats.set(sym, {
                        ...st,
                        recordedTradeIds: new Set((st.recordedTradeIds || []).map(String))
                    });
                }
            }
            console.log(`💾 [STORAGE] Đã khôi phục dữ liệu từ ${DATA_FILE}`);
        }
    } catch (e) {
        console.error("Lỗi khi đọc file bot_data.json:", e.message);
    }
}

function saveData() {
    try {
        const statsObj = {};
        for (const [sym, st] of volumeStats.entries()) {
            statsObj[sym] = {
                ...st,
                recordedTradeIds: Array.from(st.recordedTradeIds || []).map(String)
            };
        }
        const spotStatsObj = {};
        for (const [sym, st] of spotStats.entries()) {
            spotStatsObj[sym] = {
                ...st,
                recordedTradeIds: Array.from(st.recordedTradeIds || []).map(String)
            };
        }
        const payload = {
            botSettings,
            spotSettings,
            volumeStats: statsObj,
            spotStats: spotStatsObj,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error("Lỗi khi ghi file bot_data.json:", e.message);
    }
}

function checkBanStatus() {
    if (status.ipBannedUntil > Date.now()) {
        const remainingSec = Math.ceil((status.ipBannedUntil - Date.now()) / 1000);
        return { isBanned: true, remainingSec };
    }
    return { isBanned: false, remainingSec: 0 };
}

function triggerIpBan(msg, banDurationMs = 300000) {
    status.ipBannedUntil = Date.now() + banDurationMs;
    addBotLog(`<span style="color:#facc15">⚠️ [IP BANNED] Khóa IP đến ${new Date(status.ipBannedUntil).toLocaleTimeString('vi-VN')}: ${msg}</span>`, "warn");
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    if (typeof method === 'object' && method !== null) {
        data = method;
        method = 'GET';
    }
    method = (method || 'GET').toUpperCase();

    const ban = checkBanStatus();
    if (ban.isBanned) throw new Error(`IP đang bị khóa tạm thời. Còn ${ban.remainingSec}s.`);

    await waitForSafeRateLimit();

    try {
        const timestamp = Date.now() + timestampOffset;
        const queryParams = { ...data, timestamp, recvWindow: 60000 };
        const query = new URLSearchParams(queryParams).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');

        let reqConfig = {
            method: method,
            headers: { 'X-MBX-APIKEY': API_KEY }
        };

        if (method === 'GET' || method === 'DELETE') {
            reqConfig.url = `${endpoint}?${query}&signature=${signature}`;
        } else {
            reqConfig.url = endpoint;
            reqConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            reqConfig.data = `${query}&signature=${signature}`;
        }

        const res = await binanceFutures(reqConfig);
        return res.data;
    } catch (e) {
        const statusErr = e.response?.status;
        const errData = e.response?.data;

        if (statusErr === 418 || statusErr === 429 || errData?.code === -1003) {
            let banMs = 300000;
            const match = errData?.msg?.match(/banned until (\d+)/);
            if (match && match[1]) banMs = Math.max(parseInt(match[1]) - Date.now(), 60000);
            triggerIpBan(errData?.msg || 'Too Many Requests', banMs);
        }

        if (errData?.code === -1021) {
            try {
                const t = await axios.get('https://fapi.binance.com/fapi/v1/time', { timeout: 5000 });
                timestampOffset = t.data.serverTime - Date.now();
                return binancePrivate(endpoint, method, data);
            } catch (err) {}
        }
        throw e;
    }
}

async function binanceSpotPrivate(endpoint, method = 'GET', data = {}) {
    if (typeof method === 'object' && method !== null) {
        data = method;
        method = 'GET';
    }
    method = (method || 'GET').toUpperCase();

    try {
        const timestamp = Date.now() + timestampOffset;
        const queryParams = { ...data, timestamp, recvWindow: 60000 };
        const query = new URLSearchParams(queryParams).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');

        let reqConfig = {
            method: method,
            headers: { 'X-MBX-APIKEY': API_KEY }
        };

        if (method === 'GET' || method === 'DELETE') {
            reqConfig.url = `${endpoint}?${query}&signature=${signature}`;
        } else {
            reqConfig.url = endpoint;
            reqConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            reqConfig.data = `${query}&signature=${signature}`;
        }

        const res = await binanceSpot(reqConfig);
        return res.data;
    } catch (e) {
        throw e;
    }
}

function formatSymbolAuto(rawInput, isSpot = false) {
    if (!rawInput) return null;
    let clean = rawInput.trim().toUpperCase().replace(/[\/\-_ ]/g, '');
    if (!clean) return null;

    const infoSource = isSpot ? status.spotExchangeInfo : status.exchangeInfo;
    if (infoSource[clean]) return clean;

    const quotePriorities = ['USDC', 'USDT', 'USD1', 'FDUSD', 'BNB', 'BTC', 'ETH'];
    for (const q of quotePriorities) {
        const candidate = `${clean}${q}`;
        if (infoSource[candidate]) return candidate;
    }

    for (const q of quotePriorities) {
        const candidate1000 = `1000${clean}${q}`;
        if (infoSource[candidate1000]) return candidate1000;
    }

    const matched = Object.keys(infoSource).find(sym => sym.startsWith(clean));
    if (matched) return matched;

    return `${clean}USDC`;
}

function getBaseAsset(symbol, isSpot = true) {
    const info = isSpot ? status.spotExchangeInfo[symbol] : status.exchangeInfo[symbol];
    if (info?.baseAsset) return info.baseAsset;
    return symbol.replace(/(USDT|USDC|USD1|FDUSD|BNB|BTC|ETH)$/, '');
}

function getQuoteAsset(symbol, isSpot = true) {
    const info = isSpot ? status.spotExchangeInfo[symbol] : status.exchangeInfo[symbol];
    if (info?.quoteAsset) return info.quoteAsset;
    const quotes = ['USDT', 'USDC', 'USD1', 'FDUSD', 'BNB', 'BTC', 'ETH'];
    for (const q of quotes) {
        if (symbol.endsWith(q)) return q;
    }
    return 'USDT';
}

function roundPrice(symbol, price, isSpot = false) {
    const info = (isSpot ? status.spotExchangeInfo[symbol] : status.exchangeInfo[symbol]) || { pricePrecision: 4, tickSize: 0.0001 };
    const precision = info.pricePrecision ?? 4;
    const step = info.tickSize || Math.pow(10, -precision);
    const rounded = Math.round(price / step) * step;
    return parseFloat(rounded.toFixed(precision));
}

function roundQty(symbol, qty, isSpot = false) {
    const info = (isSpot ? status.spotExchangeInfo[symbol] : status.exchangeInfo[symbol]) || { quantityPrecision: 2, stepSize: 0.01 };
    const precision = info.quantityPrecision ?? 2;
    const step = info.stepSize || Math.pow(10, -precision);
    const rounded = Math.floor(Number(qty) / step) * step;
    return parseFloat(rounded.toFixed(precision));
}

function getConditionalType(side, currentPrice, targetPrice) {
    if (side === 'BUY') {
        return targetPrice > currentPrice ? 'STOP' : 'TAKE_PROFIT';
    } else {
        return targetPrice < currentPrice ? 'STOP' : 'TAKE_PROFIT';
    }
}

async function fetchMaxLeverage(symbol) {
    try {
        const res = await binancePrivate('/fapi/v1/leverageBracket', 'GET', { symbol });
        if (Array.isArray(res) && res[0]?.brackets?.[0]?.initialLeverage) {
            return res[0].brackets[0].initialLeverage;
        }
    } catch (e) {}
    return status.exchangeInfo[symbol]?.maxLeverage || 50;
}

// =========================================================================
// TÍNH TOÁN KHỐI LƯỢNG LỆNH: DÙNG ĐÚNG SỐ TIỀN CẤU HÌNH (KHÔNG ÉP BUỘC SỐ LẠ)
// =========================================================================
function calculateOrderQtyForPrice(symbol, orderPrice) {
    const info = status.exchangeInfo[symbol] || { 
        quantityPrecision: 2, stepSize: 0.01, minQty: 0.01, minNotional: 5.0, maxLeverage: 50
    };
    const wallet = parseFloat(accountCache.totalWalletBalance || accountCache.availableBalance || 0);

    let inputStr = botSettings.invValue.toString().trim();
    let isPercent = inputStr.includes('%');
    let val = parseFloat(inputStr.replace('%', ''));
    if (isNaN(val) || val <= 0) val = 5;

    let notional = 0;
    if (isPercent) {
        let margin = (wallet * val) / 100;
        const lev = info.maxLeverage || 50;
        notional = margin * lev;
    } else {
        notional = val; // DÙNG ĐÚNG SỐ TIỀN BẠN CẤU HÌNH
    }

    // Chỉ chặn nếu thấp hơn mức tối thiểu của sàn
    const minFloorNotional = info.minNotional || 5.0;
    if (notional < minFloorNotional) notional = minFloorNotional;

    let rawQty = notional / orderPrice;
    if (info.minQty && rawQty < info.minQty) rawQty = info.minQty;

    const step = info.stepSize || Math.pow(10, -(info.quantityPrecision ?? 2));
    let finalQty = Math.ceil(rawQty / step) * step;

    while (finalQty * orderPrice < minFloorNotional) finalQty += step;

    return parseFloat(finalQty.toFixed(info.quantityPrecision ?? 2));
}

function calculateSpotOrderQty(symbol, orderPrice) {
    const info = status.spotExchangeInfo[symbol] || {
        quantityPrecision: 2, stepSize: 0.001, minQty: 0.001, minNotional: 10.0
    };
    
    let inputStr = spotSettings.invValue.toString().trim();
    let isPercent = inputStr.includes('%');
    let val = parseFloat(inputStr.replace('%', ''));
    if (isNaN(val) || val <= 0) val = 10;

    let notional = 0;
    if (isPercent) {
        const quoteAsset = getQuoteAsset(symbol, true);
        const quoteBal = (spotAccountCache.balances || []).find(b => b.asset === quoteAsset);
        const availableQuote = parseFloat(quoteBal?.free || 0);
        notional = (availableQuote * val) / 100;
    } else {
        notional = val; // DÙNG ĐÚNG SỐ TIỀN BẠN CẤU HÌNH TRÊN GIAO DIỆN
    }

    // Chỉ chặn nếu thấp hơn mức tối thiểu của sàn quy định
    const minNotional = info.minNotional || 10.0;
    if (notional < minNotional) notional = minNotional;

    let rawQty = notional / orderPrice;
    if (info.minQty && rawQty < info.minQty) rawQty = info.minQty;

    const step = info.stepSize || Math.pow(10, -(info.quantityPrecision ?? 2));
    let finalQty = Math.ceil(rawQty / step) * step;

    while (finalQty * orderPrice < minNotional) finalQty += step;

    return parseFloat(finalQty.toFixed(info.quantityPrecision ?? 2));
}

function calculateTradeFeeUsd(t, priceMap, symbol) {
    const commission = parseFloat(t.commission || 0);
    const asset = (t.commissionAsset || '').toUpperCase().trim();
    if (commission <= 0 || !asset) return 0;

    if (['USDT', 'USDC', 'USD1', 'FDUSD', 'BUSD', 'DAI'].includes(asset)) {
        return commission;
    }

    const pUSDT = priceMap.get(`${asset}USDT`);
    if (pUSDT) return commission * pUSDT;

    const pUSDC = priceMap.get(`${asset}USDC`);
    if (pUSDC) return commission * pUSDC;

    const pBTC = priceMap.get(`${asset}BTC`);
    const btcUsdt = priceMap.get('BTCUSDT') || priceMap.get('BTCUSDC');
    if (pBTC && btcUsdt) return commission * pBTC * btcUsdt;

    if (symbol && symbol.startsWith(asset)) {
        const tradePrice = parseFloat(t.price || 0);
        return commission * tradePrice;
    }

    return commission;
}

function calculateFillsFee(fills, priceMap, symbol) {
    if (!Array.isArray(fills) || fills.length === 0) return 0;
    let totalFeeUsd = 0;
    for (const f of fills) {
        const commission = parseFloat(f.commission || 0);
        const asset = (f.commissionAsset || '').toUpperCase().trim();
        if (commission <= 0 || !asset) continue;

        if (['USDT', 'USDC', 'USD1', 'FDUSD', 'BUSD', 'DAI'].includes(asset)) {
            totalFeeUsd += commission;
        } else {
            const pUSDT = priceMap.get(`${asset}USDT`);
            if (pUSDT) {
                totalFeeUsd += commission * pUSDT;
            } else {
                const pUSDC = priceMap.get(`${asset}USDC`);
                if (pUSDC) totalFeeUsd += commission * pUSDC;
                else if (symbol && symbol.startsWith(asset)) {
                    totalFeeUsd += commission * parseFloat(f.price || 0);
                } else {
                    totalFeeUsd += commission;
                }
            }
        }
    }
    return totalFeeUsd;
}

async function cancelOpenTpOrders(symbol, positionSide) {
    try {
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        if (Array.isArray(openOrders)) {
            const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';
            for (const o of openOrders) {
                if (o.positionSide === positionSide && o.side === closeSide) {
                    await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(() => {});
                }
            }
        }
    } catch (e) {}
}

async function cancelOpenSlAlgoOrders(symbol, positionSide) {
    try {
        const openAlgo = await binancePrivate('/fapi/v1/openAlgoOrders', 'GET', { symbol }).catch(() => []);
        const algoList = Array.isArray(openAlgo) ? openAlgo : (openAlgo?.orders || []);
        for (const a of algoList) {
            if (a.positionSide === positionSide) {
                await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: a.algoId }).catch(() => {});
            }
        }
    } catch (e) {}
}

async function placeMakerLimitOrder(symbol, side, positionSide, price, qty, clientOrderId = null) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;
    try {
        const pStr = roundPrice(symbol, price).toFixed(info.pricePrecision ?? 4);
        const qStr = roundQty(symbol, qty).toFixed(info.quantityPrecision ?? 2);

        const params = {
            symbol, side, positionSide,
            type: 'LIMIT',
            timeInForce: 'GTC',
            quantity: qStr, price: pStr
        };
        if (clientOrderId) params.newClientOrderId = clientOrderId;

        rateLimiter.orderCount10s += 1;
        return await binancePrivate('/fapi/v1/order', 'POST', params);
    } catch (e) {
        addBotLog(`<b style="color:#ff3355">❌ [LỖI SÀN TỪ CHỐI TP]</b> ${symbol} ${side}_${positionSide}: ${e.response?.data?.msg || e.message}`, "error");
        return null;
    }
}

async function placeMakerConditionalOrder(symbol, side, positionSide, targetPrice, limitPrice, qty, clientAlgoId = null) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;
    try {
        const ticker = await binanceFutures.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
        const currentP = ticker ? parseFloat(ticker.data.price) : targetPrice;

        let orderType = getConditionalType(side, currentP, targetPrice);
        const trigStr = roundPrice(symbol, targetPrice).toFixed(info.pricePrecision ?? 4);
        const pStr = roundPrice(symbol, limitPrice).toFixed(info.pricePrecision ?? 4);
        const qStr = roundQty(symbol, qty).toFixed(info.quantityPrecision ?? 2);

        const params = {
            algoType: 'CONDITIONAL',
            symbol, side, positionSide,
            type: orderType,
            quantity: qStr,
            price: pStr,
            triggerPrice: trigStr,
            timeInForce: 'GTC',
            workingType: 'MARK_PRICE'
        };
        if (clientAlgoId) params.clientAlgoId = clientAlgoId;

        rateLimiter.orderCount10s += 1;
        let res;
        try {
            res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params);
        } catch (err) {
            if (err.response?.data?.code === -2021) {
                params.type = (orderType === 'STOP' ? 'TAKE_PROFIT' : 'STOP');
                res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params).catch(() => null);
            } else {
                throw err;
            }
        }
        return res;
    } catch (e) {
        addBotLog(`<b style="color:#ff3355">❌ [LỖI SÀN TỪ CHỐI SL]</b> ${symbol} ${side}_${positionSide}: ${e.response?.data?.msg || e.message}`, "error");
        return null;
    }
}

async function placeSpotMakerBuyOrder(symbol, price, qty, clientOrderId = null) {
    const info = status.spotExchangeInfo[symbol];
    if (!info) return null;
    try {
        const pStr = roundPrice(symbol, price, true).toFixed(info.pricePrecision ?? 4);
        const qStr = roundQty(symbol, qty, true).toFixed(info.quantityPrecision ?? 2);

        const params = {
            symbol, side: 'BUY',
            type: 'LIMIT_MAKER',
            quantity: qStr, price: pStr
        };
        if (clientOrderId) params.newClientOrderId = clientOrderId;

        return await binanceSpotPrivate('/api/v3/order', 'POST', params);
    } catch (e) {
        addSpotLog(`<span style="color:#ff3355">⚠️ [Lỗi Mua Spot] ${symbol}: ${e.response?.data?.msg || e.message}</span>`, "warn");
        return null;
    }
}

async function placeSpotLimitSellOrder(symbol, price, qty, clientOrderId = null) {
    const info = status.spotExchangeInfo[symbol];
    if (!info) return null;
    try {
        const pStr = roundPrice(symbol, price, true).toFixed(info.pricePrecision ?? 4);
        const qStr = roundQty(symbol, qty, true).toFixed(info.quantityPrecision ?? 2);

        const params = {
            symbol, side: 'SELL',
            type: 'LIMIT',
            timeInForce: 'GTC',
            quantity: qStr, price: pStr
        };
        if (clientOrderId) params.newClientOrderId = clientOrderId;

        return await binanceSpotPrivate('/api/v3/order', 'POST', params);
    } catch (e) {
        addSpotLog(`<span style="color:#ff3355">⚠️ [Lỗi Bán TP Spot] ${symbol}: ${e.response?.data?.msg || e.message}</span>`, "warn");
        return null;
    }
}

async function deployGridLevel(symbol, levelPrice, initialEntry, gridNum) {
    const offset01 = initialEntry * 0.001;
    const qty = calculateOrderQtyForPrice(symbol, levelPrice);
    let openLong, openShort;

    if (gridNum > 0) {
        openShort = await placeMakerLimitOrder(symbol, 'SELL', 'SHORT', levelPrice, qty, `OPENSHORT${Date.now()}`);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        const longLimitPrice = levelPrice - offset01;
        openLong = await placeMakerConditionalOrder(symbol, 'BUY', 'LONG', levelPrice, longLimitPrice, qty, `OPENLONG${Date.now()}`);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    } else {
        openLong = await placeMakerLimitOrder(symbol, 'BUY', 'LONG', levelPrice, qty, `OPENLONG${Date.now()}`);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        const shortLimitPrice = levelPrice + offset01;
        openShort = await placeMakerConditionalOrder(symbol, 'SELL', 'SHORT', levelPrice, shortLimitPrice, qty, `OPENSHORT${Date.now()}`);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    }

    const orderIds = [openLong?.orderId, openShort?.orderId].filter(Boolean);
    const algoIds = [openLong?.algoId, openShort?.algoId].filter(Boolean);

    return { 
        gridNum, 
        levelPrice, 
        qty,
        orderIds, 
        algoIds,
        status: 'PENDING',
        openedBy: 'LIMIT',
        triggerTime: null
    };
}

async function cancelGridLevelOrders(symbol, levelObj) {
    if (!levelObj) return;
    if (levelObj.orderIds) {
        for (const id of levelObj.orderIds) {
            try { await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: id }); } catch (e) {}
        }
    }
    if (levelObj.algoIds) {
        for (const id of levelObj.algoIds) {
            try { await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: id }); } catch (e) {}
        }
    }
}

async function deployTpSlForPosition(symbol, positionSide, qty, entryPrice, isMarketOpen = false) {
    const info = status.exchangeInfo[symbol];
    if (!info) return false;

    const openPos = (accountCache.rawPositions || []).find(
        p => p.symbol === symbol && p.positionSide === positionSide
    );
    const actualPosAmt = openPos ? Math.abs(parseFloat(openPos.positionAmt)) : qty;
    if (actualPosAmt <= 0) return false;

    const finalQty = roundQty(symbol, Math.min(qty, actualPosAmt));
    if (finalQty <= 0) return false;

    const initialEntry = gridState.get(symbol)?.initialEntry || entryPrice;
    
    const tpMultiplier = isMarketOpen ? 1.5 : 1.0;
    const tpPct = botSettings.tpSlPct * tpMultiplier;
    const slPct = botSettings.tpSlPct * 0.5;

    const offset01 = initialEntry * 0.001;
    const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';

    let tpP, slP, slLimitP;
    if (positionSide === 'LONG') {
        tpP = roundPrice(symbol, entryPrice * (1 + tpPct / 100));
        slP = roundPrice(symbol, entryPrice * (1 - slPct / 100));
        slLimitP = roundPrice(symbol, slP + offset01);
    } else {
        tpP = roundPrice(symbol, entryPrice * (1 - tpPct / 100));
        slP = roundPrice(symbol, entryPrice * (1 + slPct / 100));
        slLimitP = roundPrice(symbol, slP - offset01);
    }

    const gridTag = getGridTagForPrice(symbol, entryPrice);
    const lev = info.maxLeverage || 50;
    const margin = ((finalQty * entryPrice) / lev).toFixed(2);

    await cancelOpenTpOrders(symbol, positionSide);

    const tpClientId = `TP${positionSide}${Date.now()}`;
    const tpRes = await placeMakerLimitOrder(symbol, closeSide, positionSide, tpP, finalQty, tpClientId);

    await cancelOpenSlAlgoOrders(symbol, positionSide);

    const slClientId = `SL${positionSide}${Date.now()}`;
    let slRes = await placeMakerConditionalOrder(symbol, closeSide, positionSide, slP, slLimitP, finalQty, slClientId);

    if (!slRes) {
        const trigStr = roundPrice(symbol, slP).toFixed(info.pricePrecision ?? 4);
        const qStr = finalQty.toFixed(info.quantityPrecision ?? 2);
        slRes = await binancePrivate('/fapi/v1/algoOrder', 'POST', {
            algoType: 'CONDITIONAL',
            symbol,
            side: closeSide,
            positionSide: positionSide,
            type: 'STOP_MARKET',
            quantity: qStr,
            triggerPrice: trigStr,
            workingType: 'MARK_PRICE'
        }).catch(e => {
            addBotLog(`<b style="color:#ff3355">❌ [LỖI THIẾU LỆNH SL]</b> ${symbol} ${positionSide}: ${e.response?.data?.msg || e.message}`, "error");
            return null;
        });
    }

    if (tpRes && slRes) {
        activeProtectedPositions.set(`${symbol}_${positionSide}`, {
            amt: finalQty,
            tpOrderId: tpRes.orderId,
            slAlgoId: slRes.algoId,
            entryPrice: entryPrice,
            isMarketOpen
        });
        const marketTag = isMarketOpen ? ' <span style="color:#00ff88;font-weight:bold">(MỞ MARKET: TP +50%)</span>' : '';
        addBotLog(`<b style="color:#facc15">[GRID ${gridTag}]</b> open: <b style="color:#facc15">${symbol}</b> <b style="color:#facc15">${positionSide}</b> <span style="color:#facc15">x${lev}</span>, margin: <span style="color:#facc15">${margin}$</span>, giá open: <b style="color:#facc15">${entryPrice}</b>, TP: <span style="color:#facc15">${tpP} (${tpPct.toFixed(2)}%)</span>, SL: <span style="color:#facc15">${slP} (${slPct.toFixed(2)}%)</span>${marketTag}`, "info");
        return true;
    }

    return false;
}

async function handleOneWayGridEmergency(symbol, markP) {
    const cState = gridState.get(symbol);
    if (!cState || cState.isInitializing) return;

    // --- MỐC TRÊN (LONG PHÁ ĐỈNH) ---
    const hitUpperLevels = cState.upperLevels.filter(l => markP >= l.levelPrice);
    if (hitUpperLevels.length > 0) {
        const frontierUpper = hitUpperLevels[hitUpperLevels.length - 1];

        const bypassedUpper = hitUpperLevels.slice(0, -1).filter(l => {
            const key = `${symbol}_LONG_${l.gridNum}`;
            return l.status !== 'OPENED' && !marketOpenedGrids.has(key);
        });

        if (bypassedUpper.length > 0) {
            const totalQty = roundQty(symbol, bypassedUpper.reduce((sum, l) => sum + (l.qty || 0), 0));
            if (totalQty > 0) {
                for (const lvl of bypassedUpper) {
                    marketOpenedGrids.add(`${symbol}_LONG_${lvl.gridNum}`);
                    lvl.status = 'OPENED';
                    lvl.openedBy = 'MARKET';
                    await cancelGridLevelOrders(symbol, lvl);
                }

                await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol, side: 'BUY', positionSide: 'LONG',
                    type: 'MARKET', quantity: totalQty.toString()
                }).catch(() => null);

                addBotLog(`<b style="color:#00ff88">⚡ [VƯỢT MỐC GRID CẤP TỐC]</b> <b style="color:#facc15">${symbol} LONG</b>: Giá phóng qua các mốc <b style="color:#facc15">[${bypassedUpper.map(l => '+' + l.gridNum).join(', ')}]</b>! Đã gộp 1 lệnh MARKET tổng KL = <b style="color:#facc15">${totalQty}</b> (TP +50% = ${(botSettings.tpSlPct * 1.5).toFixed(2)}%)!`, "success");
                await deployTpSlForPosition(symbol, 'LONG', totalQty, markP, true);
            }
        }

        const frontierKey = `${symbol}_LONG_${frontierUpper.gridNum}`;
        if (frontierUpper.status !== 'OPENED' && !marketOpenedGrids.has(frontierKey)) {
            if (!frontierUpper.triggerTime) {
                frontierUpper.triggerTime = Date.now();
                frontierUpper.status = 'TRIGGERED';
            } else if (Date.now() - frontierUpper.triggerTime >= OPEN_MARKET_TIMEOUT_MS) {
                marketOpenedGrids.add(frontierKey);
                frontierUpper.status = 'OPENED';
                frontierUpper.openedBy = 'MARKET';

                const qty = roundQty(symbol, frontierUpper.qty);
                await cancelGridLevelOrders(symbol, frontierUpper);

                await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol, side: 'BUY', positionSide: 'LONG',
                    type: 'MARKET', quantity: qty.toString()
                }).catch(() => null);

                addBotLog(`<b style="color:#facc15">⚡ [QUÁ 15S CHƯA KHỚP]</b> <b style="color:#facc15">${symbol} LONG [GRID +${frontierUpper.gridNum}]</b>: Đã hủy lệnh mốc và mở MARKET (TP +50% = ${(botSettings.tpSlPct * 1.5).toFixed(2)}%)!`, "warn");
                await deployTpSlForPosition(symbol, 'LONG', qty, markP, true);
            }
        }
    }

    // --- MỐC DƯỚI (SHORT XẢ ĐÁY) ---
    const hitLowerLevels = cState.lowerLevels.filter(l => markP <= l.levelPrice);
    if (hitLowerLevels.length > 0) {
        const frontierLower = hitLowerLevels[hitLowerLevels.length - 1];

        const bypassedLower = hitLowerLevels.slice(0, -1).filter(l => {
            const key = `${symbol}_SHORT_${l.gridNum}`;
            return l.status !== 'OPENED' && !marketOpenedGrids.has(key);
        });

        if (bypassedLower.length > 0) {
            const totalQty = roundQty(symbol, bypassedLower.reduce((sum, l) => sum + (l.qty || 0), 0));
            if (totalQty > 0) {
                for (const lvl of bypassedLower) {
                    marketOpenedGrids.add(`${symbol}_SHORT_${lvl.gridNum}`);
                    lvl.status = 'OPENED';
                    lvl.openedBy = 'MARKET';
                    await cancelGridLevelOrders(symbol, lvl);
                }

                await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol, side: 'SELL', positionSide: 'SHORT',
                    type: 'MARKET', quantity: totalQty.toString()
                }).catch(() => null);

                addBotLog(`<b style="color:#00ff88">⚡ [XẢ THỦNG MỐC GRID CẤP TỐC]</b> <b style="color:#facc15">${symbol} SHORT</b>: Giá xả thủng các mốc <b style="color:#facc15">[${bypassedLower.map(l => l.gridNum).join(', ')}]</b>! Đã gộp 1 lệnh MARKET tổng KL = <b style="color:#facc15">${totalQty}</b> (TP +50% = ${(botSettings.tpSlPct * 1.5).toFixed(2)}%)!`, "success");
                await deployTpSlForPosition(symbol, 'SHORT', totalQty, markP, true);
            }
        }

        const frontierKey = `${symbol}_SHORT_${frontierLower.gridNum}`;
        if (frontierLower.status !== 'OPENED' && !marketOpenedGrids.has(frontierKey)) {
            if (!frontierLower.triggerTime) {
                frontierLower.triggerTime = Date.now();
                frontierLower.status = 'TRIGGERED';
            } else if (Date.now() - frontierLower.triggerTime >= OPEN_MARKET_TIMEOUT_MS) {
                marketOpenedGrids.add(frontierKey);
                frontierLower.status = 'OPENED';
                frontierLower.openedBy = 'MARKET';

                const qty = roundQty(symbol, frontierLower.qty);
                await cancelGridLevelOrders(symbol, frontierLower);

                await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol, side: 'SELL', positionSide: 'SHORT',
                    type: 'MARKET', quantity: qty.toString()
                }).catch(() => null);

                addBotLog(`<b style="color:#facc15">⚡ [QUÁ 15S CHƯA KHỚP]</b> <b style="color:#facc15">${symbol} SHORT [GRID ${frontierLower.gridNum}]</b>: Đã hủy lệnh mốc và mở MARKET (TP +50% = ${(botSettings.tpSlPct * 1.5).toFixed(2)}%)!`, "warn");
                await deployTpSlForPosition(symbol, 'SHORT', qty, markP, true);
            }
        }
    }
}

async function checkTpMarketX5(symbol, markP) {
    const openPositions = (accountCache.rawPositions || []).filter(
        p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0
    );

    for (const p of openPositions) {
        const entryPrice = parseFloat(p.entryPrice);
        const posAmt = Math.abs(parseFloat(p.positionAmt));
        const posSide = p.positionSide;
        const tpPct = botSettings.tpSlPct;
        const targetX5Pct = tpPct * 5;

        let currentProfitPct = 0;
        if (posSide === 'LONG') {
            currentProfitPct = ((markP - entryPrice) / entryPrice) * 100;
        } else {
            currentProfitPct = ((entryPrice - markP) / entryPrice) * 100;
        }

        if (currentProfitPct >= targetX5Pct) {
            const closeSide = posSide === 'LONG' ? 'SELL' : 'BUY';
            const closeRes = await binancePrivate('/fapi/v1/order', 'POST', {
                symbol, side: closeSide, positionSide: posSide,
                type: 'MARKET', quantity: posAmt.toString()
            }).catch(() => null);

            if (closeRes) {
                await cancelOpenTpOrders(symbol, posSide);
                await cancelOpenSlAlgoOrders(symbol, posSide);
                activeProtectedPositions.delete(`${symbol}_${posSide}`);
                
                for (const k of marketOpenedGrids) {
                    if (k.startsWith(`${symbol}_${posSide}`)) marketOpenedGrids.delete(k);
                }

                addBotLog(`<b style="color:#00ff88">🚀 [TP MARKET x5]</b> <b style="color:#facc15">${symbol} ${posSide}</b>: Lãi đạt <b style="color:#00ff88">+${currentProfitPct.toFixed(2)}%</b>! Đã chốt lời Market ngay!`, "success");
            }
        }
    }
}

async function checkSlMarketEmergency(symbol, markP) {
    const openPos = (accountCache.rawPositions || []).find(
        p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0
    );
    if (!openPos) {
        slWatchTracker.delete(`${symbol}_LONG`);
        slWatchTracker.delete(`${symbol}_SHORT`);
        return;
    }

    const posSide = openPos.positionSide;
    const posAmt = Math.abs(parseFloat(openPos.positionAmt));
    const entryPrice = parseFloat(openPos.entryPrice);
    const initialEntry = gridState.get(symbol)?.initialEntry || entryPrice;

    const slPct = botSettings.tpSlPct * 0.5;
    const offset01 = initialEntry * 0.001;
    const posKey = `${symbol}_${posSide}`;

    let triggerSlPrice, limitSlPrice;
    let isHitStop = false;
    let isSlippedTooMuch = false;

    if (posSide === 'LONG') {
        triggerSlPrice = entryPrice * (1 - slPct / 100);
        limitSlPrice = triggerSlPrice + offset01;
        if (markP <= triggerSlPrice) isHitStop = true;
        if (markP <= limitSlPrice * (1 - SL_MARKET_SLIPPAGE_PCT / 100)) isSlippedTooMuch = true;
    } else {
        triggerSlPrice = entryPrice * (1 + slPct / 100);
        limitSlPrice = triggerSlPrice - offset01;
        if (markP >= triggerSlPrice) isHitStop = true;
        if (markP >= limitSlPrice * (1 + SL_MARKET_SLIPPAGE_PCT / 100)) isSlippedTooMuch = true;
    }

    if (isHitStop) {
        if (!slWatchTracker.has(posKey)) {
            slWatchTracker.set(posKey, { triggerTime: Date.now(), limitSlPrice });
        }
        const watch = slWatchTracker.get(posKey);
        const elapsedMs = Date.now() - watch.triggerTime;

        if (elapsedMs >= SL_MARKET_TIMEOUT_MS || isSlippedTooMuch) {
            const reason = isSlippedTooMuch 
                ? `trượt giá quá ${SL_MARKET_SLIPPAGE_PCT}%` 
                : `sau ${(elapsedMs / 1000).toFixed(1)}s không khớp SL Limit`;

            const closeSide = posSide === 'LONG' ? 'SELL' : 'BUY';
            const closeRes = await binancePrivate('/fapi/v1/order', 'POST', {
                symbol, side: closeSide, positionSide: posSide,
                type: 'MARKET', quantity: posAmt.toString()
            }).catch(() => null);

            if (closeRes) {
                await cancelOpenTpOrders(symbol, posSide);
                await cancelOpenSlAlgoOrders(symbol, posSide);
                activeProtectedPositions.delete(posKey);
                
                for (const k of marketOpenedGrids) {
                    if (k.startsWith(`${symbol}_${posSide}`)) marketOpenedGrids.delete(k);
                }

                addBotLog(`<b style="color:#ff3355">🚨 [SL MARKET KHẨN CẤP]</b> <b style="color:#facc15">${symbol} ${posSide}</b>: Đã kích hoạt SL Market (${reason})!`, "error");
                slWatchTracker.delete(posKey);
            }
        }
    } else {
        slWatchTracker.delete(posKey);
    }
}

// WORKER SPAM VOLUME FUTURES
async function futuresSpamVolWorker() {
    if (status.isReady && botSettings.isRunning && botSettings.isSpamVol) {
        try {
            for (const symbol of botSettings.coinList) {
                if (!botSettings.isSpamVol || !botSettings.isRunning) break;

                const ticker = await binanceFutures.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
                const markP = ticker ? parseFloat(ticker.data.price) : 0;
                if (markP <= 0) continue;

                const qty = calculateOrderQtyForPrice(symbol, markP);
                if (qty <= 0) continue;

                const qStr = qty.toString();
                const lev = status.exchangeInfo[symbol]?.maxLeverage || 50;

                const openLong = await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol, side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: qStr
                }).catch(() => null);

                const openShort = await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol, side: 'SELL', positionSide: 'SHORT', type: 'MARKET', quantity: qStr
                }).catch(() => null);

                await new Promise(r => setTimeout(r, 150));

                const closeLong = await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol, side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: qStr
                }).catch(() => null);

                const closeShort = await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol, side: 'BUY', positionSide: 'SHORT', type: 'MARKET', quantity: qStr
                }).catch(() => null);

                const openLongP = parseFloat(openLong?.avgPrice || markP);
                const openShortP = parseFloat(openShort?.avgPrice || markP);
                const closeLongP = parseFloat(closeLong?.avgPrice || markP);
                const closeShortP = parseFloat(closeShort?.avgPrice || markP);

                const longVol = parseFloat(openLong?.cumQuote || (qty * openLongP));
                const shortVol = parseFloat(openShort?.cumQuote || (qty * openShortP));
                const cycleVol = longVol + shortVol;

                const longPnl = (closeLongP - openLongP) * qty;
                const shortPnl = (openShortP - closeShortP) * qty;
                const totalFee = (cycleVol * 2) * 0.0005;
                const netPnl = (longPnl + shortPnl) - totalFee;
                const marginUsed = ((cycleVol / 2) / lev).toFixed(2);

                let stat = volumeStats.get(symbol) || {
                    orderCount: 0, totalVolume: 0, totalPnL: 0, totalGridsRan: 0,
                    tpCount: 0, tpPnL: 0, slCount: 0, slPnL: 0, recordedTradeIds: new Set()
                };

                stat.orderCount += 2;
                stat.totalVolume += cycleVol;
                stat.totalPnL += netPnl;
                stat.totalGridsRan += 1;
                if (netPnl >= 0) {
                    stat.tpCount += 1;
                    stat.tpPnL += netPnl;
                } else {
                    stat.slCount += 1;
                    stat.slPnL += netPnl;
                }
                volumeStats.set(symbol, stat);
                saveData();

                let session = futuresSpamSessions.get(symbol);
                if (!session) {
                    session = { startTime: Date.now(), roundCount: 0, totalVolume: 0, totalPnL: 0, totalFee: 0, margin: marginUsed, lev };
                }
                session.roundCount += 1;
                session.totalVolume += cycleVol;
                session.totalPnL += netPnl;
                session.totalFee += totalFee;
                session.margin = marginUsed;
                session.lev = lev;
                futuresSpamSessions.set(symbol, session);

                updateFuturesSpamHeader(symbol, session);

                await new Promise(r => setTimeout(r, 600));
            }
        } catch (e) {}
    }
    setTimeout(futuresSpamVolWorker, 2200);
}

// WORKER SPAM VOLUME SPOT (QUÉT VÍ THỰC TẾ & BÁN CHÍNH XÁC)
async function spotSpamVolWorker() {
    if (status.isReady && spotSettings.isRunning && spotSettings.isSpamVol) {
        try {
            const allTickers = await binanceSpot.get('/api/v3/ticker/price').catch(() => null);
            const priceMap = new Map();
            if (allTickers && Array.isArray(allTickers.data)) {
                for (const item of allTickers.data) priceMap.set(item.symbol, parseFloat(item.price));
            }

            for (const symbol of spotSettings.coinList) {
                if (!spotSettings.isSpamVol || !spotSettings.isRunning) break;

                const markP = priceMap.get(symbol) || 0;
                if (markP <= 0) continue;

                const qty = calculateSpotOrderQty(symbol, markP);
                if (qty <= 0) continue;

                const quoteAsset = getQuoteAsset(symbol, true);
                const baseAsset = getBaseAsset(symbol, true);

                const accBefore = await binanceSpotPrivate('/api/v3/account').catch(() => null);
                const quoteBal = (accBefore?.balances || []).find(b => b.asset === quoteAsset);
                const freeQuote = parseFloat(quoteBal?.free || 0);

                if (freeQuote < qty * markP) {
                    addSpotLog(`<span style="color:#facc15">⚠️ [Spam Vol Spot] ${quoteAsset} không đủ (${freeQuote.toFixed(2)}$) để mua ${symbol}!</span>`, "warn");
                    continue;
                }

                const qBuyStr = roundQty(symbol, qty, true).toString();

                // 1. MUA MARKET
                const buyRes = await binanceSpotPrivate('/api/v3/order', 'POST', {
                    symbol, side: 'BUY', type: 'MARKET', quantity: qBuyStr
                }).catch(err => {
                    addSpotLog(`<b style="color:#ff3355">❌ [Lỗi Mua Market Spot]</b> ${symbol}: ${err.response?.data?.msg || err.message}`, "error");
                    return null;
                });

                if (buyRes) {
                    await new Promise(r => setTimeout(r, 250));

                    // 2. LẤY SỐ DƯ TOKEN CƠ SỞ THỰC TẾ ĐỂ BÁN HẾT
                    const accAfter = await binanceSpotPrivate('/api/v3/account').catch(() => null);
                    const baseBal = (accAfter?.balances || []).find(b => b.asset === baseAsset);
                    const freeBase = parseFloat(baseBal?.free || 0);
                    const qSellStr = roundQty(symbol, freeBase, true).toString();

                    let sellRes = null;
                    if (parseFloat(qSellStr) > 0) {
                        sellRes = await binanceSpotPrivate('/api/v3/order', 'POST', {
                            symbol, side: 'SELL', type: 'MARKET', quantity: qSellStr
                        }).catch(err => {
                            addSpotLog(`<b style="color:#ff3355">❌ [Lỗi Bán Market Spot]</b> ${symbol}: ${err.response?.data?.msg || err.message}`, "error");
                            return null;
                        });
                    }

                    if (sellRes) {
                        const buyP = parseFloat(buyRes.fills?.[0]?.price || markP);
                        const sellP = parseFloat(sellRes.fills?.[0]?.price || markP);
                        const buyVol = parseFloat(buyRes.cummulativeQuoteQty || (qty * buyP));
                        const sellVol = parseFloat(sellRes.cummulativeQuoteQty || (parseFloat(qSellStr) * sellP));

                        const buyFee = calculateFillsFee(buyRes.fills, priceMap, symbol) || (buyVol * 0.00075);
                        const sellFee = calculateFillsFee(sellRes.fills, priceMap, symbol) || (sellVol * 0.00075);
                        const totalFee = buyFee + sellFee;

                        const netPnl = (sellVol - buyVol) - totalFee;

                        let stat = spotStats.get(symbol) || {
                            totalBuyCount: 0, totalBuyVolume: 0, totalSellCount: 0, totalSellVolume: 0,
                            completedCycles: 0, totalFee: 0, totalPnL: 0, recordedTradeIds: new Set()
                        };

                        stat.totalBuyCount += 1;
                        stat.totalBuyVolume += buyVol;
                        stat.totalSellCount += 1;
                        stat.totalSellVolume += sellVol;
                        stat.completedCycles += 1;
                        stat.totalFee += totalFee;
                        stat.totalPnL += netPnl;
                        spotStats.set(symbol, stat);
                        saveData();

                        let session = spotSpamSessions.get(symbol);
                        if (!session) {
                            session = { startTime: Date.now(), roundCount: 0, totalVolume: 0, totalPnL: 0, totalFee: 0, margin: buyVol.toFixed(2) };
                        }
                        session.roundCount += 1;
                        session.totalVolume += (buyVol + sellVol);
                        session.totalPnL += netPnl;
                        session.totalFee += totalFee;
                        session.margin = buyVol.toFixed(2);
                        spotSpamSessions.set(symbol, session);

                        updateSpotSpamHeader(symbol, session);
                    }
                }

                await new Promise(r => setTimeout(r, 600));
            }
        } catch (e) {}
    }
    setTimeout(spotSpamVolWorker, 2500);
}

// =========================================================================
// SPOT GRID KHỞI TẠO & THEO DÕI THÔNG THƯỜNG
// =========================================================================
async function deploySpotGridLevel(symbol, levelPrice, qty, gridNum) {
    const buyOrder = await placeSpotMakerBuyOrder(symbol, levelPrice, qty, `SPOTBUY${Date.now()}`);
    return { gridNum, levelPrice, qty, orderId: buyOrder?.orderId };
}

async function initializeSpotCoinGrid(symbol) {
    const info = status.spotExchangeInfo[symbol];
    if (!info) return;

    try {
        const ticker = await binanceSpot.get(`/api/v3/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);
        const stepPct = spotSettings.gridOpenPct / 100;

        const queuePlan = [];
        for (let k = 1; k <= spotSettings.gridLevels; k++) {
            const p = initialEntry * (1 - (k * stepPct));
            const q = calculateSpotOrderQty(symbol, p);
            queuePlan.push({ gridNum: -k, price: p, qty: q });
        }

        const coinSpotGrid = {
            initialEntry,
            levels: [],
            isInitializing: true,
            lastBuyPrice: initialEntry,
            startTime: Date.now()
        };
        spotGridState.set(symbol, coinSpotGrid);

        let stat = spotStats.get(symbol) || {
            totalBuyCount: 0, totalBuyVolume: 0, totalSellCount: 0, totalSellVolume: 0,
            completedCycles: 0, totalFee: 0, totalPnL: 0, recordedTradeIds: new Set()
        };

        const pastTrades = await binanceSpotPrivate('/api/v3/myTrades', 'GET', { symbol, limit: 50 }).catch(() => []);
        if (Array.isArray(pastTrades)) {
            for (const t of pastTrades) {
                stat.recordedTradeIds.add(String(t.id));
            }
        }
        spotStats.set(symbol, stat);

        const quoteAsset = getQuoteAsset(symbol, true);
        const quoteBal = (spotAccountCache.balances || []).find(b => b.asset === quoteAsset);
        const freeQuote = parseFloat(quoteBal?.free || 0);

        for (const item of queuePlan) {
            if (!spotSettings.isRunning || spotSettings.isSpamVol) break;
            const requiredQuote = item.price * item.qty;
            if (freeQuote < requiredQuote) {
                addSpotLog(`<span style="color:#facc15">⚠️ [Spot] Số dư ${quoteAsset} khả dụng (${freeQuote.toFixed(2)}$) không đủ để đặt mốc Grid ${item.gridNum}!</span>`, "warn");
                break;
            }
            const lvlObj = await deploySpotGridLevel(symbol, item.price, item.qty, item.gridNum);
            coinSpotGrid.levels.push(lvlObj);
            await new Promise(r => setTimeout(r, 120));
        }

        coinSpotGrid.isInitializing = false;
        saveData();
    } catch (e) {
        addSpotLog(`<span style="color:#ff3355">⚠️ Lỗi khởi tạo Spot ${symbol}: ${e.message}</span>`, "warn");
    }
}

async function deploySpotTpSl(symbol, qty, buyPrice) {
    const cGrid = spotGridState.get(symbol);
    const initialEntry = cGrid?.initialEntry || buyPrice;
    const tpPct = spotSettings.tpSlPct;
    const slPct = spotSettings.tpSlPct * 0.5;

    const tpPrice = roundPrice(symbol, initialEntry * (1 + tpPct / 100), true);
    const slPrice = roundPrice(symbol, initialEntry * (1 - slPct / 100), true);

    const openOrders = await binanceSpotPrivate('/api/v3/openOrders', 'GET', { symbol }).catch(() => []);
    if (Array.isArray(openOrders)) {
        for (const o of openOrders) {
            if (o.side === 'SELL') {
                await binanceSpotPrivate('/api/v3/order', 'DELETE', { symbol, orderId: o.orderId }).catch(() => {});
            }
        }
    }

    await new Promise(r => setTimeout(r, 300));
    const baseAsset = getBaseAsset(symbol, true);
    const acc = await binanceSpotPrivate('/api/v3/account').catch(() => null);
    const baseBal = (acc?.balances || []).find(b => b.asset === baseAsset);
    const freeBase = parseFloat(baseBal?.free || 0);

    const sellQty = roundQty(symbol, Math.min(qty, freeBase), true);
    if (sellQty <= 0) return;

    const tpRes = await placeSpotLimitSellOrder(symbol, tpPrice, sellQty, `SPOTTP${Date.now()}`);

    if (cGrid) {
        cGrid.lastBuyPrice = buyPrice;
        cGrid.slPrice = slPrice;
        cGrid.tpOrderId = tpRes?.orderId;
    }

    addSpotLog(`open: <b style="color:#facc15">${symbol} SPOT</b>, KL: <span style="color:#facc15">${sellQty}</span>, giá mua: <b style="color:#facc15">${buyPrice}</b>, SL: <span style="color:#facc15">${slPrice} (-${slPct.toFixed(2)}%)</span>, TP: <span style="color:#facc15">${tpPrice} (+${tpPct.toFixed(2)}%)</span>`, "info");
}

async function monitorSpotWorker() {
    if (status.isReady && spotSettings.isRunning && !spotSettings.isSpamVol) {
        try {
            const allTickers = await binanceSpot.get('/api/v3/ticker/price').catch(() => null);
            const priceMap = new Map();
            if (allTickers && Array.isArray(allTickers.data)) {
                for (const item of allTickers.data) priceMap.set(item.symbol, parseFloat(item.price));
            }

            for (const symbol of spotSettings.coinList) {
                const markP = priceMap.get(symbol) || 0;
                const cGrid = spotGridState.get(symbol);

                if (cGrid && markP > 0) {
                    const buyP = cGrid.lastBuyPrice || cGrid.initialEntry;
                    
                    const currentSpotProfitPct = ((markP - buyP) / buyP) * 100;
                    if (currentSpotProfitPct >= (spotSettings.tpSlPct * 5)) {
                        const openOrders = await binanceSpotPrivate('/api/v3/openOrders', 'GET', { symbol }).catch(() => []);
                        for (const o of openOrders) {
                            await binanceSpotPrivate('/api/v3/order', 'DELETE', { symbol, orderId: o.orderId }).catch(() => {});
                        }
                        const baseAsset = getBaseAsset(symbol, true);
                        const bal = (spotAccountCache.balances || []).find(b => b.asset === baseAsset);
                        const freeQty = parseFloat(bal?.free || 0);
                        if (freeQty > 0) {
                            const qStr = roundQty(symbol, freeQty, true).toString();
                            await binanceSpotPrivate('/api/v3/order', 'POST', {
                                symbol, side: 'SELL', type: 'MARKET', quantity: qStr
                            }).catch(() => null);
                            addSpotLog(`<b style="color:#00ff88">🚀 [SPOT TP MARKET x5]</b> ${symbol}: Lãi đạt <b style="color:#00ff88">+${currentSpotProfitPct.toFixed(2)}%</b>! Đã bán Market chốt lời ngay!`, "success");
                        }
                    }

                    const slPrice = cGrid.slPrice || (cGrid.initialEntry * (1 - (spotSettings.tpSlPct * 0.5 / 100)));
                    if (markP <= slPrice) {
                        const trackKey = `SPOT_SL_${symbol}`;
                        if (!spotSlWatchTracker.has(trackKey)) {
                            spotSlWatchTracker.set(trackKey, Date.now());
                        } else {
                            if (Date.now() - spotSlWatchTracker.get(trackKey) >= 15000) {
                                const openOrders = await binanceSpotPrivate('/api/v3/openOrders', 'GET', { symbol }).catch(() => []);
                                for (const o of openOrders) {
                                    await binanceSpotPrivate('/api/v3/order', 'DELETE', { symbol, orderId: o.orderId }).catch(() => {});
                                }
                                const baseAsset = getBaseAsset(symbol, true);
                                const bal = (spotAccountCache.balances || []).find(b => b.asset === baseAsset);
                                const freeQty = parseFloat(bal?.free || 0);
                                if (freeQty > 0) {
                                    const qStr = roundQty(symbol, freeQty, true).toString();
                                    await binanceSpotPrivate('/api/v3/order', 'POST', {
                                        symbol, side: 'SELL', type: 'MARKET', quantity: qStr
                                    }).catch(() => null);
                                    addSpotLog(`<b style="color:#ff3355">🚨 [SPOT SL MARKET]</b> ${symbol}: Bán Market sau 15s cắt lỗ!`, "error");
                                }
                                spotSlWatchTracker.delete(trackKey);
                            }
                        }
                    } else {
                        spotSlWatchTracker.delete(`SPOT_SL_${symbol}`);
                    }
                }

                const trades = await binanceSpotPrivate('/api/v3/myTrades', 'GET', { symbol, limit: 20 }).catch(() => []);
                let stat = spotStats.get(symbol) || {
                    totalBuyCount: 0, totalBuyVolume: 0, totalSellCount: 0, totalSellVolume: 0,
                    completedCycles: 0, totalFee: 0, totalPnL: 0, recordedTradeIds: new Set()
                };

                let updated = false;
                for (const t of trades) {
                    const tradeId = String(t.id);
                    if (stat.recordedTradeIds.has(tradeId) || (cGrid?.startTime && t.time < cGrid.startTime)) {
                        stat.recordedTradeIds.add(tradeId);
                        continue;
                    }

                    stat.recordedTradeIds.add(tradeId);
                    const qty = parseFloat(t.qty);
                    const price = parseFloat(t.price);
                    const val = parseFloat(t.quoteQty || (qty * price));
                    
                    const realFeeUsd = calculateTradeFeeUsd(t, priceMap, symbol);
                    stat.totalFee += realFeeUsd;

                    if (t.isBuyer) {
                        stat.totalBuyCount += 1;
                        stat.totalBuyVolume += val;
                        await deploySpotTpSl(symbol, qty, price);
                    } else {
                        stat.totalSellCount += 1;
                        stat.totalSellVolume += val;
                        stat.completedCycles += 1;

                        const initialE = cGrid?.lastBuyPrice || cGrid?.initialEntry || price;
                        const pnlRaw = (price - initialE) * qty;
                        const pnlNet = pnlRaw - realFeeUsd;
                        stat.totalPnL += pnlNet;

                        addSpotLog(`close: <b style="color:#facc15">${symbol} SPOT</b>, giá bán: <b style="color:#facc15">${price}</b>, fee: <span style="color:#facc15">${realFeeUsd.toFixed(4)}$</span>, pnl: <b style="${pnlNet>=0?'color:#00ff88':'color:#ff3355'}">${pnlNet >= 0 ? '+' : ''}${pnlNet.toFixed(4)}$</b>`, pnlNet >= 0 ? "success" : "error");
                    }
                    updated = true;
                }
                spotStats.set(symbol, stat);
                if (updated) saveData();
            }
        } catch (e) {}
    }
    setTimeout(monitorSpotWorker, 2500);
}

async function syncSpotAccountWorker() {
    try {
        const acc = await binanceSpotPrivate('/api/v3/account');
        if (acc && acc.balances) {
            spotAccountCache.balances = acc.balances;
            const usdtBal = acc.balances.find(b => b.asset === 'USDT');
            const usdcBal = acc.balances.find(b => b.asset === 'USDC');
            const usd1Bal = acc.balances.find(b => b.asset === 'USD1');
            const fdusdBal = acc.balances.find(b => b.asset === 'FDUSD');
            
            const totalAvail = parseFloat(usdtBal?.free || 0) + parseFloat(usdcBal?.free || 0) + parseFloat(usd1Bal?.free || 0) + parseFloat(fdusdBal?.free || 0);
            const totalWallet = totalAvail + parseFloat(usdtBal?.locked || 0) + parseFloat(usdcBal?.locked || 0) + parseFloat(usd1Bal?.locked || 0) + parseFloat(fdusdBal?.locked || 0);

            spotAccountCache.availableBalance = totalAvail.toFixed(2);
            spotAccountCache.totalWalletBalance = totalWallet.toFixed(2);

            let totalHoldingUsdt = 0;
            const allTickers = await binanceSpot.get('/api/v3/ticker/price').catch(() => null);
            const priceMap = new Map();
            if (allTickers && Array.isArray(allTickers.data)) {
                for (const item of allTickers.data) priceMap.set(item.symbol, parseFloat(item.price));
            }

            for (const b of acc.balances) {
                const totalAmt = parseFloat(b.free) + parseFloat(b.locked);
                if (totalAmt > 0 && !['USDT', 'USDC', 'USD1', 'FDUSD'].includes(b.asset)) {
                    const price = priceMap.get(`${b.asset}USDT`) || priceMap.get(`${b.asset}USDC`) || 0;
                    totalHoldingUsdt += (totalAmt * price);
                }
            }
            spotAccountCache.holdingValue = totalHoldingUsdt.toFixed(2);
        }
    } catch (e) {}
    setTimeout(syncSpotAccountWorker, 3500);
}

// =========================================================================
// LUỒNG GIÁM SÁT FUTURES THÔNG THƯỜNG
// =========================================================================
async function monitorGridWorker() {
    if (status.isReady && botSettings.isRunning && !botSettings.isSpamVol) {
        try {
            const allTickersRes = await binanceFutures.get('/fapi/v1/ticker/price').catch(() => null);
            const priceMap = new Map();
            if (allTickersRes && Array.isArray(allTickersRes.data)) {
                for (const item of allTickersRes.data) priceMap.set(item.symbol, parseFloat(item.price));
            }

            for (const symbol of botSettings.coinList) {
                const markP = priceMap.get(symbol) || 0;
                if (markP > 0) {
                    await handleTrailing(symbol, markP);
                    await checkSlMarketEmergency(symbol, markP);
                    await handleOneWayGridEmergency(symbol, markP);
                    await checkTpMarketX5(symbol, markP);
                }

                const openPositions = (accountCache.rawPositions || []).filter(
                    p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0
                );

                for (const p of openPositions) {
                    const posSide = p.positionSide;
                    const posAmt = Math.abs(parseFloat(p.positionAmt));
                    const entryPrice = parseFloat(p.entryPrice);
                    const posKey = `${symbol}_${posSide}`;

                    const prot = activeProtectedPositions.get(posKey);
                    if (!prot || Math.abs(prot.amt - posAmt) > 0.00001) {
                        const isMarketOpen = prot?.isMarketOpen || false;
                        await deployTpSlForPosition(symbol, posSide, posAmt, entryPrice, isMarketOpen);
                    }
                }

                for (const [key, prot] of activeProtectedPositions.entries()) {
                    if (key.startsWith(symbol + '_')) {
                        const side = key.split('_')[1];
                        const stillOpen = openPositions.some(p => p.positionSide === side);
                        if (!stillOpen) {
                            activeProtectedPositions.delete(key);
                            await cancelOpenTpOrders(symbol, side);
                            await cancelOpenSlAlgoOrders(symbol, side);
                        }
                    }
                }

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 20 }).catch(() => []);
                let stat = volumeStats.get(symbol) || {
                    orderCount: 0, totalVolume: 0, totalPnL: 0, totalGridsRan: 0,
                    tpCount: 0, tpPnL: 0, slCount: 0, slPnL: 0, recordedTradeIds: new Set()
                };

                let updated = false;
                for (const t of trades) {
                    const tradeIdStr = String(t.id);
                    if (!stat.recordedTradeIds.has(tradeIdStr)) {
                        stat.recordedTradeIds.add(tradeIdStr);
                        stat.orderCount += 1;

                        const qty = parseFloat(t.qty);
                        const price = parseFloat(t.price);
                        const val = parseFloat(t.quoteQty || (qty * price));
                        stat.totalVolume += val;

                        const pnl = parseFloat(t.realizedPnl || 0);
                        stat.totalPnL += pnl;

                        const lev = status.exchangeInfo[symbol]?.maxLeverage || 50;
                        const margin = ((qty * price) / lev).toFixed(2);

                        if (Math.abs(pnl) > 0) {
                            let openP;
                            if (t.positionSide === 'LONG') openP = (price - (pnl / qty)).toFixed(4);
                            else openP = (price + (pnl / qty)).toFixed(4);

                            const gridTag = getGridTagForPrice(symbol, parseFloat(openP));
                            slWatchTracker.delete(`${symbol}_${t.positionSide}`);
                            activeProtectedPositions.delete(`${symbol}_${t.positionSide}`);
                            await cancelOpenTpOrders(symbol, t.positionSide);
                            await cancelOpenSlAlgoOrders(symbol, t.positionSide);

                            for (const k of marketOpenedGrids) {
                                if (k.startsWith(`${symbol}_${t.positionSide}`)) marketOpenedGrids.delete(k);
                            }

                            if (pnl > 0) {
                                stat.tpCount += 1;
                                stat.tpPnL += pnl;
                                addBotLog(`<b style="color:#facc15">[GRID ${gridTag}]</b> close: <b style="color:#facc15">${symbol}</b> <b style="color:#facc15">${t.positionSide}</b> <span style="color:#facc15">x${lev}</span>, margin: <span style="color:#facc15">${margin}$</span>, giá open: <span style="color:#facc15">${openP}</span>, giá đóng: <span style="color:#facc15">${price}</span>, pnl: <b style="color:#00ff88;font-weight:bold">+${pnl.toFixed(4)}$</b>`, "success");
                            } else {
                                stat.slCount += 1;
                                stat.slPnL += pnl;
                                addBotLog(`<b style="color:#facc15">[GRID ${gridTag}]</b> close: <b style="color:#facc15">${symbol}</b> <b style="color:#facc15">${t.positionSide}</b> <span style="color:#facc15">x${lev}</span>, margin: <span style="color:#facc15">${margin}$</span>, giá open: <span style="color:#facc15">${openP}</span>, giá đóng: <span style="color:#facc15">${price}</span>, pnl: <b style="color:#ff3355;font-weight:bold">${pnl.toFixed(4)}$</b>`, "error");
                            }
                        }
                        updated = true;
                    }
                }
                volumeStats.set(symbol, stat);
                if (updated) saveData();
            }
        } catch (e) {}
    }
    setTimeout(monitorGridWorker, 2200);
}

async function handleTrailing(symbol, markPrice) {
    const cState = gridState.get(symbol);
    if (!cState || cState.isInitializing || cState.isTrailing) return;

    const stepPct = botSettings.gridOpenPct / 100;
    const initialEntry = cState.initialEntry;
    const nextUpperIndex = cState.currentCenterIndex + 1;
    const nextLowerIndex = cState.currentCenterIndex - 1;

    const upperThreshold = initialEntry * (1 + (nextUpperIndex * stepPct));
    const lowerThreshold = initialEntry * (1 + (nextLowerIndex * stepPct));

    if (markPrice >= upperThreshold && cState.upperLevels.length > 0) {
        cState.isTrailing = true;
        try {
            const newUpperGridNum = Math.max(...cState.upperLevels.map(l => l.gridNum)) + 1;
            const newUpperPrice = initialEntry * (1 + (newUpperGridNum * stepPct));
            const newUpper = await deployGridLevel(symbol, newUpperPrice, initialEntry, newUpperGridNum);

            if (cState.lowerLevels.length > 0) {
                const removedLower = cState.lowerLevels.shift();
                await cancelGridLevelOrders(symbol, removedLower);
            }

            cState.currentCenterIndex = nextUpperIndex;
            const crossed = cState.upperLevels.shift();
            if (crossed) cState.lowerLevels.push(crossed);
            cState.upperLevels.push(newUpper);

            const stat = volumeStats.get(symbol);
            if (stat) stat.totalGridsRan += 1;
            saveData();
        } catch (e) {} finally {
            cState.isTrailing = false;
        }
    } else if (markPrice <= lowerThreshold && cState.lowerLevels.length > 0) {
        cState.isTrailing = true;
        try {
            const newLowerGridNum = Math.min(...cState.lowerLevels.map(l => l.gridNum)) - 1;
            const newLowerPrice = initialEntry * (1 + (newLowerGridNum * stepPct));
            const newLower = await deployGridLevel(symbol, newLowerPrice, initialEntry, newLowerGridNum);

            if (cState.upperLevels.length > 0) {
                const removedUpper = cState.upperLevels.pop();
                await cancelGridLevelOrders(symbol, removedUpper);
            }

            cState.currentCenterIndex = nextLowerIndex;
            const crossed = cState.lowerLevels.pop();
            if (crossed) cState.upperLevels.unshift(crossed);
            cState.lowerLevels.unshift(newLower);

            const stat = volumeStats.get(symbol);
            if (stat) stat.totalGridsRan += 1;
            saveData();
        } catch (e) {} finally {
            cState.isTrailing = false;
        }
    }
}

async function syncAccountWorker() {
    try {
        const ban = checkBanStatus();
        if (!ban.isBanned) {
            const acc = await binancePrivate('/fapi/v2/account');
            if (acc) {
                const totalWallet = parseFloat(acc.totalWalletBalance || acc.totalMarginBalance || 0);
                const avail = parseFloat(acc.availableBalance || 0);

                accountCache.totalWalletBalance = totalWallet.toFixed(2);
                accountCache.availableBalance = avail.toFixed(2);
                accountCache.totalUnrealizedProfit = parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2);
                accountCache.rawPositions = acc.positions || [];
                accountCache.lastUpdate = Date.now();

                if (totalWallet > 0 && botSettings.isRunning && !botSettings.isSpamVol) {
                    const availRatio = (avail / totalWallet) * 100;
                    if (availRatio < LIQUIDATION_PROTECT_RATIO) {
                        addBotLog(`<span style="color:#facc15">⚠️ [BẢO VỆ THANH LÝ] Khả dụng còn ${availRatio.toFixed(1)}% (<15% ví). Tự động đóng hết vị thế & DỪNG BOT!</span>`, "warn");
                        botSettings.isRunning = false;
                        saveData();

                        for (const p of (acc.positions || [])) {
                            const amt = parseFloat(p.positionAmt);
                            if (Math.abs(amt) > 0) {
                                const closeSide = p.positionSide === 'LONG' ? 'SELL' : 'BUY';
                                await binancePrivate('/fapi/v1/order', 'POST', {
                                    symbol: p.symbol, side: closeSide, positionSide: p.positionSide,
                                    type: 'MARKET', quantity: Math.abs(amt).toString()
                                }).catch(() => {});
                            }
                        }

                        for (const sym of botSettings.coinList) {
                            await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol: sym }).catch(() => {});
                            await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol: sym }).catch(() => {});
                            gridState.delete(sym);
                        }
                    }
                }
            }
        }
    } catch (e) {}
    setTimeout(syncAccountWorker, 2200);
}

function getGridTagForPrice(symbol, fillPrice) {
    const cState = gridState.get(symbol);
    if (!cState || !cState.initialEntry) return "?";
    const initialE = cState.initialEntry;
    const step = (botSettings.gridOpenPct / 100) * initialE;
    if (step <= 0) return "?";

    const diff = fillPrice - initialE;
    let k = Math.round(diff / step);
    if (k === 0) k = diff >= 0 ? 1 : -1;
    return k > 0 ? `+${k}` : `${k}`;
}

async function initializeCoinGrid(symbol) {
    const info = status.exchangeInfo[symbol];
    if (!info) return;

    try {
        const maxLev = await fetchMaxLeverage(symbol);
        info.maxLeverage = maxLev;

        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});
        await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(() => {});
        await binancePrivate('/fapi/v1/leverage', 'POST', { symbol, leverage: maxLev }).catch(() => {});

        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});

        const ticker = await binanceFutures.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);
        const stepPct = botSettings.gridOpenPct / 100;

        const queuePlan = [];
        for (let k = botSettings.gridLevels; k >= 1; k--) {
            queuePlan.push({ gridNum: k, price: initialEntry * (1 + (k * stepPct)) });
            queuePlan.push({ gridNum: -k, price: initialEntry * (1 - (k * stepPct)) });
        }

        const currentCoinGrid = {
            initialEntry,
            currentCenterIndex: 0,
            upperLevels: [],
            lowerLevels: [],
            isInitializing: true,
            isTrailing: false
        };
        gridState.set(symbol, currentCoinGrid);

        let stat = volumeStats.get(symbol) || {
            orderCount: 0, totalVolume: 0, totalPnL: 0, totalGridsRan: 0,
            tpCount: 0, tpPnL: 0, slCount: 0, slPnL: 0, recordedTradeIds: new Set()
        };

        const pastTrades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 20 }).catch(() => []);
        if (Array.isArray(pastTrades)) {
            pastTrades.forEach(t => stat.recordedTradeIds.add(String(t.id)));
        }
        volumeStats.set(symbol, stat);

        for (const item of queuePlan) {
            if (!botSettings.isRunning || botSettings.isSpamVol) break;
            const levelObj = await deployGridLevel(symbol, item.price, initialEntry, item.gridNum);
            if (item.gridNum > 0) currentCoinGrid.upperLevels.push(levelObj);
            else currentCoinGrid.lowerLevels.push(levelObj);
            await new Promise(r => setTimeout(r, 120));
        }

        currentCoinGrid.upperLevels.sort((a, b) => a.levelPrice - b.levelPrice);
        currentCoinGrid.lowerLevels.sort((a, b) => b.levelPrice - a.levelPrice);
        currentCoinGrid.isInitializing = false;

        stat.totalGridsRan += (currentCoinGrid.upperLevels.length + currentCoinGrid.lowerLevels.length);
        saveData();
    } catch (e) {
        addBotLog(`<span style="color:#facc15">⚠️ Lỗi khởi tạo Futures ${symbol}: ${e.message}</span>`, "warn");
    }
}

async function processQueue() {
    if (isQueueProcessing) return;
    isQueueProcessing = true;

    while (initCoinQueue.length > 0 && botSettings.isRunning && !botSettings.isSpamVol) {
        const symbol = initCoinQueue.shift();
        await initializeCoinGrid(symbol);
        await new Promise(r => setTimeout(r, 800));
    }

    while (spotInitCoinQueue.length > 0 && spotSettings.isRunning && !spotSettings.isSpamVol) {
        const symbol = spotInitCoinQueue.shift();
        await initializeSpotCoinGrid(symbol);
        await new Promise(r => setTimeout(r, 800));
    }

    isQueueProcessing = false;
}

// KHỞI CHẠY HỆ THỐNG
async function init() {
    loadSavedData();
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time', { timeout: 5000 }).catch(() => null);
        if (t && t.data) timestampOffset = t.data.serverTime - Date.now();

        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});

        const info = await binanceFutures.get('/fapi/v1/exchangeInfo');
        const temp = {};
        info.data.symbols.forEach(s => {
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL') || s.filters.find(f => f.filterType === 'NOTIONAL');
            temp[s.symbol] = {
                baseAsset: s.baseAsset,
                quoteAsset: s.quoteAsset,
                quantityPrecision: s.quantityPrecision ?? 2,
                pricePrecision: s.pricePrecision ?? 4,
                stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.001,
                minQty: lotFilter ? parseFloat(lotFilter.minQty) : 0.001,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.0001,
                minNotional: notionalFilter ? parseFloat(notionalFilter.notional || notionalFilter.minNotional || 5.0) : 5.0,
                maxLeverage: 50
            };
        });

        const spotInfoRes = await binanceSpot.get('/api/v3/exchangeInfo');
        const spotTemp = {};
        spotInfoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const price = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const notional = s.filters.find(f => f.filterType === 'NOTIONAL') || s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            spotTemp[s.symbol] = {
                baseAsset: s.baseAsset,
                quoteAsset: s.quoteAsset,
                quantityPrecision: s.baseAssetPrecision ?? 2,
                pricePrecision: s.quotePrecision ?? 4,
                stepSize: lot ? parseFloat(lot.stepSize) : 0.001,
                minQty: lot ? parseFloat(lot.minQty) : 0.001,
                tickSize: price ? parseFloat(price.tickSize) : 0.0001,
                minNotional: notional ? parseFloat(notional.minNotional || 10.0) : 10.0
            };
        });

        try {
            const brk = await binancePrivate('/fapi/v1/leverageBracket');
            if (Array.isArray(brk)) {
                brk.forEach(b => {
                    if (temp[b.symbol]) temp[b.symbol].maxLeverage = b.brackets[0]?.initialLeverage || 50;
                });
            }
        } catch (e) {}

        for (const sym of botSettings.coinList) {
            await binancePrivate('/fapi/v1/marginType', 'POST', { symbol: sym, marginType: 'CROSSED' }).catch(() => {});
        }

        status.exchangeInfo = temp;
        status.spotExchangeInfo = spotTemp;
        status.isReady = true;

        const firstAcc = await binancePrivate('/fapi/v2/account').catch(() => null);
        if (firstAcc) {
            accountCache.totalWalletBalance = parseFloat(firstAcc.totalWalletBalance || firstAcc.totalMarginBalance || 0).toFixed(2);
            accountCache.availableBalance = parseFloat(firstAcc.availableBalance || 0).toFixed(2);
            accountCache.totalUnrealizedProfit = parseFloat(firstAcc.totalUnrealizedProfit || 0).toFixed(2);
            accountCache.rawPositions = firstAcc.positions || [];
            accountCache.lastUpdate = Date.now();
        }

    } catch (e) {
        addBotLog(`<span style="color:#facc15">⚠️ Lỗi kết nối sàn: ${e.message}</span>`, "warn");
    }

    updateRateLimitHeader();
    syncAccountWorker();
    monitorGridWorker();
    futuresSpamVolWorker();
    syncSpotAccountWorker();
    monitorSpotWorker();
    spotSpamVolWorker();
}
init();

// =========================================================================
// API & WEB SERVER
// =========================================================================
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/', (req, res) => {
    const p1 = path.join(__dirname, 'index.html');
    const p2 = path.join(__dirname, 'index (50).html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.send("Đã chạy server bot Grid Futures & Spot.");
});

APP.get('/api/status', (req, res) => {
    const ban = checkBanStatus();

    const openPositions = (accountCache.rawPositions || [])
        .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0 && gridState.has(p.symbol))
        .map(p => {
            const sym = p.symbol;
            const cState = gridState.get(sym);
            const initialE = cState?.initialEntry || parseFloat(p.entryPrice);
            const markP = parseFloat(p.markPrice || p.entryPrice);
            const distPct = initialE > 0 ? ((markP - initialE) / initialE) * 100 : 0;
            const info = status.exchangeInfo[sym] || { maxLeverage: 50 };
            const maxLev = info.maxLeverage || 50;

            return {
                symbol: sym,
                side: p.positionSide,
                leverage: p.leverage || maxLev,
                margin: parseFloat(p.isolatedMargin || (Math.abs(parseFloat(p.positionAmt)) * markP / (p.leverage || maxLev))).toFixed(2),
                qty: Math.abs(parseFloat(p.positionAmt)),
                initialEntry: initialE,
                currentPrice: markP,
                entryPrice: parseFloat(p.entryPrice),
                distPct: distPct.toFixed(2),
                pnl: parseFloat(p.unrealizedProfit)
            };
        });

    const allStatSymbols = Array.from(new Set([...Array.from(volumeStats.keys()), ...botSettings.coinList]));
    const volumeData = allStatSymbols.map((s, idx) => {
        const st = volumeStats.get(s) || { 
            orderCount: 0, totalVolume: 0, totalPnL: 0, totalGridsRan: 0,
            tpCount: 0, tpPnL: 0, slCount: 0, slPnL: 0 
        };
        const info = status.exchangeInfo[s] || { maxLeverage: 50 };
        return {
            stt: idx + 1,
            symbol: s,
            leverage: info.maxLeverage || 50,
            totalVolume: (st.totalVolume || 0).toFixed(2),
            totalGrids: st.totalGridsRan || 0,
            tpDisplay: `${st.tpCount || 0} / +${(st.tpPnL || 0).toFixed(4)}$`,
            slDisplay: `${st.slCount || 0} / ${(st.slPnL || 0).toFixed(4)}$`,
            totalPnL: (st.totalPnL || 0).toFixed(4)
        };
    });

    const allSpotSymbols = Array.from(new Set([...Array.from(spotStats.keys()), ...spotSettings.coinList]));
    let totalSpotBuyCount = 0, totalSpotBuyVol = 0, totalSpotSellCount = 0, totalSpotSellVol = 0;

    const spotDetailData = allSpotSymbols.map((s, idx) => {
        const st = spotStats.get(s) || {
            totalBuyCount: 0, totalBuyVolume: 0, totalSellCount: 0, totalSellVolume: 0,
            completedCycles: 0, totalFee: 0, totalPnL: 0
        };

        totalSpotBuyCount += st.totalBuyCount;
        totalSpotBuyVol += st.totalBuyVolume;
        totalSpotSellCount += st.totalSellCount;
        totalSpotSellVol += st.totalSellVolume;

        const avgBuyPrice = st.totalBuyCount > 0 ? (st.totalBuyVolume / st.totalBuyCount) : 0;
        const avgSellPrice = st.totalSellCount > 0 ? (st.totalSellVolume / st.totalSellCount) : 0;
        const totalCoinVol = st.totalBuyVolume + st.totalSellVolume;

        return {
            stt: idx + 1,
            symbol: s,
            cycles: st.completedCycles || 0,
            buyDisplay: `${st.totalBuyCount} / ${avgBuyPrice.toFixed(2)}$`,
            sellDisplay: `${st.totalSellCount} / ${avgSellPrice.toFixed(2)}$`,
            volume: totalCoinVol.toFixed(2),
            fee: (st.totalFee || 0).toFixed(4),
            pnl: (st.totalPnL || 0).toFixed(4)
        };
    });

    const spotOverview = {
        walletBalance: spotAccountCache.totalWalletBalance,
        availableBalance: spotAccountCache.availableBalance,
        holdingValueUsdt: spotAccountCache.holdingValue,
        totalBuyCount: totalSpotBuyCount,
        totalBuyVolume: totalSpotBuyVol.toFixed(2),
        totalSellCount: totalSpotSellCount,
        totalSellVolume: totalSpotSellVol.toFixed(2),
        totalTradeCount: totalSpotBuyCount + totalSpotSellCount,
        totalTradeVolume: (totalSpotBuyVol + totalSpotSellVol).toFixed(2)
    };

    res.json({
        botSettings,
        spotSettings,
        openPositions,
        volumeData,
        spotOverview,
        spotDetailData,
        status: {
            ...status,
            usedWeight1m: `${rateLimiter.currentUsedWeight1m} / 2400`,
            ipBannedUntilStr: ban.isBanned ? `${ban.remainingSec}s còn lại` : "Hoạt động bình thường"
        },
        wallet: {
            totalWalletBalance: accountCache.totalWalletBalance,
            availableBalance: accountCache.availableBalance,
            totalUnrealizedProfit: accountCache.totalUnrealizedProfit
        }
    });
});

APP.post('/api/settings', async (req, res) => {
    const { isRunning, isSpamVol, invValue, gridOpenPct, tpSlPct, gridLevels } = req.body;
    if (invValue !== undefined) botSettings.invValue = invValue;
    if (gridOpenPct !== undefined) botSettings.gridOpenPct = parseFloat(gridOpenPct);
    if (tpSlPct !== undefined) botSettings.tpSlPct = parseFloat(tpSlPct);
    if (gridLevels !== undefined) botSettings.gridLevels = parseInt(gridLevels);

    if (isSpamVol !== undefined && isSpamVol !== botSettings.isSpamVol) {
        if (!isSpamVol && botSettings.isSpamVol) {
            finalizeFuturesSpamSession();
        }
        botSettings.isSpamVol = isSpamVol;
        if (botSettings.isSpamVol) {
            for (const sym of botSettings.coinList) {
                await binancePrivate('/fapi/v1/algoOpenOrders', { symbol: sym }, 'DELETE').catch(() => {});
                await binancePrivate('/fapi/v1/allOpenOrders', { symbol: sym }, 'DELETE').catch(() => {});
            }
        }
    }

    if (isRunning !== undefined && isRunning !== botSettings.isRunning) {
        if (!isRunning && botSettings.isSpamVol) {
            finalizeFuturesSpamSession();
        }
        botSettings.isRunning = isRunning;
        saveData();
        if (botSettings.isRunning) {
            if (!botSettings.isSpamVol) {
                initCoinQueue = [...new Set(botSettings.coinList)];
                processQueue();
            }
        } else {
            initCoinQueue = [];
            for (const sym of botSettings.coinList) {
                try {
                    await binancePrivate('/fapi/v1/algoOpenOrders', { symbol: sym }, 'DELETE');
                    await binancePrivate('/fapi/v1/allOpenOrders', { symbol: sym }, 'DELETE');
                } catch (e) {}
                gridState.delete(sym);
            }
        }
    }

    saveData();
    res.json({ success: true, botSettings });
});

APP.post('/api/spot/settings', async (req, res) => {
    const { isRunning, isSpamVol, invValue, gridOpenPct, tpSlPct, gridLevels } = req.body;
    if (invValue !== undefined) spotSettings.invValue = invValue;
    if (gridOpenPct !== undefined) spotSettings.gridOpenPct = parseFloat(gridOpenPct);
    if (tpSlPct !== undefined) spotSettings.tpSlPct = parseFloat(tpSlPct);
    if (gridLevels !== undefined) spotSettings.gridLevels = parseInt(gridLevels);

    if (isSpamVol !== undefined && isSpamVol !== spotSettings.isSpamVol) {
        if (!isSpamVol && spotSettings.isSpamVol) {
            finalizeSpotSpamSession();
        }
        spotSettings.isSpamVol = isSpamVol;
        if (spotSettings.isSpamVol) {
            for (const sym of spotSettings.coinList) {
                const openOrders = await binanceSpotPrivate('/api/v3/openOrders', 'GET', { symbol: sym }).catch(() => []);
                for (const o of openOrders) {
                    await binanceSpotPrivate('/api/v3/order', 'DELETE', { symbol, orderId: o.orderId }).catch(() => {});
                }
            }
        }
    }

    if (isRunning !== undefined && isRunning !== spotSettings.isRunning) {
        if (!isRunning && spotSettings.isSpamVol) {
            finalizeSpotSpamSession();
        }
        spotSettings.isRunning = isRunning;
        saveData();
        if (spotSettings.isRunning) {
            if (!spotSettings.isSpamVol) {
                spotInitCoinQueue = [...new Set(spotSettings.coinList)];
                processQueue();
            }
        } else {
            spotInitCoinQueue = [];
            for (const sym of spotSettings.coinList) {
                try {
                    const openOrders = await binanceSpotPrivate('/api/v3/openOrders', 'GET', { symbol: sym }).catch(() => []);
                    for (const o of openOrders) {
                        await binanceSpotPrivate('/api/v3/order', 'DELETE', { symbol, orderId: o.orderId }).catch(() => {});
                    }
                } catch (e) {}
                spotGridState.delete(sym);
            }
        }
    }

    saveData();
    res.json({ success: true, spotSettings });
});

APP.post('/api/coins/add', async (req, res) => {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: "Trống" });

    const rawList = input.split(',');
    for (const raw of rawList) {
        const formatted = formatSymbolAuto(raw, false);
        if (formatted && !botSettings.coinList.includes(formatted)) {
            await binancePrivate('/fapi/v1/marginType', 'POST', { symbol: formatted, marginType: 'CROSSED' }).catch(() => {});
            botSettings.coinList.push(formatted);
            if (botSettings.isRunning && !botSettings.isSpamVol) {
                initCoinQueue.push(formatted);
                processQueue();
            }
        }
    }
    saveData();
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.post('/api/coins/remove', async (req, res) => {
    const { symbol } = req.body;
    botSettings.coinList = botSettings.coinList.filter(c => c !== symbol);
    initCoinQueue = initCoinQueue.filter(c => c !== symbol);
    saveData();
    try {
        await binancePrivate('/fapi/v1/algoOpenOrders', { symbol }, 'DELETE');
        await binancePrivate('/fapi/v1/allOpenOrders', { symbol }, 'DELETE');
    } catch (e) {}
    gridState.delete(symbol);
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.post('/api/spot/coins/add', async (req, res) => {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: "Trống" });

    const rawList = input.split(',');
    for (const raw of rawList) {
        const formatted = formatSymbolAuto(raw, true);
        if (formatted && !spotSettings.coinList.includes(formatted)) {
            spotSettings.coinList.push(formatted);
            if (spotSettings.isRunning && !spotSettings.isSpamVol) {
                spotInitCoinQueue.push(formatted);
                processQueue();
            }
        }
    }
    saveData();
    res.json({ success: true, coinList: spotSettings.coinList });
});

APP.post('/api/spot/coins/remove', async (req, res) => {
    const { symbol } = req.body;
    spotSettings.coinList = spotSettings.coinList.filter(c => c !== symbol);
    spotInitCoinQueue = spotInitCoinQueue.filter(c => c !== symbol);
    saveData();
    try {
        const openOrders = await binanceSpotPrivate('/api/v3/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binanceSpotPrivate('/api/v3/order', 'DELETE', { symbol, orderId: o.orderId }).catch(() => {});
        }
    } catch (e) {}
    spotGridState.delete(symbol);
    res.json({ success: true, coinList: spotSettings.coinList });
});

APP.listen(PORT, () => {
    console.log(`🚀 BOT GRID VOLUME FUTURES & SPOT ĐANG CHẠY TẠI PORT: ${PORT}`);
});
