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
let isProcessingTrade = false;
let botRunning = false;
let botStartTime = null;

let currentLongPosition = null;
let currentShortPosition = null;

let positionCheckInterval = null;
let nextScheduledCycleTimeout = null;

let consecutiveApiErrors = 0;
const MAX_CONSECUTIVE_API_ERRORS = 3;
const ERROR_RETRY_DELAY_MS = 10000;
let retryBotTimeout = null;

const logCounts = {};
const LOG_COOLDOWN_MS = 2000;

let currentBotMode = 'kill';
let lastHourVolatility = 0;

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

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;

        if ((now.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return;
        } else {
            if (logCounts[messageHash].count > 1) {
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
                 if (LOG_TO_CUSTOM_FILE) {
                    fs.appendFile(CUSTOM_LOG_FILE, `[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}\n`, (err) => {});
                }
            } else {
                console.log(logEntry);
                if (LOG_TO_CUSTOM_FILE) {
                    fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {});
                }
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) {
            fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {});
        }
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
                     try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) {
                        errorDetails.msg += ` - Raw: ${data.substring(0, Math.min(data.length, 200))}`;
                    }
                    addLog(`HTTP Request lỗi: ${errorDetails.msg}`);
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
        addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -1003) {
            addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT).");
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
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
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API công khai: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
         if (error.code === -1003) {
            addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT).");
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
            throw new CriticalApiError("Quá nhiều lỗi API liên tiếp, bot dừng.");
        }
        throw error;
    }
}

async function getHourlyVolatility(symbol) {
    try {
        const klines = await callPublicAPI('/fapi/v1/klines', { symbol: symbol, interval: '1h', limit: 2 });
        if (klines && klines.length > 0) {
            const lastCompletedCandle = klines[0];
            const high = parseFloat(lastCompletedCandle[2]);
            const low = parseFloat(lastCompletedCandle[3]);
            if (low > 0) {
                const volatility = ((high - low) / low) * 100;
                lastHourVolatility = volatility;
                return volatility;
            } else {
                addLog(`Dữ liệu Low price không hợp lệ cho ${symbol} (Low=${low}).`);
            }
        } else {
            addLog(`Không thể lấy dữ liệu kline 1h cho ${symbol} hoặc mảng rỗng.`);
        }
        return 0;
    } catch (e) {
        addLog(`Lỗi khi lấy dữ liệu biến động 1h (/fapi/v1/klines): ${e.message}`);
        if (e instanceof CriticalApiError) throw e;
        return 0;
    }
}

async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); addLog(`Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`); } catch (e) { addLog(`Lỗi đồng bộ thời gian: ${e.message}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const bracket = r.find(i => i.symbol === symbol)?.brackets[0]; return bracket ? parseInt(bracket.initialLeverage) : null; } catch (e) { addLog(`Lỗi lấy đòn bẩy: ${e.msg}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { addLog(`Lỗi đặt đòn bẩy: ${e.msg}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize || 0.001), stepSize: parseFloat(l?.stepSize || 0.001), minNotional: parseFloat(m?.notional || 0) }; }); addLog('Đã tải thông tin sàn.'); return exchangeInfoCache; } catch (e) { addLog('Lỗi tải thông tin sàn.'); if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { addLog(`Lỗi lấy giá: ${e.message}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }

async function cancelAllOpenOrdersForSymbol(symbol) {
    addLog(`Hủy TẤT CẢ lệnh chờ cho ${symbol} (cả LONG và SHORT)...`);
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) {
            return;
        }
        for (const order of openOrders) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId });
                await sleep(50);
            } catch (innerError) {
                 if (innerError.code !== -2011) addLog(`Lỗi hủy lệnh ${order.orderId}: ${innerError.msg || innerError.message}`);
                 if (innerError instanceof CriticalApiError) stopBotLogicInternal();
            }
        }
        addLog(`Đã gửi yêu cầu hủy ${openOrders.length} lệnh cho ${symbol}.`);
    } catch (error) {
        if (error.code !== -2011) addLog(`Lỗi lấy lệnh chờ để hủy tất cả: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}


async function cleanupAndResetCycle(symbol) {
    addLog(`Chu kỳ ${symbol} kết thúc. Dọn dẹp...`);
    currentLongPosition = null;
    currentShortPosition = null;
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
    await cancelAllOpenOrdersForSymbol(symbol);
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

    if (realizedPnl !== 0) {
        if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
        netPNL = totalProfit - totalLoss;
        addLog(`PNL Ròng: ${netPNL.toFixed(2)} (Lời: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`);
    }

    const isLongClosureByBotTarget = currentLongPosition && (orderId == currentLongPosition.currentTPId || orderId == currentLongPosition.currentSLId);
    const isShortClosureByBotTarget = currentShortPosition && (orderId == currentShortPosition.currentTPId || orderId == currentShortPosition.currentSLId);

    if (isLongClosureByBotTarget || isShortClosureByBotTarget) {
        addLog(`Lệnh bot chính ${orderId} (${positionSide}) khớp.`);
        const closedPositionSide = positionSide;
        const remainingPosition = (closedPositionSide === 'LONG') ? currentShortPosition : currentLongPosition;

        if (closedPositionSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;

        if (realizedPnl >= 0) {
             addLog(`Vị thế LÃI (${closedPositionSide}) đã đóng. Kiểm tra và đóng vị thế LỖ đối ứng.`);
             if (remainingPosition) {
                 try {
                     const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPosition.symbol });
                     const currentLosingQtyOnExchange = Math.abs(parseFloat(positionsOnExchange.find(p => p.symbol === remainingPosition.symbol && p.positionSide === remainingPosition.side)?.positionAmt || 0));
                     if (currentLosingQtyOnExchange > 0) {
                          addLog(`Vị thế LỖ ${remainingPosition.side} còn (${currentLosingQtyOnExchange}). Đang đóng hoàn toàn.`);
                          await closePosition(remainingPosition.symbol, 0, `Lệnh LÃI đối ứng (${closedPositionSide}) đã chốt`, remainingPosition.side);
                     }
                 } catch(e) {
                     addLog(`Lỗi kiểm tra/đóng vị thế lỗ sau khi chốt lãi: ${e.msg || e.message}`);
                     if (e instanceof CriticalApiError) stopBotLogicInternal();
                 }
             }
             await cleanupAndResetCycle(symbol);
        } else {
             addLog(`Vị thế LỖ (${closedPositionSide}) đã đóng. Lệnh còn lại (${remainingPosition ? remainingPosition.side : 'Không có'}) sẽ chạy tiếp.`);
        }
    }
    isProcessingTrade = false;
}

async function closePosition(symbol, quantityToCloseParam, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide || isProcessingTrade) return false;
    isProcessingTrade = true;
    addLog(`Đóng lệnh ${positionSide} ${symbol} (Lý do: ${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (posOnBinance) {
            // Do not cancel orders here if this is part of a larger reset that cancels all.
            // await cancelAllOpenOrdersForSymbol(symbol, positionSide);
            // await sleep(300);
            const qtyToCloseMarket = Math.abs(parseFloat(posOnBinance.positionAmt));
            if (qtyToCloseMarket === 0) {
                 addLog(`Vị thế ${positionSide} đã đóng hết trên sàn (KL=0).`);
                 isProcessingTrade = false;
                 return false;
            }
            const closeSideOrder = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            addLog(`Gửi lệnh đóng MARKET ${positionSide} KL: ${qtyToCloseMarket}`);
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSideOrder, positionSide, type: 'MARKET', quantity: qtyToCloseMarket });
            addLog(`Đã gửi lệnh đóng ${positionSide}.`);

            if (positionSide === 'LONG' && currentLongPosition) {
                currentLongPosition.quantity = 0;
            } else if (positionSide === 'SHORT' && currentShortPosition) {
                currentShortPosition.quantity = 0;
            }
            isProcessingTrade = false;
            return true;
        } else {
            addLog(`Vị thế ${positionSide} đã đóng hoặc không tồn tại.`);
            isProcessingTrade = false;
            return false;
        }
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${positionSide}: ${error.msg || error.message}`);
         if (error instanceof CriticalApiError) stopBotLogicInternal();
        isProcessingTrade = false;
        return false;
    }
}

async function openMarketPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    addLog(`Mở ${tradeDirection} ${symbol} với ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
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
             addLog(`Giá trị lệnh quá nhỏ: ${quantity * currentPrice}. Min: ${symbolDetails.minNotional}. Vui lòng tăng vốn.`);
             throw new Error("Giá trị lệnh quá nhỏ so với sàn.");
        }
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        addLog(`Gửi lệnh MARKET ${tradeDirection} KL: ${quantity.toFixed(symbolDetails.quantityPrecision)} giá ~${currentPrice.toFixed(symbolDetails.pricePrecision)}`);
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
                 break;
            }
        }
        if (!openPos || Math.abs(parseFloat(openPos.positionAmt)) === 0) {
            throw new Error("Vị thế chưa xác nhận trên sàn sau nhiều lần thử.");
        }
        const entryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`Đã mở ${tradeDirection} | KL: ${actualQuantity.toFixed(symbolDetails.quantityPrecision)} | Giá vào: ${entryPrice.toFixed(symbolDetails.pricePrecision)}`);

        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, entryPrice,
            initialMargin: INITIAL_INVESTMENT_AMOUNT,
            side: tradeDirection, maxLeverageUsed: maxLeverage,
            pricePrecision: symbolDetails.pricePrecision,
            quantityPrecision: symbolDetails.quantityPrecision,
            closedLossAmount: 0,
            nextPartialCloseLossIndex: 0,
            pnlBaseForNextMoc: 0, // PNL cơ sở ban đầu là 0%
            hasAdjustedSLToSpecificLevel: {},
            hasClosedAllLossPositionAtLastLevel: false,
            pairEntryPrice: currentPrice,
            hasBeenReopenedInSideways: false
        };
    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        return null;
    }
}

async function setInitialTPAndSL(position) {
    if (!position || position.quantity <=0 ) {
        addLog(`Không đặt TP/SL cho ${position?.side} do vị thế null hoặc KL = 0.`);
        return false;
    }
    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity, quantity } = position;
    addLog(`Đặt TP/SL ban đầu cho ${side} (Entry: ${entryPrice.toFixed(pricePrecision)}, KL hiện tại: ${quantity.toFixed(position.quantityPrecision)})...`);
    try {
        // Hủy lệnh của vị thế này trước, vì cancelAllOpenOrdersForSymbol sẽ được gọi nếu là reset toàn bộ cặp.
        // await cancelAllOpenOrdersForSymbol(symbol, side); // Đã thay bằng cancelAllOpenOrdersForSymbol ở nơi gọi addPosition
        // await sleep(300);

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
        const quantityToOrder = quantity;

        if (quantityToOrder <= 0) {
            addLog(`KL đặt TP/SL cho ${side} là 0 hoặc âm. Bỏ qua.`);
            return false;
        }

        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side, type: 'STOP_MARKET',
            stopPrice: slPrice, quantity: quantityToOrder,
            timeInForce: 'GTC', newClientOrderId: `SL-${side}-${Date.now()}`
        });
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice, quantity: quantityToOrder,
            timeInForce: 'GTC', newClientOrderId: `TP-${side}-${Date.now()}`
        });

        addLog(`TP/SL ban đầu cho ${side}: TP=${tpPrice.toFixed(pricePrecision)}, SL=${slPrice.toFixed(pricePrecision)} (KL: ${quantityToOrder.toFixed(position.quantityPrecision)})`);

        position.initialTPPrice = tpPrice;
        position.initialSLPrice = slPrice;
        position.currentTPId = tpOrder.orderId;
        position.currentSLId = slOrder.orderId;
        position.partialCloseLossLevels = partialCloseLossSteps;

        // Chỉ reset các cờ này nếu chúng chưa được chủ động set bởi logic "reset về Mốc 0"
        if (typeof position.nextPartialCloseLossIndex !== 'number' || position.nextPartialCloseLossIndex < 0) {
            position.nextPartialCloseLossIndex = 0;
        }
        if (typeof position.pnlBaseForNextMoc !== 'number') {
            position.pnlBaseForNextMoc = 0;
        }
        position.hasAdjustedSLToSpecificLevel = {};
        position.hasClosedAllLossPositionAtLastLevel = false;
        position.hasBeenReopenedInSideways = false;

        return true;
    } catch (error) {
        addLog(`Lỗi nghiêm trọng đặt TP/SL ban đầu cho ${side}: ${error.msg || error.message}.`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        return false;
    }
}

async function updateStopLimitOrder(position, newPrice, type) {
    if (!position || position.quantity <= 0) {
        addLog(`Không cập nhật ${type} cho ${position?.side} do vị thế null hoặc KL = 0.`);
        return null;
    }
    const { symbol, side, currentSLId, currentTPId, pricePrecision } = position;
    const orderIdToCancel = (type === 'STOP') ? currentSLId : currentTPId;
    const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';
    const newOrderType = `${type}_MARKET`;

    if (type === 'TAKE_PROFIT') {
        addLog("Logic rời TP chưa được triển khai.");
        return position.currentTPId;
    }

    if (isProcessingTrade) {
        addLog(`Bỏ qua cập nhật ${type} cho ${side} do đang xử lý giao dịch khác.`);
        return orderIdToCancel;
    }
    isProcessingTrade = true;

    try {
        if (orderIdToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: orderIdToCancel });
                addLog(`Đã hủy lệnh ${type} cũ ${orderIdToCancel} cho ${side}.`);
            } catch (innerError) {
                if (innerError.code !== -2011) {
                    addLog(`Lỗi hủy lệnh ${type} cũ ${orderIdToCancel}: ${innerError.msg || innerError.message}`);
                    if (innerError instanceof CriticalApiError) throw innerError;
                }
            }
        }

        const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol });
        const currentPositionOnExchange = positionsOnExchange.find(p => p.symbol === symbol && p.positionSide === side);
        const actualQuantityOnExchange = Math.abs(parseFloat(currentPositionOnExchange?.positionAmt || 0));

        if (actualQuantityOnExchange === 0) {
             addLog(`Vị thế ${side} đã đóng, không thể đặt lệnh ${type} mới.`);
             if (type === 'STOP') position.currentSLId = null;
             isProcessingTrade = false;
             return null;
        }
        const symbolDetails = await getSymbolDetails(symbol);
        const quantityToUse = parseFloat((Math.floor(actualQuantityOnExchange / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToUse <= 0) {
            addLog(`Khối lượng cho lệnh ${type} mới quá nhỏ (${quantityToUse}).`);
             if (type === 'STOP') position.currentSLId = null;
             isProcessingTrade = false;
            return null;
        }

        const stopPriceFormatted = parseFloat(newPrice.toFixed(pricePrecision));
        const newOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side,
            type: newOrderType,
            stopPrice: stopPriceFormatted,
            quantity: quantityToUse,
            timeInForce: 'GTC',
            newClientOrderId: `${type.toUpperCase()}-UPD-${side}-${Date.now()}`
        });
        addLog(`Đã đặt lệnh ${type} mới cho ${side} ở giá ${stopPriceFormatted.toFixed(pricePrecision)} (KL: ${quantityToUse.toFixed(position.quantityPrecision)}). ID: ${newOrder.orderId}`);

        if (type === 'STOP') position.currentSLId = newOrder.orderId;
        return newOrder.orderId;
    } catch (error) {
        addLog(`Lỗi cập nhật lệnh ${type} cho ${side}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) throw error;
        return orderIdToCancel;
    } finally {
        isProcessingTrade = false;
    }
}

async function closePartialPosition(position, quantityToClose) {
    if (!position || position.quantity <= 0 || isProcessingTrade) return false;
    isProcessingTrade = true;
    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol khi đóng từng phần.");
        let currentQtyInBot = position.quantity;
        if (currentQtyInBot === 0) {
            addLog(`Vị thế ${position.side} đã đóng hết (theo bot), không cần đóng từng phần.`);
            position.closedLossAmount = position.initialQuantity;
            position.hasClosedAllLossPositionAtLastLevel = true;
            isProcessingTrade = false;
            return false;
        }
        let effectiveQuantityToClose = Math.min(quantityToClose, currentQtyInBot);
        effectiveQuantityToClose = parseFloat((Math.floor(effectiveQuantityToClose / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (effectiveQuantityToClose <= 0) {
            addLog(`Khối lượng đóng từng phần quá nhỏ/không hợp lệ: ${effectiveQuantityToClose}.`);
            isProcessingTrade = false;
            return false;
        }
        const orderSide = (position.side === 'LONG') ? 'SELL' : 'BUY';
        addLog(`Đóng từng phần ${effectiveQuantityToClose.toFixed(symbolDetails.quantityPrecision)} ${position.symbol} của vị thế ${position.side}.`);
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: effectiveQuantityToClose,
            newClientOrderId: `PARTIAL-CLOSE-${position.side}-${Date.now()}`
        });
        position.closedLossAmount += effectiveQuantityToClose;
        position.quantity -= effectiveQuantityToClose;
        if (position.quantity < 0) position.quantity = 0;
        addLog(`Đã gửi lệnh đóng từng phần. Tổng KL đã đóng lỗ (cho vị thế này): ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}. KL còn lại (bot): ${position.quantity.toFixed(symbolDetails.quantityPrecision)}`);
        isProcessingTrade = false;
        return true;
    } catch (error) {
        addLog(`Lỗi đóng từng phần vị thế ${position.side}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        isProcessingTrade = false;
        return false;
    } finally {
        if(isProcessingTrade) isProcessingTrade = false;
    }
}

async function addPosition(position, quantityToAdd, reasonForAdd = "generic_reopen") {
    if (!position || quantityToAdd <= 0 || isProcessingTrade) return false;
    isProcessingTrade = true;
    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol khi mở lại lệnh.");
        const currentQtyInBot = position.quantity;
        let effectiveQuantityToAdd = quantityToAdd;
        const maxQtyAllowedToReachInitial = position.initialQuantity - currentQtyInBot;

        if (maxQtyAllowedToReachInitial <= 0) {
            addLog(`Không cần mở lại ${position.side}, KL hiện tại (${currentQtyInBot.toFixed(symbolDetails.quantityPrecision)}) >= KL ban đầu (${position.initialQuantity.toFixed(symbolDetails.quantityPrecision)}).`);
            position.closedLossAmount = 0;
            isProcessingTrade = false;
            return false;
        }
        effectiveQuantityToAdd = Math.min(effectiveQuantityToAdd, maxQtyAllowedToReachInitial);
        effectiveQuantityToAdd = parseFloat((Math.floor(effectiveQuantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
         if (effectiveQuantityToAdd <= 0) {
             addLog(`Khối lượng mở lại sau làm tròn quá nhỏ (${effectiveQuantityToAdd}).`);
             isProcessingTrade = false;
             return false;
         }
        const orderSide = (position.side === 'LONG') ? 'BUY' : 'SELL';
        addLog(`Mở lại ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)} ${position.symbol} cho ${position.side} (Lý do: ${reasonForAdd}).`);

        addLog(`Hủy tất cả lệnh chờ của ${TARGET_COIN_SYMBOL} trước khi mở lại và đặt TP/SL mới.`);
        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
        await sleep(500);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: effectiveQuantityToAdd,
             newClientOrderId: `ADD-POS-${position.side}-${Date.now()}`
        });
        addLog(`Đã gửi lệnh mở lại ${position.side} KL: ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)}. Chờ khớp...`);
        
        position.closedLossAmount -= effectiveQuantityToAdd;
        if (position.closedLossAmount < 0) position.closedLossAmount = 0;
        position.hasBeenReopenedInSideways = true; 
        position.hasClosedAllLossPositionAtLastLevel = false;
        
        const otherPos = (position.side === 'LONG') ? currentShortPosition : currentLongPosition;
        if (otherPos && reasonForAdd === "sideways_moc5_reopen") {
            addLog(`Reset Mốc 0 cho lệnh đối ứng ${otherPos.side} do mở lại từ Sideways Mốc 5.`);
            otherPos.pnlBaseForNextMoc = (otherPos.unrealizedPnl / otherPos.initialMargin) * 100;
            otherPos.nextPartialCloseLossIndex = 0;
            otherPos.hasAdjustedSLToSpecificLevel = {};
        } else if (otherPos && reasonForAdd === "price_near_pair_entry_reopen") {
            addLog(`Reset Mốc 0 cho CẢ HAI LỆNH do mở lại khi giá về gần entry cặp.`);
            otherPos.pnlBaseForNextMoc = (otherPos.unrealizedPnl / otherPos.initialMargin) * 100;
            otherPos.nextPartialCloseLossIndex = 0;
            otherPos.hasAdjustedSLToSpecificLevel = {};
            position.pnlBaseForNextMoc = (position.unrealizedPnl / position.initialMargin) * 100; // Cập nhật cho vị thế vừa add
            position.nextPartialCloseLossIndex = 0; // Cập nhật cho vị thế vừa add
        }

        const newPairEntryPrice = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (newPairEntryPrice) {
            if (currentLongPosition) currentLongPosition.pairEntryPrice = newPairEntryPrice;
            if (currentShortPosition) currentShortPosition.pairEntryPrice = newPairEntryPrice;
            addLog(`Cập nhật giá vào cặp mới: ${newPairEntryPrice.toFixed(symbolDetails.pricePrecision)}`);
        }
        addLog("Đợi 2s cho lệnh mở lại khớp hoàn toàn...");
        await sleep(2000); 

        const updatedPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        if (currentLongPosition) {
            const lpOnEx = updatedPositions.find(p => p.symbol === currentLongPosition.symbol && p.positionSide === currentLongPosition.side);
            if (lpOnEx) {
                currentLongPosition.quantity = Math.abs(parseFloat(lpOnEx.positionAmt));
                currentLongPosition.entryPrice = parseFloat(lpOnEx.entryPrice);
            }
        }
        if (currentShortPosition) {
            const spOnEx = updatedPositions.find(p => p.symbol === currentShortPosition.symbol && p.positionSide === currentShortPosition.side);
            if (spOnEx) {
                currentShortPosition.quantity = Math.abs(parseFloat(spOnEx.positionAmt));
                currentShortPosition.entryPrice = parseFloat(spOnEx.entryPrice);
            }
        }

        addLog("Đặt lại TP/SL ban đầu cho cả hai vị thế...");
        let tpslSuccess = true;
        if (currentLongPosition && currentLongPosition.quantity > 0) {
            if (!await setInitialTPAndSL(currentLongPosition)) tpslSuccess = false;
            await sleep(300);
        }
        if (currentShortPosition && currentShortPosition.quantity > 0) {
            if (!await setInitialTPAndSL(currentShortPosition)) tpslSuccess = false;
        }

        if (tpslSuccess) {
            addLog("Hoàn tất mở lại lệnh và đặt lại TP/SL cho cặp.");
        } else {
            addLog("Lỗi đặt lại TP/SL sau khi mở lại lệnh. Cần kiểm tra thủ công hoặc đóng lệnh.");
        }
        isProcessingTrade = false;
        return true;
    } catch (error) {
        addLog(`Lỗi mở lại lệnh ${position.side}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        isProcessingTrade = false;
        return false;
    } finally {
        if(isProcessingTrade) isProcessingTrade = false;
    }
}

async function runTradingLogic() {
    if (!botRunning || currentLongPosition || currentShortPosition) {
        return;
    }
    addLog('Bắt đầu chu kỳ giao dịch mới...');
    try {
        const vol = await getHourlyVolatility(TARGET_COIN_SYMBOL);
        if (vol <= 5) {
            currentBotMode = 'sideways';
            addLog(`Chế độ SIDEWAYS kích hoạt cho chu kỳ mới (Biến động 1h: ${vol.toFixed(2)}%)`);
        } else {
            currentBotMode = 'kill';
            addLog(`Chế độ KILL kích hoạt cho chu kỳ mới (Biến động 1h: ${vol.toFixed(2)}%)`);
        }

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

        const longPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', 0, maxLeverage);
        if (!longPositionData) {
            addLog("Mở lệnh LONG thất bại. Bỏ qua chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentLongPosition = longPositionData;
        currentLongPosition.pairEntryPrice = initialPairPrice;
        currentLongPosition.nextPartialCloseLossIndex = 0;
        currentLongPosition.pnlBaseForNextMoc = 0;


        await sleep(800);

        const shortPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', 0, maxLeverage);
        if (!shortPositionData) {
            addLog('Mở lệnh SHORT thất bại. Đang đóng lệnh LONG.');
            if (currentLongPosition) {
                await closePosition(currentLongPosition.symbol, 0, 'Lỗi mở lệnh SHORT', 'LONG');
            }
            currentLongPosition = null;
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentShortPosition = shortPositionData;
        currentShortPosition.pairEntryPrice = initialPairPrice;
        currentShortPosition.nextPartialCloseLossIndex = 0;
        currentShortPosition.pnlBaseForNextMoc = 0;

        addLog("Đã mở cả hai vị thế. Đợi 3s để đặt TP/SL...");
        await sleep(3000);

        let tpslAllSet = true;
        if (currentLongPosition && currentLongPosition.quantity > 0) {
            if (!await setInitialTPAndSL(currentLongPosition)) tpslAllSet = false;
        }
        await sleep(500);
        if (currentShortPosition && currentShortPosition.quantity > 0) {
             if (!await setInitialTPAndSL(currentShortPosition)) tpslAllSet = false;
        }

        if (!tpslAllSet) {
             addLog("Đặt TP/SL cho một hoặc cả hai vị thế thất bại. Đang đóng cả hai.");
             if (currentLongPosition) await closePosition(currentLongPosition.symbol, 0, 'Lỗi đặt TP/SL', 'LONG');
             if (currentShortPosition) await closePosition(currentShortPosition.symbol, 0, 'Lỗi đặt TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        addLog("Đã đặt TP/SL cho cả hai vị thế. Bắt đầu theo dõi.");
        if (!positionCheckInterval) {
             positionCheckInterval = setInterval(async () => {
                 if (botRunning && (currentLongPosition || currentShortPosition)) {
                     try {
                         await manageOpenPosition();
                     }
                     catch (error) {
                         addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                         if(error instanceof CriticalApiError) {
                             addLog(`Bot dừng do lỗi API trong kiểm tra vị thế.`);
                             stopBotLogicInternal();
                         }
                     }
                 } else if (!botRunning && positionCheckInterval) {
                     clearInterval(positionCheckInterval);
                     positionCheckInterval = null;
                 }
             }, 10000);
        }
    } catch (error) {
        addLog(`Lỗi trong chu kỳ chính: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) stopBotLogicInternal();
        if(botRunning) scheduleNextMainCycle();
    }
}

const manageOpenPosition = async () => {
    if (!currentLongPosition && !currentShortPosition) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        if(botRunning) scheduleNextMainCycle();
        return;
    }
    if (isProcessingTrade) return;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        let longPosOnExchange = positions.find(p => p.positionSide === 'LONG' && Math.abs(parseFloat(p.positionAmt)) > 0);
        let shortPosOnExchange = positions.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (currentLongPosition) {
             if(longPosOnExchange){
                currentLongPosition.unrealizedPnl = parseFloat(longPosOnExchange.unRealizedProfit);
                currentLongPosition.currentPrice = parseFloat(longPosOnExchange.markPrice);
                currentLongPosition.quantity = Math.abs(parseFloat(longPosOnExchange.positionAmt));
                currentLongPosition.entryPrice = parseFloat(longPosOnExchange.entryPrice);
             } else {
                 addLog(`Vị thế LONG không trên sàn. Cập nhật trạng thái bot.`);
                 currentLongPosition = null;
             }
        }
        if (currentShortPosition) {
             if(shortPosOnExchange){
                currentShortPosition.unrealizedPnl = parseFloat(shortPosOnExchange.unRealizedProfit);
                currentShortPosition.currentPrice = parseFloat(shortPosOnExchange.markPrice);
                currentShortPosition.quantity = Math.abs(parseFloat(shortPosOnExchange.positionAmt));
                currentShortPosition.entryPrice = parseFloat(shortPosOnExchange.entryPrice);
            } else {
                 addLog(`Vị thế SHORT không trên sàn. Cập nhật trạng thái bot.`);
                 currentShortPosition = null;
             }
        }

        if (!currentLongPosition || !currentShortPosition) {
            if (!currentLongPosition && !currentShortPosition && botRunning) {
                addLog("Cả hai vị thế không còn trên sàn/bot. Dọn dẹp và bắt đầu chu kỳ mới.");
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            }
            return;
        }

        let winningPos = null;
        let losingPos = null;
        if (currentLongPosition.unrealizedPnl >= 0 && currentShortPosition.unrealizedPnl < 0) {
            winningPos = currentLongPosition;
            losingPos = currentShortPosition;
        } else if (currentShortPosition.unrealizedPnl >= 0 && currentLongPosition.unrealizedPnl < 0) {
            winningPos = currentShortPosition;
            losingPos = currentLongPosition;
        } else {
            return;
        }

        if (winningPos && losingPos && winningPos.partialCloseLossLevels && winningPos.quantity > 0 && losingPos.quantity > 0) {
            const actualPnlPercentageOfWinningPos = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
            const pnlBaseForWinningPos = winningPos.pnlBaseForNextMoc || 0;
            const targetMocPnlPercentage_Relative = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
            const absolutePnlPercentageThresholdForNextMoc = pnlBaseForWinningPos + targetMocPnlPercentage_Relative;

            const PARTIAL_CLOSE_INDEX_5 = 4;
            const PARTIAL_CLOSE_LEVEL_5_RELATIVE = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5]; // e.g. 250%
            const PARTIAL_CLOSE_INDEX_8 = 7;
            const PARTIAL_CLOSE_LEVEL_8_RELATIVE = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_8]; // e.g. 400%

            let actionTakenAtMoc = false;

            if (targetMocPnlPercentage_Relative !== undefined && actualPnlPercentageOfWinningPos >= absolutePnlPercentageThresholdForNextMoc) {
                actionTakenAtMoc = true;
                let currentHourlyVol = lastHourVolatility;
                const currentMocIndexReached = winningPos.nextPartialCloseLossIndex;


                if (currentBotMode === 'sideways') {
                    if (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5) {
                        addLog(`[SIDEWAYS] Đạt Mốc 5 (ngưỡng PNL tuyệt đối: ${absolutePnlPercentageThresholdForNextMoc.toFixed(0)}%, PNL hiện tại: ${actualPnlPercentageOfWinningPos.toFixed(2)}%). Kiểm tra lại biến động...`);
                        currentHourlyVol = await getHourlyVolatility(TARGET_COIN_SYMBOL);
                        addLog(`Biến động 1h hiện tại: ${currentHourlyVol.toFixed(2)}%`);

                        if (currentHourlyVol <= 5) {
                            addLog(`[SIDEWAYS] Biến động thấp. Mở lại phần lệnh lỗ ${losingPos.side} (${losingPos.closedLossAmount.toFixed(losingPos.quantityPrecision)}). Reset về Mốc 0 cho ${winningPos.side}.`);
                            if (losingPos.closedLossAmount > 0 && !losingPos.hasBeenReopenedInSideways) {
                                const reopenSuccess = await addPosition(losingPos, losingPos.closedLossAmount, "sideways_moc5_reopen");
                                if (reopenSuccess) return;
                                else {
                                    addLog(`[SIDEWAYS] Mở lại lệnh lỗ thất bại. Sẽ đóng từng phần 20% cho Mốc 5 này.`);
                                    const qtyToCloseNow = losingPos.initialQuantity * 0.20; // 20% for MOC 5
                                    if(await closePartialPosition(losingPos, qtyToCloseNow)) winningPos.nextPartialCloseLossIndex++;
                                }
                            } else {
                                addLog(`[SIDEWAYS] Không có phần lỗ nào để mở lại hoặc đã mở lại gần đây. Đóng 20% cho Mốc 5 này.`);
                                const qtyToCloseNow = losingPos.initialQuantity * 0.20;
                                if(await closePartialPosition(losingPos, qtyToCloseNow)) winningPos.nextPartialCloseLossIndex++;
                            }
                        } else {
                            addLog(`[SIDEWAYS -> KILL] Biến động CAO (${currentHourlyVol.toFixed(2)}%) tại Mốc 5. Chuyển sang KILL. Đóng 20% lệnh lỗ.`);
                            currentBotMode = 'kill';
                            const qtyToCloseNow = losingPos.initialQuantity * 0.20;
                            if(await closePartialPosition(losingPos, qtyToCloseNow)) winningPos.nextPartialCloseLossIndex++;
                            
                            if (!winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5_RELATIVE] && losingPos.quantity > 0) {
                                addLog(`[KILL MODE TRIGGERED] Điều chỉnh SL lệnh lỗ ${losingPos.side}.`);
                                const lossPercentageForSL = PARTIAL_CLOSE_LEVEL_8_RELATIVE / 100;
                                const priceChangeForLosingSL = (losingPos.initialMargin * lossPercentageForSL) / losingPos.initialQuantity;
                                const slPriceLosing = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeForLosingSL : losingPos.entryPrice + priceChangeForLosingSL).toFixed(losingPos.pricePrecision));
                                const newSLId = await updateStopLimitOrder(losingPos, slPriceLosing, 'STOP');
                                if (newSLId) {
                                    losingPos.currentSLId = newSLId;
                                    winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5_RELATIVE] = true;
                                }
                            }
                        }
                    } else {
                        addLog(`[SIDEWAYS] Đạt Mốc ${currentMocIndexReached + 1} (ngưỡng PNL tuyệt đối: ${absolutePnlPercentageThresholdForNextMoc.toFixed(0)}%, PNL hiện tại: ${actualPnlPercentageOfWinningPos.toFixed(2)}%). Đóng từng phần tiêu chuẩn.`);
                        let quantityToCloseFraction = (currentMocIndexReached >= PARTIAL_CLOSE_INDEX_8) ? 1.00 : 0.10;
                        const qtyToCloseNow = (quantityToCloseFraction === 1.00) ? losingPos.quantity : losingPos.initialQuantity * quantityToCloseFraction;
                        if(await closePartialPosition(losingPos, qtyToCloseNow)) winningPos.nextPartialCloseLossIndex++;
                    }
                } else { // currentBotMode === 'kill'
                    addLog(`[KILL] Đạt Mốc ${currentMocIndexReached + 1} (ngưỡng PNL tuyệt đối: ${absolutePnlPercentageThresholdForNextMoc.toFixed(0)}%, PNL hiện tại: ${actualPnlPercentageOfWinningPos.toFixed(2)}%). Kiểm tra lại biến động...`);
                    currentHourlyVol = await getHourlyVolatility(TARGET_COIN_SYMBOL);
                    addLog(`Biến động 1h hiện tại: ${currentHourlyVol.toFixed(2)}%`);

                    if (currentHourlyVol <= 5 && currentMocIndexReached >= PARTIAL_CLOSE_INDEX_5) {
                        addLog(`[KILL -> SIDEWAYS] Biến động THẤP và đang ở/sau Mốc 5. Chuyển sang SIDEWAYS. Reset về Mốc 0 cho ${winningPos.side}.`);
                        currentBotMode = 'sideways';
                        winningPos.pnlBaseForNextMoc = actualPnlPercentageOfWinningPos; // PNL hiện tại làm base mới
                        winningPos.nextPartialCloseLossIndex = 0; // Reset về Mốc 0
                        winningPos.hasAdjustedSLToSpecificLevel = {}; // Reset cờ SL
                        addLog(`Đã hủy TP/SL của cả cặp lệnh để đặt lại theo trạng thái mới.`);
                        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                        await sleep(500);
                        if (currentLongPosition && currentLongPosition.quantity > 0) await setInitialTPAndSL(currentLongPosition);
                        await sleep(300);
                        if (currentShortPosition && currentShortPosition.quantity > 0) await setInitialTPAndSL(currentShortPosition);
                        // Vẫn thực hiện đóng lệnh cho mốc hiện tại đã đạt
                        addLog(`Áp dụng đóng từng phần cho mốc vừa đạt (${targetMocPnlPercentage_Relative.toFixed(0)}% tương đối) ngay cả khi chuyển sang Sideways.`);
                        let quantityToCloseFraction = (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5) ? 0.20 :
                                                      (currentMocIndexReached >= PARTIAL_CLOSE_INDEX_8) ? 1.00 : 0.10;
                        const qtyToCloseNow = (quantityToCloseFraction === 1.00) ? losingPos.quantity : losingPos.initialQuantity * quantityToCloseFraction;
                        await closePartialPosition(losingPos, qtyToCloseNow); // Không tăng nextPartialCloseLossIndex vì đã reset

                    } else {
                        if (currentHourlyVol > 5) addLog(`[KILL] Biến động CAO. Giữ KILL.`);
                        else addLog(`[KILL] Biến động THẤP nhưng CHƯA đạt Mốc 5. Giữ KILL.`);

                        let quantityToCloseFraction = (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5) ? 0.20 :
                                                      (currentMocIndexReached >= PARTIAL_CLOSE_INDEX_8) ? 1.00 : 0.10;
                        addLog(`[KILL] Đóng ${quantityToCloseFraction * 100}% KL ban đầu của lệnh lỗ ${losingPos.side}.`);
                        const qtyToCloseNow = (quantityToCloseFraction === 1.00) ? losingPos.quantity : losingPos.initialQuantity * quantityToCloseFraction;
                        if(await closePartialPosition(losingPos, qtyToCloseNow)) winningPos.nextPartialCloseLossIndex++;

                        if (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5 &&
                            !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5_RELATIVE] &&
                            losingPos.quantity > 0) {
                            addLog(`[KILL] Điều chỉnh SL lệnh lỗ ${losingPos.side} tại Mốc 5.`);
                            const lossPercentageForSL = PARTIAL_CLOSE_LEVEL_8_RELATIVE / 100;
                            const priceChangeForLosingSL = (losingPos.initialMargin * lossPercentageForSL) / losingPos.initialQuantity;
                            const slPriceLosing = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeForLosingSL : losingPos.entryPrice + priceChangeForLosingSL).toFixed(losingPos.pricePrecision));
                            const newSLId = await updateStopLimitOrder(losingPos, slPriceLosing, 'STOP');
                            if (newSLId) {
                                losingPos.currentSLId = newSLId;
                                winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5_RELATIVE] = true;
                            }
                        }
                    }
                }
                 if (losingPos.quantity <= 0 || (winningPos.nextPartialCloseLossIndex > PARTIAL_CLOSE_INDEX_8 && actionTakenAtMoc) ) {
                    losingPos.hasClosedAllLossPositionAtLastLevel = true;
                    addLog(`Vị thế lỗ ${losingPos.side} đã đóng hoàn toàn hoặc đã xử lý đến mốc cuối.`);
                }
            }

            const absolutePnlThresholdForMoc8 = (winningPos.pnlBaseForNextMoc || 0) + PARTIAL_CLOSE_LEVEL_8_RELATIVE;
            if (PARTIAL_CLOSE_LEVEL_8_RELATIVE !== undefined && actualPnlPercentageOfWinningPos >= absolutePnlThresholdForMoc8 && !losingPos.hasClosedAllLossPositionAtLastLevel && losingPos.quantity > 0 && !actionTakenAtMoc) {
                 addLog(`Lệnh lãi ${winningPos.side} đạt/vượt Mốc 8 (ngưỡng PNL tuyệt đối ${absolutePnlThresholdForMoc8.toFixed(0)}%). Đóng nốt ${losingPos.side}. (Mode: ${currentBotMode.toUpperCase()})`);
                 await closePosition(losingPos.symbol, 0, `Đóng nốt ở Mốc 8 lãi lệnh thắng`, losingPos.side);
                 if (losingPos) {
                    losingPos.hasClosedAllLossPositionAtLastLevel = true;
                    losingPos.quantity = 0;
                 }
             }
        }

        if (losingPos && losingPos.closedLossAmount > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel && winningPos && winningPos.quantity > 0) {
            const pairEntryPrice = winningPos.pairEntryPrice;
            const tolerance = pairEntryPrice * 0.0005;
            if (currentMarketPrice !== null && pairEntryPrice !== null) {
                const isPriceNearPairEntry = Math.abs(currentMarketPrice - pairEntryPrice) <= tolerance;
                if (isPriceNearPairEntry && !isProcessingTrade && !losingPos.hasBeenReopenedInSideways) { // Thêm !losingPos.hasBeenReopenedInSideways
                    addLog(`Giá ${currentMarketPrice?.toFixed(winningPos.pricePrecision || 4)} gần giá vào cặp ${pairEntryPrice?.toFixed(winningPos.pricePrecision || 4)}. Mở lại ${losingPos.closedLossAmount.toFixed(losingPos.quantityPrecision)} ${losingPos.side}.`);
                    await addPosition(losingPos, losingPos.closedLossAmount, "price_near_pair_entry_reopen");
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

async function getListenKey() { if (!API_KEY || !SECRET_KEY) { addLog("API Key chưa cấu hình."); return null; } try { const data = await callSignedAPI('/fapi/v1/listenKey', 'POST'); return data.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.message}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }
async function keepAliveListenKey() { if (listenKey) { try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) { addLog(`Lỗi làm mới listenKey. Lấy key mới...`); if (e instanceof CriticalApiError) stopBotLogicInternal(); if (botRunning) { setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); else addLog("Không lấy được listenKey mới để kết nối lại User Data WS."); }, 1000); } } } }

function setupMarketDataStream(symbol) {
    if (marketWs) marketWs.close();
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${symbol.toLowerCase()}@markPrice@1s`;
    addLog(`Kết nối Market WS ${symbol}...`);
    marketWs = new WebSocket(streamUrl);
    marketWs.onopen = () => addLog(`Market WS ${symbol} đã kết nối.`);
    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
             if (data.e === 'markPriceUpdate' && data.s === symbol) {
                currentMarketPrice = parseFloat(data.p);
            }
        } catch (e) {}
    };
    marketWs.onclose = (event) => {
        addLog(`Market WS ${symbol} đóng (Code ${event.code}). Kết nối lại 5s...`);
        marketWs = null;
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
    marketWs.onerror = (error) => {
        addLog(`Lỗi Market WS ${symbol}: ${error.message}`);
        marketWs = null;
         if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
}

function setupUserDataStream(key) {
    if (userDataWs) userDataWs.close();
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`;
    addLog(`Kết nối User Data WS...`);
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
            }
        } catch (e) {
            addLog(`Lỗi xử lý User Data WS: ${e.message}`);
        }
    };
    userDataWs.onclose = async (event) => {
        addLog(`User Data WS đóng (Code ${event.code}). Kết nối lại 5s...`);
        userDataWs = null;
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
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
        userDataWs = null;
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
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
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
    }
    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime();
        await getExchangeInfo();
        const initialVolatility = await getHourlyVolatility(TARGET_COIN_SYMBOL);
        if (initialVolatility <= 5) {
            currentBotMode = 'sideways';
            addLog(`Chế độ SIDEWAYS kích hoạt khi khởi động (Biến động 1h: ${initialVolatility.toFixed(2)}%)`);
        } else {
            currentBotMode = 'kill';
            addLog(`Chế độ KILL kích hoạt khi khởi động (Biến động 1h: ${initialVolatility.toFixed(2)}%)`);
        }
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
        listenKey = await getListenKey();
        if (listenKey) {
            setupUserDataStream(listenKey);
            addLog("Đã lấy listenKey và thiết lập User Data Stream.");
        } else {
            addLog("Không thể lấy listenKey. User Data Stream sẽ không hoạt động.");
        }
        setupMarketDataStream(TARGET_COIN_SYMBOL);
        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT | Chế độ: ${currentBotMode.toUpperCase()}`);
        scheduleNextMainCycle();
        return 'Bot khởi động thành công.';
    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog(`[Lỗi khởi động bot] ${errorMsg}`);
        stopBotLogicInternal();
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s do lỗi nghiêm trọng.`);
            retryBotTimeout = setTimeout(async () => {
                addLog('Thử khởi động lại bot sau lỗi nghiêm trọng...');
                retryBotTimeout = null;
                await startBotLogicInternal();
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) return 'Bot không chạy.';
    addLog('--- Dừng Bot ---');
    botRunning = false;
    clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) clearInterval(positionCheckInterval); positionCheckInterval = null;
    if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
    if (marketWs) { try { marketWs.close(); } catch(e){} } marketWs = null;
    if (userDataWs) { try { userDataWs.close(); } catch(e){} } userDataWs = null;
    listenKey = null;
    currentLongPosition = null;
    currentShortPosition = null;
    isProcessingTrade = false;
    consecutiveApiErrors = 0;
     if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
    }
    addLog('--- Bot đã dừng ---');
    return 'Bot đã dừng.';
}

async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Kiểm tra vị thế sót ${symbol}.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const remainingPositions = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remainingPositions.length > 0) {
            addLog(`Tìm thấy ${remainingPositions.length} vị thế sót. Đang đóng...`);
            await cancelAllOpenOrdersForSymbol(symbol); // Hủy tất cả lệnh trước khi đóng
            await sleep(500);
            for (const pos of remainingPositions) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                await closePosition(pos.symbol, 0, `Vị thế sót khi khởi động/dọn dẹp`, sideToClose);
                await sleep(1000);
            }
            addLog("Đã đóng các vị thế sót.");
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
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
            exec('pm2 jlist', (error, stdout, stderr) => {
                 if (error) reject(stderr || error.message);
                resolve(stdout);
            });
        });
        const processes = JSON.parse(pm2List);
        const botProcess = processes.find(p => p.name === THIS_BOT_PM2_NAME);
        let statusMessage = 'MÁY CHỦ: TẮT (PM2)';
        if (botProcess) {
            statusMessage = `MÁY CHỦ: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | BOT: ${botRunning ? 'ĐANG CHẠY' : 'ĐÃ DỪNG'}`;
                if (botStartTime && botRunning) {
                    const uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / 60000);
                    statusMessage += ` | Chạy: ${uptimeMinutes} phút`;
                }
                statusMessage += ` | ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
                statusMessage += ` | Chế độ: ${currentBotMode.toUpperCase()} (1hVol: ${lastHourVolatility.toFixed(2)}%)`;
                 let openPositionsText = " | Vị thế: --";
                 if(currentLongPosition || currentShortPosition) {
                    openPositionsText = " | Vị thế: ";
                    if(currentLongPosition) openPositionsText += `L(${(currentLongPosition.unrealizedPnl || 0).toFixed(2)} PNLbase:${(currentLongPosition.pnlBaseForNextMoc || 0).toFixed(0)}% M${currentLongPosition.nextPartialCloseLossIndex +1}) `;
                    if(currentShortPosition) openPositionsText += `S(${(currentShortPosition.unrealizedPnl || 0).toFixed(2)} PNLbase:${(currentShortPosition.pnlBaseForNextMoc || 0).toFixed(0)}% M${currentShortPosition.nextPartialCloseLossIndex +1})`;
                 }
                 statusMessage += openPositionsText;
            }
        } else {
             statusMessage = `Bot PM2 '${THIS_BOT_PM2_NAME}' không tìm thấy.`;
        }
        res.send(statusMessage);
    } catch (error) {
        res.status(500).send(`Bot: Lỗi lấy trạng thái PM2. (${error.message})`);
    }
});
app.get('/api/bot_stats', (req, res) => {
    let openPositionsData = [];
    if (currentLongPosition) {
        const pos = currentLongPosition;
        openPositionsData.push({
            side: pos.side,
            entryPrice: pos.entryPrice?.toFixed(pos.pricePrecision || 4) || 'N/A',
            quantity: pos.quantity?.toFixed(pos.quantityPrecision || 4) || 'N/A',
            unrealizedPnl: (pos.unrealizedPnl || 0).toFixed(2),
            currentPrice: pos.currentPrice?.toFixed(pos.pricePrecision || 4) || 'N/A',
            initialQuantity: pos.initialQuantity?.toFixed(pos.quantityPrecision || 4) || 'N/A',
            closedLossAmount: pos.closedLossAmount?.toFixed(pos.quantityPrecision || 4) || 'N/A',
            pairEntryPrice: pos.pairEntryPrice?.toFixed(pos.pricePrecision || 4) || 'N/A',
            nextMocIndex: pos.nextPartialCloseLossIndex,
            pnlBaseForNextMoc: (pos.pnlBaseForNextMoc || 0).toFixed(2)
        });
    }
    if (currentShortPosition) {
         const pos = currentShortPosition;
        openPositionsData.push({
            side: pos.side,
            entryPrice: pos.entryPrice?.toFixed(pos.pricePrecision || 4) || 'N/A',
            quantity: pos.quantity?.toFixed(pos.quantityPrecision || 4) || 'N/A',
            unrealizedPnl: (pos.unrealizedPnl || 0).toFixed(2),
            currentPrice: pos.currentPrice?.toFixed(pos.pricePrecision || 4) || 'N/A',
            initialQuantity: pos.initialQuantity?.toFixed(pos.quantityPrecision || 4) || 'N/A',
            closedLossAmount: pos.closedLossAmount?.toFixed(pos.quantityPrecision || 4) || 'N/A',
            pairEntryPrice: pos.pairEntryPrice?.toFixed(pos.pricePrecision || 4) || 'N/A',
            nextMocIndex: pos.nextPartialCloseLossIndex,
            pnlBaseForNextMoc: (pos.pnlBaseForNextMoc || 0).toFixed(2)
        });
    }
    res.json({
        success: true,
        data: {
            botStatus: botRunning ? 'ĐANG CHẠY' : 'ĐÃ DỪNG',
            currentBotMode: currentBotMode.toUpperCase(),
            lastHourVolatility: lastHourVolatility.toFixed(2),
            totalProfit: totalProfit.toFixed(2),
            totalLoss: totalLoss.toFixed(2),
            netPNL: netPNL.toFixed(2),
            currentOpenPositions: openPositionsData,
            currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT,
            targetCoin: TARGET_COIN_SYMBOL
        }
    });
});
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinConfigs } = req.body;
    let configChanged = false;
    if (apiKey && apiKey.trim() !== API_KEY) {
        API_KEY = apiKey.trim();
        configChanged = true;
        addLog('API Key đã cập nhật.');
    }
    if (secretKey && secretKey.trim() !== SECRET_KEY) {
        SECRET_KEY = secretKey.trim();
        configChanged = true;
        addLog('Secret Key đã cập nhật.');
    }
    if (coinConfigs && coinConfigs.length > 0) {
        const config = coinConfigs[0];
        const oldSymbol = TARGET_COIN_SYMBOL;
        const oldAmount = INITIAL_INVESTMENT_AMOUNT;
        let coinConfigChanged = false;
        if (config.symbol && config.symbol.trim().toUpperCase() !== TARGET_COIN_SYMBOL) {
            TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase();
            coinConfigChanged = true;
        }
        if (config.initialAmount && parseFloat(config.initialAmount) !== INITIAL_INVESTMENT_AMOUNT && parseFloat(config.initialAmount) > 0) {
             INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount);
             coinConfigChanged = true;
        }
        if (coinConfigChanged) {
            configChanged = true;
            addLog(`Cấu hình coin đã cập nhật: Coin ${TARGET_COIN_SYMBOL} (cũ: ${oldSymbol}), Vốn ${INITIAL_INVESTMENT_AMOUNT} USDT (cũ: ${oldAmount})`);
            totalProfit = 0;
            totalLoss = 0;
            netPNL = 0;
            addLog("PNL đã được reset do thay đổi cấu hình coin.");
            if (botRunning) {
                addLog("Bot đang chạy. Dừng bot để áp dụng cấu hình coin mới.");
                stopBotLogicInternal();
                addLog("Vui lòng khởi động lại bot để kiểm tra biến động cho coin mới và xác định chế độ hoạt động.");
            }
        }
    }
    if (configChanged) {
        res.json({ success: true, message: 'Cấu hình đã cập nhật. Nếu thay đổi API/Secret hoặc Coin/Vốn, hãy khởi động lại bot (nếu đang chạy) để áp dụng đầy đủ.' });
    } else {
         res.json({ success: false, message: 'Không có thay đổi cấu hình nào được phát hiện.' });
    }
});

app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));

app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web server trên cổng ${WEB_SERVER_PORT}`);
    addLog(`Quản lý tại: http://localhost:${WEB_SERVER_PORT}`);
});
