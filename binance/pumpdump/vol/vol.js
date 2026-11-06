import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

// =========================================================================
// CẤU HÌNH HỆ THỐNG GRID VOLUME FUTURES (CHỐNG BAN IP & QUÁ TẢI RATE LIMIT)
// =========================================================================
const PORT = 3334;
const DEFAULT_COIN_SUFFIX = 'USDC';
const MIN_ORDER_DELAY_MS = 150;                  // Giãn cách an toàn tối thiểu giữa các lệnh
const LIQUIDATION_PROTECT_RATIO = 15;            // Dưới 15% khả dụng/ví -> Đóng sạch và tắt bot
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bot_data.json');

// CẤU HÌNH BẢO VỆ RATE LIMIT (CHUẨN BINANCE FUTURES: 2400 WEIGHT/PHÚT, 1200 ORDER/PHÚT, 300 ORDER/10S)
const SAFE_WEIGHT_CEILING = 1850;                // Trần an toàn (Sàn cho 2400, bot tự phanh khi đạt 1850)
const MAX_ORDERS_PER_10S = 220;                  // Sàn cho 300 orders/10s, giới hạn an toàn 220
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 10000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

let botSettings = {
    isRunning: false,
    invValue: "0.1%",
    gridOpenPct: 1.0,
    tpSlPct: 1.0,
    gridLevels: 5,
    coinList: ['BTCUSDC', 'ETHUSDC']
};

let status = {
    botLogs: [],
    exchangeInfo: {},
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

// =========================================================================
// HỆ THỐNG GIÁM SÁT RATE LIMIT THỜI GIAN THỰC
// =========================================================================
let rateLimiter = {
    currentUsedWeight1m: 0,
    orderCount10s: 0,
    last10sWindow: Date.now(),
    isThrottled: false
};

// Đọc header trả về từ Binance sau mỗi request
binanceApi.interceptors.response.use(
    response => {
        const usedWeight = response.headers['x-mbx-used-weight-1m'];
        if (usedWeight) {
            rateLimiter.currentUsedWeight1m = parseInt(usedWeight, 10);
        }
        return response;
    },
    error => {
        const usedWeight = error.response?.headers?.['x-mbx-used-weight-1m'];
        if (usedWeight) {
            rateLimiter.currentUsedWeight1m = parseInt(usedWeight, 10);
        }
        return Promise.reject(error);
    }
);

async function waitForSafeRateLimit() {
    // 1. Reset cửa sổ 10 giây cho số lượng order
    const now = Date.now();
    if (now - rateLimiter.last10sWindow >= 10000) {
        rateLimiter.orderCount10s = 0;
        rateLimiter.last10sWindow = now;
    }

    // 2. Nếu gần chạm trần 10 giây của lệnh -> phanh 1.5 giây
    if (rateLimiter.orderCount10s >= MAX_ORDERS_PER_10S) {
        const waitMs = Math.max(10000 - (now - rateLimiter.last10sWindow), 1000);
        await new Promise(r => setTimeout(r, waitMs));
        rateLimiter.orderCount10s = 0;
        rateLimiter.last10sWindow = Date.now();
    }

    // 3. Nếu Request Weight vượt quá trần an toàn (1,850 / 2,400) -> Tự động ngủ nhả tải
    if (rateLimiter.currentUsedWeight1m >= SAFE_WEIGHT_CEILING) {
        if (!rateLimiter.isThrottled) {
            rateLimiter.isThrottled = true;
            addBotLog(`<span style="color:#facc15">⚠️ [RATE LIMIT] Weight đạt ${rateLimiter.currentUsedWeight1m}/2400. Đang tạm phanh 3s để bảo vệ IP...</span>`, "warn");
        }
        await new Promise(r => setTimeout(r, 3000));
        rateLimiter.isThrottled = false;
    }
}

let gridState = new Map();
let volumeStats = new Map();
let initCoinQueue = [];
let isQueueProcessing = false;
let timestampOffset = 0;

// =========================================================================
// LƯU TRỮ VÀ KHÔI PHỤC DỮ LIỆU BỀN VỮNG
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
            if (parsed.volumeStats) {
                for (const [sym, st] of Object.entries(parsed.volumeStats)) {
                    volumeStats.set(sym, {
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
        const payload = {
            botSettings,
            volumeStats: statsObj,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error("Lỗi khi ghi file bot_data.json:", e.message);
    }
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    const cleanMsg = msg.replace(/<[^>]*>?/gm, '');
    console.log(`[${time}] ${cleanMsg}`);
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
    if (ban.isBanned) {
        throw new Error(`IP đang bị khóa tạm thời. Còn ${ban.remainingSec}s.`);
    }

    // Luôn kiểm tra tải trước khi gửi request
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

        const res = await binanceApi(reqConfig);
        return res.data;
    } catch (e) {
        const statusErr = e.response?.status;
        const errData = e.response?.data;

        // Xử lý khi bị 429 hoặc 418
        if (statusErr === 418 || statusErr === 429 || errData?.code === -1003) {
            let banMs = 300000;
            const retryAfter = e.response?.headers?.['retry-after'];
            if (retryAfter) {
                banMs = Math.max(parseInt(retryAfter, 10) * 1000, 60000);
            } else {
                const match = errData?.msg?.match(/banned until (\d+)/);
                if (match && match[1]) {
                    banMs = Math.max(parseInt(match[1]) - Date.now(), 60000);
                }
            }
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

function formatSymbol(rawInput) {
    if (!rawInput) return null;
    let clean = rawInput.trim().toUpperCase();
    if (!clean) return null;
    if (clean.endsWith('USDT') || clean.endsWith('USDC')) {
        return clean;
    }
    return `${clean}${DEFAULT_COIN_SUFFIX}`;
}

function roundPrice(symbol, price) {
    const info = status.exchangeInfo[symbol] || { pricePrecision: 4, tickSize: 0.0001 };
    const precision = info.pricePrecision ?? 4;
    const step = info.tickSize || Math.pow(10, -precision);
    const rounded = Math.round(price / step) * step;
    return parseFloat(rounded.toFixed(precision));
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
        quantityPrecision: 2, 
        stepSize: 0.01, 
        minQty: 0.01, 
        minNotional: 5.0,
        maxLeverage: 50
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

    while (finalQty * orderPrice < minFloorNotional) {
        finalQty += step;
    }

    return parseFloat(finalQty.toFixed(info.quantityPrecision ?? 2));
}

// =========================================================================
// CÁC HÀM ĐẶT LỆNH MAKER (POST-ONLY "GTX") CÓ RATE LIMIT COUNTER
// =========================================================================
async function placeMakerLimitOrder(symbol, side, positionSide, price, qty) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;
    try {
        const pStr = roundPrice(symbol, price).toFixed(info.pricePrecision ?? 4);
        const qStr = Number(qty).toFixed(info.quantityPrecision ?? 2);

        const params = {
            symbol,
            side,
            positionSide,
            type: 'LIMIT',
            timeInForce: 'GTX',
            quantity: qStr,
            price: pStr
        };

        rateLimiter.orderCount10s += 1;
        const res = await binancePrivate('/fapi/v1/order', 'POST', params);
        return res;
    } catch (e) {
        if (e.response?.data?.code !== -5022) {
            addBotLog(`<span style="color:#facc15">⚠️ [Lỗi Limit Maker] ${symbol} ${side}_${positionSide}: ${e.response?.data?.msg || e.message}</span>`, "warn");
        }
        return null;
    }
}

async function placeMakerConditionalOrder(symbol, side, positionSide, triggerPrice, limitPrice, qty) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;
    try {
        const trigStr = roundPrice(symbol, triggerPrice).toFixed(info.pricePrecision ?? 4);
        const pStr = roundPrice(symbol, limitPrice).toFixed(info.pricePrecision ?? 4);
        const qStr = Number(qty).toFixed(info.quantityPrecision ?? 2);

        const params = {
            algoType: 'CONDITIONAL',
            symbol,
            side,
            positionSide,
            type: 'STOP',
            quantity: qStr,
            price: pStr,
            triggerPrice: trigStr,
            timeInForce: 'GTX',
            workingType: 'MARK_PRICE'
        };

        rateLimiter.orderCount10s += 1;
        const res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params);
        return res;
    } catch (e) {
        if (e.response?.data?.code !== -5022 && e.response?.data?.code !== -2021) {
            addBotLog(`<span style="color:#facc15">⚠️ [Lỗi Algo Maker] ${symbol} ${side}_${positionSide}: ${e.response?.data?.msg || e.message}</span>`, "warn");
        }
        return null;
    }
}

// =========================================================================
// TRIỂN KHAI MỐC GRID (SHORT: LIMIT > STOP | LONG: LIMIT < STOP)
// =========================================================================
async function deployGridLevel(symbol, levelPrice, initialEntry, gridNum) {
    const offset01 = initialEntry * 0.001; // Độ lệch 0.1% giá cho Maker

    let openLong, openShort;
    const qty = calculateOrderQtyForPrice(symbol, levelPrice);

    if (gridNum > 0) {
        // MỐC TRÊN:
        // Short: Limit thường treo tại levelPrice (Maker tự nhiên)
        openShort = await placeMakerLimitOrder(symbol, 'SELL', 'SHORT', levelPrice, qty);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        // Long: Điều kiện Mua (BUY) -> Maker thì Limit phải THẤP HƠN Stop
        const longLimitPrice = levelPrice - offset01;
        openLong = await placeMakerConditionalOrder(symbol, 'BUY', 'LONG', levelPrice, longLimitPrice, qty);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    } else {
        // MỐC DƯỚI:
        // Long: Limit thường treo tại levelPrice (Maker tự nhiên)
        openLong = await placeMakerLimitOrder(symbol, 'BUY', 'LONG', levelPrice, qty);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        // Short: Điều kiện Bán (SELL) -> Maker thì Limit phải CAO HƠN Stop
        const shortLimitPrice = levelPrice + offset01;
        openShort = await placeMakerConditionalOrder(symbol, 'SELL', 'SHORT', levelPrice, shortLimitPrice, qty);
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
            try {
                await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: id });
            } catch (e) {}
        }
    }
    if (levelObj.algoIds) {
        for (const id of levelObj.algoIds) {
            try {
                await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: id });
            } catch (e) {}
        }
    }
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

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
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
                orderCount: 0,
                totalVolume: 0,
                totalPnL: 0,
                totalGridsRan: 0,
                tpCount: 0,
                tpPnL: 0,
                slCount: 0,
                slPnL: 0,
                recordedTradeIds: new Set()
            });
        }

        for (const item of queuePlan) {
            if (!botSettings.isRunning) break;
            const levelObj = await deployGridLevel(symbol, item.price, initialEntry, item.gridNum);
            if (item.gridNum > 0) {
                currentCoinGrid.upperLevels.push(levelObj);
            } else {
                currentCoinGrid.lowerLevels.push(levelObj);
            }
            // Giãn cách 200ms giữa các mốc để không nghẽn burst
            await new Promise(r => setTimeout(r, 200));
        }

        currentCoinGrid.upperLevels.sort((a, b) => a.levelPrice - b.levelPrice);
        currentCoinGrid.lowerLevels.sort((a, b) => a.levelPrice - b.levelPrice);
        currentCoinGrid.isInitializing = false;

        const stat = volumeStats.get(symbol);
        stat.totalGridsRan += (currentCoinGrid.upperLevels.length + currentCoinGrid.lowerLevels.length);
        saveData();

    } catch (e) {
        addBotLog(`<span style="color:#facc15">⚠️ Lỗi khởi tạo ${symbol}: ${e.message}</span>`, "warn");
    }
}

async function processQueue() {
    if (isQueueProcessing || initCoinQueue.length === 0 || !botSettings.isRunning) return;
    isQueueProcessing = true;
    while (initCoinQueue.length > 0 && botSettings.isRunning) {
        const symbol = initCoinQueue.shift();
        await initializeCoinGrid(symbol);
        await new Promise(r => setTimeout(r, 1200));
    }
    isQueueProcessing = false;
}

// TRAILING GRID
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

// BẢO VỆ TÀI KHOẢN (< 15% KHẢ DỤNG) - CHU KỲ 3.5 GIÂY TIẾT KIỆM TẢI
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
                                    symbol: p.symbol,
                                    side: closeSide,
                                    positionSide: p.positionSide,
                                    type: 'MARKET',
                                    quantity: Math.abs(amt).toString()
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
    setTimeout(syncAccountWorker, 3500); // 3.5s gọi 1 lần (tiết kiệm 45% tải)
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

// TỐI ƯU HÓA MONITOR: LẤY TẤT CẢ GIÁ COIN CHỈ VỚI 1 REQUEST DUY NHẤT (WEIGHT = 2)
async function monitorGridWorker() {
    if (status.isReady && botSettings.isRunning) {
        try {
            // Lấy giá tất cả các coin trong 1 call (tiết kiệm hàng trăm weight mỗi phút)
            const allTickersRes = await binanceApi.get('/fapi/v1/ticker/price').catch(() => null);
            const priceMap = new Map();
            if (allTickersRes && Array.isArray(allTickersRes.data)) {
                for (const item of allTickersRes.data) {
                    priceMap.set(item.symbol, parseFloat(item.price));
                }
            }

            for (const symbol of botSettings.coinList) {
                const markP = priceMap.get(symbol) || 0;
                if (markP > 0) {
                    await handleTrailing(symbol, markP);
                }

                // userTrades chỉ gọi giãn cách khi cần
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 12 }).catch(() => []);
                let stat = volumeStats.get(symbol) || {
                    orderCount: 0,
                    totalVolume: 0,
                    totalPnL: 0,
                    totalGridsRan: 0,
                    tpCount: 0,
                    tpPnL: 0,
                    slCount: 0,
                    slPnL: 0,
                    recordedTradeIds: new Set()
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
                        const initialEntry = gridState.get(symbol)?.initialEntry || price;

                        const tpPct = botSettings.tpSlPct;
                        const slPct = botSettings.tpSlPct * 0.8;
                        const offset01 = initialEntry * 0.001; // 0.1% giá

                        // 1. LOG CLOSE
                        if (Math.abs(pnl) > 0) {
                            let openP;
                            if (t.positionSide === 'LONG') {
                                openP = (price - (pnl / qty)).toFixed(4);
                            } else {
                                openP = (price + (pnl / qty)).toFixed(4);
                            }

                            const gridTag = getGridTagForPrice(symbol, parseFloat(openP));

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
                        // 2. LOG OPEN & TREO TP/SL MAKER
                        else {
                            let tpP, slP, slLimitP;
                            const gridTag = getGridTagForPrice(symbol, price);

                            if (t.positionSide === 'LONG') {
                                tpP = roundPrice(symbol, price * (1 + tpPct / 100));
                                slP = roundPrice(symbol, price * (1 - slPct / 100));
                                // Cắt lỗ Long là BÁN -> Maker thì Limit > Stop
                                slLimitP = roundPrice(symbol, slP + offset01);

                                placeMakerLimitOrder(symbol, 'SELL', 'LONG', tpP, qty).catch(() => {});
                                placeMakerConditionalOrder(symbol, 'SELL', 'LONG', slP, slLimitP, qty).catch(() => {});
                            } else {
                                tpP = roundPrice(symbol, price * (1 - tpPct / 100));
                                slP = roundPrice(symbol, price * (1 + slPct / 100));
                                // Cắt lỗ Short là MUA -> Maker thì Limit < Stop
                                slLimitP = roundPrice(symbol, slP - offset01);

                                placeMakerLimitOrder(symbol, 'BUY', 'SHORT', tpP, qty).catch(() => {});
                                placeMakerConditionalOrder(symbol, 'BUY', 'SHORT', slP, slLimitP, qty).catch(() => {});
                            }

                            addBotLog(`<b style="color:#facc15">[GRID ${gridTag}]</b> open: <b style="color:#facc15">${symbol}</b> <b style="color:#facc15">${t.positionSide}</b> <span style="color:#facc15">x${lev}</span>, margin: <span style="color:#facc15">${margin}$</span>, giá mở: <span style="color:#facc15">${price}</span>, TP: <span style="color:#facc15">${tpP} (${tpPct.toFixed(2)}%)</span>, SL: <span style="color:#facc15">${slP} (${slPct.toFixed(2)}%)</span>`, "info");
                        }

                        updated = true;
                    }
                }

                volumeStats.set(symbol, stat);
                if (updated) saveData();

                // Giãn cách nhẹ giữa các coin trong danh sách
                await new Promise(r => setTimeout(r, 100));
            }
        } catch (e) {}
    }
    setTimeout(monitorGridWorker, 3500); // 3.5s quét 1 lần
}

// KHỞI CHẠY HỆ THỐNG
async function init() {
    loadSavedData();
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time', { timeout: 5000 }).catch(() => null);
        if (t && t.data) timestampOffset = t.data.serverTime - Date.now();

        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});

        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
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

        try {
            const brk = await binancePrivate('/fapi/v1/leverageBracket');
            if (Array.isArray(brk)) {
                brk.forEach(b => {
                    if (temp[b.symbol]) {
                        temp[b.symbol].maxLeverage = b.brackets[0]?.initialLeverage || 50;
                    }
                });
            }
        } catch (e) {}

        for (const sym of botSettings.coinList) {
            await binancePrivate('/fapi/v1/marginType', 'POST', { symbol: sym, marginType: 'CROSSED' }).catch(() => {});
        }

        status.exchangeInfo = temp;
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

    syncAccountWorker();
    monitorGridWorker();
}
init();

// =========================================================================
// API & WEB SERVER (HIỆN THÊM CHỈ SỐ RATE LIMIT TRÊN DASHBOARD)
// =========================================================================
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/', (req, res) => {
    const p1 = path.join(__dirname, 'index.html');
    const p2 = path.join(__dirname, 'index (47).html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.send("Đã chạy server port 3334.");
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

    const allStatSymbols = Array.from(new Set([
        ...Array.from(volumeStats.keys()),
        ...botSettings.coinList
    ]));

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

    res.json({
        botSettings,
        openPositions,
        volumeData,
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

APP.post('/api/coins/add', async (req, res) => {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: "Trống" });

    const rawList = input.split(',');
    for (const raw of rawList) {
        const formatted = formatSymbol(raw);
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
    if (!symbol) return res.status(400).json({ error: "Thiếu symbol" });

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

APP.listen(PORT, () => {
    console.log(`🚀 BOT GRID VOLUME FUTURES ĐANG CHẠY TẠI PORT: ${PORT} (ĐÃ BẬT RATE LIMIT GUARDIAN)`);
});
