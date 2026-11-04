import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

// =========================================================================
// CẤU HÌNH NHANH HỆ THỐNG GRID VOLUME FUTURES
// =========================================================================
const PORT = 3333;
const DEFAULT_COIN_SUFFIX = 'USDC';              // Nhập "uai" tự động hiểu là "UAIUSDC"
const INIT_DURATION_PER_COIN_MS = 60000;         // Khởi tạo 1 coin rải đều trong đúng 1 phút
const MIN_ORDER_DELAY_MS = 650;                  // Giãn cách an toàn giữa các lệnh chống rate limit
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
    invValue: "10",        // Số $ hoặc % ví khả dụng
    gridOpenPct: 1.0,      // % khoảng cách mỗi mốc Grid tính từ Entry quét đầu
    tpSlPct: 1.0,          // % TP (SL sẽ tự động tính = 90% của TP)
    gridLevels: 5,         // Số mốc Grid trên và số mốc Grid dưới
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
    console.log(`[${time}] ${msg}`);
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

// Wrapper gọi Binance Private API với chữ ký HMAC SHA256 chuẩn
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

// Chuẩn hóa tên coin nhập vào (uai -> UAIUSDC)
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

function roundQty(symbol, qty) {
    const info = status.exchangeInfo[symbol] || { quantityPrecision: 2, stepSize: 0.01 };
    const precision = info.quantityPrecision ?? 2;
    const step = info.stepSize || Math.pow(10, -precision);
    const rounded = Math.floor(qty / step) * step;
    return parseFloat(rounded.toFixed(precision));
}

// Tính khối lượng từ cache số dư ví không cần gọi thêm API
function calculateOrderQty(symbol, currentPrice) {
    const info = status.exchangeInfo[symbol];
    if (!info) return 0.01;

    let margin = 0;
    if (botSettings.invValue.toString().includes('%')) {
        const avail = parseFloat(accountCache.availableBalance || 0);
        const pct = parseFloat(botSettings.invValue) / 100;
        margin = avail * pct;
    } else {
        margin = parseFloat(botSettings.invValue);
    }

    if (margin <= 0) margin = 5;
    const lev = info.maxLeverage || 20;
    const rawQty = (margin * lev) / currentPrice;
    let finalQty = roundQty(symbol, rawQty);
    if (finalQty < info.stepSize) finalQty = info.stepSize;
    return finalQty;
}

// Xác định loại lệnh điều kiện đúng chuẩn Binance
function getConditionalOrderType(side, currentPrice, targetPrice) {
    if (side === 'BUY') {
        return targetPrice >= currentPrice ? 'STOP' : 'TAKE_PROFIT';
    } else {
        return targetPrice <= currentPrice ? 'STOP' : 'TAKE_PROFIT';
    }
}

// Đặt lệnh có điều kiện Limit qua ALGO ORDER ENDPOINT MỚI (/fapi/v1/algoOrder)
async function placeConditionalLimitOrder(symbol, side, positionSide, targetPrice, qty) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;

    try {
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentP = parseFloat(ticker.data.price);

        const orderType = getConditionalOrderType(side, currentP, targetPrice);
        const pStr = roundPrice(symbol, targetPrice).toString();
        const qStr = roundQty(symbol, qty).toString();

        // Chuẩn cấu hình tham số Algo Order của Binance Futures
        const params = {
            algoType: 'CONDITIONAL',
            symbol: symbol,
            side: side,
            positionSide: positionSide,          // Luôn dùng Hedge Mode: 'LONG' hoặc 'SHORT'
            type: orderType,
            quantity: qStr,
            price: pStr,
            triggerPrice: pStr,                  // Algo API sử dụng triggerPrice thay vì stopPrice
            timeInForce: 'GTC',
            workingType: 'MARK_PRICE'
        };

        const res = await binancePrivate('/fapi/v1/algoOrder', 'POST', params);
        addBotLog(`📝 [ĐẶT LỆNH ALGO] ${symbol} | ${side} ${positionSide} | Type: ${orderType} | Price: ${pStr} | Qty: ${qStr} | AlgoID: ${res?.algoId || 'OK'}`, "info");
        return res;
    } catch (e) {
        addBotLog(`❌ [LỖI LỆNH] ${symbol} | ${side}_${positionSide} @ ${targetPrice}: ${e.response?.data?.msg || e.message}`, "error");
        return null;
    }
}

// Triển khai 1 mốc Grid (Cặp Long/Short + Cặp TP/SL tương ứng)
async function deployGridLevel(symbol, levelPrice, qty) {
    const tpPct = botSettings.tpSlPct;
    const slPct = botSettings.tpSlPct * 0.9;

    // 1. Mở vị thế tại mốc Grid
    const openLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', levelPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    const openShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', levelPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    // 2. Cài TP/SL cho vị thế Long
    const longTpPrice = levelPrice * (1 + (tpPct / 100));
    const longSlPrice = levelPrice * (1 - (slPct / 100));

    const tpLong = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longTpPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    const slLong = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longSlPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    // 3. Cài TP/SL cho vị thế Short
    const shortTpPrice = levelPrice * (1 - (tpPct / 100));
    const shortSlPrice = levelPrice * (1 + (slPct / 100));

    const tpShort = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortTpPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    const slShort = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortSlPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    return {
        levelPrice,
        qty,
        algoIds: [
            openLong?.algoId, openShort?.algoId,
            tpLong?.algoId, slLong?.algoId,
            tpShort?.algoId, slShort?.algoId
        ].filter(Boolean)
    };
}

// Hủy mốc grid qua Algo API
async function cancelGridLevelOrders(symbol, levelObj) {
    if (!levelObj || !levelObj.algoIds) return;
    for (const aId of levelObj.algoIds) {
        try {
            await binancePrivate('/fapi/v1/algoOrder', 'DELETE', { symbol, algoId: aId });
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {}
    }
}

// Khởi tạo Grid tuần tự trải đều trong 1 phút
async function initializeCoinGrid(symbol) {
    const info = status.exchangeInfo[symbol];
    if (!info) {
        addBotLog(`⚠️ Không có thông tin hợp đồng cho ${symbol}. Bỏ qua.`, "warn");
        return;
    }

    try {
        // Luôn đảm bảo chế độ phòng hộ (Hedge Mode) và luôn ép Cross Margin
        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});
        await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(() => {});
        await binancePrivate('/fapi/v1/leverage', 'POST', { symbol, leverage: info.maxLeverage }).catch(() => {});

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);
        const qty = calculateOrderQty(symbol, initialEntry);

        addBotLog(`🚀 [KHỞI TẠO GRID] ${symbol} | Giá quét đầu: ${initialEntry} | Rải ${botSettings.gridLevels} trên & ${botSettings.gridLevels} dưới trong ${(INIT_DURATION_PER_COIN_MS/1000)}s | Margin: CROSSED`, "info");

        const stepPct = botSettings.gridOpenPct / 100;
        const upperList = [];
        const lowerList = [];

        for (let i = 1; i <= botSettings.gridLevels; i++) {
            upperList.push({ idx: i, price: initialEntry * (1 + (i * stepPct)) });
            lowerList.push({ idx: i, price: initialEntry * (1 - (i * stepPct)) });
        }

        const queuePlan = [];
        for (let i = 0; i < botSettings.gridLevels; i++) {
            queuePlan.push({ type: 'UPPER', data: upperList[i] });
            queuePlan.push({ type: 'LOWER', data: lowerList[i] });
        }

        const totalSteps = queuePlan.length;
        const delayBetweenSteps = Math.max(Math.floor(INIT_DURATION_PER_COIN_MS / totalSteps), MIN_ORDER_DELAY_MS * 6 + 100);

        const currentCoinGrid = {
            initialEntry,
            upperLevels: [],
            lowerLevels: [],
            isInitializing: true
        };
        gridState.set(symbol, currentCoinGrid);

        for (const item of queuePlan) {
            if (!botSettings.isRunning) break;
            const ban = checkBanStatus();
            if (ban.isBanned) break;

            const tStart = Date.now();
            const levelObj = await deployGridLevel(symbol, item.data.price, qty);

            if (item.type === 'UPPER') {
                currentCoinGrid.upperLevels.push(levelObj);
            } else {
                currentCoinGrid.lowerLevels.push(levelObj);
            }

            addBotLog(`✅ Đã thiết lập mốc ${item.type} #${item.data.idx} của ${symbol} @ ${roundPrice(symbol, item.data.price)}`);

            const elapsed = Date.now() - tStart;
            const waitTime = delayBetweenSteps - elapsed;
            if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
        }

        currentCoinGrid.isInitializing = false;
        addBotLog(`🎯 HOÀN TẤT KHỞI TẠO GRID CHO ${symbol}! Đang chạy chế độ Trailing.`, "success");

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

// Xử lý Trailing cân bằng mốc trên và mốc dưới
async function handleTrailing(symbol, markPrice) {
    const cState = gridState.get(symbol);
    if (!cState || cState.isInitializing) return;

    const stepPct = botSettings.gridOpenPct / 100;
    const qty = calculateOrderQty(symbol, markPrice);

    if (cState.upperLevels.length > 0) {
        const lowestUpper = cState.upperLevels[0];
        const highestUpper = cState.upperLevels[cState.upperLevels.length - 1];

        if (markPrice >= lowestUpper.levelPrice) {
            if (cState.lowerLevels.length > 0) {
                const removedLower = cState.lowerLevels.pop();
                await cancelGridLevelOrders(symbol, removedLower);
                addBotLog(`🔄 [TRAILING LÊN] ${symbol}: Hủy mốc dưới ${roundPrice(symbol, removedLower.levelPrice)}`, "warn");
            }
            const newUpperPrice = highestUpper.levelPrice * (1 + stepPct);
            const newUpper = await deployGridLevel(symbol, newUpperPrice, qty);
            cState.upperLevels.push(newUpper);
            addBotLog(`➕ [TRAILING LÊN] ${symbol}: Thêm mốc trên mới ${roundPrice(symbol, newUpperPrice)}`, "success");
        }
    }

    if (cState.lowerLevels.length > 0) {
        const highestLower = cState.lowerLevels[0];
        const lowestLower = cState.lowerLevels[cState.lowerLevels.length - 1];

        if (markPrice <= highestLower.levelPrice) {
            if (cState.upperLevels.length > 0) {
                const removedUpper = cState.upperLevels.pop();
                await cancelGridLevelOrders(symbol, removedUpper);
                addBotLog(`🔄 [TRAILING XUỐNG] ${symbol}: Hủy mốc trên ${roundPrice(symbol, removedUpper.levelPrice)}`, "warn");
            }
            const newLowerPrice = lowestLower.levelPrice * (1 - stepPct);
            const newLower = await deployGridLevel(symbol, newLowerPrice, qty);
            cState.lowerLevels.push(newLower);
            addBotLog(`➕ [TRAILING XUỐNG] ${symbol}: Thêm mốc dưới mới ${roundPrice(symbol, newLowerPrice)}`, "success");
        }
    }
}

// LUỒNG NGẦM ĐỒNG BỘ TÀI KHOẢN (BACKGROUND WORKER - 2 GIÂY/LẦN)
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

// LUỒNG NGẦM GIÁM SÁT VỊ THẾ & VOLUME TRADE
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

        // Luôn ép chế độ phòng hộ (Hedge Mode)
        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});

        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const temp = {};
        
        info.data.symbols.forEach(s => {
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision ?? 2,
                pricePrecision: s.pricePrecision ?? 4,
                stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.001,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.0001,
                maxLeverage: 20
            };
        });

        try {
            const brk = await binancePrivate('/fapi/v1/leverageBracket');
            if (Array.isArray(brk)) {
                brk.forEach(b => {
                    if (temp[b.symbol]) {
                        temp[b.symbol].maxLeverage = b.brackets[0]?.initialLeverage || 20;
                    }
                });
            }
        } catch (e) {}

        // Luôn ép Cross Margin cho tất cả các coin trong danh sách ban đầu
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
            addBotLog(`💰 Kết nối tài khoản OK! Số dư ví: ${accountCache.totalWalletBalance}$ | Khả dụng: ${accountCache.availableBalance}$`, "success");
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
// API & WEB SERVER (PHẢN HỒI SIÊU TỐC TỪ CACHE, KHÔNG CHỜ BINANCE)
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
            const info = status.exchangeInfo[sym] || { maxLeverage: 20 };

            const tpPct = botSettings.tpSlPct;
            const slPct = botSettings.tpSlPct * 0.9;
            const isLong = p.positionSide === 'LONG';
            const calcTp = isLong ? parseFloat(p.entryPrice) * (1 + tpPct/100) : parseFloat(p.entryPrice) * (1 - tpPct/100);
            const calcSl = isLong ? parseFloat(p.entryPrice) * (1 - slPct/100) : parseFloat(p.entryPrice) * (1 + slPct/100);

            return {
                symbol: sym,
                side: p.positionSide,
                leverage: p.leverage || info.maxLeverage,
                margin: parseFloat(p.isolatedMargin || (Math.abs(parseFloat(p.positionAmt)) * markP / (p.leverage || 20))).toFixed(2),
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
            ipBannedUntilStr: ban.isBanned ? `${ban.remainingSec}s còn lại` : "Hoạt động bình thường"
        },
        wallet: {
            totalWalletBalance: accountCache.totalWalletBalance,
            availableBalance: accountCache.availableBalance,
            totalUnrealizedProfit: accountCache.totalUnrealizedProfit
        }
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
            addBotLog(`🟢 BẬT BOT: Bắt đầu khởi tạo ${botSettings.coinList.length} coin.`, "success");
            initCoinQueue = [...botSettings.coinList];
            processQueue();
        } else {
            addBotLog(`🛑 TẮT BOT: Đã dừng tiến trình tự động.`, "warn");
            initCoinQueue = [];
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
            // Luôn ép Cross Margin ngay khi thêm coin mới
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
        // Hủy toàn bộ lệnh thường & lệnh Algo (conditional) của symbol này
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await binancePrivate('/fapi/v1/algoOpenOrders', 'DELETE', { symbol }).catch(() => {});
    } catch (e) {}

    gridState.delete(symbol);
    addBotLog(`🗑️ Đã xóa ${symbol} và hủy mọi lệnh chờ (kể cả Algo) của coin này.`, "warn");
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 BOT GRID VOLUME FUTURES ĐANG CHẠY TẠI PORT: ${PORT}`);
    console.log(`🔗 Truy cập giao diện: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
