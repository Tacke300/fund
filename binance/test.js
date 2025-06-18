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

let serverTimeOffset = 0;
let exchangeInfoCache = null;
let isProcessingTrade = false;
let botRunning = false;
let botStartTime = null;

let currentLongPosition = null;
let currentShortPosition = null;

let positionCheckInterval = null;
let nextScheduledCycleTimeout = null;

let consecutiveApiErrors = 0;
const MAX_CONSECUTIVE_API_ERRORS = 3;

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

const WEB_SERVER_PORT = 1111;
const THIS_BOT_PM2_NAME = 'test';
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
            console.log(`[${time}] (x${logCounts[messageHash].count}) ${message}`);
            if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, `[${time}] (x${logCounts[messageHash].count}) ${message}\n`, () => {});
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
                    const errorMsg = `HTTP Lỗi: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try { errorDetails = { ...errorDetails, ...JSON.parse(data) }; }
                    catch (e) { errorDetails.msg += ` - Raw: ${data.substring(0, 200)}`; }
                    addLog(errorDetails.msg);
                    reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => {
            addLog(`Lỗi Mạng: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });
        if (postData) req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Lỗi: Thiếu API/SECRET key.");

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
        addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.code || 'UNK'} - ${error.msg || error.message}`);
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
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const bracket = r.find(i => i.symbol === symbol)?.brackets[0]; return bracket ? parseInt(bracket.initialLeverage) : null; } catch (e) { addLog(`Lỗi lấy đòn bẩy: ${e.msg}`); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { addLog(`Lỗi đặt đòn bẩy: ${e.msg}`); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize || 0.001), stepSize: parseFloat(l?.stepSize || 0.001), minNotional: parseFloat(m?.notional || 0) }; }); addLog('Đã tải thông tin sàn.'); return exchangeInfoCache; } catch (e) { throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { addLog(`Lỗi lấy giá: ${e.message}`); return null; } }

async function cancelOpenOrdersForSymbol(symbol, positionSide = null) {
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) {
            addLog("Không có lệnh chờ nào để hủy.");
            return;
        }

        let ordersToCancel = openOrders;
        if (positionSide) {
            ordersToCancel = openOrders.filter(o => o.positionSide === positionSide);
        }

        if (ordersToCancel.length === 0) {
            addLog(`Không có lệnh chờ nào khớp side: ${positionSide}.`);
            return;
        }

        addLog(`Đang hủy ${ordersToCancel.length} lệnh cho ${symbol} (${positionSide || 'Tất cả'})...`);
        for (const order of ordersToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId });
            } catch (innerError) {
                 if (innerError.code !== -2011) addLog(`Lỗi hủy lệnh ${order.orderId}: ${innerError.msg || innerError.message}`);
            }
            await sleep(50);
        }
        addLog("Hoàn tất hủy lệnh chờ.");

    } catch (error) {
        if (error.code !== -2011) addLog(`Lỗi lấy lệnh chờ: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function cleanupAndResetCycle(symbol) {
    addLog(`Chu kỳ cho ${symbol} kết thúc. Dọn dẹp...`);

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
    if(isProcessingTrade) return;
    isProcessingTrade = true;

    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide, q: quantity, S: side } = orderInfo;
    const realizedPnl = parseFloat(realizedPnlStr);

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED') {
        isProcessingTrade = false;
        return;
    }

    addLog(`[Trade] ID ${orderId} (${positionSide} ${side}) KL ${parseFloat(quantity).toFixed(4)} PNL ${realizedPnl.toFixed(4)}`);

    if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
    netPNL = totalProfit - totalLoss;
    addLog(`PNL Ròng: ${netPNL.toFixed(2)} (Lời: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`);

    const isLongClosureByBotTarget = currentLongPosition && (orderId == currentLongPosition.currentTPId || orderId == currentLongPosition.currentSLId);
    const isShortClosureByBotTarget = currentShortPosition && (orderId == currentShortPosition.currentTPId || orderId == currentShortPosition.currentSLId);

    if (isLongClosureByBotTarget || isShortClosureByBotTarget) {
        addLog(`Lệnh bot chính ${orderId} (${positionSide}) khớp.`);

        const closedPositionSide = positionSide;
        const remainingPosition = (closedPositionSide === 'LONG') ? currentShortPosition : currentLongPosition;

        if (closedPositionSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;

        if (realizedPnl >= 0) {
             addLog(`Vị thế LÃI (${closedPositionSide}) đã đóng. Kiểm tra vị thế LỖ.`);
             if (remainingPosition) {
                 const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPosition.symbol });
                 const currentLosingQtyOnExchange = Math.abs(parseFloat(positionsOnExchange.find(p => p.symbol === remainingPosition.symbol && p.positionSide === remainingPosition.side)?.positionAmt || 0));
                 if (currentLosingQtyOnExchange > 0) {
                      addLog(`Vị thế LỖ ${remainingPosition.side} tìm thấy (${currentLosingQtyOnExchange}). Đang đóng hoàn toàn.`);
                      await closePosition(remainingPosition.symbol, 0, `Lệnh LÃI đối ứng đã chốt`, remainingPosition.side);
                 } else {
                      addLog(`Vị thế LỖ ${remainingPosition.side} không tìm thấy trên sàn.`);
                 }
             } else {
                  addLog(`Không tìm thấy vị thế LỖ còn lại.`);
             }
             await cleanupAndResetCycle(symbol);

        } else {
             addLog(`Vị thế LỖ (${closedPositionSide}) đã đóng. Lệnh còn lại sẽ chạy tiếp.`);
        }
    } else {
         addLog(`Lệnh ${orderId} không phải TP/SL chính của bot. Có thể đóng từng phần/thủ công.`);
    }
    isProcessingTrade = false;
}


async function closePosition(symbol, quantity, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide || isProcessingTrade) return false;
    isProcessingTrade = true;

    addLog(`Đang đóng lệnh ${positionSide} ${symbol} (Lý do: ${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (posOnBinance) {
            await cancelOpenOrdersForSymbol(symbol, positionSide);
            await sleep(500);

            const qtyToClose = Math.abs(parseFloat(posOnBinance.positionAmt));
            if (qtyToClose === 0) {
                 addLog(`Vị thế ${positionSide} đã đóng hết trên sàn.`);
                 return false;
            }
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            addLog(`Gửi lệnh đóng MARKET cho ${positionSide} KL: ${qtyToClose}`);
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: qtyToClose });
            addLog(`Đã gửi lệnh đóng ${positionSide}.`);
            return true;
        } else {
            addLog(`Vị thế ${positionSide} đã đóng hoặc không tồn tại.`);
            return false;
        }
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${positionSide}: ${error.msg || error.message}`);
        return false;
    } finally {
        isProcessingTrade = false;
    }
}

async function openMarketPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    addLog(`Đang mở ${tradeDirection} ${symbol} với ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol.");
        if (!await setLeverage(symbol, maxLeverage)) throw new Error("Lỗi đặt đòn bẩy.");

        await sleep(200);

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) throw new Error("Lỗi lấy giá hiện tại.");

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / currentPrice;
        quantity = parseFloat((Math.floor(quantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (quantity * currentPrice < symbolDetails.minNotional) {
             addLog(`Giá trị lệnh quá nhỏ: ${quantity * currentPrice}. Min: ${symbolDetails.minNotional}`);
             throw new Error("Giá trị lệnh quá nhỏ.");
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        addLog(`Đang gửi lệnh MARKET ${tradeDirection} Khối lượng: ${quantity.toFixed(symbolDetails.quantityPrecision)} tại giá xấp xỉ ${currentPrice.toFixed(symbolDetails.pricePrecision)}`);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection,
            type: 'MARKET', quantity,
        });

        let openPos = null;
        const maxRetries = 15;
        const retryDelay = 400;

        for(let i = 0; i < maxRetries; i++) {
            await sleep(retryDelay);
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
            openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) >= quantity * 0.95);
            if (openPos && Math.abs(parseFloat(openPos.positionAmt)) > 0) {
                 addLog(`Vị thế xác nhận trên sàn sau ${i+1} lần thử.`);
                 break;
            }
             if(i < maxRetries - 1) addLog(`Không tìm thấy vị thế trên sàn. Thử lại kiểm tra... (${i+1}/${maxRetries})`);
        }


        if (!openPos || Math.abs(parseFloat(openPos.positionAmt)) === 0) throw new Error("Vị thế chưa xác nhận trên sàn sau nhiều lần thử.");

        const entryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`Đã mở ${tradeDirection} | Khối lượng: ${actualQuantity.toFixed(symbolDetails.quantityPrecision)} | Giá vào: ${entryPrice.toFixed(symbolDetails.pricePrecision)}`);

        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, entryPrice,
            initialMargin: INITIAL_INVESTMENT_AMOUNT, side: tradeDirection, maxLeverageUsed: maxLeverage,
            pricePrecision: symbolDetails.pricePrecision,
            closedLossAmount: 0,
            nextPartialCloseLossIndex: 0,
            hasAdjustedSLToSpecificLevel: {},
            hasClosedAllLossPositionAtLastLevel: false,
            pairEntryPrice: currentPrice
        };
    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection}: ${error.msg || error.message}`);
        return null;
    }
}

async function setInitialTPAndSL(position) {
    if (!position) return false;
    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity } = position;
    addLog(`Đang đặt TP/SL ban đầu cho ${side}...`);
    try {
        await cancelOpenOrdersForSymbol(symbol, side);

        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];
        if (maxLeverageUsed >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = 6;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100);
        } else if (maxLeverageUsed >= 50) {
            TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = 3;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50);
        } else {
            TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 2;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35);
        }

        const priceChangeForTP = (initialMargin * TAKE_PROFIT_MULTIPLIER) / initialQuantity;
        const priceChangeForSL = (initialMargin * STOP_LOSS_MULTIPLIER) / initialQuantity;

        const slPrice = parseFloat((side === 'LONG' ? entryPrice - priceChangeForSL : entryPrice + priceChangeForSL).toFixed(pricePrecision));
        const tpPrice = parseFloat((side === 'LONG' ? entryPrice + priceChangeForTP : entryPrice - priceChangeForTP).toFixed(pricePrecision));

        const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';

        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side, type: 'STOP_MARKET',
            stopPrice: slPrice, quantity: initialQuantity,
            timeInForce: 'GTC', newClientOrderId: `SL-${side}-${Date.now()}`
        });
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice, quantity: initialQuantity,
            timeInForce: 'GTC', newClientOrderId: `TP-${side}-${Date.now()}`
        });

        addLog(`TP/SL ban đầu cho ${side}: TP=${tpPrice.toFixed(pricePrecision)}, SL=${slPrice.toFixed(pricePrecision)}`);

        position.initialTPPrice = tpPrice;
        position.initialSLPrice = slPrice;
        position.currentTPId = tpOrder.orderId;
        position.currentSLId = slOrder.orderId;
        position.partialCloseLossLevels = partialCloseLossSteps;
        position.closedLossAmount = 0;
        position.nextPartialCloseLossIndex = 0;
        position.hasAdjustedSLToSpecificLevel = {};
        position.hasClosedAllLossPositionAtLastLevel = false;

        return true;
    } catch (error) {
        addLog(`Lỗi nghiêm trọng đặt TP/SL ban đầu cho ${side}: ${error.msg || error.message}.`);
        return false;
    }
}

async function updateStopLimitOrder(position, newPrice, type) {
    const { symbol, side, currentSLId, currentTPId, pricePrecision } = position;
    const orderIdToCancel = (type === 'STOP') ? currentSLId : currentTPId;
    const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';

    if (type === 'TAKE_PROFIT') {
        return position.currentTPId;
    }

    try {
        if (orderIdToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: orderIdToCancel });
                addLog(`Đã hủy lệnh ${type} cũ ${orderIdToCancel} cho ${side}.`);
            } catch (innerError) {
                if (innerError.code !== -2011) addLog(`Lỗi hủy lệnh ${type} cũ ${orderIdToCancel}: ${innerError.msg || innerError.message}`);
            }
        }

        const symbolDetails = await getSymbolDetails(symbol);
        const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol });
        const currentPositionOnExchange = positionsOnExchange.find(p => p.symbol === symbol && p.positionSide === side);
        const actualQuantity = Math.abs(parseFloat(currentPositionOnExchange?.positionAmt || 0));

        if (actualQuantity === 0) {
             addLog(`Vị thế ${side} đã đóng, không thể đặt lệnh ${type} mới.`);
             if (type === 'STOP') position.currentSLId = null;
             return null;
        }

        const quantityToUse = parseFloat((Math.floor(actualQuantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToUse <= 0) {
            addLog(`Khối lượng cho lệnh ${type} mới quá nhỏ (${quantityToUse}).`);
             if (type === 'STOP') position.currentSLId = null;
            return null;
        }

        const stopPriceFormatted = parseFloat(newPrice.toFixed(pricePrecision));

        const newOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side,
            type: `${type}_MARKET`,
            stopPrice: stopPriceFormatted,
            quantity: quantityToUse,
            timeInForce: 'GTC',
            newClientOrderId: `${type.toUpperCase()}-UPD-${side}-${Date.now()}`
        });
        addLog(`Đã đặt lệnh ${type} mới cho ${side} ở giá ${stopPriceFormatted}. ID: ${newOrder.orderId}`);

        if (type === 'STOP') position.currentSLId = newOrder.orderId;

        return newOrder.orderId;
    } catch (error) {
        addLog(`Lỗi cập nhật lệnh ${type} cho ${side}: ${error.msg || error.message}`);
        if (type === 'STOP') position.currentSLId = null;
        return null;
    }
}

async function closePartialPosition(position, quantityToClose) {
    if (!position || isProcessingTrade) return false;
    isProcessingTrade = true;

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol khi đóng từng phần.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));

        if (currentQty === 0) {
            addLog(`Vị thế ${position.side} đã đóng hết, không cần đóng từng phần.`);
            position.closedLossAmount = position.initialQuantity;
            position.hasClosedAllLossPositionAtLastLevel = true;
            return false;
        }

        quantityToClose = Math.min(quantityToClose, currentQty);

        quantityToClose = parseFloat((Math.floor(quantityToClose / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToClose <= 0) {
            addLog(`Khối lượng đóng từng phần quá nhỏ/không hợp lệ: ${quantityToClose}.`);
            return false;
        }

        const orderSide = (position.side === 'LONG') ? 'SELL' : 'BUY';

        addLog(`Đóng từng phần ${quantityToClose.toFixed(symbolDetails.quantityPrecision)} ${position.symbol} của vị thế lỗ ${position.side}.`);

        await cancelOpenOrdersForSymbol(position.symbol, position.side);
        position.currentSLId = null;
        position.currentTPId = null;
        await sleep(500);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: quantityToClose,
            newClientOrderId: `PARTIAL-CLOSE-${position.side}-${Date.now()}`
        });

        position.closedLossAmount += quantityToClose;
        addLog(`Đã gửi lệnh đóng từng phần. Tổng KL đã đóng: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);

        return true;
    } catch (error) {
        addLog(`Lỗi đóng từng phần vị thế ${position.side}: ${error.msg || error.message}`);
        return false;
    } finally {
        isProcessingTrade = false;
    }
}

async function addPosition(position, quantityToAdd) {
    if (!position || quantityToAdd <= 0 || isProcessingTrade) return false;
    isProcessingTrade = true;

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol khi mở lại lệnh.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));

        let effectiveQuantityToAdd = quantityToAdd;
        const maxQtyAllowedToAdd = position.initialQuantity - currentQty;
        effectiveQuantityToAdd = Math.min(effectiveQuantityToAdd, maxQtyAllowedToAdd);

        if (effectiveQuantityToAdd <= 0) {
            addLog(`Khối lượng mở lại quá nhỏ (${effectiveQuantityToAdd}) hoặc KL hiện tại >= KL ban đầu.`);
            return false;
        }

        effectiveQuantityToAdd = parseFloat((Math.floor(effectiveQuantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

         if (effectiveQuantityToAdd <= 0) {
             addLog(`Khối lượng mở lại sau làm tròn quá nhỏ (${effectiveQuantityToAdd}).`);
             return false;
         }

        const orderSide = (position.side === 'LONG') ? 'BUY' : 'SELL';

        addLog(`Đang mở lại ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)} ${position.symbol} cho vị thế ${position.side} (phần đã cắt lỗ).`);

        await cancelOpenOrdersForSymbol(position.symbol, position.side);
        position.currentSLId = null;
        position.currentTPId = null;
         await sleep(500);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: effectiveQuantityToAdd,
             newClientOrderId: `ADD-POS-${position.side}-${Date.now()}`
        });

        addLog(`Đã gửi lệnh mở lại. Khối lượng cần mở: ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)}. Đang chờ khớp.`);

        position.closedLossAmount -= effectiveQuantityToAdd;
        if (position.closedLossAmount < 0) position.closedLossAmount = 0;
        addLog(`Tổng Khối lượng lệnh lỗ đã đóng còn lại: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);

        const winningPos = (position.side === 'LONG' && currentShortPosition) ? currentShortPosition :
                           (position.side === 'SHORT' && currentLongPosition) ? currentLongPosition : null;

        if (winningPos) {
             addLog("Đã mở lại lệnh lỗ. Đang reset trạng thái & đặt lại TP/SL ban đầu cho cặp...");
             winningPos.nextPartialCloseLossIndex = 0;
             winningPos.hasAdjustedSLToSpecificLevel = {};
             position.hasClosedAllLossPositionAtLastLevel = false;

             await sleep(1000);
             await setInitialTPAndSL(winningPos);
             await sleep(500);
             await setInitialTPAndSL(position);
             addLog("Đã hoàn tất reset trạng thái & đặt lại TP/SL ban đầu.");
        } else {
             addLog("Đã mở lại lệnh lỗ, nhưng không tìm thấy lệnh đối ứng để reset trạng thái.");
        }

        return true;
    } catch (error) {
        addLog(`Lỗi mở lại lệnh ${position.side}: ${error.msg || error.message}`);
        return false;
    } finally {
        isProcessingTrade = false;
    }
}


async function runTradingLogic() {
    if (!botRunning || currentLongPosition || currentShortPosition) return;

    addLog('Bắt đầu chu kỳ giao dịch mới...');
    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) {
            addLog("Không thể lấy đòn bẩy. Bỏ qua chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const initialPairPrice = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (!initialPairPrice) {
            addLog("Không thể lấy giá ban đầu. Bỏ qua chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const longPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        if (!longPositionData) {
            addLog("Mở lệnh LONG thất bại. Bỏ qua chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentLongPosition = longPositionData;
        currentLongPosition.pairEntryPrice = initialPairPrice;

        await sleep(800);

        const shortPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        if (!shortPositionData) {
            addLog('Mở lệnh SHORT thất bại. Đang đóng lệnh LONG.');
            await closePosition(currentLongPosition.symbol, 0, 'Lỗi mở lệnh SHORT', 'LONG');
            currentLongPosition = null;
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentShortPosition = shortPositionData;
        currentShortPosition.pairEntryPrice = initialPairPrice;


        addLog("Đã mở cả hai vị thế. Đợi 3s để đặt TP/SL...");
        await sleep(3000);

        const isLongTPSLSet = await setInitialTPAndSL(currentLongPosition);
        if (!isLongTPSLSet) {
             addLog("Đặt TP/SL cho LONG thất bại. Đang đóng cả hai.");
             await closePosition(currentLongPosition.symbol, 0, 'Lỗi đặt TP/SL', 'LONG');
             await closePosition(currentShortPosition.symbol, 0, 'Lỗi đặt TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        await sleep(500);

        const isShortTPSLSet = await setInitialTPAndSL(currentShortPosition);
         if (!isShortTPSLSet) {
             addLog("Đặt TP/SL cho SHORT thất bại. Đang đóng cả hai.");
             await closePosition(currentLongPosition.symbol, 0, 'Lỗi đặt TP/SL', 'LONG');
             await closePosition(currentShortPosition.symbol, 0, 'Lỗi đặt TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        addLog("Đã đặt TP/SL cho cả hai vị thế. Bắt đầu theo dõi.");
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 15000);
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
        addLog("Không có vị thế mở để theo dõi.");
        if(botRunning) scheduleNextMainCycle();
        return;
    }
    if (isProcessingTrade) return;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });

        let longPosOnExchange = positions.find(p => p.positionSide === 'LONG' && parseFloat(p.positionAmt) > 0);
        let shortPosOnExchange = positions.find(p => p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);

        if (currentLongPosition) {
             if(longPosOnExchange){
                currentLongPosition.unrealizedPnl = parseFloat(longPosOnExchange.unRealizedProfit);
                currentLongPosition.currentPrice = parseFloat(longPosOnExchange.markPrice);
             } else {
                 addLog(`Vị thế LONG không trên sàn. Cập nhật trạng thái bot.`);
                 currentLongPosition = null;
             }
        }
         if (currentShortPosition) {
             if(shortPosOnExchange){
                currentShortPosition.unrealizedPnl = parseFloat(shortPosOnExchange.unRealizedProfit);
                currentShortPosition.currentPrice = parseFloat(shortPosOnExchange.markPrice);
            } else {
                 addLog(`Vị thế SHORT không trên sàn. Cập nhật trạng thái bot.`);
                 currentShortPosition = null;
             }
         }

        if (!currentLongPosition && !currentShortPosition) {
            addLog("Cả hai vị thế đã đóng.");
            if (botRunning) cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }

        let winningPos = null;
        let losingPos = null;

        if (currentLongPosition?.unrealizedPnl > 0 && currentShortPosition?.unrealizedPnl <= 0) {
            winningPos = currentLongPosition;
            losingPos = currentShortPosition;
        } else if (currentShortPosition?.unrealizedPnl > 0 && currentLongPosition?.unrealizedPnl <= 0) {
            winningPos = currentShortPosition;
            losingPos = currentLongPosition;
        } else {
             return;
        }

        if (winningPos && losingPos && winningPos.partialCloseLossLevels) {
            const currentProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;

            const PARTIAL_CLOSE_INDEX_5 = 4;
            const PARTIAL_CLOSE_INDEX_8 = 7;

            const PARTIAL_CLOSE_LEVEL_5 = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5];
            const PARTIAL_CLOSE_LEVEL_8 = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_8];

            const nextCloseLevel = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
            if (nextCloseLevel !== undefined && currentProfitPercentage >= nextCloseLevel) {
                if (!losingPos.hasClosedAllLossPositionAtLastLevel) {
                    let quantityToCloseFraction = 0.10;

                    if (winningPos.nextPartialCloseLossIndex === PARTIAL_CLOSE_INDEX_5) {
                        quantityToCloseFraction = 0.20;
                        addLog(`Lệnh ${winningPos.side} đạt ${nextCloseLevel}% lãi. Đóng 20% KL ban đầu của lệnh ${losingPos.side} (lỗ).`);
                    } else if (winningPos.nextPartialCloseLossIndex === PARTIAL_CLOSE_INDEX_8) {
                         quantityToCloseFraction = 1.00;
                         addLog(`Lệnh ${winningPos.side} đạt ${nextCloseLevel}% lãi. Đóng 100% KL còn lại của lệnh ${losingPos.side} (lỗ).`);
                    } else if (winningPos.nextPartialCloseLossIndex < winningPos.partialCloseLossLevels.length) {
                        quantityToCloseFraction = 0.10;
                         addLog(`Lệnh ${winningPos.side} đạt ${nextCloseLevel}% lãi. Đóng 10% KL ban đầu của lệnh ${losingPos.side} (lỗ).`);
                    } else {
                         winningPos.nextPartialCloseLossIndex++;
                        return;
                    }

                    const currentLosingQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));

                    if (currentLosingQtyOnExchange > 0) {
                        const qtyToCloseNow = (quantityToCloseFraction === 1.00) ? currentLosingQtyOnExchange : losingPos.initialQuantity * quantityToCloseFraction;

                        const success = await closePartialPosition(losingPos, qtyToCloseNow);
                        if (success) {
                            winningPos.nextPartialCloseLossIndex++;
                            const remainingQtyAfterClose = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));
                            if (remainingQtyAfterClose <= 0 || winningPos.nextPartialCloseLossIndex > winningPos.partialCloseLossLevels.length -1 ) {
                                losingPos.hasClosedAllLossPositionAtLastLevel = true;
                                addLog(`Vị thế lỗ ${losingPos.side} đã đóng hoàn toàn.`);
                            }
                        }
                    } else {
                        addLog(`Vị thế lỗ ${losingPos.side} đã đóng hết trên sàn, không cần đóng từng phần nữa.`);
                         losingPos.hasClosedAllLossPositionAtLastLevel = true;
                        winningPos.nextPartialCloseLossIndex++;
                    }
                } else {
                     winningPos.nextPartialCloseLossIndex++;
                }
            }

            if (PARTIAL_CLOSE_LEVEL_5 !== undefined && currentProfitPercentage >= PARTIAL_CLOSE_LEVEL_5 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5]) {
                addLog(`Lệnh lãi ${winningPos.side} đạt ${PARTIAL_CLOSE_LEVEL_5}% lãi. Điều chỉnh SL lệnh lỗ ${losingPos.side}.`);

                 const currentLosingQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));

                if (losingPos && currentLosingQtyOnExchange > 0 && PARTIAL_CLOSE_LEVEL_8 !== undefined) {
                    const lossPercentageAtLevel8 = PARTIAL_CLOSE_LEVEL_8 / 100;
                    const priceChangeForLosingSL = (losingPos.initialMargin * (lossPercentageAtLevel8 / 100)) / losingPos.initialQuantity;
                    const slPriceLosing = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeForLosingSL : losingPos.entryPrice + priceChangeForLosingSL).toFixed(losingPos.pricePrecision));

                    losingPos.currentSLId = await updateStopLimitOrder(losingPos, slPriceLosing, 'STOP');
                    if (losingPos.currentSLId) {
                        addLog(`SL lệnh LỖ ${losingPos.side} rời về giá ${slPriceLosing.toFixed(losingPos.pricePrecision)} (PNL ${PARTIAL_CLOSE_LEVEL_8}%).`);
                        winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5] = true;
                    } else {
                        addLog(`Không thể đặt lại SL lệnh lỗ ${losingPos.side} ở Mốc ${PARTIAL_CLOSE_LEVEL_5}% lãi lệnh thắng.`);
                    }
                } else {
                    addLog(`Không thể điều chỉnh SL lệnh lỗ ${losingPos.side} ở Mốc ${PARTIAL_CLOSE_LEVEL_5}% lãi lệnh thắng vì vị thế đã đóng hoặc không tồn tại.`);
                    winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5] = true;
                }
            }

             if (PARTIAL_CLOSE_LEVEL_8 !== undefined && currentProfitPercentage >= PARTIAL_CLOSE_LEVEL_8 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_8]) {
                 addLog(`Lệnh lãi ${winningPos.side} đạt ${PARTIAL_CLOSE_LEVEL_8}% lãi.`);
                 if (losingPos.hasClosedAllLossPositionAtLastLevel) {
                     addLog(`Vị thế LỖ ${losingPos.side} đã đóng hoàn toàn.`);
                 } else {
                     addLog(`Vị thế LỖ ${losingPos.side} chưa đóng hoàn toàn ở Mốc ${PARTIAL_CLOSE_LEVEL_8}% lãi lệnh thắng. Đang đóng nốt.`);
                     await closePosition(losingPos.symbol, 0, `Đóng nốt ở Mốc ${PARTIAL_CLOSE_LEVEL_8}% lãi lệnh thắng`, losingPos.side);
                     const remainingQtyAfterClose = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));
                     if (remainingQtyAfterClose <= 0) losingPos.hasClosedAllLossPositionAtLastLevel = true;
                 }
                 winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_8] = true;
             }
        }

        if (losingPos && losingPos.closedLossAmount > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel && winningPos) {
            const pairEntryPrice = winningPos.pairEntryPrice;
            if (currentMarketPrice !== null && pairEntryPrice !== null) {
                const tolerance = pairEntryPrice * 0.0005;

                const isPriceNearPairEntry = Math.abs(currentMarketPrice - pairEntryPrice) <= tolerance;

                if (isPriceNearPairEntry) {
                    addLog(`Giá ${currentMarketPrice?.toFixed(winningPos.pricePrecision) || 'N/A'} gần giá vào cặp ${pairEntryPrice?.toFixed(winningPos.pricePrecision) || 'N/A'}. Đang mở lại vị thế lỗ ${losingPos.side}.`);
                    await addPosition(losingPos, losingPos.closedLossAmount);
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
    addLog(`Lên lịch chu kỳ tiếp theo sau 2 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}

async function getListenKey() { if (!API_KEY || !SECRET_KEY) { addLog("API Key chưa cấu hình."); return null; } try { const data = await callSignedAPI('/fapi/v1/listenKey', 'POST'); addLog(`Đã lấy listenKey mới.`); return data.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.message}`); return null; } }
async function keepAliveListenKey() { if (listenKey) { try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) { addLog(`Lỗi làm mới listenKey. Đang lấy key mới...`); listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); } } }

function setupMarketDataStream(symbol) {
    if (marketWs) marketWs.close();
    const streamUrl = `${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice`;
    marketWs = new WebSocket(streamUrl);

    marketWs.onopen = () => addLog(`Market WS cho ${symbol} đã kết nối.`);
    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
             if (data.e === 'markPriceUpdate' && data.s === symbol) {
                currentMarketPrice = parseFloat(data.p);
            }
        } catch (e) {}
    };
    marketWs.onclose = () => {
        addLog(`Market WS cho ${symbol} đã đóng. Kết nối lại sau 5s...`);
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
    marketWs.onerror = (error) => {
        addLog(`Lỗi Market WS cho ${symbol}: ${error.message}`);
         if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
}

function setupUserDataStream(key) {
    if (userDataWs) userDataWs.close();
    const streamUrl = `${WS_BASE_URL}/ws/${key}`;
    userDataWs = new WebSocket(streamUrl);

    userDataWs.onopen = () => {
        addLog('User Data WS đã kết nối.');
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000);
    };
    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'ORDER_TRADE_UPDATE') {
                await processTradeResult(data.o);
            } else if (data.e === 'ACCOUNT_UPDATE') {
            }
        } catch (e) {}
    };
    userDataWs.onclose = async () => {
        addLog('User Data WS đã đóng. Kết nối lại sau 5s...');
        if (botRunning) {
            setTimeout(async () => {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
                 else addLog("Không lấy được listenKey mới để kết nối lại User Data WS.");
            }, 5000);
        }
    };
    userDataWs.onerror = (error) => {
        addLog(`Lỗi User Data WS: ${error.message}`);
        if (botRunning) {
            setTimeout(async () => {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
                 else addLog("Không lấy được listenKey mới để kết nối lại User Data WS sau lỗi.");
            }, 5000);
        }
    };
}

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đã chạy.';
    if (!API_KEY || !SECRET_KEY) return 'Lỗi: Thiếu API/SECRET key.';

    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime();
        await getExchangeInfo();

        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);

        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey);
         else throw new Error("Không thể thiết lập User Data Stream.");

        setupMarketDataStream(TARGET_COIN_SYMBOL);

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`);

        scheduleNextMainCycle();
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 15000);
        }
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
    positionCheckInterval = null;
    listenKeyRefreshInterval = null;
    marketWs = null;
    userDataWs = null;
    listenKey = null;
    currentLongPosition = null;
    currentShortPosition = null;
    totalProfit = 0;
    totalLoss = 0;
    netPNL = 0;
    isProcessingTrade = false;
    addLog('--- Bot đã dừng ---');
    return 'Bot đã dừng.';
}

async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Đang kiểm tra vị thế còn sót lại cho ${symbol}.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const remainingPositions = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPositions.length > 0) {
            addLog(`Tìm thấy ${remainingPositions.length} vị thế sót. Đang đóng...`);
            for (const pos of remainingPositions) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                const success = await closePosition(pos.symbol, 0, `Vị thế sót khi khởi động/reset`, sideToClose);
                if(success) await sleep(1000);
            }
        } else {
            addLog(`Không có vị thế sót cho ${symbol}.`);
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót: ${error.msg || error.message}`);
    }
}

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).send('Lỗi đọc file log');
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        res.send(cleanData.split('\n').slice(-500).join('\n'));
    });
});
app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => {
            exec('pm2 jlist', (error, stdout) => {
                if (error) reject(error);
                resolve(stdout);
            });
        });
        const botProcess = JSON.parse(pm2List).find(p => p.name === THIS_BOT_PM2_NAME);
        let statusMessage = 'MÁY CHỦ: TẮT (PM2)';
        if (botProcess) {
            statusMessage = `MÁY CHỦ: ${botProcess.pm2_env.status.toUpperCase()}`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | BOT: ${botRunning ? 'ĐANG CHẠY' : 'ĐÃ DỪNG'}`;
                if (botStartTime) {
                    const uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / 60000);
                    statusMessage += ` | Thời gian chạy: ${uptimeMinutes} phút`;
                }
                statusMessage += ` | Coin: ${TARGET_COIN_SYMBOL} | Vốn lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
                 let openPositionsText = " | Vị thế: KHÔNG CÓ";
                 if(currentLongPosition || currentShortPosition) {
                    openPositionsText = " | Vị thế: ";
                    if(currentLongPosition) openPositionsText += `LONG (${currentLongPosition.unrealizedPnl?.toFixed(2) || 'N/A'} PNL) `;
                    if(currentShortPosition) openPositionsText += `SHORT (${currentShortPosition.unrealizedPnl?.toFixed(2) || 'N/A'} PNL)`;
                 }
                 statusMessage += openPositionsText;
            }
        }
        res.send(statusMessage);
    } catch (error) {
        res.status(500).send(`Lỗi lấy trạng thái PM2.`);
    }
});
app.get('/api/bot_stats', (req, res) => {
    let openPositionsData = [];
    if (currentLongPosition) {
        const pos = currentLongPosition;
        openPositionsData.push({
            side: pos.side,
            entryPrice: pos.entryPrice?.toFixed(pos.pricePrecision) || 'N/A',
            quantity: Math.abs(parseFloat(pos.quantity || 0)).toFixed(pos.pricePrecision) || 'N/A',
            unrealizedPnl: pos.unrealizedPnl?.toFixed(2) || 'N/A',
            currentPrice: pos.currentPrice?.toFixed(pos.pricePrecision) || 'N/A',
            initialQuantity: pos.initialQuantity?.toFixed(pos.pricePrecision) || 'N/A',
            closedLossAmount: pos.closedLossAmount?.toFixed(pos.pricePrecision) || 'N/A',
            pairEntryPrice: pos.pairEntryPrice?.toFixed(pos.pricePrecision) || 'N/A',
        });
    }
    if (currentShortPosition) {
         const pos = currentShortPosition;
        openPositionsData.push({
            side: pos.side,
            entryPrice: pos.entryPrice?.toFixed(pos.pricePrecision) || 'N/A',
            quantity: Math.abs(parseFloat(pos.quantity || 0)).toFixed(pos.pricePrecision) || 'N/A',
            unrealizedPnl: pos.unrealizedPnl?.toFixed(2) || 'N/A',
            currentPrice: pos.currentPrice?.toFixed(pos.pricePrecision) || 'N/A',
            initialQuantity: pos.initialQuantity?.toFixed(pos.pricePrecision) || 'N/A',
            closedLossAmount: pos.closedLossAmount?.toFixed(pos.pricePrecision) || 'N/A',
            pairEntryPrice: pos.pairEntryPrice?.toFixed(pos.pricePrecision) || 'N/A',
        });
    }
    res.json({ success: true, data: { totalProfit: totalProfit.toFixed(2), totalLoss: totalLoss.toFixed(2), netPNL: netPNL.toFixed(2), currentOpenPositions: openPositionsData, currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT } });
});
app.post('/api/configure', (req, res) => {
    const config = req.body.coinConfigs?.[0];
    if (config) {
        const oldSymbol = TARGET_COIN_SYMBOL;
        TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase();
        INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount);

        addLog(`Cấu hình đã cập nhật: Coin: ${TARGET_COIN_SYMBOL}, Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`);

        if (oldSymbol !== TARGET_COIN_SYMBOL) {
            addLog(`Coin đã thay đổi ${oldSymbol} -> ${TARGET_COIN_SYMBOL}. Đang reset trạng thái.`);
            stopBotLogicInternal();
            setTimeout(() => startBotLogicInternal(), 2000);
        }
        res.json({ success: true, message: 'Cấu hình đã cập nhật.' });
    } else {
        res.status(400).send('Dữ liệu cấu hình không hợp lệ.');
    }
});

app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));

app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web server trên cổng ${WEB_SERVER_PORT}`);
    addLog(`Quản lý tại: http://localhost:${WEB_SERVER_PORT}`);
});
