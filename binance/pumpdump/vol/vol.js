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
const INIT_DURATION_PER_COIN_MS = 60000;         // Khởi tạo 1 coin rải đều trong đúng 1 phút
const MIN_ORDER_DELAY_MS = 650;                  // Giãn cách an toàn giữa các lệnh chống rate limit
const SAFE_LEVERAGE = 20;                        // Đòn bẩy an toàn mặc định
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
    tpSlPct: 1.0,          // % TP (SL sẽ tự động tính = 90% của TP)
    gridLevels: 5,         // Số mốc Grid trên và số mốc Grid dưới (5 trên + 5 dưới = 10 mốc)
    coinList: ['BTCUSDC', 'ETHUSDC']
};

let status = {
    botLogs: [],
    exchangeInfo: {},
    isReady: false,
    ipBannedUntil: 0
};

// BỘ NHỚ ĐỆM TÀI KHOẢN (TRÁNH NGHẼN API KHI TRÌNH DUYỆT SYNC)
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

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    // Bỏ thẻ HTML khi in ra terminal console để dễ đọc
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
    addBotLog(`🚨 [IP BANNED] Tạm ngưng gọi sàn đến: ${new Date(status.ipBannedUntil).toLocaleTimeString('vi-VN')}. Chi tiết: ${msg}`, "error");
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

// FIX TỰ LÀM TRÒN LÊN ĐỂ KHÔNG BAO GIỜ BỊ LỖI MIN NOTIONAL HOẶC MIN VOL
function calculateOrderQty(symbol, currentPrice) {
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

    // Nếu người dùng nhập số < 1 (ví dụ 0.1) dù không gõ '%' thì mặc định vẫn là 0.1% ví
    if (val < 1 && !isPercent) {
        isPercent = true;
    }

    let margin = 0;
    if (isPercent) {
        margin = (wallet * val) / 100;
    } else {
        margin = val;
    }

    const lev = Math.min(SAFE_LEVERAGE, info.maxLeverage || SAFE_LEVERAGE);
    let notional = margin * lev;

    // Binance yêu cầu giá trị tối thiểu mỗi lệnh là 5 USDT/USDC (lấy 5.2$ để có đệm an toàn)
    const safeMinNotional = Math.max(info.minNotional || 5.0, 5.2);
    if (notional < safeMinNotional) {
        notional = safeMinNotional;
    }

    let rawQty = notional / currentPrice;
    if (info.minQty && rawQty < info.minQty) {
        rawQty = info.minQty;
    }

    // Tự động làm tròn lên (Math.ceil) theo stepSize để đảm bảo không bị tụt dưới Min Notional
    const step = info.stepSize || Math.pow(10, -(info.quantityPrecision ?? 2));
    let finalQty = Math.ceil(rawQty / step) * step;

    // Kiểm tra lại chắc chắn sau khi làm tròn
    while (finalQty * currentPrice < safeMinNotional) {
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

// Đặt lệnh có điều kiện qua Algo Order Endpoint
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
            positionSide: positionSide,          // 'LONG' hoặc 'SHORT'
            type: orderType,
            quantity: qStr,
            price: pStr,
            triggerPrice: pStr,
            timeInForce: 'GTC',
            workingType: 'MARK_PRICE'
        };

        const res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params);
        addBotLog(`📝 [ĐẶT LỆNH] ${symbol} | <b style="color:#facc15">[GRID ${gridTag}]</b> | ${side} ${positionSide} | Type: ${orderType} | Price: ${pStr} | Qty: ${qStr} (~${(qty * targetPrice).toFixed(1)}$)`, "info");
        return res;
    } catch (e) {
        addBotLog(`❌ [LỖI LỆNH] ${symbol} | <b style="color:#facc15">[GRID ${gridTag}]</b> | ${side}_${positionSide} @ ${targetPrice}: ${e.response?.data?.msg || e.message}`, "error");
        return null;
    }
}

// TRIỂN KHAI ĐÚNG 4 LỆNH TRÊN 1 MỐC GRID (10 MỐC = 40 LỆNH)
async function deployGridLevel(symbol, levelPrice, qty, gridNum) {
    const tpPct = botSettings.tpSlPct;
    const slPct = botSettings.tpSlPct * 0.9;
    const gridTag = gridNum > 0 ? `+${gridNum}` : `${gridNum}`;

    let openLong, openShort, tpOrder, slOrder;

    // 1. Luôn mở cặp lệnh Mở Long & Mở Short tại giá mốc Grid
    openLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', levelPrice, qty, gridTag);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    openShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', levelPrice, qty, gridTag);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    // 2. Thiết lập đúng 1 lệnh TP và 1 lệnh SL theo chiều mốc (Tổng đúng 4 lệnh)
    if (gridNum > 0) {
        // MỐC TRÊN: Giá tăng chạm mốc -> Long chốt lời ở trên, Short cắt lỗ ở trên
        const longTpPrice = levelPrice * (1 + (tpPct / 100));
        const shortSlPrice = levelPrice * (1 + (slPct / 100));

        tpOrder = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longTpPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        slOrder = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortSlPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    } else {
        // MỐC DƯỚI: Giá giảm chạm mốc -> Short chốt lời ở dưới, Long cắt lỗ ở dưới
        const shortTpPrice = levelPrice * (1 - (tpPct / 100));
        const longSlPrice = levelPrice * (1 - (slPct / 100));

        tpOrder = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortTpPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

        slOrder = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longSlPrice, qty, gridTag);
        await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));
    }

    return {
        gridNum,
        levelPrice,
        qty,
        algoIds: [
            openLong?.algoId, openShort?.algoId,
            tpOrder?.algoId, slOrder?.algoId
        ].filter(Boolean)
    };
}

async function cancelGridLevelOrders(symbol, levelObj) {
    if (!levelObj || !levelObj.algoIds) return;
    const gridTag = levelObj.gridNum > 0 ? `+${levelObj.gridNum}` : `${levelObj.gridNum}`;
    addBotLog(`🔄 [HỦY MỐC] ${symbol}: Đang hủy mốc <b style="color:#facc15">[GRID ${gridTag}]</b> @ ${roundPrice(symbol, levelObj.levelPrice)} (4 lệnh)`, "warn");
    for (const aId of levelObj.algoIds) {
        try {
            await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: aId });
            await new Promise(r => setTimeout(r, 80));
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

        // Dọn sạch toàn bộ lệnh cũ trước khi rải để đảm bảo không bị thừa lệnh
        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);
        const qty = calculateOrderQty(symbol, initialEntry);

        addBotLog(`🚀 [KHỞI TẠO GRID] ${symbol} | Giá quét đầu: ${initialEntry} | Cài đặt: ${botSettings.gridLevels} mốc trên + ${botSettings.gridLevels} mốc dưới (Tổng 10 mốc = đúng 40 lệnh) | Khối lượng: ${qty} (~${(qty * initialEntry).toFixed(1)}$/lệnh)`, "info");

        const stepPct = botSettings.gridOpenPct / 100;

        // XÂY DỰNG HÀNG ĐỢI ƯU TIÊN MỐC XA NHẤT TRƯỚC: Grid 5 -> Grid -5 -> Grid 4 -> Grid -4...
        const queuePlan = [];
        for (let k = botSettings.gridLevels; k >= 1; k--) {
            queuePlan.push({ gridNum: k, price: initialEntry * (1 + (k * stepPct)) });   // Mốc trên xa nhất (+5, +4, +3...)
            queuePlan.push({ gridNum: -k, price: initialEntry * (1 - (k * stepPct)) });  // Mốc dưới xa nhất (-5, -4, -3...)
        }

        const totalSteps = queuePlan.length;
        const delayBetweenSteps = Math.max(Math.floor(INIT_DURATION_PER_COIN_MS / totalSteps), MIN_ORDER_DELAY_MS * 4 + 100);

        const currentCoinGrid = {
            initialEntry,
            currentCenterPrice: initialEntry,
            upperLevels: [],
            lowerLevels: [],
            isInitializing: true,
            isTrailing: false
        };
        gridState.set(symbol, currentCoinGrid);

        for (const item of queuePlan) {
            if (!botSettings.isRunning) break;
            const ban = checkBanStatus();
            if (ban.isBanned) break;

            const tStart = Date.now();
            const levelObj = await deployGridLevel(symbol, item.price, qty, item.gridNum);

            if (item.gridNum > 0) {
                currentCoinGrid.upperLevels.push(levelObj);
            } else {
                currentCoinGrid.lowerLevels.push(levelObj);
            }

            const gridTag = item.gridNum > 0 ? `+${item.gridNum}` : `${item.gridNum}`;
            addBotLog(`✅ Đã thiết lập xong mốc <b style="color:#facc15">[GRID ${gridTag}]</b> của ${symbol} @ ${roundPrice(symbol, item.price)} (Đủ 4/4 lệnh)`);

            const elapsed = Date.now() - tStart;
            const waitTime = delayBetweenSteps - elapsed;
            if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
        }

        // Sắp xếp các mốc theo thứ tự giá tăng dần để phục vụ Trailing chính xác
        currentCoinGrid.upperLevels.sort((a, b) => a.levelPrice - b.levelPrice);
        currentCoinGrid.lowerLevels.sort((a, b) => a.levelPrice - b.levelPrice);

        currentCoinGrid.isInitializing = false;
        const totalOrdersPlaced = (currentCoinGrid.upperLevels.length + currentCoinGrid.lowerLevels.length) * 4;
        addBotLog(`🎯 HOÀN TẤT KHỞI TẠO GRID ${symbol}! Đã đặt đủ ${currentCoinGrid.upperLevels.length + currentCoinGrid.lowerLevels.length} mốc với đúng ${totalOrdersPlaced} lệnh chờ trên sàn.`, "success");

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
        await new Promise(r => setTimeout(r, 2000));
    }

    isQueueProcessing = false;
}

// LOGIC TRAILING CHUẨN XÁC: LUÔN DUY TRÌ ĐÚNG 40 LỆNH (10 MỐC X 4)
async function handleTrailing(symbol, markPrice) {
    const cState = gridState.get(symbol);
    if (!cState || cState.isInitializing || cState.isTrailing) return;

    const stepPct = botSettings.gridOpenPct / 100;
    const qty = calculateOrderQty(symbol, markPrice);

    const upperThreshold = cState.currentCenterPrice * (1 + stepPct);
    const lowerThreshold = cState.currentCenterPrice * (1 - stepPct);

    // 1. KHI GIÁ VƯỢT LÊN MỐC TRÊN TIẾP THEO
    if (markPrice >= upperThreshold && cState.upperLevels.length > 0) {
        cState.isTrailing = true;
        try {
            cState.currentCenterPrice = upperThreshold;

            // Hủy mốc xa nhất phía dưới (dưới cùng)
            if (cState.lowerLevels.length > 0) {
                const removedLower = cState.lowerLevels.shift();
                await cancelGridLevelOrders(symbol, removedLower);
            }

            // Mốc vừa vượt qua chuyển từ Upper thành mốc Lower gần nhất
            const crossedLevel = cState.upperLevels.shift();
            if (crossedLevel) cState.lowerLevels.push(crossedLevel);

            // Bổ sung mốc mới ở đỉnh trên cùng
            const highestUpper = cState.upperLevels[cState.upperLevels.length - 1] || crossedLevel;
            const newGridNum = (highestUpper.gridNum || botSettings.gridLevels) + 1;
            const newUpperPrice = highestUpper.levelPrice * (1 + stepPct);
            const newUpper = await deployGridLevel(symbol, newUpperPrice, qty, newGridNum);
            cState.upperLevels.push(newUpper);

            addBotLog(`➕ [TRAILING LÊN] ${symbol}: Thêm mốc <b style="color:#facc15">[GRID +${newGridNum}]</b> @ ${roundPrice(symbol, newUpperPrice)}. Giữ nguyên đúng ${cState.upperLevels.length + cState.lowerLevels.length} mốc (40 lệnh).`, "success");
        } catch (err) {
            console.error("Trailing Up Err:", err.message);
        } finally {
            cState.isTrailing = false;
        }
    }

    // 2. KHI GIÁ TỤT XUỐNG MỐC DƯỚI TIẾP THEO
    else if (markPrice <= lowerThreshold && cState.lowerLevels.length > 0) {
        cState.isTrailing = true;
        try {
            cState.currentCenterPrice = lowerThreshold;

            // Hủy mốc xa nhất phía trên (trên đỉnh)
            if (cState.upperLevels.length > 0) {
                const removedUpper = cState.upperLevels.pop();
                await cancelGridLevelOrders(symbol, removedUpper);
            }

            // Mốc vừa bị xuyên thủng chuyển từ Lower thành mốc Upper gần nhất
            const crossedLevel = cState.lowerLevels.pop();
            if (crossedLevel) cState.upperLevels.unshift(crossedLevel);

            // Bổ sung mốc mới ở đáy dưới cùng
            const lowestLower = cState.lowerLevels[0] || crossedLevel;
            const newGridNum = (lowestLower.gridNum || -botSettings.gridLevels) - 1;
            const newLowerPrice = lowestLower.levelPrice * (1 - stepPct);
            const newLower = await deployGridLevel(symbol, newLowerPrice, qty, newGridNum);
            cState.lowerLevels.unshift(newLower);

            addBotLog(`➕ [TRAILING XUỐNG] ${symbol}: Thêm mốc <b style="color:#facc15">[GRID ${newGridNum}]</b> @ ${roundPrice(symbol, newLowerPrice)}. Giữ nguyên đúng ${cState.upperLevels.length + cState.lowerLevels.length} mốc (40 lệnh).`, "success");
        } catch (err) {
            console.error("Trailing Down Err:", err.message);
        } finally {
            cState.isTrailing = false;
        }
    }
}

// Luồng ngầm đồng bộ tài khoản 2 giây/lần
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

// Luồng ngầm giám sát vị thế & volume trade
async function monitorGridWorker() {
    if (status.isReady && botSettings.isRunning) {
        try {
            for (const symbol of botSettings.coinList) {
                const currentPos = accountCache.rawPositions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
                if (currentPos) {
                    await handleTrailing(symbol, parseFloat(currentPos.markPrice || currentPos.entryPrice));
                }

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 }).catch(() => []);
                let stat = volumeStats.get(symbol) || {
                    orderCount: 0,
                    totalVolume: 0,
                    totalPnL: 0,
                    lastTpPrice: 0,
                    lastSlPrice: 0,
                    lastTpPnl: 0,
                    lastSlPnl: 0,
                    recordedTradeIds: new Set()
                };

                for (const t of trades) {
                    if (!stat.recordedTradeIds.has(t.id)) {
                        stat.recordedTradeIds.add(t.id);
                        stat.orderCount += 1;
                        const val = parseFloat(t.qty) * parseFloat(t.price);
                        stat.totalVolume += val;
                        const pnl = parseFloat(t.realizedPnl);
                        stat.totalPnL += pnl;

                        if (pnl > 0) {
                            stat.lastTpPrice = parseFloat(t.price);
                            stat.lastTpPnl = pnl;
                            addBotLog(`💰 [KHỚP TP] ${symbol} | Giá: ${t.price} | Lãi: +${pnl.toFixed(4)}$ | Vol: ${val.toFixed(2)}$`, "success");
                        } else if (pnl < 0) {
                            stat.lastSlPrice = parseFloat(t.price);
                            stat.lastSlPnl = pnl;
                            addBotLog(`📉 [KHỚP SL] ${symbol} | Giá: ${t.price} | Lỗ: ${pnl.toFixed(4)}$ | Vol: ${val.toFixed(2)}$`, "error");
                        }
                    }
                }
                volumeStats.set(symbol, stat);
            }
        } catch (e) {}
    }
    setTimeout(monitorGridWorker, 3000);
}

// Khởi chạy hệ thống nền
async function init() {
    addBotLog("🔄 Khởi tạo kết nối Binance...", "info");
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

    const openPositions = (accountCache.rawPositions || [])
        .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
        .map(p => {
            const sym = p.symbol;
            const cState = gridState.get(sym);
            const initialE = cState?.initialEntry || parseFloat(p.entryPrice);
            const markP = parseFloat(p.markPrice || p.entryPrice);
            const distPct = initialE > 0 ? ((markP - initialE) / initialE) * 100 : 0;
            const info = status.exchangeInfo[sym] || { maxLeverage: SAFE_LEVERAGE };

            const tpPct = botSettings.tpSlPct;
            const slPct = botSettings.tpSlPct * 0.9;
            const isLong = p.positionSide === 'LONG';
            const calcTp = isLong ? parseFloat(p.entryPrice) * (1 + tpPct/100) : parseFloat(p.entryPrice) * (1 - tpPct/100);
            const calcSl = isLong ? parseFloat(p.entryPrice) * (1 - slPct/100) : parseFloat(p.entryPrice) * (1 + slPct/100);

            return {
                symbol: sym,
                side: p.positionSide,
                leverage: p.leverage || SAFE_LEVERAGE,
                margin: parseFloat(p.isolatedMargin || (Math.abs(parseFloat(p.positionAmt)) * markP / (p.leverage || SAFE_LEVERAGE))).toFixed(2),
                qty: Math.abs(parseFloat(p.positionAmt)),
                initialEntry: initialE,
                currentPrice: markP,
                entryPrice: parseFloat(p.entryPrice),
                tp: calcTp.toFixed(4),
                sl: calcSl.toFixed(4),
                distPct: distPct.toFixed(2),
                pnl: parseFloat(p.unrealizedProfit)
            };
        });

    const volumeData = botSettings.coinList.map((s, idx) => {
        const st = volumeStats.get(s) || { orderCount: 0, totalVolume: 0, totalPnL: 0, lastTpPrice: 0, lastSlPrice: 0, lastTpPnl: 0, lastSlPnl: 0 };
        const info = status.exchangeInfo[s] || { maxLeverage: SAFE_LEVERAGE };
        return {
            stt: idx + 1,
            symbol: s,
            leverage: SAFE_LEVERAGE,
            orderCount: st.orderCount,
            totalVolume: st.totalVolume.toFixed(2),
            totalPnL: st.totalPnL.toFixed(4),
            lastTpPrice: st.lastTpPrice,
            lastSlPrice: st.lastSlPrice,
            lastTpPnl: st.lastTpPnl.toFixed(4),
            lastSlPnl: st.lastSlPnl.toFixed(4)
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

    if (isRunning !== undefined && isRunning !== botSettings.isRunning) {
        botSettings.isRunning = isRunning;
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

    addBotLog(`⚙️ Đã thêm ${added} coin mới (Ép Cross Margin).`, "success");
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.post('/api/coins/remove', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: "Thiếu symbol" });

    botSettings.coinList = botSettings.coinList.filter(c => c !== symbol);
    initCoinQueue = initCoinQueue.filter(c => c !== symbol);

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
