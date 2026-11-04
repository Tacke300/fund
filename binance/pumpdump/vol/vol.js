import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================================
// CẤU HÌNH HỆ THỐNG GRID & CHỐNG BAN IP (TÙY CHỈNH TẠI ĐÂY)
// =========================================================================
const PORT = 3333;
const DEFAULT_COIN_SUFFIX = 'USDC';              // Mặc định thêm nếu nhập thiếu (uai -> UAIUSDC)
const INIT_DURATION_PER_COIN_MS = 60000;         // Thời gian khởi tạo trải đều cho mỗi coin (1 phút = 60000ms)
const ORDER_CALL_DELAY_MS = 650;                 // Độ giãn cách tối thiểu giữa mỗi request order để an toàn rate limit
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 15000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, 
        recvWindow: 60000, 
        adjustForTimeDifference: true 
    } 
});

// Trạng thái cấu hình bot
let botSettings = {
    isRunning: false,
    invValue: "10",        // $ hoặc %
    gridOpenPct: 1.0,      // % open (khoảng cách mỗi mốc grid tính từ entry quét đầu)
    tpSlPct: 1.0,          // TP % (SL sẽ tự động = 90% của giá trị này: 0.9 * tpSlPct)
    gridLevels: 5,         // Số grid trên và số grid dưới
    coinList: ['BTCUSDC', 'ETHUSDC']
};

let status = {
    botLogs: [],
    exchangeInfo: {},
    isReady: false,
    ipBannedUntil: 0       // Timestamp nếu bị ban IP
};

// Dữ liệu nội bộ quản lý
let gridState = new Map();       // symbol => { initialEntry, upperLevels: [], lowerLevels: [], isInitializing: false }
let volumeStats = new Map();     // symbol => { orderCount, totalVolume, totalPnL, lastTpPrice, lastSlPrice, lastTpPnl, lastSlPnl }
let isQueueInitializing = false;
let initCoinQueue = [];
let timestampOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// Kiểm tra và xử lý IP BAN
function checkBanStatus() {
    if (status.ipBannedUntil > Date.now()) {
        const remainingSec = Math.ceil((status.ipBannedUntil - Date.now()) / 1000);
        return { isBanned: true, remainingSec };
    }
    return { isBanned: false, remainingSec: 0 };
}

function triggerIpBan(msg, banDurationMs = 300000) {
    status.ipBannedUntil = Date.now() + banDurationMs;
    addBotLog(`🚨 [IP_BAN] Hệ thống phát hiện IP bị hạn chế! Tạm dừng mọi hoạt động tới: ${new Date(status.ipBannedUntil).toLocaleTimeString('vi-VN')}. Chi tiết: ${msg}`, "error");
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const banCheck = checkBanStatus();
    if (banCheck.isBanned) {
        throw new Error(`IP đang bị khóa, thử lại sau ${banCheck.remainingSec}s`);
    }

    try {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        const statusErr = e.response?.status;
        const errData = e.response?.data;

        if (statusErr === 418 || statusErr === 429 || errData?.code === -1003) {
            let banMs = 300000;
            const match = errData?.msg?.match(/banned until (\d+)/);
            if (match && match[1]) {
                const targetTime = parseInt(match[1]);
                banMs = Math.max(targetTime - Date.now(), 60000);
            }
            triggerIpBan(errData?.msg || 'Too many requests / Banned IP', banMs);
        }

        if (errData?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

// Chuẩn hóa tên coin nhập vào (uai -> UAIUSDC)
function formatSymbol(rawInput) {
    let clean = rawInput.trim().toUpperCase();
    if (!clean) return null;
    if (clean.endsWith('USDT') || clean.endsWith('USDC')) {
        return clean;
    }
    return `${clean}${DEFAULT_COIN_SUFFIX}`;
}

// Tính khối lượng theo vốn cài đặt ($ hoặc % ví)
async function calculateOrderQty(symbol, currentPrice) {
    const info = status.exchangeInfo[symbol];
    if (!info) return 0;

    let margin = 0;
    if (botSettings.invValue.toString().includes('%')) {
        const acc = await binancePrivate('/fapi/v2/account');
        const avail = parseFloat(acc?.availableBalance || 0);
        const pct = parseFloat(botSettings.invValue) / 100;
        margin = avail * pct;
    } else {
        margin = parseFloat(botSettings.invValue);
    }

    if (margin <= 0) margin = 5;
    const notional = margin * info.maxLeverage;
    const rawQty = notional / currentPrice;
    let qty = Math.ceil(rawQty / info.stepSize) * info.stepSize;
    if (qty < info.stepSize) qty = info.stepSize;
    return parseFloat(qty.toFixed(info.quantityPrecision));
}

// Đặt lệnh có điều kiện Limit (Conditional Limit Order)
async function placeConditionalLimitOrder(symbol, side, positionSide, triggerPrice, orderPrice, qty, reduceOnly = false) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;

    // Type chọn phù hợp với chiều kích hoạt của Binance Futures: STOP hoặc TAKE_PROFIT
    // Đơn giản hóa: dùng type STOP cho lệnh điều kiện mở/đóng với price và stopPrice
    const params = {
        symbol: symbol,
        side: side,
        positionSide: positionSide,
        type: 'STOP',
        quantity: qty.toFixed(info.quantityPrecision),
        price: orderPrice.toFixed(info.pricePrecision),
        stopPrice: triggerPrice.toFixed(info.pricePrecision),
        timeInForce: 'GTC',
        workingType: 'MARK_PRICE'
    };
    if (reduceOnly) params.reduceOnly = 'true';

    try {
        const res = await binancePrivate('/fapi/v1/order', 'POST', params);
        return res;
    } catch (e) {
        addBotLog(`❌ [LỖI ĐẶT LỆNH] ${symbol} | ${side}_${positionSide} @ ${orderPrice}: ${e.response?.data?.msg || e.message}`, "error");
        return null;
    }
}

// Xây dựng toàn bộ các lệnh cho 1 mốc Grid (Cặp Long & Short + Cặp TP & SL của mốc đó)
async function deploySingleGridLevel(symbol, levelPrice, qty, isAbove) {
    const info = status.exchangeInfo[symbol];
    const tpPercent = botSettings.tpSlPct;
    const slPercent = botSettings.tpSlPct * 0.9; // SL = 90% của TP theo yêu cầu

    // 1. Mở vị thế tại levelPrice
    // LONG mở tại levelPrice
    const openLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', levelPrice, levelPrice, qty);
    await new Promise(r => setTimeout(r, ORDER_CALL_DELAY_MS));

    // SHORT mở tại levelPrice
    const openShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', levelPrice, levelPrice, qty);
    await new Promise(r => setTimeout(r, ORDER_CALL_DELAY_MS));

    // 2. Cài TP/SL có điều kiện cho vị thế LONG của mốc này (tính theo % của giá điểm mở levelPrice)
    const longTpPrice = levelPrice * (1 + tpPercent / 100);
    const longSlPrice = levelPrice * (1 - slPercent / 100);

    const tpLong = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longTpPrice, longTpPrice, qty, true);
    await new Promise(r => setTimeout(r, ORDER_CALL_DELAY_MS));

    const slLong = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longSlPrice, longSlPrice, qty, true);
    await new Promise(r => setTimeout(r, ORDER_CALL_DELAY_MS));

    // 3. Cài TP/SL có điều kiện cho vị thế SHORT của mốc này (tính theo % của giá điểm mở levelPrice)
    const shortTpPrice = levelPrice * (1 - tpPercent / 100);
    const shortSlPrice = levelPrice * (1 + slPercent / 100);

    const tpShort = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortTpPrice, shortTpPrice, qty, true);
    await new Promise(r => setTimeout(r, ORDER_CALL_DELAY_MS));

    const slShort = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortSlPrice, shortSlPrice, qty, true);
    await new Promise(r => setTimeout(r, ORDER_CALL_DELAY_MS));

    return {
        levelPrice,
        qty,
        orders: {
            openLongId: openLong?.orderId,
            openShortId: openShort?.orderId,
            tpLongId: tpLong?.orderId,
            slLongId: slLong?.orderId,
            tpShortId: tpShort?.orderId,
            slShortId: slShort?.orderId
        },
        targets: {
            longTpPrice, longSlPrice, shortTpPrice, shortSlPrice
        }
    };
}

// Hủy tất cả các lệnh thuộc một mốc Grid
async function cancelGridLevelOrders(symbol, levelObj) {
    if (!levelObj || !levelObj.orders) return;
    for (const key of Object.keys(levelObj.orders)) {
        const oId = levelObj.orders[key];
        if (oId) {
            try {
                await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: oId });
                await new Promise(r => setTimeout(r, 150));
            } catch (e) {}
        }
    }
}

// Khởi tạo Grid cho 1 Coin (trải dài trong 1 phút, ưu tiên mốc gần entry trước)
async function initializeGridForCoin(symbol) {
    const info = status.exchangeInfo[symbol];
    if (!info) {
        addBotLog(`⚠️ Bỏ qua ${symbol}: Không tìm thấy thông tin hợp đồng trên sàn.`, "warn");
        return;
    }

    try {
        await exchange.setLeverage(info.maxLeverage, symbol).catch(() => {});
        
        // Quét giá hiện tại làm entry quét đầu
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);
        const qty = await calculateOrderQty(symbol, initialEntry);

        addBotLog(`🚀 BẮT ĐẦU KHỞI TẠO GRID: ${symbol} | Giá quét đầu: ${initialEntry} | SL Grid: ${botSettings.gridLevels} trên/${botSettings.gridLevels} dưới. Thời gian trải: ${(INIT_DURATION_PER_COIN_MS/1000)}s`, "info");

        // Tạo danh sách các mức giá
        const upperPrices = [];
        const lowerPrices = [];
        const stepPct = botSettings.gridOpenPct / 100;

        for (let i = 1; i <= botSettings.gridLevels; i++) {
            upperPrices.push({ index: i, price: initialEntry * (1 + (i * stepPct)) });
            lowerPrices.push({ index: i, price: initialEntry * (1 - (i * stepPct)) });
        }

        // Xen kẽ ưu tiên mốc gần entry trước: Upper 1, Lower 1, Upper 2, Lower 2...
        const deploymentPlan = [];
        for (let i = 0; i < botSettings.gridLevels; i++) {
            deploymentPlan.push({ type: 'UPPER', data: upperPrices[i] });
            deploymentPlan.push({ type: 'LOWER', data: lowerPrices[i] });
        }

        const totalSteps = deploymentPlan.length;
        // Chia đều thời gian để đúng trong 1 phút xong coin đó
        const delayPerLevel = Math.max(Math.floor(INIT_DURATION_PER_COIN_MS / totalSteps), ORDER_CALL_DELAY_MS * 6 + 200);

        const currentCoinGrid = {
            initialEntry: initialEntry,
            upperLevels: [],
            lowerLevels: [],
            isInitializing: true,
            activeGridCenter: initialEntry
        };
        gridState.set(symbol, currentCoinGrid);

        for (const item of deploymentPlan) {
            if (!botSettings.isRunning) break;
            const check = checkBanStatus();
            if (check.isBanned) {
                addBotLog(`🛑 Quá trình khởi tạo ${symbol} tạm dừng do IP bị giới hạn.`, "error");
                break;
            }

            const startTime = Date.now();
            const res = await deploySingleGridLevel(symbol, item.data.price, qty, item.type === 'UPPER');
            
            if (item.type === 'UPPER') {
                currentCoinGrid.upperLevels.push(res);
            } else {
                currentCoinGrid.lowerLevels.push(res);
            }

            addBotLog(`📍 [GIAO LỆNH XONG] ${symbol} | Mốc ${item.type} #${item.data.index} tại giá: ${item.data.price.toFixed(info.pricePrecision)}`);

            const elapsed = Date.now() - startTime;
            const remainingWait = delayPerLevel - elapsed;
            if (remainingWait > 0) {
                await new Promise(r => setTimeout(r, remainingWait));
            }
        }

        currentCoinGrid.isInitializing = false;
        addBotLog(`✅ HOÀN TẤT KHỞI TẠO GRID CHO: ${symbol}! Sẵn sàng chế độ Trailing.`, "success");

    } catch (e) {
        addBotLog(`❌ Lỗi khởi tạo Grid ${symbol}: ${e.message}`, "error");
    }
}

// Bộ xử lý tuần tự từng Coin (Coin này xong mới tới coin tiếp theo)
async function processInitQueue() {
    if (isQueueInitializing || initCoinQueue.length === 0 || !botSettings.isRunning) return;
    isQueueInitializing = true;

    while (initCoinQueue.length > 0 && botSettings.isRunning) {
        const symbol = initCoinQueue.shift();
        await initializeGridForCoin(symbol);
        await new Promise(r => setTimeout(r, 2000)); // Nghỉ 2s giữa 2 coin
    }

    isQueueInitializing = false;
}

// Logic Trailing Grid: Khi giá lên/xuống chạm mốc grid, hủy mốc xa nhất đối diện và bù mốc mới cùng chiều
async function handleTrailingGrid(symbol, currentMarkPrice) {
    const coinState = gridState.get(symbol);
    if (!coinState || coinState.isInitializing) return;

    const info = status.exchangeInfo[symbol];
    const stepPct = botSettings.gridOpenPct / 100;
    const qty = await calculateOrderQty(symbol, currentMarkPrice);

    // Kiểm tra giá vượt lên trên mốc upper gần nhất
    const highestUpper = coinState.upperLevels[coinState.upperLevels.length - 1];
    const lowestUpper = coinState.upperLevels[0];

    // Trailing LÊN: Nếu giá vượt qua mốc upper thấp nhất
    if (lowestUpper && currentMarkPrice >= lowestUpper.levelPrice * 1.001) {
        // Hủy mốc lower sâu nhất (dưới cùng)
        if (coinState.lowerLevels.length > 0) {
            const removedLower = coinState.lowerLevels.pop();
            await cancelGridLevelOrders(symbol, removedLower);
            addBotLog(`🔄 [TRAILING UP] ${symbol}: Hủy mốc dưới cùng ${removedLower.levelPrice.toFixed(info.pricePrecision)}`, "warn");
        }

        // Tạo thêm 1 mốc upper mới ở trên cùng
        const newUpperPrice = highestUpper.levelPrice * (1 + stepPct);
        const newUpperObj = await deploySingleGridLevel(symbol, newUpperPrice, qty, true);
        coinState.upperLevels.push(newUpperObj);
        addBotLog(`➕ [TRAILING UP] ${symbol}: Thêm mốc trên mới tại ${newUpperPrice.toFixed(info.pricePrecision)}`, "success");
    }

    // Trailing XUỐNG: Nếu giá tụt dưới mốc lower cao nhất
    const lowestLower = coinState.lowerLevels[coinState.lowerLevels.length - 1];
    const highestLower = coinState.lowerLevels[0];

    if (highestLower && currentMarkPrice <= highestLower.levelPrice * 0.999) {
        // Hủy mốc upper cao nhất (trên cùng)
        if (coinState.upperLevels.length > 0) {
            const removedUpper = coinState.upperLevels.pop();
            await cancelGridLevelOrders(symbol, removedUpper);
            addBotLog(`🔄 [TRAILING DOWN] ${symbol}: Hủy mốc trên cùng ${removedUpper.levelPrice.toFixed(info.pricePrecision)}`, "warn");
        }

        // Tạo thêm 1 mốc lower mới ở dưới cùng
        const newLowerPrice = lowestLower.levelPrice * (1 - stepPct);
        const newLowerObj = await deploySingleGridLevel(symbol, newLowerPrice, qty, false);
        coinState.lowerLevels.push(newLowerObj);
        addBotLog(`➕ [TRAILING DOWN] ${symbol}: Thêm mốc dưới mới tại ${newLowerPrice.toFixed(info.pricePrecision)}`, "success");
    }
}

// Luồng giám sát vị thế & thống kê khối lượng
async function monitorPositionsAndVolume() {
    if (!status.isReady || !botSettings.isRunning) {
        return setTimeout(monitorPositionsAndVolume, 2000);
    }

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        for (const symbol of botSettings.coinList) {
            const positions = posRisk.filter(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
            const coinState = gridState.get(symbol);

            for (const p of positions) {
                const markP = parseFloat(p.markPrice);
                // Trailing grid theo giá hiện tại
                await handleTrailingGrid(symbol, markP);
            }

            // Cập nhật thống kê lệnh & volume từ userTrades gần nhất
            const trades = await binancePrivate('/fapi/v1/userTrades', { symbol, limit: 15 }).catch(() => []);
            let stat = volumeStats.get(symbol) || {
                orderCount: 0,
                totalVolume: 0,
                totalPnL: 0,
                lastTpPrice: 0,
                lastSlPrice: 0,
                lastTpPnl: 0,
                lastSlPnl: 0,
                processedTrades: new Set()
            };

            for (const t of trades) {
                if (!stat.processedTrades) stat.processedTrades = new Set();
                if (!stat.processedTrades.has(t.id)) {
                    stat.processedTrades.add(t.id);
                    stat.orderCount += 1;
                    const val = parseFloat(t.qty) * parseFloat(t.price);
                    stat.totalVolume += val;
                    const pnl = parseFloat(t.realizedPnl);
                    stat.totalPnL += pnl;

                    if (pnl > 0) {
                        stat.lastTpPrice = parseFloat(t.price);
                        stat.lastTpPnl = pnl;
                        addBotLog(`💰 [KHỚP TP/LÃI] ${symbol} | Giá: ${t.price} | PnL: +${pnl.toFixed(4)}$ | Vol: ${val.toFixed(2)}$`, "success");
                    } else if (pnl < 0) {
                        stat.lastSlPrice = parseFloat(t.price);
                        stat.lastSlPnl = pnl;
                        addBotLog(`📉 [KHỚP SL/LỖ] ${symbol} | Giá: ${t.price} | PnL: ${pnl.toFixed(4)}$ | Vol: ${val.toFixed(2)}$`, "error");
                    } else {
                        addBotLog(`📦 [MỞ LỆNH GRID] ${symbol} | ${t.side} | Qty: ${t.qty} @ ${t.price} | Val: ${val.toFixed(2)}$`, "info");
                    }
                }
            }
            volumeStats.set(symbol, stat);
        }
    } catch (e) {
        if (!e.message.includes('IP đang bị khóa')) {
            console.error("Monitor Err:", e.message);
        }
    }

    setTimeout(monitorPositionsAndVolume, 3000);
}

// Khởi chạy hệ thống sàn
async function initSystem() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();

        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};

        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 50;
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.001,
                maxLeverage: maxLev
            };
        });

        status.exchangeInfo = temp;
        status.isReady = true;
        addBotLog(`🚀 Hệ thống Luffy Grid Volume sẵn sàng trên Port ${PORT}.`);
        monitorPositionsAndVolume();
    } catch (e) {
        console.error("Init Error, retrying...", e.message);
        setTimeout(initSystem, 5000);
    }
}
initSystem();

// =========================================================================
// EXPRESS API SERVER
// =========================================================================
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    let acc = null;
    let openPositions = [];

    const ban = checkBanStatus();

    if (status.isReady && !ban.isBanned) {
        acc = await binancePrivate('/fapi/v2/account').catch(() => null);
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => []);
        
        openPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => {
            const sym = p.symbol;
            const cState = gridState.get(sym);
            const initialE = cState?.initialEntry || parseFloat(p.entryPrice);
            const markP = parseFloat(p.markPrice);
            const distPct = ((markP - initialE) / initialE) * 100;
            const info = status.exchangeInfo[sym] || { maxLeverage: 20 };

            const tpPct = botSettings.tpSlPct;
            const slPct = botSettings.tpSlPct * 0.9;
            const isLong = p.positionSide === 'LONG';
            const calcTp = isLong ? parseFloat(p.entryPrice) * (1 + tpPct/100) : parseFloat(p.entryPrice) * (1 - tpPct/100);
            const calcSl = isLong ? parseFloat(p.entryPrice) * (1 - slPct/100) : parseFloat(p.entryPrice) * (1 + slPct/100);

            return {
                symbol: sym,
                side: p.positionSide,
                leverage: info.maxLeverage,
                margin: parseFloat(p.isolatedMargin || (Math.abs(parseFloat(p.positionAmt)) * markP / info.maxLeverage)).toFixed(2),
                qty: Math.abs(parseFloat(p.positionAmt)),
                initialEntry: initialE,
                currentPrice: markP,
                entryPrice: parseFloat(p.entryPrice),
                tp: calcTp.toFixed(4),
                sl: calcSl.toFixed(4),
                distPct: distPct.toFixed(2),
                pnl: parseFloat(p.unRealizedProfit)
            };
        });
    }

    // Format bảng volumeStats
    const volumeData = botSettings.coinList.map((s, idx) => {
        const st = volumeStats.get(s) || { orderCount: 0, totalVolume: 0, totalPnL: 0, lastTpPrice: 0, lastSlPrice: 0, lastTpPnl: 0, lastSlPnl: 0 };
        const info = status.exchangeInfo[s] || { maxLeverage: 20 };
        return {
            stt: idx + 1,
            symbol: s,
            leverage: info.maxLeverage,
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
            ipBannedUntilStr: ban.isBanned ? `${ban.remainingSec}s còn lại` : "Bình thường"
        },
        wallet: acc ? {
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2),
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2)
        } : { totalWalletBalance: "0.00", availableBalance: "ERR", totalUnrealizedProfit: "0.00" }
    });
});

APP.post('/api/settings', (req, res) => {
    const { isRunning, invValue, gridOpenPct, tpSlPct, gridLevels } = req.body;
    
    if (invValue !== undefined) botSettings.invValue = invValue;
    if (gridOpenPct !== undefined) botSettings.gridOpenPct = parseFloat(gridOpenPct);
    if (tpSlPct !== undefined) botSettings.tpSlPct = parseFloat(tpSlPct);
    if (gridLevels !== undefined) botSettings.gridLevels = parseInt(gridLevels);

    if (isRunning !== undefined && isRunning !== botSettings.isRunning) {
        botSettings.isRunning = isRunning;
        if (botSettings.isRunning) {
            addBotLog(`🟢 START BOT: Nạp danh sách ${botSettings.coinList.length} coin vào hàng đợi khởi tạo.`, "success");
            initCoinQueue = [...botSettings.coinList];
            processInitQueue();
        } else {
            addBotLog(`🛑 STOP BOT: Đã dừng các luồng tự động.`, "warn");
            initCoinQueue = [];
        }
    }

    res.json({ success: true, botSettings });
});

// Thêm coin mới
APP.post('/api/coins/add', (req, res) => {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: "Dữ liệu trống" });

    const rawList = input.split(',');
    let added = 0;

    rawList.forEach(raw => {
        const formatted = formatSymbol(raw);
        if (formatted && !botSettings.coinList.includes(formatted)) {
            botSettings.coinList.push(formatted);
            added++;
            if (botSettings.isRunning) {
                initCoinQueue.push(formatted);
                processInitQueue();
            }
        }
    });

    addBotLog(`⚙️ Thêm thành công ${added} coin vào danh sách chạy.`, "success");
    res.json({ success: true, coinList: botSettings.coinList });
});

// Xóa coin
APP.post('/api/coins/remove', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: "Thiếu symbol" });

    botSettings.coinList = botSettings.coinList.filter(c => c !== symbol);
    initCoinQueue = initCoinQueue.filter(c => c !== symbol);
    
    // Hủy các lệnh đang treo của coin đó nếu có
    try {
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
    } catch (e) {}

    gridState.delete(symbol);
    addBotLog(`🗑️ Đã xóa ${symbol} và dọn dẹp lệnh chờ tương ứng.`, "warn");
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`🤖 LUFFY GRID VOLUME BOT SẴN SÀNG TẠI PORT: ${PORT}`);
    console.log(`🌐 Truy cập giao diện: http://localhost:${PORT}`);
    console.log(`===============================================`);
});
