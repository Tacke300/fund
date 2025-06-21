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

let botMode = 'stopped';
let volatileStatus = 'unknown';

const VOLATILITY_CHECK_INTERVAL_MS = 3 * 60 * 1000;
const VOLATILITY_DURATION_MS = 60 * 60 * 1000;
const VOLATILITY_THRESHOLD = 0.05;

let priceBuffer = [];
let volatilityCheckInterval = null;

const MODE_RESET_PROFIT_LEVEL_INDEX = 4;
const MOC_8_INDEX = 7;

let isResetReopenPending = false;
let pendingResetReason = '';
let pendingResetTargetMode = 'mode1_trading';

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
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;
        if ((now.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            logCounts[messageHash].count++;
            return;
        } else {
            if (logCounts[messageHash].count > 1) {
                console.log(`[${time}] (x${logCounts[messageHash].count}) ${message}`);
                 if (LOG_TO_CUSTOM_FILE) {
                    fs.appendFile(CUSTOM_LOG_FILE, `[${time}] (x${logCounts[messageHash].count}) ${message}\n`, (err) => {});
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
                    const errorMsg = `HTTP Lỗi ${res.statusCode}: ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                     try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) {
                        errorDetails.msg += ` - Raw: ${data.substring(0, Math.min(data.length, 200))}`;
                    }
                    addLog(`[API] Request lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => {
            addLog(`[API] Lỗi mạng: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });
        if (postData) req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("[API] Thiếu API/SECRET key.");

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
        throw new Error(`[API] Phương thức không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`[API] Lỗi gọi API (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`[API] Lỗi liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
            throw new CriticalApiError("[BOT] Quá nhiều lỗi API liên tiếp, bot dừng.");
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
         addLog(`[API] Lỗi gọi API công khai: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
             addLog(`[API] Lỗi liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
             throw new CriticalApiError("[BOT] Quá nhiều lỗi API liên tiếp, bot dừng.");
        }
        throw error;
    }
}

async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); addLog(`[API] Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`); } catch (e) { addLog(`[API] Lỗi đồng bộ thời gian: ${e.message}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const bracket = r.find(i => i.symbol === symbol)?.brackets[0]; return bracket ? parseInt(bracket.initialLeverage) : null; } catch (e) { addLog(`[API] Lỗi lấy đòn bẩy: ${e.msg}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { addLog(`[API] Lỗi đặt đòn bẩy: ${e.msg}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize || 0.001), stepSize: parseFloat(l?.stepSize || 0.001), minNotional: parseFloat(m?.notional || 0) }; }); addLog('[API] Đã tải thông tin sàn.'); return exchangeInfoCache; } catch (e) { addLog('[API] Lỗi tải thông tin sàn.'); if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { addLog(`[API] Lỗi lấy giá: ${e.message}`); if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }


async function cancelOpenOrdersForSymbol(symbol, positionSide = null) {
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) return;

        let ordersToCancel = openOrders;
        if (positionSide) ordersToCancel = openOrders.filter(o => o.positionSide === positionSide);
        if (ordersToCancel.length === 0) return;

        addLog(`[API] Hủy ${ordersToCancel.length} lệnh ${symbol}${positionSide ? ' ' + positionSide : ''}...`);
        for (const order of ordersToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId });
            } catch (innerError) {
                 if (innerError.code !== -2011) addLog(`[API] Lỗi hủy lệnh ${order.orderId}: ${innerError.msg || innerError.message}`);
                 if (innerError instanceof CriticalApiError) stopBotLogicInternal();
            }
            await sleep(50);
        }
        addLog("[API] Đã hủy lệnh chờ.");

    } catch (error) {
        if (error.code !== -2011) addLog(`[API] Lỗi lấy lệnh chờ để hủy: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function cleanupAndResetCycle(symbol) {
    addLog(`[BOT] Chu kỳ cho ${symbol} kết thúc (TP đạt). Dọn dẹp...`);

    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }

    // DO NOT clear volatilityCheckInterval or priceBuffer
    // DO NOT reset volatileStatus

    // Reset position state
    currentLongPosition = null;
    currentShortPosition = null;

    // Reset pending reset flag - ensure no pending actions carry over
    isResetReopenPending = false;
    pendingResetReason = '';
    pendingResetTargetMode = 'mode1_trading';


    await cancelOpenOrdersForSymbol(symbol);
    await checkAndHandleRemainingPosition(symbol);

    if (botRunning) {
         const nextMode = volatileStatus === 'calm' ? 'mode1_trading' : 'mode2_trading';
         addLog(`[BOT] Chu kỳ kết thúc. Biến động 1h: ${volatileStatus.toUpperCase()}. Bắt đầu chu kỳ mới trong ${nextMode.toUpperCase()} sau 2 giây...`);
         scheduleNextMainCycle(nextMode);
    } else {
         addLog("[BOT] Bot đã dừng, không lên lịch chu kỳ mới.");
    }
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide, q: quantity, S: side, p: price } = orderInfo;
    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED') {
        return;
    }

    const realizedPnl = parseFloat(realizedPnlStr);

    addLog(`[TRADE] FILL ${orderId} (${positionSide} ${side}) Qty ${parseFloat(quantity).toFixed(4)} Price ${parseFloat(price).toFixed(4)} PNL ${realizedPnl.toFixed(4)}`);

    if (realizedPnl !== 0) {
         if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
         netPNL = totalProfit - totalLoss;
         addLog(`[TRADE] PNL Ròng: ${netPNL.toFixed(2)} (L: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`);
    }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const currentQtyOnExchange = Math.abs(parseFloat(positions.find(p => p.symbol === symbol && p.positionSide === positionSide)?.positionAmt || 0));

        const isFullClosure = currentQtyOnExchange === 0;

        if (isFullClosure) {
             addLog(`[TRADE] Vị thế ${positionSide} đóng hoàn toàn.`);

             const remainingPosSide = positionSide === 'LONG' ? 'SHORT' : 'LONG';
             const remainingPosOnExchange = positions.find(p => p.symbol === symbol && p.positionSide === remainingPosSide && Math.abs(parseFloat(p.positionAmt)) > 0);
             const otherPosExistsAndIsWinning = remainingPosOnExchange ? parseFloat(remainingPosOnExchange.unRealizedProfit) > 0 : false;


             if (remainingPosOnExchange && otherPosExistsAndIsWinning) {
                 addLog(`[TRADE] Lệnh LỖ (${positionSide}) đóng hoàn tất. Lệnh LÃI ${remainingPosSide} còn.`);
                  if (positionSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;

             } else {
                 addLog(`[TRADE] Lệnh ${positionSide} đóng hoàn tất, kết thúc chu kỳ.`);
                 if(botRunning) await cleanupAndResetCycle(symbol);
             }
        }
    } catch (error) {
        addLog(`[TRADE] Lỗi kiểm tra vị thế sau Trade FILL: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}


async function closePosition(symbol, quantity, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide || isProcessingTrade) return false;

    addLog(`[TRADE] Đóng lệnh ${positionSide} (${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (posOnBinance) {
            await cancelOpenOrdersForSymbol(symbol, positionSide);
            await sleep(500);

            const qtyToClose = Math.abs(parseFloat(posOnBinance.positionAmt));
            if (qtyToClose === 0) {
                 addLog(`[TRADE] Vị thế ${positionSide} đã đóng hết.`);
                 return false;
            }
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            addLog(`[TRADE] Gửi lệnh đóng MARKET ${positionSide} Qty ${qtyToClose.toFixed(4)}`);
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: qtyToClose });
            addLog(`[TRADE] Đã gửi lệnh đóng ${positionSide}.`);
            return true;
        } else {
            addLog(`[TRADE] Vị thế ${positionSide} không tồn tại/đã đóng.`);
            return false;
        }
    } catch (error) {
        addLog(`[TRADE] Lỗi đóng vị thế ${positionSide}: ${error.msg || error.message}`);
         if (error instanceof CriticalApiError) stopBotLogicInternal();
        throw error;
    }
}

async function addPosition(position, quantityToAdd) {
    if (!position || quantityToAdd <= 0 || isProcessingTrade) return false;

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("[API] Lỗi lấy chi tiết symbol khi mở lại lệnh.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));

        const maxQtyAllowedToAdd = position.initialQuantity - currentQty;
        let effectiveQuantityToAdd = Math.min(quantityToAdd, maxQtyAllowedToAdd);

        if (effectiveQuantityToAdd <= symbolDetails.stepSize * 0.999) {
            addLog(`[TRADE] Mở lại Qty ${effectiveQuantityToAdd.toFixed(position.quantityPrecision)} quá nhỏ (${currentQty.toFixed(position.quantityPrecision)} >= ${position.initialQuantity.toFixed(position.quantityPrecision)}). Bỏ qua.`);
            return false;
        }

        effectiveQuantityToAdd = parseFloat((Math.floor(effectiveQuantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

         if (effectiveQuantityToAdd <= symbolDetails.stepSize * 0.999) {
             addLog(`[TRADE] Mở lại Qty ${effectiveQuantityToAdd.toFixed(position.quantityPrecision)} sau làm tròn quá nhỏ. Bỏ qua.`);
             return false;
         }

        const orderSide = (position.side === 'LONG') ? 'BUY' : 'SELL';

        addLog(`[TRADE] Gửi lệnh MARKET mở lại ${effectiveQuantityToAdd.toFixed(position.quantityPrecision)} ${position.symbol} ${position.side} (lỗ đã đóng).`);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: effectiveQuantityToAdd,
             newClientOrderId: `ADD-POS-${position.side}-${Date.now()}`
        });

        addLog(`[TRADE] Đã gửi lệnh mở lại ${position.side}.`);
        return true;

    } catch (error) {
        addLog(`[TRADE] Lỗi gửi lệnh mở lại ${position.side}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        throw error;
    }
}

async function setInitialTPAndSL(position) {
    if (!position) {
        addLog("[BOT] Không thể đặt TP/SL: Vị thế null.");
        return false;
    }
    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity, quantityPrecision } = position;
    addLog(`[BOT] Đặt TP/SL ban đầu/mới cho ${side} (Entry ${entryPrice.toFixed(pricePrecision)})...`);
    try {
        const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol });
        const currentPositionOnExchange = positionsOnExchange.find(p => p.symbol === symbol && p.positionSide === side);
        const actualQuantity = Math.abs(parseFloat(currentPositionOnExchange?.positionAmt || 0));

        if (actualQuantity === 0) {
             addLog(`[BOT] Vị thế ${side} đã đóng, không đặt TP/SL.`);
             position.currentTPId = null;
             position.currentSLId = null;
             return false;
        }

        const symbolDetails = await getSymbolDetails(symbol);
        const quantityToOrder = parseFloat((Math.floor(actualQuantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

         if (quantityToOrder <= symbolDetails.stepSize * 0.999) {
            addLog(`[BOT] KL đặt TP/SL mới ${quantityToOrder.toFixed(quantityPrecision)} quá nhỏ.`);
            position.currentTPId = null;
            position.currentSLId = null;
            return false;
         }

        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];

        if (maxLeverageUsed >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = 6;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100);
        } else if (maxLeverageUsed >= 25) {
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

         position.initialTPPrice = tpPrice;
         position.initialSLPrice = slPrice;


        await cancelOpenOrdersForSymbol(symbol, side);
        await sleep(300);

        let slOrder = null;
        try {
             slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol, side: orderSide, positionSide: side, type: 'STOP_MARKET',
                stopPrice: slPrice, quantity: quantityToOrder,
                timeInForce: 'GTC', newClientOrderId: `SL-${side}-${Date.now()}`
            });
             addLog(`[BOT] Đặt SL ${side}: ${slPrice.toFixed(pricePrecision)} (ID ${slOrder?.orderId || 'N/A'})`);
             position.currentSLId = slOrder?.orderId || null;
        } catch (e) {
            addLog(`[BOT] Lỗi đặt SL ${side}: ${e.msg || e.message}`);
             position.currentSLId = null;
            if (e.code === -2021) addLog("[BOT] SL nằm trong vùng giá cấm.");
            if (e instanceof CriticalApiError) throw e;
        }

         let tpOrder = null;
         try {
             tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol, side: orderSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                stopPrice: tpPrice, quantity: quantityToOrder,
                timeInForce: 'GTC', newClientOrderId: `TP-${side}-${Date.now()}`
            });
             addLog(`[BOT] Đặt TP ${side}: ${tpPrice.toFixed(pricePrecision)} (ID ${tpOrder?.orderId || 'N/A'})`);
            position.currentTPId = tpOrder?.orderId || null;
         } catch (e) {
             addLog(`[BOT] Lỗi đặt TP ${side}: ${e.msg || e.message}`);
             position.currentTPId = null;
             if (e.code === -2021) addLog("[BOT] TP nằm trong vùng giá cấm.");
              if (e instanceof CriticalApiError) throw e;
         }

        position.partialCloseLossLevels = partialCloseLossSteps;

        return slOrder !== null && tpOrder !== null;
    } catch (error) {
        addLog(`[BOT] Lỗi nghiêm trọng đặt TP/SL cho ${side}: ${error.msg || error.message}.`);
        if (error instanceof CriticalApiError) throw error;
        return false;
    }
}

async function runTradingLogic() {
    if (!botRunning || (botMode !== 'mode1_trading' && botMode !== 'mode2_trading')) {
        addLog(`[BOT] runTradingLogic gọi sai trạng thái: ${botRunning}/${botMode}.`);
        return;
    }

    addLog(`[BOT] Bắt đầu chu kỳ giao dịch mới: ${botMode.toUpperCase()}`);

    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
         if (!maxLeverage) {
            addLog("[BOT] Không lấy đòn bẩy. Kết thúc chu kỳ.");
             if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }

        const initialPairPrice = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (!initialPairPrice) {
            addLog("[BOT] Không lấy giá ban đầu. Kết thúc chu kỳ.");
            if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }

        addLog(`[BOT] Giá vào cặp dự kiến: ${initialPairPrice.toFixed(4)}`);

        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
        await sleep(1000);

        let longPositionData;
        try {
            longPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        } catch (e) {
            addLog(`[BOT] Mở LONG thất bại: ${e.message}.`);
            if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }
        currentLongPosition = longPositionData;
        currentLongPosition.pairEntryPrice = initialPairPrice;
         currentLongPosition.reopenProcessedAtLevel5 = false;
         currentLongPosition.previousPartialCloseLossIndex = -1;


        await sleep(1500);

        let shortPositionData;
        try {
            shortPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        } catch (e) {
            addLog(`[BOT] Mở SHORT thất bại: ${e.message}. Đóng LONG.`);
            if (currentLongPosition) {
                try { await closePosition(currentLongPosition.symbol, 0, 'Lỗi mở SHORT', 'LONG'); } catch(closeErr) { addLog(`[BOT] Lỗi đóng LONG sau lỗi mở SHORT: ${closeErr.message}`); }
                currentLongPosition = null;
            }
            if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }
        currentShortPosition = shortPositionData;
        currentShortPosition.pairEntryPrice = initialPairPrice;
        currentShortPosition.reopenProcessedAtLevel5 = false;
        currentShortPosition.previousPartialCloseLossIndex = -1;


        addLog("[BOT] Đã mở 2 vị thế. Đặt TP/SL...");
        await sleep(3000);

        let isLongTPSLSet = false;
        try { isLongTPSLSet = await setInitialTPAndSL(currentLongPosition); } catch(e) { addLog(`[BOT] Lỗi đặt LONG TP/SL: ${e.message}`); if (e instanceof CriticalApiError) throw e; }

        await sleep(500);

        let isShortTPSLSet = false;
         try { isShortTPSLSet = await setInitialTPAndSL(currentShortPosition); } catch(e) { addLog(`[BOT] Lỗi đặt SHORT TP/SL: ${e.message}`); if (e instanceof CriticalApiError) throw e; }


         if (!isLongTPSLSet || !isShortTPSLSet) {
             addLog("[BOT] Đặt TP/SL thất bại. Đóng cả hai.");
             try { await closePosition(currentLongPosition?.symbol || TARGET_COIN_SYMBOL, 0, 'Lỗi đặt TP/SL', 'LONG'); } catch(e){}
             try { await closePosition(currentShortPosition?.symbol || TARGET_COIN_SYMBOL, 0, 'Lỗi đặt TP/SL', 'SHORT'); } catch(e){}
             if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        addLog(`[BOT] Đã đặt TP/SL (${botMode.toUpperCase()}). Bắt đầu theo dõi.`);
        if (!positionCheckInterval) {
             positionCheckInterval = setInterval(async () => {
                 if (botRunning && (currentLongPosition || currentShortPosition)) {
                     try {
                         await manageOpenPosition();
                     }
                     catch (error) {
                         addLog(`[BOT] Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                         if(error instanceof CriticalApiError) {
                             addLog(`[BOT] Bot dừng do lỗi API.`);
                             stopBotLogicInternal();
                         }
                     }
                 } else if (!botRunning && positionCheckInterval) {
                     clearInterval(positionCheckInterval);
                     positionCheckInterval = null;
                 }
             }, 15000);
        }
    } catch (error) {
        addLog(`[BOT] Lỗi trong runTradingLogic (${botMode}): ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) stopBotLogicInternal();
        if(botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
    }
}

async function checkVolatilityAndModeChange() {
    if (!botRunning || currentMarketPrice === null) return;

    const now = Date.now();
    priceBuffer.push({ timestamp: now, price: currentMarketPrice });

    const oldestAllowedTimestamp = now - VOLATILITY_DURATION_MS;
    priceBuffer = priceBuffer.filter(item => item.timestamp >= oldestAllowedTimestamp);

    const oldPriceEntry = priceBuffer.find(item => item.timestamp <= oldestAllowedTimestamp + (VOLATILITY_CHECK_INTERVAL_MS * 0.5));

    let newVolatileStatus = volatileStatus;

    if (oldPriceEntry && oldPriceEntry.price > 0) {
        const oldPrice = oldPriceEntry.price;
        const priceChange = Math.abs(currentMarketPrice - oldPrice) / oldPrice;
        newVolatileStatus = priceChange >= VOLATILITY_THRESHOLD ? 'volatile' : 'calm';

        if (newVolatileStatus !== volatileStatus) {
             // Only log the volatility status change when it actually changes
            addLog(`[VOL] Biến động 1h đổi: ${volatileStatus.toUpperCase()} -> ${newVolatileStatus.toUpperCase()} (${(priceChange * 100).toFixed(2)}% vs ${VOLATILITY_THRESHOLD * 100}%).`);
            volatileStatus = newVolatileStatus;
        }
    } else {
        // Not enough data or invalid price. Status remains.
    }
}

async function performResetReopenAndModeChange(targetMode, triggerReason) {
     if (!currentLongPosition || !currentShortPosition) {
         addLog(`[RESET] Lỗi: Thiếu vị thế để Reset.`);
          if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
         throw new CriticalApiError("[RESET] Thiếu vị thế khi Reset.");
     }

     addLog(`[RESET] Start: ${triggerReason} -> ${targetMode.toUpperCase()}`);

     const losingPos = (currentLongPosition.unrealizedPnl <= 0) ? currentLongPosition : currentShortPosition;
     const winningPos = (losingPos === currentLongPosition) ? currentShortPosition : currentLongPosition;

     try {
         if (losingPos.closedLossAmount > 0) {
              addLog(`[RESET] Mở lại ${losingPos.closedLossAmount.toFixed(losingPos.quantityPrecision)} KL lỗ.`);
              const addSuccess = await addPosition(losingPos, losingPos.closedLossAmount);
              if (addSuccess) {
                   addLog("[RESET] Lệnh mở lại đã gửi. Chờ khớp...");
                   await sleep(3000);
              } else {
                   addLog("[RESET] Gửi lệnh mở lại thất bại.");
              }
         } else {
             addLog("[RESET] Không có KL lỗ đã đóng.");
         }

         addLog("[RESET] Lấy trạng thái mới...");
         const updatedPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });

         const updatedLongPosOnExchange = updatedPositions.find(p => p.positionSide === 'LONG' && Math.abs(parseFloat(p.positionAmt)) > 0);
         const updatedShortPosOnExchange = updatedPositions.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);

         if (!updatedLongPosOnExchange || !updatedShortPosOnExchange) {
             addLog("[RESET] Lỗi: Không tìm thấy cả hai vị thế sau mở lại/chờ. Dọn dẹp.");
              if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             throw new CriticalApiError("[RESET] Vị thế biến mất sau Reset.");
         }

         currentLongPosition.quantity = Math.abs(parseFloat(updatedLongPosOnExchange.positionAmt));
         currentLongPosition.entryPrice = parseFloat(updatedLongPosOnExchange.entryPrice);
         currentLongPosition.unrealizedPnl = parseFloat(updatedLongPosOnExchange.unRealizedProfit);
         currentLongPosition.currentPrice = parseFloat(updatedLongPosOnExchange.markPrice);

         currentShortPosition.quantity = Math.abs(parseFloat(updatedShortPosOnExchange.positionAmt));
         currentShortPosition.entryPrice = parseFloat(updatedShortPosOnExchange.entryPrice);
         currentShortPosition.unrealizedPnl = parseFloat(updatedShortPosOnExchange.unRealizedProfit);
         currentShortPosition.currentPrice = parseFloat(updatedShortPosOnExchange.markPrice);

         addLog(`[RESET] Trạng thái lệnh mới: LONG Qty ${currentLongPosition.quantity.toFixed(currentLongPosition.quantityPrecision)}, Entry ${currentLongPosition.entryPrice.toFixed(currentLongPosition.pricePrecision)} | SHORT Qty ${currentShortPosition.quantity.toFixed(currentShortPosition.quantityPrecision)}, Entry ${currentShortPosition.entryPrice.toFixed(currentShortPosition.pricePrecision)}.`);


         const newPairEntryPrice = await getCurrentPrice(TARGET_COIN_SYMBOL);
         if (newPairEntryPrice) {
              currentLongPosition.pairEntryPrice = newPairEntryPrice;
              currentShortPosition.pairEntryPrice = newPairEntryPrice;
              addLog(`[RESET] Cập nhật giá vào cặp: ${newPairEntryPrice.toFixed(winningPos.pricePrecision)}.`);
         } else {
              addLog(`[RESET] Cảnh báo: Không lấy được giá hiện tại để cập nhật mốc ban đầu.`);
         }

         currentLongPosition.closedLossAmount = 0;
         currentLongPosition.nextPartialCloseLossIndex = 0;
         currentLongPosition.hasAdjustedSLToSpecificLevel = {};
         currentLongPosition.hasClosedAllLossPositionAtLastLevel = false;
         currentLongPosition.reopenProcessedAtLevel5 = false;
         currentLongPosition.previousPartialCloseLossIndex = -1;


         currentShortPosition.closedLossAmount = 0;
         currentShortPosition.nextPartialCloseLossIndex = 0;
         currentShortPosition.hasAdjustedSLToSpecificLevel = {};
         currentShortPosition.hasClosedAllLossPositionAtLastLevel = false;
         currentShortPosition.reopenProcessedAtLevel5 = false;
         currentShortPosition.previousPartialCloseLossIndex = -1;

         addLog("[RESET] Đã reset biến trạng thái.");


         addLog("[RESET] Hủy lệnh cũ & đặt TP/SL mới...");
         await cancelOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
          await sleep(800);

          currentLongPosition.currentTPId = null; currentLongPosition.currentSLId = null;
          currentShortPosition.currentTPId = null; currentShortPosition.currentSLId = null;

         const isLongTPSLSet = await setInitialTPAndSL(currentLongPosition);
         await sleep(500);
         const isShortTPSLSet = await setInitialTPAndSL(currentShortPosition);

          if (isLongTPSLSet && isShortTPSLSet) {
             addLog("[RESET] Đã đặt TP/SL mới thành công.");
          } else {
              addLog("[RESET] Lỗi nghiêm trọng đặt TP/SL sau Reset. Dọn dẹp.");
               if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
               throw new CriticalApiError("[RESET] Đặt lại TP/SL thất bại.");
          }

         botMode = targetMode;
         addLog(`[RESET] Hoàn tất. Mode mới: ${botMode.toUpperCase()}`);


     } catch (error) {
         addLog(`[RESET] Lỗi trong quy trình: ${error.msg || error.message}`);
         if (error instanceof CriticalApiError) throw error;
         if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
         throw new Error("[RESET] Lỗi không nghiêm trọng dẫn đến dọn dẹp.");
     }
     // isProcessingTrade lock released by caller
}


const manageOpenPosition = async () => {
    if (!botRunning) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        positionCheckInterval = null;
         return;
    }

    if (!currentLongPosition && !currentShortPosition) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        addLog("[BOT] Không có vị thế mở để theo dõi.");
        if(botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
        return;
    }

    if (isResetReopenPending && !isProcessingTrade) {
        isProcessingTrade = true;
        addLog(`[MANAGE] Trigger Reset pending: ${pendingResetReason}. Initiating...`);

         const targetMode = pendingResetTargetMode;
         const reason = pendingResetReason;

        isResetReopenPending = false;
        pendingResetReason = '';
        pendingResetTargetMode = 'mode1_trading';

        try {
            await performResetReopenAndModeChange(targetMode, reason);
        } catch (e) {
             addLog(`[MANAGE] Lỗi nghiêm trọng khi thực hiện Reset: ${e.message}. Dừng bot.`);
             stopBotLogicInternal();
        } finally {
             isProcessingTrade = false;
        }
        return;

    } else if (isResetReopenPending && isProcessingTrade) {
         return;
    }


    if (isProcessingTrade) {
        return;
    }

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
                 addLog(`[MANAGE] Vị thế LONG không trên sàn.`);
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
                 addLog(`[MANAGE] Vị thế SHORT không trên sàn.`);
                 currentShortPosition = null;
             }
         }

        if (!currentLongPosition && !currentShortPosition) {
            addLog("[MANAGE] Cả hai vị thế đã đóng. Dọn dẹp.");
            if(botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }

        if (!currentLongPosition || !currentShortPosition) {
             return;
        }

        let winningPos = currentLongPosition.unrealizedPnl > currentShortPosition.unrealizedPnl ? currentLongPosition : currentShortPosition;
        let losingPos = winningPos === currentLongPosition ? currentShortPosition : currentLongPosition;


        if (!winningPos.partialCloseLossLevels || winningPos.partialCloseLossLevels.length === 0) {
             addLog("[MANAGE] Cảnh báo: partialCloseLossLevels không set.");
             return;
        }

        const MOC_5_PROFIT_PERCENTAGE = winningPos.partialCloseLossLevels[MODE_RESET_PROFIT_LEVEL_INDEX];
        const MOC_8_PROFIT_PERCENTAGE = winningPos.partialCloseLossLevels[MOC_8_INDEX];

        const currentProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;

        // Find the actual profit index based on current profit percentage
        let actualProfitIndex = winningPos.partialCloseLossLevels.findIndex(level => currentProfitPercentage < level);
        if (actualProfitIndex === -1) actualProfitIndex = winningPos.partialCloseLossLevels.length;

        const currentWinningIndex = winningPos.nextPartialCloseLossIndex;
        const previousWinningIndex = winningPos.previousPartialCloseLossIndex !== undefined ? winningPos.previousPartialCloseLossIndex : -1;


        // --- Trigger 1 (Mode 1 @ Mốc 5 Profit) ---
        // Trigger if profit is >= Mốc 5 profit AND bot is in Mode 1 AND not already pending
        if (botMode === 'mode1_trading' && currentProfitPercentage >= MOC_5_PROFIT_PERCENTAGE && !isResetReopenPending)
        {
             addLog(`[MODE1] Đạt Mốc ${MODE_RESET_PROFIT_LEVEL_INDEX + 1} (${MOC_5_PROFIT_PERCENTAGE.toFixed(2)}%). Kích hoạt Reset.`);
             isResetReopenPending = true;
             pendingResetReason = `Mode 1 đạt Mốc ${MODE_RESET_PROFIT_LEVEL_INDEX + 1} Profit`;
             return; // Exit manageOpenPosition
        }


        // --- Trigger 2 (Mode 2 -> Calm Above Mốc 5 + Price Action) ---
        if (botMode === 'mode2_trading' && volatileStatus === 'calm' && actualProfitIndex > MODE_RESET_PROFIT_LEVEL_INDEX) {

             const reachedNextStep = actualProfitIndex > previousWinningIndex && previousWinningIndex > MODE_RESET_PROFIT_LEVEL_INDEX;
             const returnedToMoc5 = (previousWinningIndex > MODE_RESET_PROFIT_LEVEL_INDEX) && (currentProfitPercentage <= MOC_5_PROFIT_PERCENTAGE);

             const losingPosCurrentQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));
             const lossSideFullyClosed = losingPos.hasClosedAllLossPositionAtLastLevel || losingPosCurrentQtyOnExchange <= 0;

             let reachedTPPrice = false;
             if (lossSideFullyClosed && winningPos.initialTPPrice !== undefined) {
                 reachedTPPrice = (winningPos.side === 'LONG' && winningPos.currentPrice >= winningPos.initialTPPrice * 0.99) || (winningPos.side === 'SHORT' && winningPos.currentPrice <= winningPos.initialTPPrice * 1.01);
             }

             if (((reachedNextStep || returnedToMoc5) && !lossSideFullyClosed) || (lossSideFullyClosed && (reachedTPPrice || returnedToMoc5))) {
                  if (!isResetReopenPending) {
                       addLog(`[MODE2] Trigger 2 met (${volatileStatus}, trên Mốc ${MODE_RESET_PROFIT_LEVEL_INDEX + 1}, price action). Kích hoạt Reset.`);
                       isResetReopenPending = true;
                       pendingResetReason = `Mode 2 biến động ${volatileStatus} và lệnh lãi trên Mốc ${MODE_RESET_PROFIT_LEVEL_INDEX + 1} đạt mốc/về Mốc ${MODE_RESET_PROFIT_LEVEL_INDEX + 1}`;
                       pendingResetTargetMode = 'mode1_trading';
                       return;
                  } else {
                       return;
                  }
             }
        }


        // --- STANDARD PARTIAL CLOSE / SL ADJUSTMENT (If no Reset/Reopen is pending and not busy) ---

        const losingPosCurrentQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));

        let processLevelIndex = winningPos.nextPartialCloseLossIndex;

        while (processLevelIndex < actualProfitIndex && processLevelIndex < winningPos.partialCloseLossLevels.length) {
            const levelIndexToProcess = processLevelIndex;
            const levelPercentageToProcess = winningPos.partialCloseLossLevels[levelIndexToProcess];

             if (botMode === 'mode1_trading') {
                  if (levelIndexToProcess >= MODE_RESET_PROFIT_LEVEL_INDEX) {
                       processLevelIndex++; // Skip Mốc 5 and above in Mode 1 standard processing
                       continue;
                  }
             }

            if (levelPercentageToProcess !== undefined && currentProfitPercentage >= levelPercentageToProcess && !isProcessingTrade) {

                 let actionPerformed = false;

                 let quantityToCloseFraction = 0.10;
                 if (botMode === 'mode2_trading') {
                      if (levelIndexToProcess === MODE_RESET_PROFIT_LEVEL_INDEX) quantityToCloseFraction = 0.20;
                      if (levelIndexToProcess === MOC_8_INDEX) quantityToCloseFraction = 1.00;
                 }


                 addLog(`[${botMode.toUpperCase()}] Đạt Mốc ${levelIndexToProcess + 1} (${levelPercentageToProcess.toFixed(2)}%).`);

                 if (losingPosCurrentQtyOnExchange > 0) {
                      isProcessingTrade = true;
                      const qtyToCloseNow = (quantityToCloseFraction === 1.00) ? losingPosCurrentQtyOnExchange : losingPos.initialQuantity * quantityToCloseFraction;
                       const finalQtyToClose = Math.min(qtyToCloseNow, losingPosCurrentQtyOnExchange);

                       if (finalQtyToClose > losingPos.quantityPrecision * Math.pow(10, -losingPos.quantityPrecision) * 0.999) {
                            try {
                                const success = await closePosition(losingPos.symbol, finalQtyToClose, `Đóng từng phần Mốc ${levelIndexToProcess + 1}`, losingPos.side);
                                 if (success) {
                                      losingPos.closedLossAmount += finalQtyToClose;
                                      addLog(`  -> Đã gửi đóng từng phần. Tổng KL lỗ: ${losingPos.closedLossAmount.toFixed(losingPos.quantityPrecision)}.`);
                                      actionPerformed = true;
                                 } else {
                                      addLog(`  -> Gửi đóng từng phần thất bại.`);
                                 }
                            } catch (e) {
                                 addLog(`  -> Lỗi gửi đóng từng phần: ${e.message}`);
                                 if (e instanceof CriticalApiError) throw e;
                            } finally {
                                 isProcessingTrade = false;
                            }
                       } else {
                             addLog(`  -> KL đóng từng phần Mốc ${levelIndexToProcess + 1} quá nhỏ. Bỏ qua.`);
                             actionPerformed = true;
                       }


                       if (botMode === 'mode2_trading' && levelIndexToProcess === MODE_RESET_PROFIT_LEVEL_INDEX && !winningPos.hasAdjustedSLToSpecificLevel[levelPercentageToProcess]) {
                             const LEVEL_8_PROFIT_THRESHOLD = winningPos.partialCloseLossLevels[MOC_8_INDEX];

                             if (LEVEL_8_PROFIT_THRESHOLD !== undefined) {
                                 const priceChangeForLosingSL = (losingPos.initialMargin * (LEVEL_8_PROFIT_THRESHOLD / 100)) / losingPos.initialQuantity;
                                  const slPriceLosing = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeForLosingSL : losingPos.entryPrice + priceChangeForLosingSL).toFixed(losingPos.pricePrecision));

                                 addLog(`  -> Điều chỉnh SL lỗ ${losingPos.side} về ${slPriceLosing.toFixed(losingPos.pricePrecision)}.`);
                                  try {
                                       isProcessingTrade = true;
                                       losingPos.currentSLId = await updateStopLimitOrder(losingPos, slPriceLosing, 'STOP');
                                       if (losingPos.currentSLId) {
                                           addLog(`  -> Đã đặt SL mới.`);
                                           winningPos.hasAdjustedSLToSpecificLevel[levelPercentageToProcess] = true;
                                       } else {
                                           addLog(`  -> Không thể đặt SL mới.`);
                                            winningPos.hasAdjustedSLToSpecificLevel[levelPercentageToProcess] = true;
                                       }
                                  } catch (e) {
                                       addLog(`  -> Lỗi gửi SL mới: ${e.message}`);
                                        if (e instanceof CriticalApiError) throw e;
                                       winningPos.hasAdjustedSLToSpecificLevel[levelPercentageToProcess] = true;
                                  } finally {
                                      isProcessingTrade = false;
                                  }
                             } else {
                                  addLog(`  -> Không xác định được SL target (Mốc 8).`);
                                   winningPos.hasAdjustedSLToSpecificLevel[levelPercentageToProcess] = true;
                             }
                              actionPerformed = true;
                        } else if (botMode === 'mode2_trading' && levelIndexToProcess === MODE_RESET_PROFIT_LEVEL_INDEX && winningPos.hasAdjustedSLToSpecificLevel[levelPercentageToProcess]) {
                        }


                  } else {
                       addLog(`[${botMode.toUpperCase()}] Vị thế lỗ đã đóng hết khi lệnh lãi đạt Mốc ${levelIndexToProcess + 1}.`);
                       losingPos.hasClosedAllLossPositionAtLastLevel = true;
                       actionPerformed = true;
                  }

                 if (actionPerformed) {
                     winningPos.nextPartialCloseLossIndex++;
                     winningPos.previousPartialCloseLossIndex = levelIndexToProcess;
                 }

            } else {
                 break;
            }
        }
         winningPos.previousPartialCloseLossIndex = actualProfitIndex;


    } catch (error) {
        addLog(`[MANAGE] Lỗi: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) stopBotLogicInternal();
    }
};


async function updateStopLimitOrder(position, newPrice, type) {
    const { symbol, side, currentSLId, currentTPId, pricePrecision, quantityPrecision } = position;
    const orderIdToCancel = (type === 'STOP') ? currentSLId : currentTPId;
    const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';
    const triggerType = (type === 'STOP') ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';

    if (type === 'TAKE_PROFIT') return position.currentTPId;

    if (isProcessingTrade) {
         addLog(`[API] updateStopLimitOrder blocked (${side} ${type}): Bot busy.`);
         return null;
     }
     isProcessingTrade = true;

    try {
        if (orderIdToCancel) {
            addLog(`[API] Hủy lệnh ${type} cũ ${orderIdToCancel} (${side})...`);
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: orderIdToCancel });
                addLog(`[API] Đã hủy lệnh ${type} cũ.`);
            } catch (innerError) {
                if (innerError.code !== -2011) addLog(`[API] Lỗi hủy lệnh ${type} cũ: ${innerError.msg || innerError.message}`);
                 if (innerError instanceof CriticalApiError) throw innerError;
            }
             await sleep(300);
        }

        const symbolDetails = await getSymbolDetails(symbol);
        const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol });
        const currentPositionOnExchange = positionsOnExchange.find(p => p.symbol === symbol && p.positionSide === side);
        const actualQuantity = Math.abs(parseFloat(currentPositionOnExchange?.positionAmt || 0));

        if (actualQuantity === 0) {
             addLog(`[API] Vị thế ${side} đã đóng, không đặt ${type} mới.`);
             if (type === 'STOP') position.currentSLId = null;
             return null;
        }

        const quantityToUse = parseFloat((Math.floor(actualQuantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToUse <= symbolDetails.stepSize * 0.999) {
            addLog(`[API] KL đặt ${type} mới ${quantityToUse.toFixed(quantityPrecision)} quá nhỏ.`);
             if (type === 'STOP') position.currentSLId = null;
            return null;
        }

        const stopPriceFormatted = parseFloat(newPrice.toFixed(pricePrecision));

         addLog(`[API] Đặt lệnh ${type} mới ${side}: ${stopPriceFormatted.toFixed(pricePrecision)} (KL: ${quantityToUse.toFixed(quantityPrecision)})...`);
        const newOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side,
            type: triggerType,
            stopPrice: stopPriceFormatted,
            quantity: quantityToUse,
            timeInForce: 'GTC',
            newClientOrderId: `${type.toUpperCase()}-UPD-${side}-${Date.now()}`
        });
        addLog(`[API] Đã đặt lệnh ${type} mới. ID: ${newOrder.orderId}`);

        if (type === 'STOP') position.currentSLId = newOrder.orderId;

        return newOrder.orderId;
    } catch (error) {
        addLog(`[API] Lỗi cập nhật ${type} cho ${side}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) throw error;
        if (type === 'STOP') position.currentSLId = null;
        return null;
    } finally {
        isProcessingTrade = false;
    }
}


async function scheduleNextMainCycle(intendedMode) {
    if (!botRunning) {
        addLog(`[BOT] Bot không chạy, không lên lịch chu kỳ mới.`);
        return;
    }
     botMode = intendedMode || (volatileStatus === 'calm' ? 'mode1_trading' : 'mode2_trading');


    clearTimeout(nextScheduledCycleTimeout);
    addLog(`[BOT] Lên lịch chu kỳ mới trong ${botMode.toUpperCase()} sau 2 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đã chạy.';
    if (!API_KEY || !SECRET_KEY) return 'Lỗi: Thiếu API/SECRET key.';

    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('[BOT] Hủy lịch tự động khởi động lại.');
    }

    addLog('[BOT] --- Khởi động Bot ---');
    botRunning = true;
    botStartTime = new Date();
    addLog(`[BOT] --- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
    addLog(`[BOT] Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`);

    try {
        await syncServerTime();
        await getExchangeInfo();

        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);

        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey);
         else addLog("[WS] Không thiết lập User Data Stream.");

        setupMarketDataStream(TARGET_COIN_SYMBOL);

        priceBuffer = [];
        volatileStatus = 'unknown';
        if (volatilityCheckInterval) clearInterval(volatilityCheckInterval);
        volatilityCheckInterval = setInterval(checkVolatilityAndModeChange, VOLATILITY_CHECK_INTERVAL_MS);
        addLog(`[VOL] Bắt đầu kiểm tra biến động 1h mỗi ${VOLATILITY_CHECK_INTERVAL_MS / 1000}s.`);


        botMode = 'mode1_trading';
        addLog("[BOT] Bắt đầu chu kỳ đầu tiên trong MODE 1...");
        await runTradingLogic();

        return 'Bot khởi động thành công.';
    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog(`[BOT] Lỗi khởi động bot: ${errorMsg}`);
        stopBotLogicInternal();

        if (error instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`[BOT] Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            retryBotTimeout = setTimeout(async () => {
                addLog('[BOT] Thử khởi động lại...');
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) return 'Bot không chạy.';
    addLog('[BOT] --- Dừng Bot ---');
    botRunning = false;
    botMode = 'stopped';

    clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) clearInterval(positionCheckInterval);
    if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
    if (volatilityCheckInterval) clearInterval(volatilityCheckInterval);

    if (marketWs) { try { marketWs.close(); } catch(e){}}
    if (userDataWs) { try { userDataWs.close(); } catch(e){}}

    positionCheckInterval = null;
    listenKeyRefreshInterval = null;
    volatilityCheckInterval = null;
    marketWs = null;
    userDataWs = null;
    listenKey = null;

    priceBuffer = [];
    volatileStatus = 'unknown';

    currentLongPosition = null;
    currentShortPosition = null;

    isResetReopenPending = false;
    pendingResetReason = '';
    pendingResetTargetMode = 'mode1_trading';

    isProcessingTrade = false;
    consecutiveApiErrors = 0;

     if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('[BOT] Hủy lịch tự động khởi động lại.');
    }
    addLog('[BOT] --- Bot đã dừng ---');
    return 'Bot đã dừng.';
}


async function checkAndHandleRemainingPosition(symbol) {
    addLog(`[BOT] Kiểm tra vị thế sót ${symbol}.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const remainingPositions = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPositions.length > 0) {
            addLog(`[BOT] Tìm thấy ${remainingPositions.length} vị thế sót. Đang đóng...`);
            await cancelOpenOrdersForSymbol(symbol);
            await sleep(500);

            for (const pos of remainingPositions) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                 const qty = Math.abs(parseFloat(pos.positionAmt));
                 try {
                     const success = await closePosition(pos.symbol, qty, `Vị thế sót`, sideToClose);
                     if(success) await sleep(1000);
                 } catch(e) {
                     addLog(`[BOT] Lỗi đóng vị thế sót ${sideToClose}: ${e.message}`);
                 }
            }
             await sleep(2000);
             const positionsAfterCleanup = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
             const remainingAfterCleanup = positionsAfterCleanup.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
             if (remainingAfterCleanup.length > 0) {
                 addLog(`[BOT] Cảnh báo: ${remainingAfterCleanup.length} vị thế sót vẫn còn. Kiểm tra thủ công.`);
             } else {
                 addLog(`[BOT] Đã đóng thành công vị thế sót.`);
             }

        } else {
            addLog(`[BOT] Không có vị thế sót.`);
        }
    } catch (error) {
        addLog(`[BOT] Lỗi kiểm tra vị thế sót: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}


function setupMarketDataStream(symbol) {
    if (marketWs) marketWs.close();
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${symbol.toLowerCase()}@markPrice@1s`;
    addLog(`[WS] Kết nối Market ${symbol}: ${streamUrl}`);
    marketWs = new WebSocket(streamUrl);

    marketWs.onopen = () => addLog(`[WS] Market ${symbol} đã kết nối.`);
    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
             if (data.e === 'markPriceUpdate' && data.s === symbol) {
                currentMarketPrice = parseFloat(data.p);
            }
        } catch (e) {
        }
    };
    marketWs.onclose = (event) => {
        addLog(`[WS] Market ${symbol} đóng (Code ${event.code}). Kết nối lại 5s...`);
        marketWs = null;
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
    marketWs.onerror = (error) => {
        addLog(`[WS] Lỗi Market ${symbol}: ${error.message}`);
        marketWs = null;
         if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
}

function setupUserDataStream(key) {
    if (userDataWs) userDataWs.close();
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`;
    addLog(`[WS] Kết nối User Data: ${streamUrl}`);
    userDataWs = new WebSocket(streamUrl);

    userDataWs.onopen = () => {
        addLog('[WS] User Data đã kết nối.');
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000);
    };
    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'ORDER_TRADE_UPDATE' && data.o.s === TARGET_COIN_SYMBOL) {
                processTradeResult(data.o).catch(e => addLog(`[WS] Lỗi xử lý trade result: ${e.message}`));
            } else if (data.e === 'ACCOUNT_UPDATE') {
            }
        } catch (e) {
            addLog(`[WS] Lỗi xử lý User Data message: ${e.message}`);
        }
    };
    userDataWs.onclose = async (event) => {
        addLog(`[WS] User Data đóng (Code ${event.code}). Kết nối lại 5s...`);
        userDataWs = null;
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
        if (botRunning) {
            setTimeout(async () => {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
                 else addLog("[WS] Không lấy listenKey mới để kết nối lại User Data WS.");
            }, 5000);
        }
    };
    userDataWs.onerror = (error) => {
        addLog(`[WS] Lỗi User Data WS: ${error.message}`);
        userDataWs = null;
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
         if (botRunning) {
             setTimeout(async () => {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
                 else addLog("[WS] Không lấy listenKey mới để kết nối lại User Data WS sau lỗi.");
            }, 5000);
         }
    };
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
                 statusMessage += ` | CHẾ ĐỘ: ${botMode.toUpperCase()}`;
                if (botStartTime) {
                    const uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / 60000);
                    statusMessage += ` | Thời gian chạy: ${uptimeMinutes} phút`;
                }
                statusMessage += ` | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
                 let openPositionsText = " | Vị thế: KHÔNG CÓ";
                 if(currentLongPosition || currentShortPosition) {
                    openPositionsText = " | Vị thế: ";
                    if(currentLongPosition) openPositionsText += `LONG (${currentLongPosition.unrealizedPnl?.toFixed(2) || 'N/A'} PNL) `;
                    if(currentShortPosition) openPositionsText += `SHORT (${currentShortPosition.unrealizedPnl?.toFixed(2) || 'N/A'} PNL)`;
                 }
                 statusMessage += openPositionsText;

                 statusMessage += ` | Biến động 1h: ${volatileStatus.toUpperCase()}`;
                 if (isResetReopenPending) statusMessage += ` | Chờ Reset: ${pendingResetReason}`;

            }
        } else {
             statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME}). Đảm bảo đã chạy PM2!`;
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error);
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error})`);
    }
});
app.get('/api/bot_stats', (req, res) => {
    let openPositionsData = [];
    if (currentLongPosition) {
        const pos = currentLongPosition;
        openPositionsData.push({
            side: pos.side,
            entryPrice: pos.entryPrice?.toFixed(pos.pricePrecision) || 'N/A',
            quantity: pos.quantity?.toFixed(pos.quantityPrecision) || 'N/A',
            unrealizedPnl: pos.unrealizedPnl?.toFixed(2) || 'N/A',
            currentPrice: pos.currentPrice?.toFixed(pos.pricePrecision) || 'N/A',
            initialQuantity: pos.initialQuantity?.toFixed(pos.quantityPrecision) || 'N/A',
            closedLossAmount: pos.closedLossAmount?.toFixed(pos.quantityPrecision) || 'N/A',
            pairEntryPrice: pos.pairEntryPrice?.toFixed(pos.pricePrecision) || 'N/A',
             botMode: botMode,
             volatileStatus: volatileStatus,
             nextPartialCloseIndex: pos.nextPartialCloseLossIndex,
             reopenProcessedAtLevel5: pos.reopenProcessedAtLevel5,
             previousPartialCloseLossIndex: pos.previousPartialCloseLossIndex,
             isResetReopenPending: isResetReopenPending,
             pendingResetReason: pendingResetReason,
             pendingResetTargetMode: pendingResetTargetMode,

        });
    }
    if (currentShortPosition) {
         const pos = currentShortPosition;
        openPositionsData.push({
            side: pos.side,
            entryPrice: pos.entryPrice?.toFixed(pos.pricePrecision) || 'N/A',
            quantity: pos.quantity?.toFixed(pos.quantityPrecision) || 'N/A',
            unrealizedPnl: pos.unrealizedPnl?.toFixed(2) || 'N/A',
            currentPrice: pos.currentPrice?.toFixed(pos.pricePrecision) || 'N/A',
            initialQuantity: pos.initialQuantity?.toFixed(pos.quantityPrecision) || 'N/A',
            closedLossAmount: pos.closedLossAmount?.toFixed(pos.quantityPrecision) || 'N/A',
            pairEntryPrice: pos.pairEntryPrice?.toFixed(pos.pricePrecision) || 'N/A',
            botMode: botMode,
            volatileStatus: volatileStatus,
             nextPartialCloseIndex: pos.nextPartialCloseLossIndex,
             reopenProcessedAtLevel5: pos.reopenProcessedAtLevel5,
             previousPartialCloseLossIndex: pos.previousPartialCloseLossIndex,
             isResetReopenPending: isResetReopenPending,
             pendingResetReason: pendingResetReason,
             pendingResetTargetMode: pendingResetTargetMode,
        });
    }
    res.json({ success: true, data: { botStatus: botRunning ? 'ĐANG CHẠY' : 'ĐÃ DỪNG', botMode: botMode, volatileStatus: volatileStatus, totalProfit: totalProfit.toFixed(2), totalLoss: totalLoss.toFixed(2), netPNL: netPNL.toFixed(2), currentOpenPositions: openPositionsData, currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT, targetCoin: TARGET_COIN_SYMBOL, isResetReopenPending: isResetReopenPending, pendingResetReason: pendingResetReason, pendingResetTargetMode: pendingResetTargetMode } });
});
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinConfigs } = req.body;
    let configChanged = false;

    if (apiKey && apiKey.trim() !== API_KEY) {
        API_KEY = apiKey.trim();
        configChanged = true;
        addLog('[BOT] API Key đã cập nhật.');
    }
    if (secretKey && secretKey.trim() !== SECRET_KEY) {
        SECRET_KEY = secretKey.trim();
        configChanged = true;
        addLog('[BOT] SECRET Key đã cập nhật.');
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
        if (config.initialAmount && parseFloat(config.initialAmount) !== INITIAL_INVESTMENT_AMOUNT) {
             INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount);
             coinConfigChanged = true;
        }

        if (coinConfigChanged) {
            configChanged = true;
             addLog(`[BOT] Cấu hình coin đã cập nhật: Coin: ${TARGET_COIN_SYMBOL} (trước: ${oldSymbol}), Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT (trước: ${oldAmount})`);
            if (botRunning) {
                addLog("[BOT] Bot đang chạy. Dừng bot và khởi động lại để áp dụng cấu hình coin mới.");
            }
        }
    } else {
         addLog('[BOT] Dữ liệu cấu hình coin không hợp lệ.');
    }

    if (configChanged) {
        res.json({ success: true, message: 'Cấu hình đã cập nhật. Khởi động lại bot để áp dụng.' });
    } else {
         res.json({ success: false, message: 'Không có thay đổi cấu hình nào được phát hiện.' });
    }
});

app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));

app.listen(WEB_SERVER_PORT, () => {
    addLog(`[BOT] Web server trên cổng ${WEB_SERVER_PORT}`);
    addLog(`[BOT] Quản lý tại: http://localhost:${WEB_SERVER_PORT}`);
});

// startBotLogicInternal();
