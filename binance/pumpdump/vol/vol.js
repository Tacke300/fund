import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

// =========================================================================
// CẤU HÌNH HỆ THỐNG GRID VOLUME FUTURES
// =========================================================================
const PORT = 3334;
const DEFAULT_COIN_SUFFIX = 'USDC';              // Nhập "uai" tự động hiểu là "UAIUSDC"
const INIT_DURATION_PER_COIN_MS = 10000;         // Khởi tạo nhanh trong ~10s
const MIN_ORDER_DELAY_MS = 120;                  // Giãn cách an toàn 120ms/lệnh
const LIQUIDATION_PROTECT_RATIO = 15;            // Dưới 15% số dư khả dụng/ví -> Đóng sạch và tắt bot
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bot_data.json');
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
    invValue: "0.1%",      // Số $ hoặc % ví khả dụng
    gridOpenPct: 1.0,      // % khoảng cách mỗi mốc Grid tính từ Entry quét đầu
    tpSlPct: 1.0,          // % TP (SL tự động tính = 70% của TP)
    gridLevels: 5,         // Số mốc Grid trên và mốc dưới (5 trên + 5 dưới = 10 mốc)
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

let gridState = new Map();
let volumeStats = new Map();
let initCoinQueue = [];
let isQueueProcessing = false;
let timestampOffset = 0;

// =========================================================================
// LƯU TRỮ VÀ KHÔI PHỤC DỮ LIỆU BỀN VỮNG (bot_data.json)
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
            console.log(`💾 [STORAGE] Đã khôi phục dữ liệu cấu hình & lịch sử thống kê từ ${DATA_FILE}`);
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

// HỆ THỐNG LOG: HỖ TRỢ MÀU VÀNG CẢNH BÁO, MÀU XANH/ĐỎ CHỐT LỜI/CẮT LỖ
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
    addBotLog(`<span style="color:#facc15">⚠️ [IP BANNED] Sàn tạm khóa IP đến ${new Date(status.ipBannedUntil).toLocaleTimeString('vi-VN')}. Lý do: ${msg}</span>`, "warn");
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

        if (statusErr === 418 || statusErr === 429 || errData?.code === -1003) {
            let banMs = 300000;
            const match = errData?.msg?.match(/banned until (\d+)/);
            if (match && match[1]) {
                banMs = Math.max(parseInt(match[1]) - Date.now(), 60000);
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

// SỬ DỤNG ĐÚNG ENDPOINT QUERY OPEN ALGO ORDERS: GET /fapi/v1/openAlgoOrders
async function getOpenAlgoOrders(symbol) {
    try {
        const res = await binancePrivate('/fapi/v1/openAlgoOrders', 'GET', { symbol });
        if (Array.isArray(res)) return res;
        if (res && Array.isArray(res.orders)) return res.orders;
    } catch (e) {}
    return [];
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

    if (val < 1 && !isPercent) {
        isPercent = true;
    }

    let margin = isPercent ? (wallet * val) / 100 : val;
    const lev = info.maxLeverage || 50;
    let notional = margin * lev;

    const minFloorNotional = Math.max(info.minNotional || 5.0, 5.5);
    if (notional < minFloorNotional) {
        notional = minFloorNotional;
    }

    let rawQty = notional / orderPrice;
    if (info.minQty && rawQty < info.minQty) {
        rawQty = info.minQty;
    }

    const step = info.stepSize || Math.pow(10, -(info.quantityPrecision ?? 2));
    let finalQty = Math.ceil(rawQty / step) * step;

    while (finalQty * orderPrice < minFloorNotional) {
        finalQty += step;
    }

    return parseFloat(finalQty.toFixed(info.quantityPrecision ?? 2));
}

function getConditionalOrderType(side, currentPrice, targetPrice) {
    if (side === 'BUY') {
        return targetPrice > currentPrice ? 'STOP' : 'TAKE_PROFIT';
    } else {
        return targetPrice < currentPrice ? 'STOP' : 'TAKE_PROFIT';
    }
}

// ĐẶT LỆNH ĐIỀU KIỆN & XỬ LÝ TRIỆT ĐỂ LỖI "Order would immediately trigger" (-2021)
async function placeConditionalLimitOrder(symbol, side, positionSide, targetPrice, qty, gridTag) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;

    try {
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
        const currentP = ticker ? parseFloat(ticker.data.price) : targetPrice;

        const tick = info.tickSize || 0.0001;
        let finalTarget = roundPrice(symbol, targetPrice);

        // Tránh trùng khít hoàn toàn với giá hiện tại gây kích hoạt ngay lập tức
        if (Math.abs(finalTarget - currentP) < tick) {
            if (side === 'BUY') {
                finalTarget = roundPrice(symbol, currentP + (tick * 2));
            } else {
                finalTarget = roundPrice(symbol, currentP - (tick * 2));
            }
        }

        let orderType = getConditionalOrderType(side, currentP, finalTarget);
        const pStr = finalTarget.toFixed(info.pricePrecision ?? 4);
        const qStr = Number(qty).toFixed(info.quantityPrecision ?? 2);

        const params = {
            algoType: 'CONDITIONAL',
            symbol: symbol,
            side: side,
            positionSide: positionSide,
            type: orderType,
            quantity: qStr,
            price: pStr,
            triggerPrice: pStr,
            timeInForce: 'GTC',
            workingType: 'MARK_PRICE'
        };

        let res;
        try {
            res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params);
        } catch (err) {
            // NẾU DÍNH LỖI -2021 "Order would immediately trigger", TỰ ĐỘNG ĐẢO CHIỀU LOẠI LỆNH VÀ THỬ LẠI NGAY
            if (err.response?.data?.code === -2021) {
                params.type = (orderType === 'STOP' ? 'TAKE_PROFIT' : 'STOP');
                res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params).catch(e2 => {
                    addBotLog(`<span style="color:#facc15">⚠️ [CẢNH BÁO LỆNH] ${symbol} [GRID ${gridTag}] ${side}_${positionSide}: ${e2.response?.data?.msg || e2.message}</span>`, "warn");
                    return null;
                });
            } else {
                addBotLog(`<span style="color:#facc15">⚠️ [CẢNH BÁO LỆNH] ${symbol} [GRID ${gridTag}] ${side}_${positionSide}: ${err.response?.data?.msg || err.message}</span>`, "warn");
                return null;
            }
        }

        if (res && (res.algoId || res.clientAlgoId || res.code === '200')) {
            return res;
        }
        return null;
    } catch (e) {
        addBotLog(`<span style="color:#facc15">⚠️ [CẢNH BÁO LỆNH] ${symbol} [GRID ${gridTag}]: ${e.response?.data?.msg || e.message}</span>`, "warn");
        return null;
    }
}

// TRIỂN KHAI 4 LỆNH TRÊN 1 MỐC GRID VỚI ĐỘ LỆCH 0.03 GIÁ & TP/SL TÍNH THEO ENTRY QUÉT ĐẦU
async function deployGridLevel(symbol, levelPrice, initialEntry, gridNum) {
    const info = status.exchangeInfo[symbol] || {};
    const tpPct = botSettings.tpSlPct;
    const slPct = botSettings.tpSlPct * 0.7; // SL = 70% TP
    const gridTag = gridNum > 0 ? `+${gridNum}` : `${gridNum}`;

    // TP/SL TÍNH THEO % GIÁ QUÉT ĐẦU TIÊN (INITIAL ENTRY)
    const tpOffset = initialEntry * (tpPct / 100);
    const slOffset = initialEntry * (slPct / 100);

    // TÍNH ĐỘ LỆCH 0.03 GIÁ GIỮA LONG VÀ SHORT
    const tick = info.tickSize || 0.01;
    let offset = 0.03;
    if (offset < tick) offset = tick;
    if (offset / levelPrice > 0.002) {
        offset = Math.max(levelPrice * 0.0003, tick);
    }
    offset = Math.round(offset / tick) * tick;
    if (offset < tick) offset = tick;

    let openLongPrice, openShortPrice, tpOrderPrice, slOrderPrice;
    let openLong, openShort, tpOrder, slOrder;

    if (gridNum > 0) {
        // MỐC TRÊN: LONG CAO HƠN SHORT 0.03 GIÁ
        openLongPrice = levelPrice + offset;
        openShortPrice = levelPrice - offset;

        tpOrderPrice = openLongPrice + tpOffset;
        slOrderPrice = openShortPrice + slOffset;

        const qtyLong = calculateOrderQtyForPrice(symbol, openLongPrice);
        const qtyShort = calculateOrderQtyForPrice(symbol, openShortPrice);

        openLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', openLongPrice, qtyLong, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        openShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', openShortPrice, qtyShort, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        tpOrder = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', tpOrderPrice, qtyLong, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        slOrder = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', slOrderPrice, qtyShort, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    } else {
        // MỐC DƯỚI: SHORT CAO HƠN LONG 0.03 GIÁ
        openShortPrice = levelPrice + offset;
        openLongPrice = levelPrice - offset;

        tpOrderPrice = openShortPrice - tpOffset;
        slOrderPrice = openLongPrice - slOffset;

        const qtyShort = calculateOrderQtyForPrice(symbol, openShortPrice);
        const qtyLong = calculateOrderQtyForPrice(symbol, openLongPrice);

        openLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', openLongPrice, qtyLong, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        openShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', openShortPrice, qtyShort, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        tpOrder = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', tpOrderPrice, qtyShort, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        slOrder = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', slOrderPrice, qtyLong, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    }

    const algoIds = [
        openLong?.algoId, openShort?.algoId,
        tpOrder?.algoId, slOrder?.algoId
    ].filter(Boolean);

    // LOG TỐI GIẢN THEO YÊU CẦU: "cài lệnh open/tp sl grid số X thành công."
    if (algoIds.length === 4) {
        addBotLog(`Cài lệnh open/tp sl grid số <b style="color:#facc15">[GRID ${gridTag}]</b> thành công.`, "info");
    } else {
        addBotLog(`<span style="color:#facc15">⚠️ Cài lệnh mốc [GRID ${gridTag}] chỉ hoàn thành ${algoIds.length}/4 lệnh.</span>`, "warn");
    }

    return {
        gridNum,
        levelPrice,
        openLongPrice,
        openShortPrice,
        tpOrderPrice,
        slOrderPrice,
        algoIds,
        successCount: algoIds.length
    };
}

// HỦY MỐC CŨ
async function cancelGridLevelOrders(symbol, levelObj) {
    if (!levelObj || !levelObj.algoIds || levelObj.algoIds.length === 0) return true;
    for (const aId of levelObj.algoIds) {
        try {
            await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: aId });
            await new Promise(r => setTimeout(r, 60));
        } catch (e) {}
    }
    return true;
}

// KHỞI TẠO GRID
async function initializeCoinGrid(symbol) {
    const info = status.exchangeInfo[symbol];
    if (!info) {
        addBotLog(`<span style="color:#facc15">⚠️ Không tìm thấy thông tin hợp đồng ${symbol}. Bỏ qua.</span>`, "warn");
        return;
    }

    try {
        const maxLev = await fetchMaxLeverage(symbol);
        info.maxLeverage = maxLev;

        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});
        await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(() => {});
        await binancePrivate('/fapi/v1/leverage', 'POST', { symbol, leverage: maxLev }).catch(() => {});

        // Xóa sạch lệnh cũ trên sàn
        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);

        const stepPct = botSettings.gridOpenPct / 100;

        // ƯU TIÊN MỐC XA NHẤT: Grid 5 -> Grid -5 -> Grid 4 -> Grid -4...
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
            const ban = checkBanStatus();
            if (ban.isBanned) break;

            const levelObj = await deployGridLevel(symbol, item.price, initialEntry, item.gridNum);

            if (item.gridNum > 0) {
                currentCoinGrid.upperLevels.push(levelObj);
            } else {
                currentCoinGrid.lowerLevels.push(levelObj);
            }
            await new Promise(r => setTimeout(r, 60));
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
        await new Promise(r => setTimeout(r, 800));
    }

    isQueueProcessing = false;
}

// TRAILING GRID CHUẨN XÁC: GIÁ LÊN THÊM ĐỈNH HỦY ĐÁY, GIÁ XUỐNG THÊM ĐÁY HỦY ĐỈNH (BỎ MARKET)
async function handleTrailing(symbol, markPrice) {
    const cState = gridState.get(symbol);
    if (!cState || cState.isInitializing || cState.isTrailing) return;

    const stepPct = botSettings.gridOpenPct / 100;
    const initialEntry = cState.initialEntry;

    const nextUpperIndex = cState.currentCenterIndex + 1;
    const nextLowerIndex = cState.currentCenterIndex - 1;

    const upperThreshold = initialEntry * (1 + (nextUpperIndex * stepPct));
    const lowerThreshold = initialEntry * (1 + (nextLowerIndex * stepPct));

    // 1. GIÁ CHẠY LÊN MỐC TRÊN TIẾP THEO
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
            const crossedLevel = cState.upperLevels.shift();
            if (crossedLevel) cState.lowerLevels.push(crossedLevel);
            cState.upperLevels.push(newUpper);

            const stat = volumeStats.get(symbol);
            if (stat) stat.totalGridsRan += 1;
            saveData();
        } catch (err) {
            console.error("Trailing Up Err:", err.message);
        } finally {
            cState.isTrailing = false;
        }
    }

    // 2. GIÁ CHẠY XUỐNG MỐC DƯỚI TIẾP THEO
    else if (markPrice <= lowerThreshold && cState.lowerLevels.length > 0) {
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
            const crossedLevel = cState.lowerLevels.pop();
            if (crossedLevel) cState.upperLevels.unshift(crossedLevel);
            cState.lowerLevels.unshift(newLower);

            const stat = volumeStats.get(symbol);
            if (stat) stat.totalGridsRan += 1;
            saveData();
        } catch (err) {
            console.error("Trailing Down Err:", err.message);
        } finally {
            cState.isTrailing = false;
        }
    }
}

// LUỒNG NGẦM ĐỒNG BỘ VÍ & CHỐNG THANH LÝ KHẨN CẤP (<15% VÍ)
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

                // CƠ CHẾ CHỐNG THANH LÝ
                if (totalWallet > 0 && botSettings.isRunning) {
                    const availRatio = (avail / totalWallet) * 100;
                    if (availRatio < LIQUIDATION_PROTECT_RATIO) {
                        addBotLog(`<span style="color:#facc15">⚠️ [CHỐNG THANH LÝ KHẨN CẤP] Khả dụng chỉ còn ${availRatio.toFixed(1)}% (<15% ví). Đóng toàn bộ vị thế và DỪNG BOT!</span>`, "warn");
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
    setTimeout(syncAccountWorker, 2000);
}

// LUỒNG NGẦM GIÁM SÁT TRAILING & CẬP NHẬT LỊCH SỬ KHỐI LƯỢNG / LOG OPEN & CLOSE CHUẨN MÀU
async function monitorGridWorker() {
    if (status.isReady && botSettings.isRunning) {
        try {
            for (const symbol of botSettings.coinList) {
                const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
                const markP = ticker ? parseFloat(ticker.data.price) : 0;
                if (markP > 0) {
                    await handleTrailing(symbol, markP);
                }

                // ĐỌC VÀ CẬP NHẬT LỊCH SỬ GIAO DỊCH VÀO BẢNG KHỐI LƯỢNG
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 15 }).catch(() => []);
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
                        const tpOffset = initialEntry * (botSettings.tpSlPct / 100);
                        const slOffset = initialEntry * (botSettings.tpSlPct * 0.7 / 100);

                        // 1. LOG KHI CLOSE (PNL != 0)
                        if (Math.abs(pnl) > 0) {
                            let openP;
                            if (t.positionSide === 'LONG') {
                                openP = (price - (pnl / qty)).toFixed(4);
                            } else {
                                openP = (price + (pnl / qty)).toFixed(4);
                            }

                            if (pnl > 0) {
                                stat.tpCount += 1;
                                stat.tpPnL += pnl;
                                // CLOSE LÃI: TÊN COIN VÀ PNL MÀU XANH
                                addBotLog(`close: <span style="color:#00ff88;font-weight:bold">${symbol}</span> ${t.positionSide} x${lev}, margin: ${margin}$, giá open: ${openP}, giá đóng: ${price}, pnl: <span style="color:#00ff88;font-weight:bold">+${pnl.toFixed(4)}$</span>`, "success");
                            } else {
                                stat.slCount += 1;
                                stat.slPnL += pnl;
                                // CLOSE LỖ: TÊN COIN VÀ PNL MÀU ĐỎ
                                addBotLog(`close: <span style="color:#ff3355;font-weight:bold">${symbol}</span> ${t.positionSide} x${lev}, margin: ${margin}$, giá open: ${openP}, giá đóng: ${price}, pnl: <span style="color:#ff3355;font-weight:bold">${pnl.toFixed(4)}$</span>`, "error");
                            }
                        } 
                        // 2. LOG KHI OPEN (PNL == 0)
                        else {
                            let tpP, slP;
                            if (t.positionSide === 'LONG') {
                                tpP = roundPrice(symbol, price + tpOffset);
                                slP = roundPrice(symbol, price - slOffset);
                            } else {
                                tpP = roundPrice(symbol, price - tpOffset);
                                slP = roundPrice(symbol, price + slOffset);
                            }
                            addBotLog(`open: ${symbol} ${t.positionSide} x${lev}, margin: ${margin}$, giá mở: ${price}, TP: ${tpP}, SL: ${slP}`, "info");
                        }

                        updated = true;
                    }
                }

                volumeStats.set(symbol, stat);
                if (updated) saveData();
            }
        } catch (e) {}
    }
    setTimeout(monitorGridWorker, 2000);
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
        addBotLog(`<span style="color:#facc15">⚠️ Lỗi khởi tạo sàn: ${e.message}</span>`, "warn");
    }

    syncAccountWorker();
    monitorGridWorker();
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
    const p2 = path.join(__dirname, 'index (47).html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.send("Đã chạy server port 3333.");
});

APP.get('/api/status', (req, res) => {
    const ban = checkBanStatus();

    // VỊ THẾ ĐANG MỞ CHỈ HIỆN COIN DO BOT QUẢN LÝ
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

    // KHÔNG XÓA LỊCH SỬ THỐNG KÊ DÙ COIN ĐANG TẮT HOẶC ĐÃ BỎ RA KHỎI DANH SÁCH CHẠY
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
                    await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol: sym });
                    await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol: sym });
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
    let added = 0;
    for (const raw of rawList) {
        const formatted = formatSymbol(raw);
        if (formatted && !botSettings.coinList.includes(formatted)) {
            await binancePrivate('/fapi/v1/marginType', 'POST', { symbol: formatted, marginType: 'CROSSED' }).catch(() => {});
            botSettings.coinList.push(formatted);
            added++;
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
    saveData(); // DỮ LIỆU BẢNG THỐNG KÊ VẪN LƯU VĨNH VIỄN TRONG volumeStats VÀ bot_data.json

    try {
        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
    } catch (e) {}

    gridState.delete(symbol);
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.listen(PORT, () => {
    console.log(`🚀 BOT GRID VOLUME FUTURES ĐANG CHẠY TẠI PORT: ${PORT}`);
});
