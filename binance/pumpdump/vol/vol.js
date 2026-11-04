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
                        recordedTradeIds: new Set(st.recordedTradeIds || [])
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

// LẤY DANH SÁCH LỆNH ALGO ĐANG THỰC SỰ TREO TRÊN SÀN
async function getOpenAlgoOrders(symbol) {
    try {
        const list = await binancePrivate('/fapi/v1/algoOpenOrders', 'GET', { symbol });
        if (Array.isArray(list)) return list;
    } catch (e) {}
    return [];
}

// LẤY MAX LEVERAGE THỰC TẾ CỦA COIN TỪ SÀN BINANCE
async function fetchMaxLeverage(symbol) {
    try {
        const res = await binancePrivate('/fapi/v1/leverageBracket', 'GET', { symbol });
        if (Array.isArray(res) && res[0]?.brackets?.[0]?.initialLeverage) {
            return res[0].brackets[0].initialLeverage;
        }
    } catch (e) {}
    return status.exchangeInfo[symbol]?.maxLeverage || 50;
}

// TÍNH TOÁN KHỐI LƯỢNG CHUẨN XÁC DỰA TRÊN MAX LEVERAGE CỦA COIN ĐÓ
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
    // SỬ DỤNG MAX LEVERAGE THỰC TẾ
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
        const pStr = roundPrice(symbol, targetPrice).toFixed(info.pricePrecision ?? 4);
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

        const res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params);
        if (res && (res.algoId || res.clientAlgoId || res.code === '200')) {
            addBotLog(`📝 [ĐẶT LỆNH] ${symbol} | <b style="color:#facc15">[GRID ${gridTag}]</b> | ${side} ${positionSide} | Type: ${orderType} | Price: ${pStr} | Qty: ${qStr} (~${(qty * targetPrice).toFixed(1)}$)`, "info");
            return res;
        } else {
            addBotLog(`❌ [LỖI LỆNH] ${symbol} | <b style="color:#facc15">[GRID ${gridTag}]</b>: Không nhận được phản hồi hợp lệ từ sàn`, "error");
            return null;
        }
    } catch (e) {
        addBotLog(`❌ [LỖI LỆNH] ${symbol} | <b style="color:#facc15">[GRID ${gridTag}]</b> | ${side}_${positionSide} @ ${targetPrice}: ${e.response?.data?.msg || e.message}`, "error");
        return null;
    }
}

// TRIỂN KHAI ĐÚNG 4 LỆNH TRÊN 1 MỐC GRID - TỶ LỆ SL = 70% TP
async function deployGridLevel(symbol, levelPrice, initialEntry, gridNum) {
    const tpPct = botSettings.tpSlPct;
    const slPct = botSettings.tpSlPct * 0.7; // SL = 70% TP
    const gridTag = gridNum > 0 ? `+${gridNum}` : `${gridNum}`;

    const tpOffset = initialEntry * (tpPct / 100);
    const slOffset = initialEntry * (slPct / 100);

    const qty = calculateOrderQtyForPrice(symbol, levelPrice);

    let openLong, openShort, tpOrder, slOrder;

    // 1. Mở cặp lệnh Long & Short tại mốc Grid
    openLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', levelPrice, qty, gridTag);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    openShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', levelPrice, qty, gridTag);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    // 2. Cài 1 lệnh TP và 1 lệnh SL theo khoảng cách giá quét đầu
    if (gridNum > 0) {
        const longTpPrice = levelPrice + tpOffset;
        const shortSlPrice = levelPrice + slOffset;

        tpOrder = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longTpPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        slOrder = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortSlPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    } else {
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
        openLongId: openLong?.algoId,
        openShortId: openShort?.algoId,
        tpOrderId: tpOrder?.algoId,
        slOrderId: slOrder?.algoId,
        algoIds,
        successCount: algoIds.length
    };
}

// HỦY MỐC VÀ KIỂM TRA TRỰC TIẾP TRÊN SÀN
async function cancelGridLevelOrders(symbol, levelObj) {
    if (!levelObj || !levelObj.algoIds || levelObj.algoIds.length === 0) return true;
    const gridTag = levelObj.gridNum > 0 ? `+${levelObj.gridNum}` : `${levelObj.gridNum}`;
    addBotLog(`🔄 [HỦY MỐC] ${symbol}: Đang gửi yêu cầu hủy mốc <b style="color:#facc15">[GRID ${gridTag}]</b> @ ${roundPrice(symbol, levelObj.levelPrice)} (${levelObj.algoIds.length} lệnh)`, "warn");
    
    for (const aId of levelObj.algoIds) {
        try {
            await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: aId });
            await new Promise(r => setTimeout(r, 60));
        } catch (e) {}
    }

    await new Promise(r => setTimeout(r, 200));
    const openOrders = await getOpenAlgoOrders(symbol);
    const openIdsSet = new Set(openOrders.map(o => String(o.algoId)));
    const remaining = levelObj.algoIds.filter(id => openIdsSet.has(String(id)));

    if (remaining.length === 0) {
        addBotLog(`🛡️ [XÁC NHẬN SÀN] ${symbol}: Đã xóa sạch các lệnh của mốc <b style="color:#facc15">[GRID ${gridTag}]</b> trên Binance.`, "info");
        return true;
    } else {
        addBotLog(`⚠️ [CẢNH BÁO] ${symbol}: Còn ${remaining.length} lệnh chưa hủy xong tại <b style="color:#facc15">[GRID ${gridTag}]</b>. Đang cưỡng chế hủy...`, "warn");
        for (const remId of remaining) {
            await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: remId }).catch(() => {});
        }
        return false;
    }
}

// KHỞI TẠO GRID
async function initializeCoinGrid(symbol) {
    const info = status.exchangeInfo[symbol];
    if (!info) {
        addBotLog(`⚠️ Không có thông tin hợp đồng cho ${symbol}. Bỏ qua.`, "warn");
        return;
    }

    try {
        const maxLev = await fetchMaxLeverage(symbol);
        info.maxLeverage = maxLev;

        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});
        await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(() => {});
        await binancePrivate('/fapi/v1/leverage', 'POST', { symbol, leverage: maxLev }).catch(() => {});

        // Dọn sạch lệnh cũ để không bị dư thừa
        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);

        addBotLog(`🚀 [KHỞI TẠO GRID] ${symbol} | Entry quét đầu: ${initialEntry} | Mốc: ${botSettings.gridLevels} trên + ${botSettings.gridLevels} dưới (Tổng 10 mốc = 40 lệnh) | Lev: x${maxLev} (MaxLev Sàn) | SL: 70% TP`, "info");

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
            const ban = checkBanStatus();
            if (ban.isBanned) break;

            const levelObj = await deployGridLevel(symbol, item.price, initialEntry, item.gridNum);

            if (item.gridNum > 0) {
                currentCoinGrid.upperLevels.push(levelObj);
            } else {
                currentCoinGrid.lowerLevels.push(levelObj);
            }

            const gridTag = item.gridNum > 0 ? `+${item.gridNum}` : `${item.gridNum}`;
            const openOrders = await getOpenAlgoOrders(symbol);
            const openIdsSet = new Set(openOrders.map(o => String(o.algoId)));
            const verified = levelObj.algoIds.filter(id => openIdsSet.has(String(id))).length;

            if (verified === 4) {
                addBotLog(`✅ Đã thiết lập xong mốc <b style="color:#facc15">[GRID ${gridTag}]</b> của ${symbol} @ ${roundPrice(symbol, item.price)} (Đã xác nhận 4/4 lệnh trên sàn)`);
            } else {
                addBotLog(`⚠️ [CẢNH BÁO SÀN] Mốc <b style="color:#facc15">[GRID ${gridTag}]</b> chỉ xác nhận được ${verified}/4 lệnh treo thực tế!`, "warn");
            }
            await new Promise(r => setTimeout(r, 80));
        }

        currentCoinGrid.upperLevels.sort((a, b) => a.levelPrice - b.levelPrice);
        currentCoinGrid.lowerLevels.sort((a, b) => a.levelPrice - b.levelPrice);

        currentCoinGrid.isInitializing = false;
        
        const stat = volumeStats.get(symbol);
        stat.totalGridsRan += (currentCoinGrid.upperLevels.length + currentCoinGrid.lowerLevels.length);
        saveData();

        addBotLog(`🎯 HOÀN TẤT KHỞI TẠO GRID ${symbol}! Đang trực chiến Trailing và giám sát STP/TP/SL.`, "success");

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

// TRAILING GRID CHUẨN XÁC
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

            addBotLog(`🔄 [TRAILING PHÁT HIỆN] ${symbol}: Giá chạm mốc ${roundPrice(symbol, upperThreshold)}! Đang đặt mốc <b style="color:#facc15">[GRID +${newUpperGridNum}]</b> và hủy mốc đáy...`, "info");

            const newUpper = await deployGridLevel(symbol, newUpperPrice, initialEntry, newUpperGridNum);

            await new Promise(r => setTimeout(r, 200));
            const openOrders = await getOpenAlgoOrders(symbol);
            const openIdsSet = new Set(openOrders.map(o => String(o.algoId)));
            const verifiedNew = newUpper.algoIds.filter(id => openIdsSet.has(String(id))).length;

            if (verifiedNew < 4) {
                addBotLog(`❌ [TRAILING LỖI] ${symbol}: Không thể đặt đủ lệnh mốc <b style="color:#facc15">[GRID +${newUpperGridNum}]</b> trên sàn (Chỉ có ${verifiedNew}/4 lệnh)! Giữ nguyên mốc.`, "error");
                cState.isTrailing = false;
                return;
            }

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

            addBotLog(`➕ [TRAILING LÊN THÀNH CÔNG] ${symbol}: Đã xác nhận trên sàn mốc <b style="color:#facc15">[GRID +${newUpperGridNum}]</b> @ ${roundPrice(symbol, newUpperPrice)} (Đủ 4 lệnh) và hủy mốc đáy.`, "success");
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

            addBotLog(`🔄 [TRAILING PHÁT HIỆN] ${symbol}: Giá chạm mốc ${roundPrice(symbol, lowerThreshold)}! Đang đặt mốc <b style="color:#facc15">[GRID ${newLowerGridNum}]</b> và hủy mốc đỉnh...`, "info");

            const newLower = await deployGridLevel(symbol, newLowerPrice, initialEntry, newLowerGridNum);

            await new Promise(r => setTimeout(r, 200));
            const openOrders = await getOpenAlgoOrders(symbol);
            const openIdsSet = new Set(openOrders.map(o => String(o.algoId)));
            const verifiedNew = newLower.algoIds.filter(id => openIdsSet.has(String(id))).length;

            if (verifiedNew < 4) {
                addBotLog(`❌ [TRAILING LỖI] ${symbol}: Không thể đặt đủ lệnh mốc <b style="color:#facc15">[GRID ${newLowerGridNum}]</b> trên sàn (Chỉ có ${verifiedNew}/4 lệnh)! Giữ nguyên mốc.`, "error");
                cState.isTrailing = false;
                return;
            }

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

            addBotLog(`➕ [TRAILING XUỐNG THÀNH CÔNG] ${symbol}: Đã xác nhận trên sàn mốc <b style="color:#facc15">[GRID ${newLowerGridNum}]</b> @ ${roundPrice(symbol, newLowerPrice)} (Đủ 4 lệnh) và hủy mốc đỉnh.`, "success");
        } catch (err) {
            console.error("Trailing Down Err:", err.message);
        } finally {
            cState.isTrailing = false;
        }
    }
}

// LUỒNG NGẦM ĐỒNG BỘ VÍ & CƠ CHẾ CHỐNG THANH LÝ KHẨN CẤP (<15% VÍ)
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

                // CƠ CHẾ CHỐNG THANH LÝ (YÊU CẦU 1)
                if (totalWallet > 0 && botSettings.isRunning) {
                    const availRatio = (avail / totalWallet) * 100;
                    if (availRatio < LIQUIDATION_PROTECT_RATIO) {
                        addBotLog(`🚨 [CHỐNG THANH LÝ KHẨN CẤP] Khả dụng chỉ còn ${availRatio.toFixed(1)}% (<15% ví: ${avail}$ / ${totalWallet}$). Khẩn cấp đóng toàn bộ vị thế và DỪNG BOT!`, "error");
                        botSettings.isRunning = false;
                        saveData();

                        // 1. Đóng sạch toàn bộ vị thế thị trường
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
                                addBotLog(`⚡ [ĐÓNG VỊ THẾ KHẨN CẤP] Đã Market Close ${p.symbol} ${p.positionSide} (KL: ${Math.abs(amt)})`, "warn");
                            }
                        }

                        // 2. Hủy toàn bộ lệnh chờ Algo & lệnh thường
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

// LUỒNG NGẦM GIÁM SÁT TRAILING & BẢO VỆ STP / VỊ THẾ KHÔNG CÓ TP/SL
async function monitorGridWorker() {
    if (status.isReady && botSettings.isRunning) {
        try {
            for (const symbol of botSettings.coinList) {
                const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
                const markP = ticker ? parseFloat(ticker.data.price) : 0;
                if (markP > 0) {
                    await handleTrailing(symbol, markP);
                }

                const cState = gridState.get(symbol);
                if (cState && !cState.isInitializing && !cState.isTrailing) {
                    const openAlgoOrders = await getOpenAlgoOrders(symbol);
                    const openIdsSet = new Set(openAlgoOrders.map(o => String(o.algoId)));

                    // KIỂM TRA LỖI STP / LỆNH OPEN BỊ HẾT HẠN (YÊU CẦU 2A)
                    const allLevels = [...cState.upperLevels, ...cState.lowerLevels];
                    for (const lvl of allLevels) {
                        const gridTag = lvl.gridNum > 0 ? `+${lvl.gridNum}` : `${lvl.gridNum}`;
                        // Kiểm tra lệnh Mở Long
                        if (lvl.openLongId && !openIdsSet.has(String(lvl.openLongId))) {
                            const currentPos = accountCache.rawPositions.find(p => p.symbol === symbol && p.positionSide === 'LONG');
                            if (!currentPos || Math.abs(parseFloat(currentPos.positionAmt)) === 0) {
                                addBotLog(`🔄 [STP/HẾT HẠN PHÁT HIỆN] ${symbol} <b style="color:#facc15">[GRID ${gridTag}]</b> lệnh Mở Long bị mất trên sàn! Đang cài lại ngay...`, "warn");
                                const newOpenLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', lvl.levelPrice, lvl.qty, gridTag);
                                if (newOpenLong?.algoId) {
                                    lvl.openLongId = newOpenLong.algoId;
                                    lvl.algoIds.push(newOpenLong.algoId);
                                }
                            }
                        }
                        // Kiểm tra lệnh Mở Short
                        if (lvl.openShortId && !openIdsSet.has(String(lvl.openShortId))) {
                            const currentPos = accountCache.rawPositions.find(p => p.symbol === symbol && p.positionSide === 'SHORT');
                            if (!currentPos || Math.abs(parseFloat(currentPos.positionAmt)) === 0) {
                                addBotLog(`🔄 [STP/HẾT HẠN PHÁT HIỆN] ${symbol} <b style="color:#facc15">[GRID ${gridTag}]</b> lệnh Mở Short bị mất trên sàn! Đang cài lại ngay...`, "warn");
                                const newOpenShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', lvl.levelPrice, lvl.qty, gridTag);
                                if (newOpenShort?.algoId) {
                                    lvl.openShortId = newOpenShort.algoId;
                                    lvl.algoIds.push(newOpenShort.algoId);
                                }
                            }
                        }
                    }

                    // KIỂM TRA VỊ THẾ MỞ CÓ TP/SL KHÔNG - NẾU KHÔNG CÓ THÌ PHẢI CẮT NGAY (YÊU CẦU 2B)
                    const longPos = accountCache.rawPositions.find(p => p.symbol === symbol && p.positionSide === 'LONG' && Math.abs(parseFloat(p.positionAmt)) > 0);
                    if (longPos) {
                        const hasLongTpSl = openAlgoOrders.some(o => o.positionSide === 'LONG' && o.side === 'SELL');
                        if (!hasLongTpSl) {
                            const longQty = Math.abs(parseFloat(longPos.positionAmt));
                            addBotLog(`🚨 [CẮT VỊ THẾ KHẨN CẤP] ${symbol} LONG (${longQty}) KHÔNG CÓ LỆNH TP/SL BẢO VỆ TRÊN SÀN! Ép đóng MARKET ngay!`, "error");
                            await binancePrivate('/fapi/v1/order', 'POST', {
                                symbol,
                                side: 'SELL',
                                positionSide: 'LONG',
                                type: 'MARKET',
                                quantity: longQty.toString()
                            }).catch(() => {});
                        }
                    }

                    const shortPos = accountCache.rawPositions.find(p => p.symbol === symbol && p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
                    if (shortPos) {
                        const hasShortTpSl = openAlgoOrders.some(o => o.positionSide === 'SHORT' && o.side === 'BUY');
                        if (!hasShortTpSl) {
                            const shortQty = Math.abs(parseFloat(shortPos.positionAmt));
                            addBotLog(`🚨 [CẮT VỊ THẾ KHẨN CẤP] ${symbol} SHORT (${shortQty}) KHÔNG CÓ LỆNH TP/SL BẢO VỆ TRÊN SÀN! Ép đóng MARKET ngay!`, "error");
                            await binancePrivate('/fapi/v1/order', 'POST', {
                                symbol,
                                side: 'BUY',
                                positionSide: 'SHORT',
                                type: 'MARKET',
                                quantity: shortQty.toString()
                            }).catch(() => {});
                        }
                    }
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

// KHỞI CHẠY HỆ THỐNG
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
                maxLeverage: 50
            };
        });

        // LẤY CHÍNH XÁC MAX LEVERAGE CỦA TẤT CẢ COIN TỪ SÀN
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

    // VỊ THẾ ĐANG MỞ CHỈ HIỆN COIN DO BOT QUẢN LÝ (YÊU CẦU 4)
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

    // KHÔNG XÓA LỊCH SỬ THỐNG KÊ DÙ COIN ĐANG TẮT / ĐÃ BỎ (YÊU CẦU 3B)
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
            totalVolume: st.totalVolume.toFixed(2),
            totalGrids: st.totalGridsRan || 0,
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
    saveData(); // Lưu lại danh sách coin nhưng KHÔNG xóa trong volumeStats

    try {
        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
    } catch (e) {}

    gridState.delete(symbol);
    addBotLog(`🗑️ Đã dừng chạy ${symbol} và hủy mọi lệnh chờ (Lịch sử thống kê vẫn được giữ nguyên).`, "warn");
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 BOT GRID VOLUME FUTURES ĐANG CHẠY TẠI PORT: ${PORT}`);
    console.log(`🔗 Truy cập giao diện: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
