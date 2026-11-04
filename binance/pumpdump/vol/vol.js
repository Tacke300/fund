import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

// =========================================================================
// CẤU HÌNH NHANH HỆ THỐNG GRID VOLUME (DỄ DÀNG CHỈNH SỬA)
// =========================================================================
const PORT = 3333;
const DEFAULT_COIN_SUFFIX = 'USDC';              // Nhập "uai" tự động hiểu là "UAIUSDC"
const INIT_DURATION_PER_COIN_MS = 60000;         // Khởi tạo 1 coin rải đều trong đúng 1 phút (60000ms)
const MIN_ORDER_DELAY_MS = 650;                  // Giãn cách tối thiểu giữa các lệnh chống quá tải rate limit
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 15000, 
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

// Kiểm tra trạng thái cấm IP
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

// Wrapper gọi Binance Private API chuẩn hóa
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
            triggerIpBan(errData?.msg || 'IP Ban Triggered', banMs);
        }

        if (errData?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time', { timeout: 5000 });
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }

        throw e;
    }
}

// Tự động chuẩn hóa cặp đúc (uai -> UAIUSDC)
function formatSymbol(rawInput) {
    if (!rawInput) return null;
    let clean = rawInput.trim().toUpperCase();
    if (!clean) return null;
    if (clean.endsWith('USDT') || clean.endsWith('USDC')) {
        return clean;
    }
    return `${clean}${DEFAULT_COIN_SUFFIX}`;
}

// Làm tròn giá theo tickSize
function roundPrice(symbol, price) {
    const info = status.exchangeInfo[symbol] || { pricePrecision: 4, tickSize: 0.0001 };
    const step = info.tickSize || Math.pow(10, -info.pricePrecision);
    const rounded = Math.round(price / step) * step;
    return parseFloat(rounded.toFixed(info.pricePrecision));
}

// Làm tròn khối lượng theo stepSize
function roundQty(symbol, qty) {
    const info = status.exchangeInfo[symbol] || { quantityPrecision: 2, stepSize: 0.01 };
    const step = info.stepSize || Math.pow(10, -info.quantityPrecision);
    const rounded = Math.floor(qty / step) * step;
    return parseFloat(rounded.toFixed(info.quantityPrecision));
}

// Tính khối lượng theo cấu hình vốn $ hoặc %
async function calculateOrderQty(symbol, currentPrice) {
    const info = status.exchangeInfo[symbol];
    if (!info) return 0.01;

    let margin = 0;
    if (botSettings.invValue.toString().includes('%')) {
        const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
        const avail = parseFloat(acc?.availableBalance || 0);
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

// Xác định loại lệnh điều kiện đúng chuẩn Binance tránh lỗi -2021
function getConditionalOrderType(side, currentPrice, targetPrice) {
    if (side === 'BUY') {
        return targetPrice >= currentPrice ? 'STOP' : 'TAKE_PROFIT';
    } else {
        return targetPrice <= currentPrice ? 'STOP' : 'TAKE_PROFIT';
    }
}

// Gửi lệnh có điều kiện Limit lên sàn
async function placeConditionalLimitOrder(symbol, side, positionSide, targetPrice, qty) {
    const info = status.exchangeInfo[symbol];
    if (!info) return null;

    try {
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentP = parseFloat(ticker.data.price);

        const orderType = getConditionalOrderType(side, currentP, targetPrice);
        const pStr = roundPrice(symbol, targetPrice).toString();
        const qStr = roundQty(symbol, qty).toString();

        const params = {
            symbol: symbol,
            side: side,
            positionSide: positionSide,
            type: orderType,
            quantity: qStr,
            price: pStr,
            stopPrice: pStr,
            timeInForce: 'GTC',
            workingType: 'MARK_PRICE'
        };

        const res = await binancePrivate('/fapi/v1/order', 'POST', params);
        addBotLog(`📝 [ĐẶT LỆNH] ${symbol} | ${side} ${positionSide} | Type: ${orderType} | Price: ${pStr} | Qty: ${qStr}`, "info");
        return res;
    } catch (e) {
        addBotLog(`❌ [LỖI LỆNH] ${symbol} | ${side}_${positionSide} @ ${targetPrice}: ${e.response?.data?.msg || e.message}`, "error");
        return null;
    }
}

// Triển khai 1 mốc Grid (Gồm 2 lệnh mở Long/Short + 4 lệnh TP/SL tương ứng)
async function deployGridLevel(symbol, levelPrice, qty) {
    const info = status.exchangeInfo[symbol];
    const tpPct = botSettings.tpSlPct;
    const slPct = botSettings.tpSlPct * 0.9; // SL luôn bằng 90% của TP

    // 1. Lệnh mở Long & Short tại mốc Grid
    const openLong = await placeConditionalLimitOrder(symbol, 'BUY', 'LONG', levelPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    const openShort = await placeConditionalLimitOrder(symbol, 'SELL', 'SHORT', levelPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    // 2. TP & SL cho vị thế Long
    const longTpPrice = levelPrice * (1 + (tpPct / 100));
    const longSlPrice = levelPrice * (1 - (slPct / 100));

    const tpLong = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longTpPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    const slLong = await placeConditionalLimitOrder(symbol, 'SELL', 'LONG', longSlPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    // 3. TP & SL cho vị thế Short
    const shortTpPrice = levelPrice * (1 - (tpPct / 100));
    const shortSlPrice = levelPrice * (1 + (slPct / 100));

    const tpShort = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortTpPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    const slShort = await placeConditionalLimitOrder(symbol, 'BUY', 'SHORT', shortSlPrice, qty);
    await new Promise(r => setTimeout(r, MIN_ORDER_DELAY_MS));

    return {
        levelPrice,
        qty,
        orders: [
            openLong?.orderId, openShort?.orderId,
            tpLong?.orderId, slLong?.orderId,
            tpShort?.orderId, slShort?.orderId
        ].filter(Boolean),
        targets: { longTpPrice, longSlPrice, shortTpPrice, shortSlPrice }
    };
}

// Hủy mốc grid
async function cancelGridLevelOrders(symbol, levelObj) {
    if (!levelObj || !levelObj.orders) return;
    for (const oId of levelObj.orders) {
        try {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: oId });
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {}
    }
}

// Khởi tạo Grid cho 1 Coin (kéo dài trong 1 phút, ưu tiên mốc gần entry quét đầu)
async function initializeCoinGrid(symbol) {
    const info = status.exchangeInfo[symbol];
    if (!info) {
        addBotLog(`⚠️ Không có thông tin hợp đồng cho ${symbol}. Bỏ qua.`, "warn");
        return;
    }

    try {
        await binancePrivate('/fapi/v1/leverage', 'POST', { symbol, leverage: info.maxLeverage }).catch(() => {});

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const initialEntry = parseFloat(ticker.data.price);
        const qty = await calculateOrderQty(symbol, initialEntry);

        addBotLog(`🚀 [KHỞI TẠO GRID] ${symbol} | Giá quét đầu: ${initialEntry} | Mốc: ${botSettings.gridLevels} trên & ${botSettings.gridLevels} dưới. Rải trong: ${(INIT_DURATION_PER_COIN_MS/1000)}s`, "info");

        const stepPct = botSettings.gridOpenPct / 100;
        const upperList = [];
        const lowerList = [];

        for (let i = 1; i <= botSettings.gridLevels; i++) {
            upperList.push({ idx: i, price: initialEntry * (1 + (i * stepPct)) });
            lowerList.push({ idx: i, price: initialEntry * (1 - (i * stepPct)) });
        }

        // Xen kẽ ưu tiên mốc gần entry trước: Trên 1, Dưới 1, Trên 2, Dưới 2...
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

            addBotLog(`✅ Đã thiết lập xong mốc ${item.type} #${item.data.idx} của ${symbol} @ ${roundPrice(symbol, item.data.price)}`);

            const elapsed = Date.now() - tStart;
            const waitTime = delayBetweenSteps - elapsed;
            if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
        }

        currentCoinGrid.isInitializing = false;
        addBotLog(`🎯 HOÀN TẤT KHỞI TẠO TOÀN DIỆN GRID CHO: ${symbol}! Sẵn sàng cơ chế Trailing.`, "success");

    } catch (e) {
        addBotLog(`❌ Lỗi khởi tạo ${symbol}: ${e.message}`, "error");
    }
}

// Hàng đợi tuần tự: Coin này xong mới tới coin tiếp theo
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

// Xử lý Trailing Grid cân bằng 2 đầu
async function handleTrailing(symbol, markPrice) {
    const cState = gridState.get(symbol);
    if (!cState || cState.isInitializing) return;

    const stepPct = botSettings.gridOpenPct / 100;
    const qty = await calculateOrderQty(symbol, markPrice);

    // Giá tăng vượt mốc Upper gần nhất: Hủy mốc lower dưới cùng và thêm mốc upper trên cùng
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

    // Giá giảm tụt mốc Lower gần nhất: Hủy mốc upper trên cùng và thêm mốc lower dưới cùng
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

// Giám sát vị thế và thống kê khối lượng
async function monitorGrid() {
    if (!status.isReady || !botSettings.isRunning) {
        return setTimeout(monitorGrid, 2000);
    }

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => []);
        
        for (const symbol of botSettings.coinList) {
            const currentPos = posRisk.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (currentPos) {
                await handleTrailing(symbol, parseFloat(currentPos.markPrice));
            }

            // Đồng bộ lịch sử khớp lệnh thống kê Volume
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

    setTimeout(monitorGrid, 2500);
}

// Khởi chạy đồng bộ sàn ban đầu
async function init() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time', { timeout: 8000 });
        timestampOffset = t.data.serverTime - Date.now();

        // Tự động kích hoạt chế độ Hedge Mode (Dual-Side)
        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(() => {});

        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const temp = {};
        
        info.data.symbols.forEach(s => {
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.001,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.0001,
                maxLeverage: 20
            };
        });

        // Lấy đòn bẩy tối đa của từng coin
        try {
            const brk = await binancePrivate('/fapi/v1/leverageBracket');
            brk.forEach(b => {
                if (temp[b.symbol]) {
                    temp[b.symbol].maxLeverage = b.brackets[0]?.initialLeverage || 20;
                }
            });
        } catch (e) {}

        status.exchangeInfo = temp;
        status.isReady = true;
        addBotLog(`🚀 Hệ thống Luffy Grid Volume đã sẵn sàng trên Port ${PORT}.`);
        monitorGrid();
    } catch (e) {
        console.error("Lỗi khởi tạo, thử lại sau 3s:", e.message);
        setTimeout(init, 3000);
    }
}
init();

// =========================================================================
// API SERVER
// =========================================================================
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

// Đọc trạng thái tài khoản & vị thế (luôn trả về dữ liệu tức thì, không bị chặn)
APP.get('/api/status', async (req, res) => {
    let acc = null;
    let openPositions = [];

    try {
        acc = await binancePrivate('/fapi/v2/account');
    } catch (e) {}

    if (acc && acc.positions) {
        openPositions = acc.positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => {
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
    }

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

    const ban = checkBanStatus();

    res.json({
        botSettings,
        openPositions,
        volumeData,
        status: {
            ...status,
            ipBannedUntilStr: ban.isBanned ? `${ban.remainingSec}s còn lại` : "Hoạt động bình thường"
        },
        wallet: acc ? {
            totalWalletBalance: parseFloat(acc.totalWalletBalance || acc.totalMarginBalance || 0).toFixed(2),
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2),
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2)
        } : { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" }
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
            addBotLog(`🟢 BẬT BOT: Bắt đầu đưa ${botSettings.coinList.length} coin vào hàng đợi khởi tạo.`, "success");
            initCoinQueue = [...botSettings.coinList];
            processQueue();
        } else {
            addBotLog(`🛑 TẮT BOT: Đã dừng các luồng tự động.`, "warn");
            initCoinQueue = [];
        }
    }

    res.json({ success: true, botSettings });
});

APP.post('/api/coins/add', (req, res) => {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: "Trống" });

    const rawList = input.split(',');
    let added = 0;
    rawList.forEach(raw => {
        const formatted = formatSymbol(raw);
        if (formatted && !botSettings.coinList.includes(formatted)) {
            botSettings.coinList.push(formatted);
            added++;
            if (botSettings.isRunning) {
                initCoinQueue.push(formatted);
                processQueue();
            }
        }
    });

    addBotLog(`⚙️ Đã thêm ${added} coin vào danh sách.`, "success");
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.post('/api/coins/remove', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: "Thiếu symbol" });

    botSettings.coinList = botSettings.coinList.filter(c => c !== symbol);
    initCoinQueue = initCoinQueue.filter(c => c !== symbol);

    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
    } catch (e) {}

    gridState.delete(symbol);
    addBotLog(`🗑️ Đã xóa ${symbol} và hủy toàn bộ lệnh chờ của coin này.`, "warn");
    res.json({ success: true, coinList: botSettings.coinList });
});

APP.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 BOT GRID VOLUME FUTURES ĐANG CHẠY TẠI PORT: ${PORT}`);
    console.log(`🔗 Truy cập giao diện: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
