import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';

let serverTimeOffset = 0;
let exchangeInfoCache = null;
let isClosingPosition = false; // Cờ này để tránh các lệnh đóng/mở chồng chéo
let botRunning = false;
let botStartTime = null;

let currentLongPosition = null;
let currentShortPosition = null;

let positionCheckInterval = null;
let nextScheduledCycleTimeout = null;
let retryBotTimeout = null;

let consecutiveApiErrors = 0;
const MAX_CONSECUTIVE_API_ERRORS = 3;
const ERROR_RETRY_DELAY_MS = 10000;

const logCounts = {};
const LOG_COOLDOWN_MS = 2000;

class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}

let INITIAL_INVESTMENT_AMOUNT = 0.12;
let TARGET_COIN_SYMBOL = 'HOMEUSDT';

let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null;

const WEB_SERVER_PORT = 1230;
const THIS_BOT_PM2_NAME = 'home';
const BOT_LOG_FILE = `/home/tacke300/.pm2/logs/${THIS_BOT_PM2_NAME}-out.log`;
const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log');
const LOG_TO_CUSTOM_FILE = true;

function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;
    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash] && (now.getTime() - logCounts[messageHash].lastLoggedTime.getTime()) >= LOG_COOLDOWN_MS) {
        logCounts[messageHash] = { count: 0, lastLoggedTime: now };
    }

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        if (logCounts[messageHash].count > 1) {
            console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
            if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, `[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}\n`, () => {});
        } else {
            console.log(logEntry);
            if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', () => {});
        }
        logCounts[messageHash].lastLoggedTime = now;
    } else {
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', () => {});
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }
}

function formatTimeUTC7(dateObject) {
    const formatter = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    return formatter.format(dateObject);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = { hostname, path, method, headers };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    const errorMsg = `HTTP Error: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try { errorDetails = { ...errorDetails, ...JSON.parse(data) }; }
                    catch (e) { errorDetails.msg += ` - Raw: ${data.substring(0, 200)}`; }
                    addLog(`HTTP Request lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => {
            addLog(`Network lỗi: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });
        if (postData) req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Thiếu API_KEY hoặc SECRET_KEY. Vui lòng kiểm tra config.js.");

    const timestamp = Date.now() + serverTimeOffset;
    const recvWindow = 5000;

    let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath;
    let requestBody = '';
    const headers = { 'X-MBX-APIKEY': API_KEY };

    if (method === 'GET' || method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
    } else if (method === 'POST' || method === 'PUT') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Phương thức không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new CriticalApiError("Quá nhiều lỗi API liên tiếp, bot dừng.");
        }
        throw error;
    }
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const fullPathWithQuery = `${fullEndpointPath}?${queryString}`;
    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, {});
        return JSON.parse(rawData);
    } catch (error) {
        addLog(`Lỗi API công khai: ${error.msg || error.message}`);
        throw error;
    }
}

async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); addLog(`Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`); } catch (e) { addLog(`Lỗi đồng bộ thời gian: ${e.message}`); throw e; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); return parseInt(r.find(i => i.symbol === symbol)?.brackets[0]?.initialLeverage); } catch (e) { addLog(`Lỗi lấy đòn bẩy: ${e.msg}`); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { addLog(`Lỗi đặt đòn bẩy: ${e.msg}`); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize || 0.001), stepSize: parseFloat(l?.stepSize || 0.001), minNotional: parseFloat(m?.notional || 0) }; }); addLog('Đã tải thông tin sàn.'); return exchangeInfoCache; } catch (e) { throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { addLog(`Lỗi lấy giá: ${e.message}`); return null; } }

async function cancelOpenOrdersForSymbol(symbol, positionSide = null) {
    addLog(`Đang hủy lệnh chờ cho ${symbol} (Side: ${positionSide || 'Tất cả'})...`);
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) {
            addLog("Không có lệnh chờ nào để hủy.");
            return;
        }

        let ordersToCancel = openOrders;
        if (positionSide && (positionSide === 'LONG' || positionSide === 'SHORT')) {
            ordersToCancel = openOrders.filter(o => o.positionSide === positionSide);
        }

        if (ordersToCancel.length === 0) {
            addLog(`Không có lệnh chờ nào khớp với side: ${positionSide}.`);
            return;
        }

        addLog(`Tìm thấy ${ordersToCancel.length} lệnh để hủy. Bắt đầu hủy...`);
        for (const order of ordersToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', {
                    symbol: symbol,
                    orderId: order.orderId,
                });
                addLog(` -> Đã hủy lệnh ${order.orderId}`);
            } catch (innerError) {
                 if (innerError.code !== -2011) { // -2011 là lỗi Order does not exist
                    addLog(`Lỗi khi hủy lệnh ${order.orderId}: ${innerError.msg || innerError.message}`);
                 }
            }
            await sleep(100);
        }
        addLog("Hoàn tất việc hủy lệnh chờ.");

    } catch (error) {
        if (error.code !== -2011) {
            addLog(`Lỗi khi lấy danh sách lệnh chờ: ${error.msg || error.message}`);
            if (error instanceof CriticalApiError) stopBotLogicInternal();
        }
    }
}

async function cleanupAndResetCycle(symbol) {
    addLog(`Chu kỳ giao dịch cho ${symbol} đã kết thúc. Dọn dẹp sau 3 giây...`);
    await sleep(3000);

    currentLongPosition = null;
    currentShortPosition = null;
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }

    await cancelOpenOrdersForSymbol(symbol);
    await checkAndHandleRemainingPosition(symbol);

    if (botRunning) {
        scheduleNextMainCycle();
    }
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide } = orderInfo;
    const realizedPnl = parseFloat(realizedPnlStr);

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED') { // Không cần kiểm tra realizedPnl === 0
        return;
    }

    addLog(`[Trade Result] Lệnh ${orderId} (${positionSide}) đã khớp. PNL: ${realizedPnl.toFixed(4)} USDT.`);

    if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
    netPNL = totalProfit - totalLoss;
    addLog(`PNL Ròng: ${netPNL.toFixed(2)} USDT (Lời: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`);

    const isLongClosure = currentLongPosition && (orderId == currentLongPosition.currentTPId || orderId == currentLongPosition.currentSLId);
    const isShortClosure = currentShortPosition && (orderId == currentShortPosition.currentTPId || orderId == currentShortPosition.currentSLId);

    // Nếu lệnh khớp là do TP/SL của bot quản lý (không phải đóng từng phần)
    if (isLongClosure || isShortClosure) {
        if (realizedPnl >= 0) { // Lệnh lãi đã đóng
            addLog(`Vị thế LÃI (${positionSide}) đã đóng. Đang kiểm tra vị thế LỖ còn lại.`);
            const remainingPosition = (positionSide === 'LONG') ? currentShortPosition : currentLongPosition;
            if (remainingPosition && Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPosition.symbol })).find(p => p.symbol === remainingPosition.symbol && p.positionSide === remainingPosition.side)?.positionAmt || 0)) > 0) {
                 addLog(`Phát hiện vị thế LỖ ${remainingPosition.side} còn sót. Đang đóng.`);
                 await closePosition(remainingPosition.symbol, 0, `Đóng do lệnh LÃI đối ứng đã chốt`, remainingPosition.side); // Đóng toàn bộ
            } else {
                 addLog(`Không tìm thấy vị thế LỖ còn lại hoặc đã đóng.`);
            }
            await cleanupAndResetCycle(symbol);
        } else { // Lệnh lỗ đã đóng (bởi SL)
            addLog(`Vị thế LỖ (${positionSide}) đã đóng. Để vị thế LÃI tiếp tục chạy.`);
            if (positionSide === 'LONG') {
                currentLongPosition = null;
            } else {
                currentShortPosition = null;
            }
        }
    } else {
         addLog(`Lệnh ${orderId} không phải là TP/SL chính của bot. Có thể là lệnh đóng từng phần hoặc lệnh thủ công.`);
         // Nếu là lệnh đóng từng phần của losingPos, chúng ta không cần làm gì ở đây
         // vì logic đó được quản lý trong manageOpenPosition
    }
}

async function closePosition(symbol, quantity, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide) return;
    // Kiểm tra isClosingPosition để tránh chạy trùng
    if (isClosingPosition) {
        addLog(`Đang trong quá trình đóng lệnh khác, bỏ qua yêu cầu đóng ${positionSide}.`);
        return;
    }
    isClosingPosition = true;

    addLog(`Đang chuẩn bị đóng lệnh ${positionSide} ${symbol} (Lý do: ${reason}).`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const posOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (posOnBinance) {
            const qtyToClose = Math.abs(parseFloat(posOnBinance.positionAmt));
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            addLog(`Gửi lệnh đóng MARKET cho ${positionSide} với qty: ${qtyToClose}`);
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: qtyToClose });
            addLog(`Đã gửi lệnh đóng ${positionSide}.`);
        } else {
            addLog(`Vị thế ${positionSide} đã được đóng hoặc không tồn tại.`);
        }
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${positionSide}: ${error.msg || error.message}`);
    } finally {
        isClosingPosition = false;
    }
}

async function openMarketPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    addLog(`Đang chuẩn bị mở ${tradeDirection} ${symbol} với vốn ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol.");
        if (!await setLeverage(symbol, maxLeverage)) throw new Error("Lỗi đặt đòn bẩy.");

        await sleep(200);

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) throw new Error("Lỗi lấy giá hiện tại.");

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / currentPrice;
        quantity = parseFloat((Math.floor(quantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (quantity * currentPrice < symbolDetails.minNotional) throw new Error("Giá trị lệnh quá nhỏ.");

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection,
            type: 'MARKET', quantity,
        });

        await sleep(1500); // Đợi một chút để lệnh khớp và vị thế hiển thị

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && parseFloat(p.positionAmt) !== 0);
        if (!openPos) throw new Error("Không tìm thấy vị thế sau khi gửi lệnh MARKET.");

        const entryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`Đã mở ${tradeDirection} | Qty: ${actualQuantity} | Giá vào: ${entryPrice.toFixed(symbolDetails.pricePrecision)}`);

        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, entryPrice, // initialQuantity: dùng để tính toán các mốc đóng từng phần
            initialMargin: INITIAL_INVESTMENT_AMOUNT, side: tradeDirection, maxLeverageUsed: maxLeverage,
            pricePrecision: symbolDetails.pricePrecision, openTime: new Date(openPos.updateTime),
            closedLossAmount: 0, // Tổng khối lượng đã đóng của lệnh lỗ
            nextPartialCloseLossIndex: 0, // Chỉ số mốc đóng lỗ tiếp theo
            hasAdjustedSLToSpecificLevel: {}, // Object để lưu trạng thái điều chỉnh SL/TP cho các mốc cụ thể
            hasClosedAllLossPositionAtLastLevel: false, // Cờ hiệu để biết đã đóng hoàn toàn lệnh lỗ ở mốc cuối cùng chưa
        };
    } catch (error) {
        addLog(`Lỗi khi mở lệnh MARKET ${tradeDirection}: ${error.msg || error.message}`);
        return null;
    }
}

async function setInitialTPAndSL(position) {
    if (!position) return false;
    const { symbol, side, quantity, entryPrice, initialMargin, maxLeverageUsed, pricePrecision } = position;
    addLog(`Đang đặt TP/SL ban đầu cho vị thế ${side}...`);
    try {
        await cancelOpenOrdersForSymbol(symbol, side); // Hủy bất kỳ lệnh chờ nào của vị thế này

        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];
        if (maxLeverageUsed >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10;
            STOP_LOSS_MULTIPLIER = 6.66;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100); // Mốc 100%, 200%, ..., 800%
        }
        else if (maxLeverageUsed >= 50) {
            TAKE_PROFIT_MULTIPLIER = 5;
            STOP_LOSS_MULTIPLIER = 3.33;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50); // Mốc 50%, 100%, ..., 400%
        }
        else {
            TAKE_PROFIT_MULTIPLIER = 3.5;
            STOP_LOSS_MULTIPLIER = 2.22;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); // Mốc 35%, 70%, ..., 280%
        }

        const priceChangeForTP = (initialMargin * TAKE_PROFIT_MULTIPLIER) / quantity;
        const priceChangeForSL = (initialMargin * STOP_LOSS_MULTIPLIER) / quantity;

        const symbolDetails = await getSymbolDetails(symbol);
        // Không cần tickSize ở đây vì dùng toFixed với pricePrecision
        // const tickSize = symbolDetails ? symbolDetails.tickSize : 0.001;

        const slPrice = parseFloat((side === 'LONG' ? entryPrice - priceChangeForSL : entryPrice + priceChangeForSL).toFixed(pricePrecision));
        const tpPrice = parseFloat((side === 'LONG' ? entryPrice + priceChangeForTP : entryPrice - priceChangeForTP).toFixed(pricePrecision));

        const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';

        // Đặt lệnh SL và TP với số lượng ban đầu của vị thế
        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side, type: 'STOP_MARKET',
            stopPrice: slPrice, quantity: position.initialQuantity, // Sử dụng initialQuantity
            timeInForce: 'GTC' // Good Till Cancelled
        });
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice, quantity: position.initialQuantity, // Sử dụng initialQuantity
            timeInForce: 'GTC'
        });

        addLog(`Đã đặt TP/SL ban đầu cho ${side}: TP=${tpPrice.toFixed(pricePrecision)}, SL=${slPrice.toFixed(pricePrecision)}`);

        position.initialTPPrice = tpPrice;
        position.initialSLPrice = slPrice;
        position.currentTPId = tpOrder.orderId;
        position.currentSLId = slOrder.orderId;
        position.partialCloseLossLevels = partialCloseLossSteps; // Gán mảng các mốc % lãi
        position.unrealizedPnl = 0;
        position.currentPrice = await getCurrentPrice(symbol);
        // Reset các cờ và index nếu đây là thiết lập lại
        position.closedLossAmount = 0;
        position.nextPartialCloseLossIndex = 0;
        position.hasAdjustedSLToSpecificLevel = {};
        position.hasClosedAllLossPositionAtLastLevel = false;

        return true;
    } catch (error) {
        addLog(`Lỗi nghiêm trọng khi đặt TP/SL ban đầu cho ${side}: ${error.msg || error.message}.`);
        return false;
    }
}

// Hàm này sẽ hủy lệnh SL/TP cũ và đặt lệnh mới
async function updateStopLimitOrder(position, newPrice, type) {
    // type có thể là 'STOP' (cho STOP_MARKET) hoặc 'TAKE_PROFIT' (cho TAKE_PROFIT_MARKET)
    const { symbol, side, currentSLId, currentTPId, initialQuantity, pricePrecision } = position;
    const orderIdToCancel = (type === 'STOP') ? currentSLId : currentTPId;
    const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';

    try {
        if (orderIdToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', {
                    symbol: symbol,
                    orderId: orderIdToCancel,
                });
                addLog(`Đã hủy lệnh ${type} cũ ${orderIdToCancel} cho ${side}.`);
            } catch (innerError) {
                if (innerError.code === -2011) { // Lỗi "Order does not exist" là bình thường nếu lệnh đã khớp/hủy rồi
                    addLog(`Lệnh ${type} cũ ${orderIdToCancel} cho ${side} đã không tồn tại hoặc đã bị hủy.`);
                } else {
                    throw innerError; // Ném lỗi khác
                }
            }
        }

        const symbolDetails = await getSymbolDetails(symbol);
        // Lấy số lượng vị thế hiện tại để đặt lệnh đóng hoàn toàn nếu cần
        const currentPositionOnExchange = (await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol }))
            .find(p => p.symbol === symbol && p.positionSide === side);
        const actualQuantity = Math.abs(parseFloat(currentPositionOnExchange?.positionAmt || 0));

        if (actualQuantity === 0) {
             addLog(`Vị thế ${side} đã đóng hết, không thể đặt lệnh ${type} mới.`);
             return null;
        }

        // Đảm bảo quantity được làm tròn theo stepSize
        const quantityToUse = parseFloat((Math.floor(actualQuantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToUse <= 0) {
            addLog(`Số lượng để đặt lệnh ${type} mới quá nhỏ hoặc không hợp lệ (${quantityToUse}).`);
            return null;
        }


        const newOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side,
            type: `${type}_MARKET`, // STOP_MARKET hoặc TAKE_PROFIT_MARKET
            stopPrice: parseFloat(newPrice.toFixed(pricePrecision)),
            quantity: quantityToUse, // Sử dụng số lượng thực tế hiện có của vị thế
            timeInForce: 'GTC',
            newClientOrderId: `${type.toUpperCase()}-${side}-${Date.now()}` // Client ID duy nhất
        });
        addLog(`Đã đặt lệnh ${type} mới cho ${side} ở giá ${newPrice.toFixed(pricePrecision)}. Order ID: ${newOrder.orderId}`);
        return newOrder.orderId;
    } catch (error) {
        addLog(`Lỗi khi cập nhật lệnh ${type} cho ${side}: ${error.msg || error.message}`);
        // Không ném CriticalApiError ở đây để bot tiếp tục chạy
        return null;
    }
}

// Hàm đóng một phần vị thế
async function closePartialPosition(position, percentageToClose) {
    if (!position || isClosingPosition) return false;
    isClosingPosition = true;

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Không lấy được chi tiết symbol.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));

        if (currentQty === 0) {
            addLog(`Vị thế ${position.side} đã đóng hết, không cần đóng từng phần.`);
            return false;
        }

        let quantityToClose = position.initialQuantity * percentageToClose;
        // Đảm bảo không đóng nhiều hơn lượng còn lại trên sàn
        quantityToClose = Math.min(quantityToClose, currentQty);

        if (quantityToClose <= 0) {
            addLog(`Số lượng đóng từng phần quá nhỏ hoặc không hợp lệ: ${quantityToClose}. Hoặc không có gì để đóng.`);
            return false;
        }

        // Làm tròn số lượng theo stepSize của sàn
        quantityToClose = parseFloat((Math.floor(quantityToClose / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        const orderSide = (position.side === 'LONG') ? 'SELL' : 'BUY';

        addLog(`Đang đóng ${percentageToClose * 100}% (${quantityToClose} ${position.symbol}) của lệnh ${position.side} lỗ.`);
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: quantityToClose,
        });

        position.closedLossAmount += quantityToClose; // Cập nhật tổng khối lượng đã đóng của lệnh lỗ
        addLog(`Đã đóng ${quantityToClose} ${position.symbol} của lệnh ${position.side}. Tổng đã đóng: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);
        return true;
    } catch (error) {
        addLog(`Lỗi khi đóng một phần vị thế ${position.side}: ${error.msg || error.message}`);
        return false;
    } finally {
        isClosingPosition = false;
    }
}

// Hàm tăng khối lượng vị thế (mở lại phần đã đóng)
async function addPosition(position, quantityToAdd) {
    if (!position || quantityToAdd <= 0 || isClosingPosition) return false;
    isClosingPosition = true;

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Không lấy được chi tiết symbol.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));
        
        // Tính toán khối lượng tối đa có thể mở lại để không vượt quá initialQuantity
        let effectiveQuantityToAdd = quantityToAdd;
        if ((currentQty + effectiveQuantityToAdd) > position.initialQuantity) {
            effectiveQuantityToAdd = position.initialQuantity - currentQty;
            if (effectiveQuantityToAdd <= 0) {
                addLog(`Không cần mở lại lệnh ${position.side}, khối lượng hiện tại đã đạt hoặc vượt quá ban đầu.`);
                return false;
            }
        }
        
        effectiveQuantityToAdd = parseFloat((Math.floor(effectiveQuantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        const orderSide = (position.side === 'LONG') ? 'BUY' : 'SELL'; // Side để tăng vị thế

        addLog(`Đang mở lại ${effectiveQuantityToAdd} ${position.symbol} cho lệnh ${position.side} (phần đã cắt lỗ).`);
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: effectiveQuantityToAdd,
        });

        position.closedLossAmount -= effectiveQuantityToAdd; // Giảm khối lượng đã đóng
        if (position.closedLossAmount < 0) position.closedLossAmount = 0; // Đảm bảo không âm

        addLog(`Đã mở lại ${effectiveQuantityToAdd} ${position.symbol}. Tổng đã đóng còn lại: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);
        return true;
    } catch (error) {
        addLog(`Lỗi khi mở lại một phần vị thế ${position.side}: ${error.msg || error.message}`);
        return false;
    } finally {
        isClosingPosition = false;
    }
}

async function runTradingLogic() {
    if (!botRunning || currentLongPosition || currentShortPosition) {
        return;
    }

    addLog('Bắt đầu chu kỳ giao dịch mới...');
    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        // Kiểm tra đủ tiền cho 2 lệnh
        const requiredAmount = INITIAL_INVESTMENT_AMOUNT * 2; // Cần đủ tiền cho cả 2 lệnh
        if (usdtAsset < requiredAmount) {
            addLog(`Số dư USDT (${usdtAsset.toFixed(2)}) không đủ cho 2 lệnh (cần ${requiredAmount.toFixed(2)}). Đợi chu kỳ sau.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) {
            addLog("Không thể lấy đòn bẩy. Hủy chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const longPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        if (!longPositionData) {
            addLog("Mở lệnh LONG thất bại, hủy chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentLongPosition = longPositionData;

        // Đợi một chút trước khi mở lệnh thứ 2 để tránh rate limit
        await sleep(1000);

        const shortPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        if (!shortPositionData) {
            addLog('Mở lệnh SHORT thất bại. Đóng lệnh LONG đã mở.');
            await closePosition(currentLongPosition.symbol, 0, 'Lỗi mở lệnh SHORT', 'LONG'); // Đóng toàn bộ Long
            currentLongPosition = null;
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentShortPosition = shortPositionData;

        addLog("Đã mở thành công cả hai vị thế. Đợi 3 giây để đặt TP/SL...");
        await sleep(3000);

        const isLongTPSLSet = await setInitialTPAndSL(currentLongPosition);
        if (!isLongTPSLSet) {
             addLog("Đặt TP/SL cho LONG thất bại. Đóng cả hai vị thế.");
             await closePosition(currentLongPosition.symbol, 0, 'Lỗi đặt TP/SL', 'LONG');
             await closePosition(currentShortPosition.symbol, 0, 'Lỗi đặt TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        // Đợi một chút trước khi đặt SL/TP lệnh thứ 2
        await sleep(1000);

        const isShortTPSLSet = await setInitialTPAndSL(currentShortPosition);
         if (!isShortTPSLSet) {
             addLog("Đặt TP/SL cho SHORT thất bại. Đóng cả hai vị thế.");
             await closePosition(currentLongPosition.symbol, 0, 'Lỗi đặt TP/SL', 'LONG');
             await closePosition(currentShortPosition.symbol, 0, 'Lỗi đặt TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        addLog("Đã đặt TP/SL cho cả hai vị thế. Bắt đầu theo dõi.");
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 5000); // Kiểm tra mỗi 5 giây
        }
    } catch (error) {
        addLog(`Lỗi trong chu kỳ chính: ${error.msg || error.message}`);
        if(botRunning) scheduleNextMainCycle();
    }
}

const manageOpenPosition = async () => {
    if (!currentLongPosition && !currentShortPosition) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        return;
    }
    if (isClosingPosition) return; // Tránh chạy nếu đang có lệnh đóng/mở khác

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });

        let longPosOnExchange = positions.find(p => p.positionSide === 'LONG' && parseFloat(p.positionAmt) > 0);
        let shortPosOnExchange = positions.find(p => p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);

        // Cập nhật trạng thái của bot nếu vị thế đã đóng trên sàn
        if (currentLongPosition && !longPosOnExchange) currentLongPosition = null;
        if (currentShortPosition && !shortPosOnExchange) currentShortPosition = null;

        // Cập nhật PNL và giá hiện tại cho các vị thế đang theo dõi
        if (longPosOnExchange && currentLongPosition) {
            currentLongPosition.unrealizedPnl = parseFloat(longPosOnExchange.unRealizedProfit);
            currentLongPosition.currentPrice = parseFloat(longPosOnExchange.markPrice);
        }
        if (shortPosOnExchange && currentShortPosition) {
            currentShortPosition.unrealizedPnl = parseFloat(shortPosOnExchange.unRealizedProfit);
            currentShortPosition.currentPrice = parseFloat(shortPosOnExchange.markPrice);
        }

        // Nếu cả hai vị thế đều đã đóng, reset và bắt đầu chu kỳ mới
        if (!currentLongPosition && !currentShortPosition && botRunning) {
            cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }

        let winningPos = null;
        let losingPos = null;

        // Xác định lệnh lãi và lệnh lỗ (nếu có)
        if (currentLongPosition?.unrealizedPnl > 0) {
            winningPos = currentLongPosition;
            losingPos = currentShortPosition;
        } else if (currentShortPosition?.unrealizedPnl > 0) {
            winningPos = currentShortPosition;
            losingPos = currentLongPosition;
        }

        // Chỉ xử lý nếu có cả lệnh lãi và lệnh lỗ (và lệnh lãi có các mốc)
        if (winningPos && losingPos && winningPos.partialCloseLossLevels && losingPos) {
            const currentProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;

            // Xác định mốc đóng từng phần số 5 và số 8 dựa trên mảng động
            const PARTIAL_CLOSE_LEVEL_5 = winningPos.partialCloseLossLevels[4]; // Mốc thứ 5 (index 4)
            const PARTIAL_CLOSE_LEVEL_8 = winningPos.partialCloseLossLevels[7]; // Mốc thứ 8 (index 7)

            // --- Logic đóng từng phần lệnh lỗ ---
            const nextCloseLevel = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
            if (nextCloseLevel && currentProfitPercentage >= nextCloseLevel) {
                if (!losingPos.hasClosedAllLossPositionAtLastLevel) { // Chỉ đóng nếu lệnh lỗ chưa đóng hoàn toàn
                    let percentageToClose = 0.10; // Mặc định đóng 10%

                    if (nextCloseLevel === PARTIAL_CLOSE_LEVEL_5) {
                        percentageToClose = 0.20; // Đóng 20% ở mốc thứ 5
                    } else if (nextCloseLevel === PARTIAL_CLOSE_LEVEL_8) {
                        percentageToClose = 1.00; // Đóng 100% ở mốc thứ 8
                    }
                    
                    // Kiểm tra xem vị thế lỗ còn tồn tại trên sàn không trước khi đóng
                    const currentLosingQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));
                    if (currentLosingQtyOnExchange > 0) {
                        addLog(`Lệnh ${winningPos.side} đạt mốc lãi ${nextCloseLevel}%. Đang đóng ${percentageToClose * 100}% khối lượng ban đầu của lệnh ${losingPos.side} (lệnh lỗ).`);
                        const success = await closePartialPosition(losingPos, percentageToClose);
                        if (success) {
                            winningPos.nextPartialCloseLossIndex++; // Chuyển sang mốc tiếp theo nếu đóng thành công
                            // Đánh dấu đã đóng hoàn toàn lệnh lỗ nếu đạt mốc 8
                            if (nextCloseLevel === PARTIAL_CLOSE_LEVEL_8) {
                                losingPos.hasClosedAllLossPositionAtLastLevel = true;
                                addLog(`Đã đóng hoàn toàn lệnh lỗ ${losingPos.side} ở mốc ${PARTIAL_CLOSE_LEVEL_8}%.`);
                            }
                        }
                    } else {
                        addLog(`Vị thế lỗ ${losingPos.side} đã đóng hết trên sàn, không cần đóng từng phần.`);
                        winningPos.nextPartialCloseLossIndex++; // Vẫn chuyển index để không lặp lại
                    }
                } else {
                    addLog(`Lệnh lỗ đã đóng hoàn toàn ở mốc ${PARTIAL_CLOSE_LEVEL_8}%, không cần đóng thêm.`);
                    winningPos.nextPartialCloseLossIndex++; // Vẫn chuyển index để không lặp lại
                }
            }

            // --- Logic điều chỉnh SL lệnh lãi và TP/SL lệnh lỗ ---
            // Mốc 5: rời SL lệnh lãi, TP lệnh lỗ về giá SL của lệnh lãi, SL lệnh lỗ ở Mốc 8
            if (PARTIAL_CLOSE_LEVEL_5 && currentProfitPercentage >= PARTIAL_CLOSE_LEVEL_5 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5]) {
                addLog(`Mốc ${PARTIAL_CLOSE_LEVEL_5}% đạt được. Đang điều chỉnh SL/TP.`);

                const PARTIAL_CLOSE_LEVEL_2 = winningPos.partialCloseLossLevels[1]; // Mốc thứ 2 (index 1)
                const PARTIAL_CLOSE_LEVEL_8_FOR_SL = winningPos.partialCloseLossLevels[7]; // Mốc thứ 8 (index 7)

                let slPriceWinning = null;

                // Tính toán và đặt SL lệnh lãi (rời về Mốc 2)
                if (PARTIAL_CLOSE_LEVEL_2) {
                    slPriceWinning = (winningPos.side === 'LONG') ?
                        winningPos.entryPrice * (1 + PARTIAL_CLOSE_LEVEL_2 / 10000) :
                        winningPos.entryPrice * (1 - PARTIAL_CLOSE_LEVEL_2 / 10000);
                    
                    // Chỉ cập nhật SL nếu lệnh lãi vẫn còn tồn tại
                    if (currentLongPosition || currentShortPosition) { // Tức là winningPos vẫn tồn tại
                        winningPos.currentSLId = await updateStopLimitOrder(winningPos, slPriceWinning, 'STOP');
                    } else {
                        addLog(`Lệnh lãi đã đóng, không thể cập nhật SL.`);
                    }
                    addLog(`SL lệnh lãi ${winningPos.side} rời về giá PNL ${PARTIAL_CLOSE_LEVEL_2}%.`);
                }

                // Tính toán và đặt TP lệnh lỗ (bằng giá SL của lệnh lãi)
                if (slPriceWinning) { // Đảm bảo slPriceWinning đã được tính toán
                    if (losingPos && !losingPos.hasClosedAllLossPositionAtLastLevel) { // Chỉ cập nhật nếu lệnh lỗ còn và chưa đóng hoàn toàn
                        losingPos.currentTPId = await updateStopLimitOrder(losingPos, slPriceWinning, 'TAKE_PROFIT');
                        addLog(`TP lệnh lỗ ${losingPos.side} rời về giá SL của lệnh lãi (${slPriceWinning.toFixed(winningPos.pricePrecision)}).`);
                    } else {
                        addLog(`Lệnh lỗ đã đóng hoặc không tồn tại, không thể cập nhật TP.`);
                    }
                } else {
                    addLog(`Không thể điều chỉnh TP lệnh lỗ vì giá SL lệnh lãi chưa xác định.`);
                }

                // Tính toán và đặt SL lệnh lỗ (rời về Mốc 8 của nó)
                if (PARTIAL_CLOSE_LEVEL_8_FOR_SL) {
                    const slPriceLosing = (losingPos.side === 'LONG') ?
                        losingPos.entryPrice * (1 - PARTIAL_CLOSE_LEVEL_8_FOR_SL / 10000) :
                        losingPos.entryPrice * (1 + PARTIAL_CLOSE_LEVEL_8_FOR_SL / 10000);
                    
                    if (losingPos && !losingPos.hasClosedAllLossPositionAtLastLevel) { // Chỉ cập nhật nếu lệnh lỗ còn và chưa đóng hoàn toàn
                        losingPos.currentSLId = await updateStopLimitOrder(losingPos, slPriceLosing, 'STOP');
                        addLog(`SL lệnh lỗ ${losingPos.side} rời về giá PNL ${PARTIAL_CLOSE_LEVEL_8_FOR_SL}% của nó.`);
                    } else {
                         addLog(`Lệnh lỗ đã đóng hoặc không tồn tại, không thể cập nhật SL.`);
                    }
                }
                winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5] = true;
            }

            // Mốc 8: đóng hoàn toàn lệnh lỗ (đã xử lý ở trên), rời SL lệnh lãi về Mốc 5
            if (PARTIAL_CLOSE_LEVEL_8 && currentProfitPercentage >= PARTIAL_CLOSE_LEVEL_8 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_8]) {
                addLog(`Mốc ${PARTIAL_CLOSE_LEVEL_8}% đạt được.`);

                const PARTIAL_CLOSE_LEVEL_5_FOR_SL = winningPos.partialCloseLossLevels[4]; // Mốc thứ 5 (index 4)

                // Rời SL lệnh lãi về mốc 5
                if (PARTIAL_CLOSE_LEVEL_5_FOR_SL) {
                    const slPriceWinning = (winningPos.side === 'LONG') ?
                        winningPos.entryPrice * (1 + PARTIAL_CLOSE_LEVEL_5_FOR_SL / 10000) :
                        winningPos.entryPrice * (1 - PARTIAL_CLOSE_LEVEL_5_FOR_SL / 10000);
                    
                    if (currentLongPosition || currentShortPosition) { // Tức là winningPos vẫn tồn tại
                        winningPos.currentSLId = await updateStopLimitOrder(winningPos, slPriceWinning, 'STOP');
                    } else {
                         addLog(`Lệnh lãi đã đóng, không thể cập nhật SL.`);
                    }
                    addLog(`SL lệnh lãi ${winningPos.side} rời về giá PNL ${PARTIAL_CLOSE_LEVEL_5_FOR_SL}%.`);
                }
                winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_8] = true;
            }

            // --- Logic mở lại lệnh lỗ nếu lệnh lãi quay đầu ---
            // Chỉ xem xét mở lại nếu đã có khối lượng lỗ được đóng VÀ chưa đóng hoàn toàn lệnh lỗ
            if (losingPos.closedLossAmount > 0 && winningPos.nextPartialCloseLossIndex > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel) {
                const lastAchievedProfitLevel = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex - 1];
                // Nếu lãi giảm xuống dưới 50% của mốc đã đạt (hoặc ngưỡng nào đó bạn muốn)
                if (currentProfitPercentage < lastAchievedProfitLevel / 2) {
                    addLog(`Lệnh lãi ${winningPos.side} quay đầu (lãi ${currentProfitPercentage.toFixed(2)}%), đang mở lại phần đã cắt lỗ của lệnh ${losingPos.side}.`);
                    const success = await addPosition(losingPos, losingPos.closedLossAmount); // Mở lại toàn bộ phần đã đóng
                    if (success) {
                        // Reset các cờ và index để có thể bắt đầu lại chu trình đóng/điều chỉnh
                        winningPos.nextPartialCloseLossIndex = 0;
                        winningPos.hasAdjustedSLToSpecificLevel = {}; // Reset tất cả cờ điều chỉnh SL/TP
                        // losingPos.hasClosedAllLossPositionAtLastLevel = false; // Không reset nếu lệnh lỗ đã đóng hoàn toàn

                        // Đặt lại SL/TP ban đầu cho cả 2 lệnh
                        await setInitialTPAndSL(winningPos);
                        await setInitialTPAndSL(losingPos);
                    }
                }
            }
        }
    } catch (error) {
        addLog(`Lỗi quản lý vị thế: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) stopBotLogicInternal();
    }
};

async function scheduleNextMainCycle() {
    if (!botRunning || currentLongPosition || currentShortPosition) return;
    clearTimeout(nextScheduledCycleTimeout);
    addLog(`Lên lịch chu kỳ giao dịch tiếp theo sau 2 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}

async function getListenKey() { if (!API_KEY || !SECRET_KEY) { addLog("API Key chưa được cấu hình."); return null; } try { const data = await callSignedAPI('/fapi/v1/listenKey', 'POST'); addLog(`Đã lấy listenKey mới.`); return data.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.message}`); return null; } }
async function keepAliveListenKey() { if (listenKey) { try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) { addLog(`Lỗi làm mới listenKey. Lấy key mới...`); listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); } } }
function setupMarketDataStream(symbol) { if (marketWs) marketWs.close(); const streamUrl = `${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice@1s`; marketWs = new WebSocket(streamUrl); marketWs.onopen = () => addLog(`Market WebSocket cho ${symbol} đã kết nối.`); marketWs.onmessage = (event) => { try { const data = JSON.parse(event.data); if (data.e === 'markPriceUpdate') { currentMarketPrice = parseFloat(data.p); if (currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice; if (currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice; } } catch (e) {} }; marketWs.onclose = () => { if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); }; }
function setupUserDataStream(key) { if (userDataWs) userDataWs.close(); const streamUrl = `${WS_BASE_URL}/ws/${key}`; userDataWs = new WebSocket(streamUrl); userDataWs.onopen = () => { addLog('User Data WebSocket đã kết nối.'); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000); }; userDataWs.onmessage = async (event) => { try { const data = JSON.parse(event.data); if (data.e === 'ORDER_TRADE_UPDATE') await processTradeResult(data.o); } catch (e) {} }; userDataWs.onclose = async () => { if (botRunning) { setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 5000); } }; }

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đang chạy.';
    if (!API_KEY || !SECRET_KEY) return 'Lỗi: API Key/Secret Key chưa được cấu hình.';

    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime();
        await getExchangeInfo();
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);

        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey);
        setupMarketDataStream(TARGET_COIN_SYMBOL);

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Coin: ${TARGET_COIN_SYMBOL} | Vốn/lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT`);

        scheduleNextMainCycle();
        return 'Bot khởi động thành công.';
    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog(`[Lỗi khởi động bot] ${errorMsg}`);
        stopBotLogicInternal();
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) return 'Bot không chạy.';
    botRunning = false;
    clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) clearInterval(positionCheckInterval);
    if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
    if (marketWs) marketWs.close();
    if (userDataWs) userDataWs.close();
    positionCheckInterval = listenKeyRefreshInterval = marketWs = userDataWs = listenKey = null;
    currentLongPosition = currentShortPosition = null;
    totalProfit = totalLoss = netPNL = 0;
    addLog('--- Bot đã dừng ---');
    return 'Bot đã dừng.';
}

async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Đang kiểm tra vị thế còn sót lại cho ${symbol}.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPositions = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPositions.length > 0) {
            addLog(`Tìm thấy ${remainingPositions.length} vị thế sót. Đang đóng...`);
            for (const pos of remainingPositions) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                await closePosition(pos.symbol, Math.abs(parseFloat(pos.positionAmt)), `Vị thế sót khi khởi động/reset`, sideToClose);
                await sleep(500); // Đợi chút giữa các lệnh đóng
            }
        } else {
            addLog(`Không có vị thế ${symbol} nào còn sót lại.`);
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót: ${error.msg || error.message}`);
    }
}

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => { fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => { if (err) { return res.status(500).send('Lỗi đọc log file'); } const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.send(cleanData.split('\n').slice(-500).join('\n')); }); });
app.get('/api/status', async (req, res) => { try { const pm2List = await new Promise((resolve, reject) => { exec('pm2 jlist', (error, stdout) => { if (error) reject(error); resolve(stdout); }); }); const botProcess = JSON.parse(pm2List).find(p => p.name === THIS_BOT_PM2_NAME); let statusMessage = 'MAY CHU: DA TAT (PM2)'; if (botProcess) { statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()}`; if (botProcess.pm2_env.status === 'online') { statusMessage += ` | TRANG THAI BOT: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`; if (botStartTime) { const uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / 60000); statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`; } statusMessage += ` | Coin: ${TARGET_COIN_SYMBOL} | Vốn lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT`; } } res.send(statusMessage); } catch (error) { res.status(500).send(`Lỗi lấy trạng thái PM2.`); } });
app.get('/api/bot_stats', (req, res) => {
    let openPositionsData = [];
    if (currentLongPosition) openPositionsData.push(currentLongPosition);
    if (currentShortPosition) openPositionsData.push(currentShortPosition);
    res.json({ success: true, data: { totalProfit, totalLoss, netPNL, currentOpenPositions: openPositionsData, currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT } });
});
app.post('/api/configure', (req, res) => { const config = req.body.coinConfigs?.[0]; if (config) { const oldSymbol = TARGET_COIN_SYMBOL; TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase(); INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount); if (oldSymbol !== TARGET_COIN_SYMBOL) { addLog(`Coin đã thay đổi từ ${oldSymbol} sang ${TARGET_COIN_SYMBOL}. Reset trạng thái.`); currentLongPosition = currentShortPosition = null; totalProfit = totalLoss = netPNL = 0; if (botRunning) setupMarketDataStream(TARGET_COIN_SYMBOL); } addLog(`Đã cập nhật cấu hình: Coin: ${TARGET_COIN_SYMBOL}, Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`); res.json({ success: true, message: 'Cấu hình đã được cập nhật.' }); } else { res.status(400).send('Dữ liệu không hợp lệ.'); } });
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.listen(WEB_SERVER_PORT, () => { addLog(`Web server trên cổng ${WEB_SERVER_PORT}`); addLog(`Truy cập: http://localhost:${WEB_SERVER_PORT}`); });
