import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

// =========================================================================
// CẤU HÌNH HỆ THỐNG GRID VOLUME FUTURES & SPOT HYBRID (FIX HEDGE MODE)
// =========================================================================
const PORT = 3334;
const MIN_ORDER_DELAY_MS = 120;
const LIQUIDATION_PROTECT_RATIO = 15;
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bot_data.json');

const SAFE_WEIGHT_CEILING = 2000;
const MAX_ORDERS_PER_10S = 240;
const SL_MARKET_TIMEOUT_MS = 5000;
const SL_MARKET_SLIPPAGE_PCT = 0.2;
const OPEN_MARKET_TIMEOUT_MS = 5000;
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

// CẤU HÌNH FUTURES
let botSettings = {
    isRunning: false,
    invValue: "0.1%",
    gridOpenPct: 1.0,
    tpSlPct: 1.0,
    gridLevels: 5,
    coinList: ['BTCUSDC', 'ETHUSDT']
};

// CẤU HÌNH SPOT
let spotSettings = {
    isRunning: false,
    invValue: "10",
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
let openTriggerTracker = new Map();

let spotGridState = new Map();
let spotStats = new Map();
let spotSlWatchTracker = new Map();

let gridState = new Map();
let volumeStats = new Map();
let initCoinQueue = [];
let spotInitCoinQueue = [];
let isQueueProcessing = false;
let timestampOffset = 0;

// =========================================================================
// BỘ LỌC CHỐNG SPAM LOG
// =========================================================================
let lastLogText = '';
const errorThrottleMap = new Map();

function addBotLog(msg, type = 'info') {
    const cleanMsg = msg.replace(/<[^>]*>?/gm, '').trim();
    const now = Date.now();

    if (cleanMsg === lastLogText) return;
    if (type === 'error' || type === 'warn' || cleanMsg.includes('Lỗi') || cleanMsg.includes('CẢNH BÁO') || cleanMsg.includes('BANNED') || cleanMsg.includes('THIẾU')) {
        if (errorThrottleMap.has(cleanMsg)) {
            const lastTime = errorThrottleMap.get(cleanMsg);
            if (now - lastTime < 120000) return;
        }
        errorThrottleMap.set(cleanMsg, now);
    }
    lastLogText = cleanMsg;

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };

    if (status.botLogs.length > 0 && status.botLogs[0].isHeader) {
        status.botLogs.splice(1, 0, logItem);
    } else {
        status.botLogs.unshift(logItem);
    }
    if (status.botLogs.length > 200) status.botLogs.pop();
    console.log(`[FUTU ${time}] ${cleanMsg}`);
}

function addSpotLog(msg, type = 'info') {
    const cleanMsg = msg.replace(/<[^>]*>?/gm, '').trim();
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.spotLogs.unshift({ time, msg, type });
    if (status.spotLogs.length > 200) status.spotLogs.pop();
    console.log(`[SPOT ${time}] ${cleanMsg}`);
}

// =========================================================================
// RATE LIMIT GUARDIAN
// =========================================================================
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

    if (status.botLogs.length > 0 && status.botLogs[0].isHeader) {
        status.botLogs[0].msg = headerMsg;
        status.botLogs[0].time = time;
    } else {
        status.botLogs.unshift({ time, msg: headerMsg, type: 'info', isHeader: true });
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

// =========================================================================
// LƯU TRỮ VÀ KHÔI PHỤC DỮ LIỆU
// =========================================================================
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
            console.log(`💾 [STORAGE] Đã khôi phục dữ liệu cấu hình từ ${DATA_FILE}`);
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

// 1. TỰ ĐỘNG CHỌN CẶP LINH HOẠT THEO THỨ TỰ: USDC -> USDT -> USD1 -> FDUSD -> BNB -> BTC -> ETH
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

function roundPrice(symbol, price, isSpot = false) {
    const info = (isSpot ? status.spotExchangeInfo[symbol] : status.exchangeInfo[symbol]) || { pricePrecision: 4, tickSize: 0.0001 };
    const precision = info.pricePrecision ?? 4;
    const step = info.tickSize || Math.pow(10, -precision);
    const rounded = Math.round(price / step) * step;
    return parseFloat(rounded.toFixed(precision));
}

// LÀM TRÒN XUỐNG (FLOOR) ĐỂ KHÔNG BAO GIỜ VƯỢT QUÁ VỊ THẾ GÂY LỖI REDUCE-ONLY
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

function calculateOrderQtyForPrice(symbol, orderPrice) {
    const info = status.exchangeInfo[symbol] || { 
        quantityPrecision: 2, stepSize: 0.01, minQty: 0.01, minNotional: 5.0, maxLeverage: 50
    };
    const wallet = parseFloat(accountCache.totalWalletBalance || accountCache.availableBalance || 0);

    let inputStr = botSettings.invValue.toString().trim();
    let isPercent = inputStr.includes('%');
    let val = parseFloat(inputStr.replace('%', ''));
    if (isNaN(val) || val <= 0) val = 0.1;
    if (val < 1 && !isPercent) isPercent = true;

    let margin = isPercent ? (wallet * val) / 100 : val;
    const lev = info.maxLeverage || 50;
    let notional = margin * lev;

    const minFloorNotional = Math.max(info.minNotional || 5.0, 5.5);
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
    const wallet = parseFloat(spotAccountCache.availableBalance || 0);

    let inputStr = spotSettings.invValue.toString().trim();
    let isPercent = inputStr.includes('%');
    let val = parseFloat(inputStr.replace('%', ''));
    if (isNaN(val) || val <= 0) val = 10;

    let notional = isPercent ? (wallet * val) / 100 : val;
    const minNotional = Math.max(info.minNotional || 10.0, 10.5);

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

// =========================================================================
// HÀM HỦY TOÀN BỘ LỆNH TP VÀ SL CŨ TRÁNH XUNG ĐỘT TRONG CHẾ ĐỘ PHÒNG HỘ
// =========================================================================
async function cancelOpenTpOrders(symbol, positionSide) {
    try {
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        if (Array.isArray(openOrders)) {
            const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';
            for (const o of openOrders) {
                // Hủy các lệnh LIMIT đóng vị thế của chiều này
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

// =========================================================================
// CÁC HÀM ĐẶT LỆNH FUTURES MAKER
// =========================================================================
async function placeMakerLimitOrder(symbol, side, positionSide, price, qty, clientOrderId = null) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;
    try {
        const pStr = roundPrice(symbol, price).toFixed(info.pricePrecision ?? 4);
        const qStr = roundQty(symbol, qty).toFixed(info.quantityPrecision ?? 2);

        const params = {
            symbol, side, positionSide,
            type: 'LIMIT',
            timeInForce: 'GTX',
            quantity: qStr, price: pStr
        };
        if (clientOrderId) params.newClientOrderId = clientOrderId;

        rateLimiter.orderCount10s += 1;
        let res;
        try {
            res = await binancePrivate('/fapi/v1/order', 'POST', params);
        } catch (err) {
            if (err.response?.data?.code === -5022) {
                params.timeInForce = 'GTC';
                res = await binancePrivate('/fapi/v1/order', 'POST', params);
            } else throw err;
        }
        return res;
    } catch (e) {
        addBotLog(`<span style="color:#ff3355">⚠️ [Lỗi Đặt Limit] ${symbol} ${side}_${positionSide}: ${e.response?.data?.msg || e.message}</span>`, "warn");
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
            } else throw err;
        }
        return res;
    } catch (e) {
        addBotLog(`<span style="color:#ff3355">⚠️ [Lỗi Đặt Algo] ${symbol} ${side}_${positionSide}: ${e.response?.data?.msg || e.message}</span>`, "warn");
        return null;
    }
}

// =========================================================================
// CÁC HÀM ĐẶT LỆNH SPOT MAKER
// =========================================================================
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
        addSpotLog(`<span style="color:#ff3355">⚠️ [Spot Lỗi Mua Maker] ${symbol}: ${e.response?.data?.msg || e.message}</span>`, "warn");
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
        addSpotLog(`<span style="color:#ff3355">⚠️ [Spot Lỗi Bán TP] ${symbol}: ${e.response?.data?.msg || e.message}</span>`, "warn");
        return null;
    }
}

async function placeSpotSlOrder(symbol, stopPrice, limitPrice, qty, clientOrderId = null) {
    const info = status.spotExchangeInfo[symbol];
    if (!info) return null;
    try {
        const stopStr = roundPrice(symbol, stopPrice, true).toFixed(info.pricePrecision ?? 4);
        const pStr = roundPrice(symbol, limitPrice, true).toFixed(info.pricePrecision ?? 4);
        const qStr = roundQty(symbol, qty, true).toFixed(info.quantityPrecision ?? 2);

        const params = {
            symbol, side: 'SELL',
            type: 'STOP_LOSS_LIMIT',
            timeInForce: 'GTC',
            quantity: qStr,
            price: pStr,
            stopPrice: stopStr
        };
        if (clientOrderId) params.newClientOrderId = clientOrderId;

        return await binanceSpotPrivate('/api/v3/order', 'POST', params);
    } catch (e) {
        addSpotLog(`<span style="color:#ff3355">⚠️ [Spot Lỗi Bán SL] ${symbol}: ${e.response?.data?.msg || e.message}</span>`, "warn");
        return null;
    }
}

// =========================================================================
// KHỞI TẠO MỐC GRID FUTURES (CHỈ CÀI LỆNH OPEN)
// =========================================================================
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

    return { gridNum, levelPrice, orderIds, algoIds };
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

// =========================================================================
// BỌC TP/SL CHO VỊ THẾ FUTURES (FIX TRIỆT ĐỂ LỖI -2022 REDUCE-ONLY TRONG HEDGE MODE)
// =========================================================================
async function deployTpSlForPosition(symbol, positionSide, qty, entryPrice) {
    const info = status.exchangeInfo[symbol];
    if (!info) return;

    // 1. Kiểm tra vị thế thực tế đang giữ trên sàn để không bao giờ vượt quá khối lượng
    const openPos = (accountCache.rawPositions || []).find(
        p => p.symbol === symbol && p.positionSide === positionSide
    );
    const actualPosAmt = openPos ? Math.abs(parseFloat(openPos.positionAmt)) : qty;
    if (actualPosAmt <= 0) return;

    const finalQty = roundQty(symbol, Math.min(qty, actualPosAmt));
    if (finalQty <= 0) return;

    // 2. HỦY SẠCH LỆNH TP CŨ TRƯỚC KHI ĐẶT LỆNH MỚI (CHỐNG LỖI -2022 REDUCE-ONLY)
    await cancelOpenTpOrders(symbol, positionSide);

    const initialEntry = gridState.get(symbol)?.initialEntry || entryPrice;
    const tpPct = botSettings.tpSlPct;
    const slPct = botSettings.tpSlPct * 0.5; // GIẢM SL = 50% TP
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

    // 3. Đặt lệnh TP (Limit Maker)
    const tpClientId = `TP${positionSide}${Date.now()}`;
    const tpRes = await placeMakerLimitOrder(symbol, closeSide, positionSide, tpP, finalQty, tpClientId);
    if (!tpRes) {
        addBotLog(`<b style="color:#ff3355">❌ [LỖI THIẾU LỆNH TP]</b> Không thể cài TP cho <b style="color:#facc15">${symbol} ${positionSide}</b> tại giá <b style="color:#facc15">${tpP}</b>!`, "error");
    }

    // 4. Hủy lệnh SL cũ và đặt lệnh SL mới
    await cancelOpenSlAlgoOrders(symbol, positionSide);
    const slClientId = `SL${positionSide}${Date.now()}`;
    const slRes = await placeMakerConditionalOrder(symbol, closeSide, positionSide, slP, slLimitP, finalQty, slClientId);
    if (!slRes) {
        addBotLog(`<b style="color:#ff3355">❌ [LỖI THIẾU LỆNH SL]</b> Không thể cài SL cho <b style="color:#facc15">${symbol} ${positionSide}</b> tại giá <b style="color:#facc15">${slP}</b>!`, "error");
    }

    activeProtectedPositions.set(`${symbol}_${positionSide}`, {
        amt: finalQty,
        tpOrderId: tpRes?.orderId,
        slAlgoId: slRes?.algoId,
        entryPrice: entryPrice
    });

    addBotLog(`<b style="color:#facc15">[GRID ${gridTag}]</b> open: <b style="color:#facc15">${symbol}</b> <b style="color:#facc15">${positionSide}</b> <span style="color:#facc15">x${lev}</span>, margin: <span style="color:#facc15">${margin}$</span>, giá open: <b style="color:#facc15">${entryPrice}</b>, TP: <span style="color:#facc15">${tpP} (${tpPct.toFixed(2)}%)</span>, SL: <span style="color:#facc15">${slP} (${slPct.toFixed(2)}%)</span>`, "info");
}

// BẢO VỆ LỆNH MỞ KHI GIÁ ĐI 1 CHIỀU: QUÁ 5S CHƯA KHỚP -> MỞ MARKET NGAY
async function checkOpenOneWayMarketEmergency(symbol, markP) {
    const cState = gridState.get(symbol);
    if (!cState || cState.isInitializing) return;

    for (const level of cState.upperLevels) {
        if (markP >= level.levelPrice) {
            const trackKey = `${symbol}_LONG_${level.gridNum}`;
            if (!openTriggerTracker.has(trackKey)) {
                openTriggerTracker.set(trackKey, { triggerTime: Date.now(), levelPrice: level.levelPrice });
            } else {
                const tr = openTriggerTracker.get(trackKey);
                if (Date.now() - tr.triggerTime >= OPEN_MARKET_TIMEOUT_MS) {
                    const hasPosition = (accountCache.rawPositions || []).some(
                        p => p.symbol === symbol && p.positionSide === 'LONG' && Math.abs(parseFloat(p.positionAmt)) > 0
                    );
                    if (!hasPosition) {
                        const qty = calculateOrderQtyForPrice(symbol, markP);
                        await cancelGridLevelOrders(symbol, level);
                        await binancePrivate('/fapi/v1/order', 'POST', {
                            symbol, side: 'BUY', positionSide: 'LONG',
                            type: 'MARKET', quantity: qty.toString()
                        }).catch(() => null);
                        addBotLog(`<b style="color:#facc15">⚡ [GIÁ 1 CHIỀU PHÁ ĐỈNH]</b> <b style="color:#facc15">${symbol} LONG [GRID +${level.gridNum}]</b>: Đã mở ngay lệnh MARKET sau 5s không khớp Limit!`, "warn");
                    }
                    openTriggerTracker.delete(trackKey);
                }
            }
        }
    }

    for (const level of cState.lowerLevels) {
        if (markP <= level.levelPrice) {
            const trackKey = `${symbol}_SHORT_${level.gridNum}`;
            if (!openTriggerTracker.has(trackKey)) {
                openTriggerTracker.set(trackKey, { triggerTime: Date.now(), levelPrice: level.levelPrice });
            } else {
                const tr = openTriggerTracker.get(trackKey);
                if (Date.now() - tr.triggerTime >= OPEN_MARKET_TIMEOUT_MS) {
                    const hasPosition = (accountCache.rawPositions || []).some(
                        p => p.symbol === symbol && p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0
                    );
                    if (!hasPosition) {
                        const qty = calculateOrderQtyForPrice(symbol, markP);
                        await cancelGridLevelOrders(symbol, level);
                        await binancePrivate('/fapi/v1/order', 'POST', {
                            symbol, side: 'SELL', positionSide: 'SHORT',
                            type: 'MARKET', quantity: qty.toString()
                        }).catch(() => null);
                        addBotLog(`<b style="color:#facc15">⚡ [GIÁ 1 CHIỀU XẢ ĐÁY]</b> <b style="color:#facc15">${symbol} SHORT [GRID ${level.gridNum}]</b>: Đã mở ngay lệnh MARKET sau 5s không khớp Limit!`, "warn");
                    }
                    openTriggerTracker.delete(trackKey);
                }
            }
        }
    }
}

// SL MARKET KHẨN CẤP FUTURES (50% TP)
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

    const slPct = botSettings.tpSlPct * 0.5; // GIẢM XUỐNG 50% TP
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
                addBotLog(`<b style="color:#ff3355">🚨 [SL MARKET KHẨN CẤP]</b> <b style="color:#facc15">${symbol} ${posSide}</b>: Đã kích hoạt SL Market (${reason})!`, "error");
                slWatchTracker.delete(posKey);
            }
        }
    } else {
        slWatchTracker.delete(posKey);
    }
}

// =========================================================================
// TRIỂN KHAI VÀ GIÁM SÁT SPOT GRID
// =========================================================================
async function deploySpotGridLevel(symbol, levelPrice, qty, gridNum) {
    const buyOrder = await placeSpotMakerBuyOrder(symbol, levelPrice, qty, `SPOTBUY${Date.now()}`);
    return {
        gridNum,
        levelPrice,
        qty,
        orderId: buyOrder?.orderId
    };
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
            lastBuyFee: 0
        };
        spotGridState.set(symbol, coinSpotGrid);

        if (!spotStats.has(symbol)) {
            spotStats.set(symbol, {
                totalBuyCount: 0,
                totalBuyVolume: 0,
                totalSellCount: 0,
                totalSellVolume: 0,
                completedCycles: 0,
                totalFee: 0,
                totalPnL: 0,
                recordedTradeIds: new Set()
            });
        }

        for (const item of queuePlan) {
            if (!spotSettings.isRunning) break;
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

async function deploySpotTpSl(symbol, qty, buyPrice, buyFee = 0) {
    const cGrid = spotGridState.get(symbol);
    const initialEntry = cGrid?.initialEntry || buyPrice;
    const tpPct = spotSettings.tpSlPct;
    const slPct = spotSettings.tpSlPct * 0.5; // GIẢM SL = 50% TP
    const offset01 = initialEntry * 0.001;

    const tpPrice = roundPrice(symbol, initialEntry * (1 + tpPct / 100), true);
    const slPrice = roundPrice(symbol, initialEntry * (1 - slPct / 100), true);
    const slLimitPrice = roundPrice(symbol, slPrice + offset01, true);

    await placeSpotLimitSellOrder(symbol, tpPrice, qty, `SPOTTP${Date.now()}`);
    await placeSpotSlOrder(symbol, slPrice, slLimitPrice, qty, `SPOTSL${Date.now()}`);

    if (cGrid) {
        cGrid.lastBuyPrice = buyPrice;
        cGrid.lastBuyFee = buyFee;
    }

    addSpotLog(`open: <b style="color:#facc15">${symbol} SPOT</b>, giá mua: <b style="color:#facc15">${buyPrice}</b>, SL: <span style="color:#facc15">${slPrice}</span>, TP: <span style="color:#facc15">${tpPrice}</span>`, "info");
}

async function monitorSpotWorker() {
    if (status.isReady && spotSettings.isRunning) {
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
                    const slPrice = cGrid.initialEntry * (1 - (spotSettings.tpSlPct * 0.5 / 100));
                    if (markP <= slPrice) {
                        const trackKey = `SPOT_SL_${symbol}`;
                        if (!spotSlWatchTracker.has(trackKey)) {
                            spotSlWatchTracker.set(trackKey, Date.now());
                        } else {
                            if (Date.now() - spotSlWatchTracker.get(trackKey) >= 5000) {
                                const openOrders = await binanceSpotPrivate('/api/v3/openOrders', 'GET', { symbol }).catch(() => []);
                                for (const o of openOrders) {
                                    await binanceSpotPrivate('/api/v3/order', 'DELETE', { symbol, orderId: o.orderId }).catch(() => {});
                                }
                                const baseAsset = symbol.replace(/USDT|USDC|USD1|FDUSD|BNB|BTC|ETH/, '');
                                const bal = (spotAccountCache.balances || []).find(b => b.asset === baseAsset);
                                const freeQty = parseFloat(bal?.free || 0);
                                if (freeQty > 0) {
                                    const qStr = roundQty(symbol, freeQty, true).toString();
                                    await binanceSpotPrivate('/api/v3/order', 'POST', {
                                        symbol, side: 'SELL', type: 'MARKET', quantity: qStr
                                    }).catch(() => null);
                                    addSpotLog(`<b style="color:#ff3355">🚨 [SPOT SL MARKET]</b> ${symbol}: Bán Market sau 5s cắt lỗ!`, "error");
                                }
                                spotSlWatchTracker.delete(trackKey);
                            }
                        }
                    } else {
                        spotSlWatchTracker.delete(`SPOT_SL_${symbol}`);
                    }
                }

                // Lấy lịch sử giao dịch Spot và trừ chuẩn xác phí sàn thực thu
                const trades = await binanceSpotPrivate('/api/v3/myTrades', 'GET', { symbol, limit: 5 }).catch(() => []);
                let stat = spotStats.get(symbol) || {
                    totalBuyCount: 0, totalBuyVolume: 0, totalSellCount: 0, totalSellVolume: 0,
                    completedCycles: 0, totalFee: 0, totalPnL: 0, recordedTradeIds: new Set()
                };

                let updated = false;
                for (const t of trades) {
                    const tradeId = String(t.id);
                    if (!stat.recordedTradeIds.has(tradeId)) {
                        stat.recordedTradeIds.add(tradeId);
                        const qty = parseFloat(t.qty);
                        const price = parseFloat(t.price);
                        const val = parseFloat(t.quoteQty || (qty * price));
                        
                        const realFeeUsd = calculateTradeFeeUsd(t, priceMap, symbol);
                        stat.totalFee += realFeeUsd;

                        if (t.isBuyer) {
                            stat.totalBuyCount += 1;
                            stat.totalBuyVolume += val;
                            await deploySpotTpSl(symbol, qty, price, realFeeUsd);
                        } else {
                            stat.totalSellCount += 1;
                            stat.totalSellVolume += val;
                            stat.completedCycles += 1;

                            const initialE = cGrid?.lastBuyPrice || cGrid?.initialEntry || price;
                            const buyFee = cGrid?.lastBuyFee || realFeeUsd;
                            const pnlRaw = (price - initialE) * qty;
                            const pnlNet = pnlRaw - (realFeeUsd + buyFee);
                            stat.totalPnL += pnlNet;

                            addSpotLog(`close: <b style="color:#facc15">${symbol} SPOT</b>, giá bán: <b style="color:#facc15">${price}</b>, fee thực: <span style="color:#facc15">${(realFeeUsd + buyFee).toFixed(4)}$</span>, pnl: <b style="${pnlNet>=0?'color:#00ff88':'color:#ff3355'}">${pnlNet.toFixed(4)}$</b>`, pnlNet >= 0 ? "success" : "error");
                        }
                        updated = true;
                    }
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
// LUỒNG GIÁM SÁT VÀ BẢO VỆ VỊ THẾ FUTURES
// =========================================================================
async function monitorGridWorker() {
    if (status.isReady && botSettings.isRunning) {
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
                    await checkOpenOneWayMarketEmergency(symbol, markP);
                }

                // CHỐT CHẶN DUY NHẤT ĐIỀU PHỐI CÀI TP/SL (ĐẢM BẢO KHÔNG BỊ TRÙNG LẶP GÂY -2022)
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
                        await deployTpSlForPosition(symbol, posSide, posAmt, entryPrice);
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

                // Quét lịch sử để ghi nhận thống kê và log đóng vị thế
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 }).catch(() => []);
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

// CÁC HÀM PHỤ TRỢ KHÁC
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

                if (totalWallet > 0 && botSettings.isRunning) {
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

        if (!volumeStats.has(symbol)) {
            volumeStats.set(symbol, {
                orderCount: 0, totalVolume: 0, totalPnL: 0, totalGridsRan: 0,
                tpCount: 0, tpPnL: 0, slCount: 0, slPnL: 0, recordedTradeIds: new Set()
            });
        }

        for (const item of queuePlan) {
            if (!botSettings.isRunning) break;
            const levelObj = await deployGridLevel(symbol, item.price, initialEntry, item.gridNum);
            if (item.gridNum > 0) currentCoinGrid.upperLevels.push(levelObj);
            else currentCoinGrid.lowerLevels.push(levelObj);
            await new Promise(r => setTimeout(r, 120));
        }

        currentCoinGrid.upperLevels.sort((a, b) => a.levelPrice - b.levelPrice);
        currentCoinGrid.lowerLevels.sort((a, b) => a.levelPrice - b.levelPrice);
        currentCoinGrid.isInitializing = false;

        const stat = volumeStats.get(symbol);
        stat.totalGridsRan += (currentCoinGrid.upperLevels.length + currentCoinGrid.lowerLevels.length);
        saveData();
    } catch (e) {
        addBotLog(`<span style="color:#facc15">⚠️ Lỗi khởi tạo Futures ${symbol}: ${e.message}</span>`, "warn");
    }
}

async function processQueue() {
    if (isQueueProcessing) return;
    isQueueProcessing = true;

    while (initCoinQueue.length > 0 && botSettings.isRunning) {
        const symbol = initCoinQueue.shift();
        await initializeCoinGrid(symbol);
        await new Promise(r => setTimeout(r, 800));
    }

    while (spotInitCoinQueue.length > 0 && spotSettings.isRunning) {
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
    syncSpotAccountWorker();
    monitorSpotWorker();
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
    const { isRunning, invValue, gridOpenPct, tpSlPct, gridLevels } = req.body;
    if (invValue !== undefined) botSettings.invValue = invValue;
    if (gridOpenPct !== undefined) botSettings.gridOpenPct = parseFloat(gridOpenPct);
    if (tpSlPct !== undefined) botSettings.tpSlPct = parseFloat(tpSlPct);
    if (gridLevels !== undefined) botSettings.gridLevels = parseInt(gridLevels);

    saveData();

    if (isRunning !== undefined && isRunning !== botSettings.isRunning) {
        botSettings.isRunning = isRunning;
        saveData();
        if (botSettings.isRunning) {
            initCoinQueue = [...new Set(botSettings.coinList)];
            processQueue();
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

    res.json({ success: true, botSettings });
});

APP.post('/api/spot/settings', async (req, res) => {
    const { isRunning, invValue, gridOpenPct, tpSlPct, gridLevels } = req.body;
    if (invValue !== undefined) spotSettings.invValue = invValue;
    if (gridOpenPct !== undefined) spotSettings.gridOpenPct = parseFloat(gridOpenPct);
    if (tpSlPct !== undefined) spotSettings.tpSlPct = parseFloat(tpSlPct);
    if (gridLevels !== undefined) spotSettings.gridLevels = parseInt(gridLevels);

    saveData();

    if (isRunning !== undefined && isRunning !== spotSettings.isRunning) {
        spotSettings.isRunning = isRunning;
        saveData();
        if (spotSettings.isRunning) {
            spotInitCoinQueue = [...new Set(spotSettings.coinList)];
            processQueue();
        } else {
            spotInitCoinQueue = [];
            for (const sym of spotSettings.coinList) {
                try {
                    const openOrders = await binanceSpotPrivate('/api/v3/openOrders', 'GET', { symbol: sym }).catch(() => []);
                    for (const o of openOrders) {
                        await binanceSpotPrivate('/api/v3/order', 'DELETE', { symbol: sym, orderId: o.orderId }).catch(() => {});
                    }
                } catch (e) {}
                spotGridState.delete(sym);
            }
        }
    }

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
            if (botSettings.isRunning) {
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
            if (spotSettings.isRunning) {
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
