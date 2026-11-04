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
const PORT = 3333;
const DEFAULT_COIN_SUFFIX = 'USDC';              // Nhập "uai" tự động hiểu là "UAIUSDC"
const INIT_DURATION_PER_COIN_MS = 10000;         // Gửi toàn bộ lệnh trong 10 giây (siêu nhanh)
const MIN_ORDER_DELAY_MS = 120;                  // Giãn cách 120ms giữa các lệnh (an toàn rate limit)
const SAFE_LEVERAGE = 20;                        // Đòn bẩy an toàn mặc định
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
    tpSlPct: 1.0,          // % TP (SL tự động tính = 90% của TP)
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
// QUẢN LÝ LƯU & TẢI DỮ LIỆU BỀN VỮNG (bot_data.json)
// =========================================================================
function loadSavedData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.botSettings) {
                botSettings = { ...botSettings, ...parsed.botSettings };
                botSettings.isRunning = false; // Luôn để false khi vừa khởi động PM2 để người dùng chủ động START
            }
            if (parsed.volumeStats) {
                for (const [sym, st] of Object.entries(parsed.volumeStats)) {
                    volumeStats.set(sym, {
                        ...st,
                        recordedTradeIds: new Set(st.recordedTradeIds || [])
                    });
                }
            }
            console.log(`💾 [STORAGE] Đã khôi phục cấu hình và lịch sử thống kê từ ${DATA_FILE}`);
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
                recordedTradeIds: Array.from(st.recordedTradeIds || [])
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
    addBotLog(`🚨 [IP BANNED] Sàn tạm khóa IP đến ${new Date(status.ipBannedUntil).toLocaleTimeString('vi-VN')}. Lý do: ${msg}`, "error");
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

// TÍNH TOÁN KHỐI LƯỢNG CHUẨN XÁC THEO GIÁ CỦA CHÍNH MỐC ĐÓ (TRIỆT TIÊU LỖI MIN VOL)
function calculateOrderQtyForPrice(symbol, orderPrice) {
    const info = status.exchangeInfo[symbol] || { 
        quantityPrecision: 2, 
        stepSize: 0.01, 
        minQty: 0.01, 
        minNotional: 5.0 
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
    const lev = Math.min(SAFE_LEVERAGE, info.maxLeverage || SAFE_LEVERAGE);
    let notional = margin * lev;

    // Đảm bảo không nhỏ hơn Min Notional của sàn (Binance yêu cầu tối thiểu 5$, đặt 5.5$ để có đệm an toàn)
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

    // Tự động cộng thêm stepSize cho đến khi giá trị đạt chuẩn minNotional
    while (finalQty * orderPrice < minFloorNotional) {
        finalQty += step;
    }

    return parseFloat(finalQty.toFixed(info.quantityPrecision ?? 2));
}

function getConditionalOrderType(side, currentPrice, targetPrice) {
    if (side === 'BUY') {
        return targetPrice >= currentPrice ? 'STOP' : 'TAKE_PROFIT';
    } else {
        return targetPrice <= currentPrice ? 'STOP' : 'TAKE_PROFIT';
    }
}

// ĐẶT LỆNH ĐIỀU KIỆN QUA ALGO ORDER VÀ KIỂM TRA CHÍNH XÁC KẾT QUẢ
async function placeConditionalLimitOrder(symbol, side, positionSide, targetPrice, qty, gridTag) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;

    try {
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentP = parseFloat(ticker.data.price);

        const orderType = getConditionalOrderType(side, currentP, targetPrice);
        const pStr = roundPrice(symbol, targetPrice).toString();
        const qStr = qty.toString();

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

        const res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params);
        if (res && (res.algoId || res.clientAlgoId || res.code === '200')) {
            addBotLog(`📝 [ĐẶT LỆNH] ${symbol} | <b style="color:#facc15">[GRID ${gridTag}]</b> | ${side} ${positionSide} | Type: ${orderType} | Price: ${pStr} | Qty: ${qStr} (~${(qty * targetPrice).toFixed(1)}$)`, "info");
            return res;
        } else {
            addBotLog(`❌ [LỖI LỆNH] ${symbol} | <b style="color:#facc15">[GRID ${gridTag}]</b>: Phản hồi không hợp lệ từ sàn`, "error");
            return null;
        }
    } catch (e) {
        addBotLog(`❌ [LỖI LỆNH] ${symbol} | <b style="color:#facc15">[GRID ${gridTag}]</b> | ${side}_${positionSide} @ ${targetPrice}: ${e.response?.data?.msg || e.message}`, "error");
        return null;
    }
}

// TRIỂN KHAI ĐÚNG 4 LỆNH TRÊN 1 MỐC GRID - TP/SL TÍNH THEO % GIÁ QUÉT ĐẦU (INITIAL ENTRY)
async function deployGridLevel(symbol, levelPrice, initialEntry, gridNum) {
    const tpPct = botSettings.tpSlPct;
    const slPct = botSettings.tpSlPct * 0.9;
    const gridTag = gridNum > 0 ? `+${gridNum}` : `${gridNum}`;

    // Tính khoảng cách TP/SL cố định theo % của GIÁ QUÉT ĐẦU (INITIAL ENTRY)
    const tpOffset = initialEntry * (tpPct / 100);
    const slOffset = initialEntry * (slPct / 100);

    const qty = calculateOrderQtyForPrice(symbol, levelPrice);

    let openLong, openShort, tpOrder, slOrder;

    // 1. Mở cặp lệnh Long & Short tại giá của mốc đó
    openLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', levelPrice, qty, gridTag);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    openShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', levelPrice, qty, gridTag);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    // 2. Cài 1 lệnh TP và 1 lệnh SL theo khoảng cách giá quét đầu
    if (gridNum > 0) {
        // MỐC TRÊN: Long chốt lời ở trên, Short cắt lỗ ở trên
        const longTpPrice = levelPrice + tpOffset;
        const shortSlPrice = levelPrice + slOffset;

        tpOrder = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longTpPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        slOrder = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortSlPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    } else {
        // MỐC DƯỚI: Short chốt lời ở dưới, Long cắt lỗ ở dưới
        const shortTpPrice = levelPrice - tpOffset;
        const longSlPrice = levelPrice - slOffset;

        tpOrder = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortTpPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        slOrder = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longSlPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    }

    const algoIds = [
        openLong?.algoId, openShort?.algoId,
        tpOrder?.algoId, slOrder?.algoId
    ].filter(Boolean);

    return {
        gridNum,
        levelPrice,
        qty,
        algoIds,
        successCount: algoIds.length
    };
}

async function cancelGridLevelOrders(symbol, levelObj) {
    if (!levelObj || !levelObj.algoIds) return;
    const gridTag = levelObj.gridNum > 0 ? `+${levelObj.gridNum}` : `${levelObj.gridNum}`;
    addBotLog(`🔄 [HỦY MỐC] ${symbol}: Hủy mốc <b style="color:#facc15">[GRID ${gridTag}]</b> @ ${roundPrice(symbol, levelObj.levelPrice)} (${levelObj.algoIds.length} lệnh)`, "warn");
    for (const aId of levelObj.algoIds) {
        try {
            await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: aId });
            await new Promise(r => setTimeout(r, 60));
        } catch (e) {}
    }
}

// KHỞI TẠO GRID: ƯU TIÊN MỐC XA GIÁ QUÉT ĐẦU TRƯỚC (Grid 5 => Grid -5 => Grid 4...)
async function initializeCoinGrid(symbol) {
    const info = status.exchangeInfo[symbol];
    if (!info) {
        addBotLog(`⚠️ Không có thông tin hợp đồng cho ${symbol}. Bỏ qua.`, "warn");
        return;
    }

    try {
        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});
        await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(() => {});
        
        const safeLev = Math.min(SAFE_LEVERAGE, info.maxLeverage || SAFE_LEVERAGE);
        await binancePrivate('/fapi/v1/leverage', 'POST', { symbol, leverage: safeLev }).catch(() => {});

        // Dọn sạch lệnh cũ để không bị dư thừa
        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);

        addBotLog(`🚀 [KHỞI TẠO GRID] ${symbol} | Giá quét đầu: ${initialEntry} | SL: ${botSettings.gridLevels} trên + ${botSettings.gridLevels} dưới (Tổng 10 mốc = 40 lệnh) | TP/SL tính theo entry đầu`, "info");

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

        // Khởi tạo thống kê nếu chưa có
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

            const gridTag = item.gridNum > 0 ? `+${item.gridNum}` : `${item.gridNum}`;
            if (levelObj.successCount === 4) {
                addBotLog(`✅ Đã thiết lập xong mốc <b style="color:#facc15">[GRID ${gridTag}]</b> của ${symbol} @ ${roundPrice(symbol, item.price)} (Đủ 4/4 lệnh)`);
            } else {
                addBotLog(`⚠️ [GRID ${gridTag}] ${symbol} chỉ hoàn thành ${levelObj.successCount}/4 lệnh! Kiểm tra lại số dư/min vol.`, "warn");
            }
            await new Promise(r => setTimeout(r, 200));
        }

        currentCoinGrid.upperLevels.sort((a, b) => a.levelPrice - b.levelPrice);
        currentCoinGrid.lowerLevels.sort((a, b) => a.levelPrice - b.levelPrice);

        currentCoinGrid.isInitializing = false;
        
        const stat = volumeStats.get(symbol);
        stat.totalGridsRan += (currentCoinGrid.upperLevels.length + currentCoinGrid.lowerLevels.length);
        saveData();

        addBotLog(`🎯 HOÀN TẤT KHỞI TẠO GRID ${symbol}! Sẵn sàng tự động Trailing khi giá dịch chuyển.`, "success");

    } catch (e) {
        addBotLog(`❌ Lỗi khởi tạo ${symbol}: ${e.message}`, "error");
    }
}

async function processQueue() {
    if (isQueueProcessing || initCoinQueue.length === 0 || !botSettings.isRunning) return;
    isQueueProcessing = true;

    while (initCoinQueue.length > 0 && botSettings.isRunning) {
        const symbol = initCoinQueue.shift();
        await initializeCoinGrid(symbol);
        await new Promise(r => setTimeout(r, 1000));
    }

    isQueueProcessing = false;
}

// TRAILING GRID CHÍNH XÁC: GIÁ TỪ GRID 0 LÊN GRID 1 -> ĐẶT NGAY GRID 6 VÀ XÓA GRID -5
async function handleTrailing(symbol, markPrice) {
    const cState = gridState.get(symbol);
    if (!cState || cState.isInitializing || cState.isTrailing) return;

    const stepPct = botSettings.gridOpenPct / 100;
    const initialEntry = cState.initialEntry;

    // Ngưỡng giá dịch chuyển sang mốc tiếp theo
    const nextUpperIndex = cState.currentCenterIndex + 1;
    const nextLowerIndex = cState.currentCenterIndex - 1;

    const upperThreshold = initialEntry * (1 + (nextUpperIndex * stepPct));
    const lowerThreshold = initialEntry * (1 + (nextLowerIndex * stepPct));

    // 1. GIÁ CHẠY LÊN MỐC TRÊN TIẾP THEO (VÍ DỤ TỪ GRID 0 LÊN GRID 1)
    if (markPrice >= upperThreshold && cState.upperLevels.length > 0) {
        cState.isTrailing = true;
        try {
            cState.currentCenterIndex = nextUpperIndex;

            // Xóa mốc dưới cùng (ví dụ xóa Grid -5)
            if (cState.lowerLevels.length > 0) {
                const removedLower = cState.lowerLevels.shift();
                await cancelGridLevelOrders(symbol, removedLower);
            }

            // Chuyển mốc vừa chạm từ Upper thành Lower
            const crossedLevel = cState.upperLevels.shift();
            if (crossedLevel) cState.lowerLevels.push(crossedLevel);

            // Xác định số thứ tự mốc trên đỉnh tiếp theo (ví dụ Grid 6)
            const highestUpper = cState.upperLevels[cState.upperLevels.length - 1] || crossedLevel;
            const newUpperGridNum = Math.max(...cState.upperLevels.map(l => l.gridNum), crossedLevel?.gridNum || 0) + 1;
            const newUpperPrice = initialEntry * (1 + (newUpperGridNum * stepPct));

            // Đặt ngay mốc mới trên đỉnh (ví dụ Grid 6)
            const newUpper = await deployGridLevel(symbol, newUpperPrice, initialEntry, newUpperGridNum);
            cState.upperLevels.push(newUpper);

            const stat = volumeStats.get(symbol);
            if (stat) stat.totalGridsRan += 1;
            saveData();

            addBotLog(`➕ [TRAILING LÊN] ${symbol}: Giá chạm mốc! Đã xóa mốc dưới và cài ngay <b style="color:#facc15">[GRID +${newUpperGridNum}]</b> @ ${roundPrice(symbol, newUpperPrice)}. Duy trì đúng 40 lệnh.`, "success");
        } catch (err) {
            console.error("Trailing Up Err:", err.message);
        } finally {
            cState.isTrailing = false;
        }
    }

    // 2. GIÁ CHẠY XUỐNG MỐC DƯỚI TIẾP THEO (VÍ DỤ TỪ GRID 0 XUỐNG GRID -1)
    else if (markPrice <= lowerThreshold && cState.lowerLevels.length > 0) {
        cState.isTrailing = true;
        try {
            cState.currentCenterIndex = nextLowerIndex;

            // Xóa mốc trên đỉnh (ví dụ xóa Grid 5)
            if (cState.upperLevels.length > 0) {
                const removedUpper = cState.upperLevels.pop();
                await cancelGridLevelOrders(symbol, removedUpper);
            }

            // Chuyển mốc vừa xuyên thủng từ Lower thành Upper
            const crossedLevel = cState.lowerLevels.pop();
            if (crossedLevel) cState.upperLevels.unshift(crossedLevel);

            // Xác định số thứ tự mốc dưới đáy tiếp theo (ví dụ Grid -6)
            const lowestLower = cState.lowerLevels[0] || crossedLevel;
            const newLowerGridNum = Math.min(...cState.lowerLevels.map(l => l.gridNum), crossedLevel?.gridNum || 0) - 1;
            const newLowerPrice = initialEntry * (1 + (newLowerGridNum * stepPct));

            // Đặt ngay mốc mới dưới đáy (ví dụ Grid -6)
            const newLower = await deployGridLevel(symbol, newLowerPrice, initialEntry, newLowerGridNum);
            cState.lowerLevels.unshift(newLower);

            const stat = volumeStats.get(symbol);
            if (stat) stat.totalGridsRan += 1;
            saveData();

            addBotLog(`➕ [TRAILING XUỐNG] ${symbol}: Giá giảm mốc! Đã xóa mốc trên và cài ngay <b style="color:#facc15">[GRID ${newLowerGridNum}]</b> @ ${roundPrice(symbol, newLowerPrice)}. Duy trì đúng 40 lệnh.`, "success");
        } catch (err) {
            console.error("Trailing Down Err:", err.message);
        } finally {
            cState.isTrailing = false;
        }
    }
}

// Luồng ngầm đồng bộ ví
async function syncAccountWorker() {
    try {
        const ban = checkBanStatus();
        if (!ban.isBanned) {
            const acc = await binancePrivate('/fapi/v2/account');
            if (acc) {
                accountCache.totalWalletBalance = parseFloat(acc.totalWalletBalance || acc.totalMarginBalance || 0).toFixed(2);
                accountCache.availableBalance = parseFloat(acc.availableBalance || 0).toFixed(2);
                accountCache.totalUnrealizedProfit = parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2);
                accountCache.rawPositions = acc.positions || [];
                accountCache.lastUpdate = Date.now();
            }
        }
    } catch (e) {}
    setTimeout(syncAccountWorker, 2000);
}

// Luồng ngầm kiểm tra giá thời gian thực cho Trailing & Thống kê Volume
async function monitorGridWorker() {
    if (status.isReady && botSettings.isRunning) {
        try {
            for (const symbol of botSettings.coinList) {
                // Lấy giá thị trường hiện tại trực tiếp để Trailing tức thì
                const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
                const markP = ticker ? parseFloat(ticker.data.price) : 0;
                if (markP > 0) {
                    await handleTrailing(symbol, markP);
                }

                // Cập nhật thống kê khớp lệnh
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 }).catch(() => []);
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
                    if (!stat.recordedTradeIds.has(t.id)) {
                        stat.recordedTradeIds.add(t.id);
                        stat.orderCount += 1;
                        const val = parseFloat(t.qty) * parseFloat(t.price);
                        stat.totalVolume += val;
                        const pnl = parseFloat(t.realizedPnl);
                        stat.totalPnL += pnl;

                        if (pnl > 0) {
                            stat.tpCount += 1;
                            stat.tpPnL += pnl;
                            addBotLog(`💰 [KHỚP TP] ${symbol} | Giá: ${t.price} | Lãi: +${pnl.toFixed(4)}$ | Vol: ${val.toFixed(2)}$`, "success");
                        } else if (pnl < 0) {
                            stat.slCount += 1;
                            stat.slPnL += pnl;
                            addBotLog(`📉 [KHỚP SL] ${symbol} | Giá: ${t.price} | Lỗ: ${pnl.toFixed(4)}$ | Vol: ${val.toFixed(2)}$`, "error");
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

// Khởi tạo hệ thống
async function init() {
    loadSavedData();
    addBotLog("🔄 Khởi tạo kết nối Binance Futures...", "info");
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
                maxLeverage: SAFE_LEVERAGE
            };
        });

        try {
            const brk = await binancePrivate('/fapi/v1/leverageBracket');
            if (Array.isArray(brk)) {
                brk.forEach(b => {
                    if (temp[b.symbol]) {
                        temp[b.symbol].maxLeverage = b.brackets[0]?.initialLeverage || SAFE_LEVERAGE;
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
            addBotLog(`💰 Kết nối tài khoản OK! Ví: ${accountCache.totalWalletBalance}$ | Khả dụng: ${accountCache.availableBalance}$`, "success");
        }

        addBotLog(`🚀 Hệ thống Luffy Grid Volume đã sẵn sàng trên Port ${PORT}.`, "success");
    } catch (e) {
        addBotLog(`⚠️ Lỗi khởi tạo sàn: ${e.message}`, "error");
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
    res.send("Đã chạy server port 3333. Vui lòng đặt file giao diện là index.html cùng thư mục bot.");
});

APP.get('/api/status', (req, res) => {
    const ban = checkBanStatus();

    // Vị thế đang mở: ĐÃ BỎ GIÁ TP VÀ GIÁ SL THEO YÊU CẦU SỐ 6
    const openPositions = (accountCache.rawPositions || [])
        .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
        .map(p => {
            const sym = p.symbol;
            const cState = gridState.get(sym);
            const initialE = cState?.initialEntry || parseFloat(p.entryPrice);
            const markP = parseFloat(p.markPrice || p.entryPrice);
            const distPct = initialE > 0 ? ((markP - initialE) / initialE) * 100 : 0;
            const info = status.exchangeInfo[sym] || { maxLeverage: SAFE_LEVERAGE };

            return {
                symbol: sym,
                side: p.positionSide,
                leverage: p.leverage || SAFE_LEVERAGE,
                margin: parseFloat(p.isolatedMargin || (Math.abs(parseFloat(p.positionAmt)) * markP / (p.leverage || SAFE_LEVERAGE))).toFixed(2),
                qty: Math.abs(parseFloat(p.positionAmt)),
                initialEntry: initialE,
                currentPrice: markP,
                entryPrice: parseFloat(p.entryPrice),
                distPct: distPct.toFixed(2),
                pnl: parseFloat(p.unrealizedProfit)
            };
        });

    // Bảng thống kê khối lượng: ĐÃ SẮP XẾP VÀ BỎ GIÁ SL CHỐT THEO YÊU CẦU SỐ 5
    const volumeData = botSettings.coinList.map((s, idx) => {
        const st = volumeStats.get(s) || { 
            orderCount: 0, totalVolume: 0, totalPnL: 0, totalGridsRan: 0,
            tpCount: 0, tpPnL: 0, slCount: 0, slPnL: 0 
        };
        const info = status.exchangeInfo[s] || { maxLeverage: SAFE_LEVERAGE };
        return {
            stt: idx + 1,
            symbol: s,
            leverage: SAFE_LEVERAGE,
            totalVolume: st.totalVolume.toFixed(2),
            totalGrids: st.totalGridsRan || (botSettings.gridLevels * 2),
            tpDisplay: `${st.tpCount} / +${st.tpPnL.toFixed(4)}$`,
            slDisplay: `${st.slCount} / ${st.slPnL.toFixed(4)}$`,
            totalPnL: st.totalPnL.toFixed(4)
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
            addBotLog(`🟢 BẬT BOT: Bắt đầu khởi tạo ${botSettings.coinList.length} coin.`, "success");
            initCoinQueue = [...new Set(botSettings.coinList)];
            processQueue();
        } else {
            addBotLog(`🛑 TẮT BOT: Đang hủy toàn bộ lệnh Algo và lệnh thường trên sàn...`, "warn");
            initCoinQueue = [];
            for (const sym of botSettings.coinList) {
                try {
                    await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol: sym });
                    await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol: sym });
                } catch (e) {}
                gridState.delete(sym);
            }
            addBotLog(`🛡️ Đã làm sạch toàn bộ lệnh chờ của tất cả các coin trên sàn!`, "success");
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
    addBotLog(`⚙️ Đã thêm ${added} coin mới (Ép Cross Margin).`, "success");
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.post('/api/coins/remove', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: "Thiếu symbol" });

    botSettings.coinList = botSettings.coinList.filter(c => c !== symbol);
    initCoinQueue = initCoinQueue.filter(c => c !== symbol);
    saveData();

    try {
        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
    } catch (e) {}

    gridState.delete(symbol);
    addBotLog(`🗑️ Đã xóa ${symbol} và hủy mọi lệnh chờ của coin này.`, "warn");
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 BOT GRID VOLUME FUTURES ĐANG CHẠY TẠI PORT: ${PORT}`);
    console.log(`🔗 Truy cập giao diện: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
